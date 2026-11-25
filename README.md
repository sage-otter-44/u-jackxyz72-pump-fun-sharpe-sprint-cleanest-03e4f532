[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/sage-otter-44/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/sage-otter-44/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Steady Scalp — Pump.fun Sharpe Sprint

A paper-trading bot for the 6-hour pump.fun forward replay. It wins on steadiness, not
on moonshots: small fixed stakes, many coins, quick exits.

## Strategy

Two tiers sharing one exit/position engine. A 2-slot fill latency kills fast-spike
entries, so the edge lives on multi-minute steady climbs, not seconds-long spikes.

**Tier A — trend core (the profit):** buys curves ≥ 1800 slots old (~6 min) with real SOL
reserve 1.5–80, ≥ 10 trades / ≥ 4 buys / ≥ 5 distinct buyers / ≥ 1 SOL net inflow over
the last 240 slots, accelerating inflow in the newer half (≥ 0.3 SOL in the last 120
slots), no sell by the curve creator, price up 2–60% and within 10% of its window high —
plus a slow-trend filter: over the last 3600 slots the price must be up 10–50% with
≥ 1 SOL net inflow. Stake 0.40 SOL, pyramiding +0.40 while the climb continues (max
0.80 SOL per coin, max 2 entries per coin, 300-slot cooldown after a core exit).
Exits on net value (after curve + tx fees) vs cost: TP ×1.10, SL ×0.96, trailing stop
4% below the peak once the peak cleared ×1.04, fade exit on net outflow < −0.3 SOL per
120 slots, max hold 3600 slots.

**Tier B — reserve filler (the guardrail):** one minimum-size 0.01 SOL shot per coin the
first time its real SOL reserve reaches ≥ 20 SOL (max 80), with non-negative recent net
flow and no creator sell. Its own exits: TP ×1.50, SL ×0.94, trailing 15% below the peak
once the peak cleared ×1.20, max hold 600 slots. It never pyramids. The filler buys only
while at least 3 position slots are free (projected), so it can never crowd out the core;
if a core signal fires for a coin holding a filler position, the core pre-empts it
(sell the filler, buy the core stake in the same reply). Core and filler entries are
counted separately per coin.

**Execution hygiene:** buys are sized 2% under the 1%-of-reserve cap (the bot's view of
the reserve can sit a hair above the harness's after its own fills move it), and a
rejected or failed buy refunds its entry count so the coin can be retried. No leverage,
no shorts; at most 5 open positions.

## Determinism

The bot reads no clock, no environment and no randomness; every decision comes from the
batch stream alone (insertion-ordered maps only), so the two grading runs produce
byte-identical action logs.

## Files

- `main.ts` — thin entrypoint wrapper (run by the grader as `node /bot/main.ts`)
- `strategy.ts` — the whole strategy (`createStrategy` / `DEFAULT_PARAMS`)
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 SDK shim, vendored byte for byte

## License

MIT — see [LICENSE](LICENSE).
