[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/adivadena1/tiny-bot-sol/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/adivadena1/tiny-bot-sol/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

# Panic Catcher — Tiny SOL Bot

A paper-trading bot for the [make.fun "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana" bounty](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1). It trades 7 Solana assets (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF) on hourly bars with $10,000 of paper USDC.

## Strategy

The dev window is a grinding downtrend with sharp panic drops and partial bounces — every asset ends 3–14% down, and buy-and-hold loses $869. Momentum chasing and EMA crossovers both lose money there: they buy the chop and pay ~44 bps a round trip. So this bot catches the panic itself instead:

- **Entry:** buy an asset only after it falls 4% from its own 24-hour high, deepest drop first, at most 6 positions, 12.5% of equity per tranche.
- **Second tranche:** if it falls another 4% from the first entry, average in once (entry becomes the mean of the two closes).
- **Exit:** take the bounce at +2% over entry, or a chandelier trailing stop (highest close since entry minus 2.5× ATR(12)) if the panic keeps falling, or after 36 bars if the bounce never comes.
- **Otherwise it sits in USDC.** Long-only, no leverage, never more than 25% of equity in one asset.

## Dev-window result

Graded locally against the kit's 136-bar dev window (`grade-local`):

| | |
|---|---|
| Net PnL | **+$197.02** |
| Trades | 56 |
| Max drawdown | 1.77% |
| 90% interval | +$70.52 .. +$330.29 |
| Win rate | 53.6% (30/56) |
| Walk-forward 72-bar folds | median +$99, 6/9 positive, worst −$148 |
| At 2× fees | +$125 (still positive) |

For comparison on the same window: buy-and-hold −$869.34, momentum rotation −$675, EMA crossover −$1,101. The dev pay zone (3rd place) is +$564 — this bot does not reach it on dev, and the final window is a fresh 3-day draw, so this is a positive-expectancy ticket, not a lock.

## How to run

The grader runs `node /bot/main.ts` (Node 22, type stripping). The bot speaks `agent-fun/bars-replay/v1` over NDJSON stdin/stdout through the vendored SDK shim (`vendor/makefun-bars.ts`, a byte-identical copy of the kit's `sdk/makefun-bars.ts`). No dependencies, no network, no clock, no randomness — fully deterministic.

## Files

- `main.ts` — the bot (strategy + wire loop via the shim).
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte-for-byte.
- `README.md` — this file.
- `LICENSE` — MIT.
