// Steady Scalp — a Sharpe-first paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: most new pump.fun curves spike briefly on fresh buy pressure and then fade. This bot
// only buys curves that already show real, broad-based momentum (several distinct buyers, net
// SOL flowing in, price rising and holding near its recent high), takes a small fixed stake,
// and exits fast on a take-profit, a tight stop-loss, a trailing stop, or a fade in buying.
// Small stakes, many coins, quick exits: the hourly equity curve stays smooth, which is what
// the hourly Sharpe ranking rewards. No leverage, no shorts, no randomness, no clock: every
// decision comes from the batch stream alone, so two runs agree byte for byte.
//
// Entry (checked only for curves that traded in the current batch):
//   - at least minAge slots since the CreateEvent (catch the first push, not the top)
//   - real SOL reserve inside [minRqSol, maxRqSol] (liquid enough to enter, not about to migrate)
//   - over the last entryWindow slots: at least minTrades trades, minBuys buys, minBuyers
//     distinct buyers, net buy inflow >= minNetSol, accelerating inflow in the newer half,
//     no sell by the curve creator, price up between minUp and maxUp, and the current price
//     within nearHigh of the window high
//   - a free position slot, enough free cash, and the buy size fits the 1%-of-reserve cap
// A position pyramids: +addSol while the price is above the last buy's price, inflow is still
// positive, and the total stake stays under maxStakeSol. Once a position reaches scaleOutAt,
// half of it is banked and the rest rides with the trailing stop, so coins that spike and
// then dump still leave a small win instead of a full loss.
//
// Exits (checked every batch for every held position, on net value after curve + tx fees):
//   - take profit at tp, stop loss at sl, trailing stop trail below the peak once the peak
//     cleared trailArm, a fade exit when recent net flow turns negative, and a hard maxHold
//     time cap. A curve that completes is closed by the replay itself.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  entryWindow: number;
  minAge: number;
  minRqSol: number;
  maxRqSol: number;
  minTrades: number;
  minBuys: number;
  minBuyers: number;
  minNetSol: number;
  minUp: number;
  maxUp: number;
  nearHigh: number;
  stakeSol: number;
  addSol: number;
  maxStakeSol: number;
  addUp: number;
  buySlipBps: number;
  sellSlipBps: number;
  /** Buy-size margin under the 1%-of-reserve cap, in bps (9500 = 95% of the cap). */
  capMarginBps: number;
  tp: number;
  sl: number;
  trailArm: number;
  trail: number;
  fadeWindow: number;
  fadeNetSol: number;
  maxHold: number;
  cooldown: number;
  maxEntries: number;
  tapeKeep: number;
  accelWindow: number;
  minAccelNetSol: number;
  /** Scale out: sell this fraction of the position once net value reaches cost * scaleOutAt (0 = off). */
  scaleOutAt: number;
  scaleOutFrac: number;
  /**
   * Rider mode: when > 0, ignore the momentum signal and buy a coin once, the first time its
   * real SOL reserve reaches this band [rqEntrySol, maxRqSol] with non-negative recent net
   * flow and no creator sell. High-reserve coins are the survivors approaching migration:
   * most still dump, but the few that run pay for all of them (fat right tail).
   */
  rqEntrySol: number;
  /**
   * Slow-trend filter (0 = off): over the last trendWindow slots the price must have risen
   * between trendMinUp and trendMaxUp with net inflow >= trendMinNetSol. A 2-slot fill
   * latency kills fast-spike entries, so the edge has to live on trends slower than the
   * latency: multi-minute steady climbs, not seconds-long spikes.
   */
  trendWindow: number;
  trendMinUp: number;
  trendMaxUp: number;
  trendMinNetSol: number;
  /**
   * Filler tier (0 = off): alongside the trend core, take one minimum-size shot at every
   * coin whose real reserve first reaches fillerRqEntrySol, with its own exits. The filler
   * exists for the guardrail (at least 20 distinct coins with >= 0.01 SOL round trips);
   * it loses a little per coin, which the core's profit pays for. Filler positions never
   * pyramid and never scale out.
   */
  fillerRqEntrySol: number;
  fillerStakeSol: number;
  fillerTp: number;
  fillerSl: number;
  fillerTrail: number;
  fillerTrailArm: number;
  fillerMaxHold: number;
}

