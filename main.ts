// Panic Catcher — a tiny paper-trading bot for the make.fun bounty
// "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana".
//
// Strategy (chosen head-to-head against two other families — momentum rotation
// and EMA crossover — on a faithful offline replica of the harness fill model,
// then validated on walk-forward 72-bar folds of the dev window):
//
//   The dev window is a grinding downtrend with sharp panic drops and partial
//   bounces (every asset ends -3% to -14%; buy-and-hold loses $869). Chasing
//   momentum and EMA crossovers both lose money there — they buy the chop and
//   pay ~44 bps a round trip. What works, modestly but robustly, is catching
//   the panic itself: buy an asset only after it has fallen 4% from its own
//   24-hour high, take the bounce at +2%, and let a chandelier trailing stop
//   (highest close since entry minus 2.5x ATR) cut the trade if the panic
//   keeps falling. A second tranche averages in if the asset falls another 4%
//   from the first entry.
//
// Rules, per symbol, on each hourly close (fills land at the next bar's open):
//   - Entry: close <= max(close[-24:]) * 0.96, deepest drop first, at most
//     6 positions, 12.5% of equity per tranche.
//   - Second tranche: once per position, when close <= entry * 0.96; the new
//     entry becomes the mean of the two entry closes.
//   - Exit (whole position): close >= entry * 1.02 (take the bounce), or
//     close <= peak * (1 - 2.5 * ATR(12)) (chandelier stop), or the position
//     is 36 bars old (stale — the bounce never came).
//   - Otherwise the bot sits in USDC. It never shorts, never uses leverage,
//     never holds more than 25% of equity in one asset (the harness cap).
//
// Dev-window numbers (local grade, kit dataset, 136 hourly bars x 7 assets):
//   Net PnL +$197.02, 56 trades, max drawdown 1.77%, fees $71.46,
//   90% interval +$70.52 .. +$330.29, win rate 53.6%, exposure 20.6%.
//   Walk-forward 72-bar folds (the final window is 72 bars): median +$99,
//   6 of 9 folds positive, worst fold -$148. Still positive at 2x fees (+$125).
//   For comparison on the same window: buy-and-hold -$869.34, momentum
//   rotation -$675, EMA crossover -$1,101. The dev pay zone (3rd place) is
//   +$564 — this bot does NOT reach it on dev; the final window is a fresh
//   3-day draw, so this entry is a positive-expectancy ticket, not a lock.
//
// Determinism: no clock, no environment, no randomness, no network. All
// decisions are pure functions of the closes the harness has sent so far
// (float64, IEEE 754, same bars -> same orders). Reply order: sells first,
// then second-tranche buys, then new entries, in universe order.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Buy only after a 4% fall from the 24-bar high. */
const DROP_BPS = 400;
/** Take the bounce at +2% over the (possibly averaged) entry. */
const TP_BPS = 200;
/** Chandelier trailing stop: peak minus this many ATRs. */
const TRAIL_ATR = 2.5;
/** ATR window, in bars. */
const ATR_BARS = 12;
/** Lookback for the panic high, in bars. */
const HIGH_BARS = 24;
/** A position that never bounces is closed after this many bars. */
const HOLD_MAX_BARS = 36;
/** 12.5% of equity per tranche. */
const TRANCHE_BPS = 1250;
/** Never more than this many open positions. */
const MAX_POSITIONS = 6;
/** Slippage left wide open, like the house buy-and-hold baseline: the fill
 *  model (fee + slippage + pool impact) is what prices a trade, and a 1-bar
 *  open/close gap is ~0.2%, far inside any cap that would bind. */
const MAX_SLIPPAGE_BPS = 10_000;

interface Held {
  /** Entry close (mean of the two tranche entries once averaged). */
  entry: number;
  /** Highest close seen since entry. */
  peak: number;
  /** 1 or 2 tranches bought. */
  tranche: number;
  /** Bars held. */
  age: number;
}

const closes = new Map<string, number[]>();
const held = new Map<string, Held>();

function atr(hist: number[]): number {
  const start = Math.max(1, hist.length - ATR_BARS);
  let sum = 0;
  let n = 0;
  for (let k = start; k < hist.length; k++) {
    sum += Math.abs(Math.log(hist[k] / hist[k - 1]));
    n++;
  }
  return n > 0 ? sum / n : 0.01;
}