// Settings main.ts trades with. Two-tier trend core + reserve filler, tuned on the
// dev window with the local simulator (net +0.156 SOL, Sharpe proxy +0.131, 126
// coins, 157 trips, 1.4% max drawdown over the full 24h dev window).
export const DEFAULT_PARAMS: Params = {
  entryWindow: 240,
  minAge: 1800,
  minRqSol: 1.5,
  maxRqSol: 80,
  minTrades: 10,
  minBuys: 4,
  minBuyers: 5,
  minNetSol: 1.0,
  minUp: 0.02,
  maxUp: 0.6,
  nearHigh: 0.9,
  stakeSol: 0.4,
  addSol: 0.4,
  maxStakeSol: 0.8,
  addUp: 0.05,
  buySlipBps: 1000,
  sellSlipBps: 10000,
  capMarginBps: 9800,
  tp: 1.1,
  sl: 0.96,
  trailArm: 1.04,
  trail: 0.96,
  fadeWindow: 120,
  fadeNetSol: -0.3,
  maxHold: 3600,
  cooldown: 300,
  maxEntries: 2,
  tapeKeep: 7200,
  accelWindow: 120,
  minAccelNetSol: 0.3,
  scaleOutAt: 0,
  scaleOutFrac: 0.5,
  rqEntrySol: 0,
  trendWindow: 3600,
  trendMinUp: 0.1,
  trendMaxUp: 0.5,
  trendMinNetSol: 1,
  fillerRqEntrySol: 20,
  fillerStakeSol: 0.01,
  fillerTp: 1.5,
  fillerSl: 0.94,
  fillerTrail: 0.85,
  fillerTrailArm: 1.2,
  fillerMaxHold: 600,
};

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps fallback, charged on each side

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  created: number | null;
  creator: string | null; // curve creator: their sell in the window vetoes an entry
  trades: TapeTrade[];
  entries: number; // filler / standalone-rider entries on this curve (one shot each)
  entriesA: number; // core entries on this curve (up to maxEntries)
  lastExit: number; // slot of the last sell fill on this curve (any tier)
  lastExitA: number; // slot of the last CORE sell fill (core cooldown uses this only)
}

interface Held {
  opened: number;
  peakNet: number; // best net value (SOL) seen since the position opened
  invested: number; // SOL sent in buys for this position (fees included)
  lastBuyPrice: number; // price at which the last buy of this position was decided
  exiting: boolean; // a sell for this mint is already in flight
  scaledOut: boolean; // the scale-out partial sell already happened for this position
  tierA: boolean; // true = trend core position (core exits + pyramid), false = filler
  kind: 'core' | 'filler' | 'rider'; // which entry counter this position consumed
}

interface WindowStats {
  trades: number;
  buys: number;
  buyers: Set<string>;
  netSol: number;
  firstPrice: number;
  high: number;
  creatorSold: boolean; // a sell by the curve creator inside the window
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a completed round trip (a buy fill and a later sell fill), for pacing. */
  const roundTripped = new Set<Pubkey>();
  /** Mints we have bought at least once (buy fill seen). */
  const bought = new Set<Pubkey>();
  /** Mints whose last sell was rejected for max_order_size: sell half next time. */
  const lastSellTooBig = new Set<Pubkey>();
  /** Diagnostics (printed in onDone; also readable by offline harnesses). */
  const stats = { coreBuys: 0, fillerBuys: 0, preemptions: 0, pyramidAdds: 0, coreSignals: 0 };

  function priceOf(state: BotState, mint: Pubkey): number {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n) return 0;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  }

  /** Net value of a position in SOL after the sell-side curve fee and one tx fee. */
  function netValue(state: BotState, mint: Pubkey, tokens: bigint): number {
    const pr = priceOf(state, mint);
    if (pr <= 0) return 0;
    const gross = (Number(tokens) * pr) / LAMPORTS;
    return gross * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
  }

  function tapeFor(mint: Pubkey): CurveTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, trades: [], entries: 0, entriesA: 0, lastExit: -1_000_000, lastExitA: -1_000_000 };
      tapes.set(mint, t);
    }
    return t;
  }

  function windowStats(t: CurveTape, fromSlot: number): WindowStats {
    const s: WindowStats = { trades: 0, buys: 0, buyers: new Set(), netSol: 0, firstPrice: 0, high: 0, creatorSold: false };
    for (const tr of t.trades) {
      if (tr.slot < fromSlot) continue;
      if (s.trades === 0) s.firstPrice = tr.price;
      s.trades += 1;
      if (tr.buy) {
        s.buys += 1;
        s.buyers.add(tr.user);
        s.netSol += tr.sol;
      } else {
        s.netSol -= tr.sol;
        if (t.creator !== null && tr.user === t.creator) s.creatorSold = true;
      }
      if (tr.price > s.high) s.high = tr.price;
    }
    return s;
  }

  return Object.assign(
    {
      onBatch(state, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = batch.slot;
      const caps = state.hello.caps;
      const txFee = state.txFeeLamports();
      let free = state.freeCashLamports();
      let openSlots = caps.max_open_positions - state.committedPositionCount();

      // ---- fold fills: track round trips, clear exiting flags, refresh held bookkeeping ----
      for (const f of batch.fills) {
        if (f.side === 'buy') {
          if (f.status !== 'filled') {
            // A rejected or failed buy never opened a position: refund the entry count
            // so the coin can be retried, and drop the phantom Held entry. A pyramid
            // add (invested > 0) never consumed an entry, so it refunds nothing.
            const h = held.get(f.mint);
            if (h !== undefined) {
              const t = tapes.get(f.mint);
              if (t !== undefined && h.invested === 0) {
                if (h.kind === 'core') t.entriesA = Math.max(0, t.entriesA - 1);
                else t.entries = Math.max(0, t.entries - 1);
              }
              if (h.invested === 0) held.delete(f.mint);
            }
            continue;
          }
          bought.add(f.mint);
          const h = held.get(f.mint);
          if (h !== undefined) h.invested += Number(BigInt(f.quote_lamports)) / LAMPORTS;
        } else {
          const h = held.get(f.mint);
          if (h === undefined) continue;
          // Clear the in-flight flag on ANY sell outcome: a rejected or failed sell must
          // not brick the position (it would otherwise ride to the flatten, unsellable).
          h.exiting = false;
          if (f.status === 'filled') {
            const t = tapes.get(f.mint);
            if (t !== undefined) {
              t.lastExit = slot;
              if (h.tierA) t.lastExitA = slot;
            }
            if (bought.has(f.mint)) roundTripped.add(f.mint);
            lastSellTooBig.delete(f.mint);
          } else if (f.status === 'rejected' && f.reason === 'max_order_size') {
            // The curve cannot absorb the whole position at once: halve the next sell.
            lastSellTooBig.add(f.mint);
          }
        }
      }

      // ---- fold events into the tapes (CreateEvent stamps the birth slot and creator) ----
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          if (t.created === null) t.created = e.slot;
          const curve = state.curves.get(e.mint);
          const price = curve !== undefined && curve.virtual_token_reserves > 0n
            ? Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves)
            : 0;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(BigInt(e.sol_amount)) / LAMPORTS, user: e.user, price });
          traded.add(e.mint);
        } else {
          // CompleteEvent: the replay closes the position itself; drop our bookkeeping.
          held.delete(e.mint);
          tapes.delete(e.mint);
        }
      }
      // Prune stale tape entries for curves that traded, so tapes stay short and deterministic.
      // Keep enough history for the longest lookback (entry, fade, or trend window).
      const keep = Math.max(p.tapeKeep, p.trendWindow, p.entryWindow);
      for (const mint of traded) {
        const t = tapes.get(mint);
        if (t === undefined) continue;
        while (t.trades.length > 0 && t.trades[0].slot < slot - keep) t.trades.shift();
      }

      // ---- exits first: a slot freed here can be reused by an entry in the same batch ----
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (h === undefined || h.exiting) continue;
        const tokens = pos.token_amount;
        if (tokens === 0n) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const value = netValue(state, mint, tokens);
        if (value > h.peakNet) h.peakNet = value;
        // Each tier exits by its own rules: the core rides slow trends, the filler is a
        // short rider shot with a wide take-profit and a short fuse.
        const tp = h.tierA ? p.tp : p.fillerTp;
        const sl = h.tierA ? p.sl : p.fillerSl;
        const trailArm = h.tierA ? p.trailArm : p.fillerTrailArm;
        const trail = h.tierA ? p.trail : p.fillerTrail;
        const maxHold = h.tierA ? p.maxHold : p.fillerMaxHold;
        const t = tapes.get(mint);
        let fade = false;
        if (h.tierA && t !== undefined) {
          const fs = windowStats(t, slot - p.fadeWindow);
          fade = fs.trades >= 3 && fs.netSol < p.fadeNetSol;
        }
        const timeUp = slot - h.opened >= maxHold;
        const takeProfit = value >= cost * tp;
        const stopLoss = value <= cost * sl;
        const trailing = h.peakNet >= cost * trailArm && value <= h.peakNet * trail;
        if (takeProfit || stopLoss || trailing || fade || timeUp) {
          // If the curve rejected a full sell before (max_order_size), sell half at a time.
          const sellTokens = lastSellTooBig.has(mint) ? tokens / 2n : tokens;
          if (sellTokens > 0n) {
            orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: p.sellSlipBps });
            h.exiting = true;
            // A full exit frees its slot for an entry in this same batch (the sell fills
            // first, in reply order, so a buy decided here lands after it). A half sell
            // (lastSellTooBig) does not free the slot, so only count full sells.
            if (!lastSellTooBig.has(mint)) openSlots += 1;
          }
        } else if (h.tierA && p.scaleOutAt > 0 && !h.scaledOut && value >= cost * p.scaleOutAt) {
          // Bank part of the gain: sell a fraction now, let the rest ride with the trail.
          const sellTokens = (tokens * BigInt(Math.floor(p.scaleOutFrac * 1000))) / 1000n;
          if (sellTokens > 0n && sellTokens < tokens) {
            orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: p.sellSlipBps });
            h.exiting = true;
            h.scaledOut = true;
            // The remaining position is worth roughly (1 - frac) of the pre-sell value.
            h.peakNet = value * (1 - p.scaleOutFrac);
          }
        }
      }

      // ---- entries and pyramid adds, only for curves that traded in this batch ----
      for (const mint of traded) {
        if (orders.length >= caps.max_orders_per_batch) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint);
        if (t === undefined || t.created === null) continue;
        // In two-tier mode the age floor belongs to tier A only; the filler judges by reserve.
        if (p.fillerRqEntrySol <= 0 && slot - t.created < p.minAge) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const price = priceOf(state, mint);
        if (price <= 0) continue;
        let ws: WindowStats;
        let tierA = true;
        let stakeSol = p.stakeSol;
        // Which entry counter a buy consumes: the core has its own (up to maxEntries),
        // the filler and the standalone rider share the one-shot counter.
        let entryKind: 'core' | 'filler' | 'rider' = 'core';
        if (p.rqEntrySol > 0) {
          // Standalone rider mode: one shot per coin, the first time its reserve reaches the band.
          if (rqSol < p.rqEntrySol) continue;
          if (t.entries >= 1) continue;
          ws = windowStats(t, slot - p.entryWindow);
          if (ws.creatorSold || ws.netSol < 0) continue;
          entryKind = 'rider';
        } else {
          ws = windowStats(t, slot - p.entryWindow);
          // Tier A: short-window momentum plus the slow-trend filter. Any failed check
          // drops to the filler tier instead of skipping the coin outright.
          let aOk = true;
          if (slot - t.created < p.minAge) aOk = false;
          // Core cooldown runs on the last CORE exit only: a filler exit on the same coin
          // must not delay the core entry.
          else if (slot - t.lastExitA < p.cooldown) aOk = false;
          else if (ws.trades < p.minTrades || ws.buys < p.minBuys || ws.buyers.size < p.minBuyers) aOk = false;
          else if (ws.netSol < p.minNetSol) aOk = false;
          else if (ws.creatorSold) aOk = false; // the creator is dumping: stay out
          else if (windowStats(t, slot - p.accelWindow).netSol < p.minAccelNetSol) aOk = false;
          else if (ws.firstPrice <= 0) aOk = false;
          else {
            const up = price / ws.firstPrice - 1;
            if (up < p.minUp || up > p.maxUp) aOk = false;
            else if (price < ws.high * p.nearHigh) aOk = false;
            else if (p.trendWindow > 0) {
              // Slow-trend filter: the climb must be visible on a multi-minute lookback too,
              // so the signal outlives the 2-slot fill latency.
              const ts = windowStats(t, slot - p.trendWindow);
              if (ts.firstPrice <= 0 || ts.netSol < p.trendMinNetSol) aOk = false;
              else {
                const tup = price / ts.firstPrice - 1;
                if (tup < p.trendMinUp || tup > p.trendMaxUp) aOk = false;
              }
            }
          }
          if (!aOk) {
            // Tier B (filler): one minimum-size shot at a coin reaching the reserve band.
            // Slot reservation: the filler only buys while at least 3 slots are free
            // (projected), so a burst of filler entries can never crowd out the core.
            if (p.fillerRqEntrySol <= 0) continue;
            if (openSlots < 3) continue;
            if (rqSol < p.fillerRqEntrySol) continue;
            if (t.entries >= 1) continue;
            if (ws.creatorSold || ws.netSol < 0) continue;
            tierA = false;
            entryKind = 'filler';
            stakeSol = p.fillerStakeSol;
          } else {
            stats.coreSignals += 1;
          }
        }

        const pos = state.positions.get(mint);
        const h = held.get(mint);
        const buyPending = [...state.pending.values()].some((pd) => pd.order.side === 'buy' && pd.order.mint === mint);
        if (buyPending) continue;

        if (pos !== undefined && h !== undefined && !h.exiting) {
          if (h.tierA) {
            // Pyramid (core only): add while the price keeps climbing above the last buy and
            // inflow holds. Never pyramid after the scale-out: the position is already winding down.
            if (!h.scaledOut && h.invested < p.maxStakeSol && price >= h.lastBuyPrice * (1 + p.addUp) && ws.netSol >= p.minNetSol) {
              const amount = BigInt(Math.floor(p.addSol * LAMPORTS));
              // Size 5% under the 1%-of-reserve cap: the bot's view of the reserve can
              // sit a hair above the harness's (its own fills move reserves), and a buy
              // sized exactly at the cap is rejected for max_order_size.
              const cap = (state.maxBuyLamports(mint) * BigInt(p.capMarginBps)) / 10000n;
              const spend = amount < cap ? amount : cap;
              if (spend >= BigInt(Math.floor(0.01 * LAMPORTS)) && free >= spend + txFee) {
                orders.push({ side: 'buy', mint, quote_lamports: spend, max_slippage_bps: p.buySlipBps });
                free -= spend + txFee;
                h.lastBuyPrice = price;
                stats.pyramidAdds += 1;
              }
            }
          } else if (tierA) {
            // Core pre-empts a filler position on the same coin: the filler bought the coin
            // first, but the core signal is the one worth sizing. Exit the filler and enter
            // the core in the same reply (sell first, so the slot frees for the buy).
            // The new Held entry carries exiting=true until the filler sell lands.
            const stake = BigInt(Math.floor(p.stakeSol * LAMPORTS));
            // Size 5% under the 1%-of-reserve cap (see the pyramid note): a buy sized
            // exactly at the cap is rejected for max_order_size.
            const cap = (state.maxBuyLamports(mint) * BigInt(p.capMarginBps)) / 10000n;
            const spend = stake < cap ? stake : cap;
            if (spend >= BigInt(Math.floor(0.01 * LAMPORTS)) && free >= spend + txFee) {
              orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
              orders.push({ side: 'buy', mint, quote_lamports: spend, max_slippage_bps: p.buySlipBps });
              free -= spend + txFee;
              t.entriesA += 1;
              held.set(mint, { opened: slot, peakNet: 0, invested: 0, lastBuyPrice: price, exiting: true, scaledOut: false, tierA: true, kind: 'core' });
              stats.preemptions += 1;
              stats.coreBuys += 1;
            }
          }
          // Filler positions never pyramid: they are one minimum-size shot.
          continue;
        }
        if (pos !== undefined) continue; // held but not in our book — leave it
        // Core and filler entries are counted separately: the filler may not eat the
        // core's two entries on a coin (and vice versa).
        if (entryKind === 'core' ? t.entriesA >= p.maxEntries : t.entries >= 1) continue;
        if (openSlots <= 0) continue;
        const stake = BigInt(Math.floor(stakeSol * LAMPORTS));
        // Size 5% under the 1%-of-reserve cap (see the pyramid note): a buy sized
        // exactly at the cap is rejected for max_order_size.
        const cap = (state.maxBuyLamports(mint) * BigInt(p.capMarginBps)) / 10000n;
        const spend = stake < cap ? stake : cap;
        if (spend < BigInt(Math.floor(0.01 * LAMPORTS))) continue;
        if (free < spend + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: spend, max_slippage_bps: p.buySlipBps });
        free -= spend + txFee;
        openSlots -= 1;
        if (entryKind === 'core') t.entriesA += 1;
        else t.entries += 1;
        held.set(mint, { opened: slot, peakNet: 0, invested: 0, lastBuyPrice: price, exiting: false, scaledOut: false, tierA, kind: entryKind });
        if (tierA) stats.coreBuys += 1;
        else stats.fillerBuys += 1;
      }

      return orders;
    },

    onDone(state) {
      const cash = Number(state.cash) / LAMPORTS;
      const coins = roundTripped.size;
      console.error(`steady-scalp done: cash ${cash.toFixed(4)} SOL, round-tripped coins ${coins}`);
      console.error(`stats coreSignals=${stats.coreSignals} coreBuys=${stats.coreBuys} fillerBuys=${stats.fillerBuys} preemptions=${stats.preemptions} pyramidAdds=${stats.pyramidAdds}`);
    },
    },
    { stats },
  );
}