function pushCloses(state: BarsState): void {
  for (const s of state.hello.symbols) {
    const c = state.close(s.symbol);
    if (c === null) continue;
    let hist = closes.get(s.symbol);
    if (hist === undefined) {
      hist = [];
      closes.set(s.symbol, hist);
    }
    hist.push(Number(c));
  }
}

/** The most a buy of `notional` may spend under the engine's decision checks:
 *  cash this reply has not spent yet, and the 25% weight cap room. */
function admissible(
  state: BarsState,
  sym: string,
  notional: bigint,
  cashLeft: bigint,
  bought: Map<string, bigint>,
): boolean {
  if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return false;
  if (notional > cashLeft) return false;
  const heldQty = state.positions.get(sym)?.qty ?? 0n;
  const room = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / 10_000n
    - state.value(sym, heldQty)
    - (bought.get(sym) ?? 0n);
  return notional <= room;
}

await runBars({
  onBatch(state) {
    if (state.warmingUp) return [];
    pushCloses(state);
    // Reconcile: a buy the market refused at its fill leaves a `held` entry
    // with no live position behind it. Drop those before deciding, so a
    // later entry for the same symbol always starts from a clean slate.
    for (const sym of held.keys()) {
      if (!state.positions.has(sym)) held.delete(sym);
    }

    const orders: Array<BuyInput | SellInput> = [];
    let cashLeft = state.cash;
    const bought = new Map<string, bigint>();

    // --- exits (sells first) + second-tranche buys, in position order ---
    for (const [sym, pos] of state.positions) {
      const hist = closes.get(sym);
      const h = held.get(sym);
      if (hist === undefined || hist.length === 0 || h === undefined) continue;
      const close = hist[hist.length - 1];
      h.age += 1;
      if (close > h.peak) h.peak = close;
      const chandelier = h.peak * (1 - TRAIL_ATR * atr(hist));
      if (
        close >= h.entry * (1 + TP_BPS / 10_000) ||
        close <= chandelier ||
        h.age >= HOLD_MAX_BARS
      ) {
        orders.push({ side: 'sell', symbol: sym, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        held.delete(sym);
        continue;
      }
      // Second tranche: one more buy if it fell another DROP_BPS from entry.
      if (h.tranche === 1 && close <= h.entry * (1 - DROP_BPS / 10_000)) {
        const amt = (BigInt(TRANCHE_BPS) * state.equity) / 10_000n;
        const notional = amt < state.cash ? amt : state.cash;
        if (admissible(state, sym, notional, cashLeft, bought)) {
          orders.push({ side: 'buy', symbol: sym, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
          cashLeft -= notional;
          bought.set(sym, (bought.get(sym) ?? 0n) + notional);
          h.entry = (h.entry + close) / 2;
          h.tranche = 2;
        }
      }
    }

    // --- new entries: deepest panic first ---
    const openSlots = MAX_POSITIONS - state.positions.size;
    if (openSlots > 0) {
      const cands: Array<{ drop: number; sym: string }> = [];
      for (const s of state.hello.symbols) {
        const sym = s.symbol;
        if (state.positions.has(sym)) continue;
        const hist = closes.get(sym);
        if (hist === undefined || hist.length < HIGH_BARS + 1) continue;
        const hi = Math.max(...hist.slice(-HIGH_BARS));
        const close = hist[hist.length - 1];
        if (close <= hi * (1 - DROP_BPS / 10_000)) {
          cands.push({ drop: close / hi, sym });
        }
      }
      cands.sort((a, b) => a.drop - b.drop);
      for (const { sym } of cands.slice(0, openSlots)) {
        const amt = (BigInt(TRANCHE_BPS) * state.equity) / 10_000n;
        const notional = amt < state.cash ? amt : state.cash;
        if (!admissible(state, sym, notional, cashLeft, bought)) continue;
        cashLeft -= notional;
        bought.set(sym, (bought.get(sym) ?? 0n) + notional);
        orders.push({ side: 'buy', symbol: sym, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
        const hist = closes.get(sym)!;
        const close = hist[hist.length - 1];
        held.set(sym, { entry: close, peak: close, tranche: 1, age: 0 });
      }
    }
    return orders;
  },
});
