// FloorSnap — Pump.fun Paper Sprint bot (pumpfun-replay/v2).
//
// Strategy (validated in sim/ against the graded sniper: sim -0.445 SOL
// vs graded -0.423 SOL; this strategy sims at +0.116 SOL, 136 fills):
//   Buy a coin only when it is sitting on its floor:
//     - price <= 1.20x its create price,
//     - price >= 50% below the coin's own high (deep drawdown off the top),
//     - age >= 100 slots since creation,
//     - real SOL reserves >= 0.3 SOL (real activity, not a dead curve),
//     - creator has never sold (dev dump = never touch it again).
//   Stake 0.10 SOL per buy, capped at 1% of the coin's real SOL reserves
//   (the harness cap binds first on small curves). Hold to the end of the
//   replay or to completion; rotate out the stalest position (no trade for
//   >= 3000 slots) only when all 5 slots are full; floor-cut sell if the
//   price falls below 0.90x the create price.
//   At most 5 open positions, at most 16 orders per batch. No randomness,
//   no clock, no file reads, no network: fully deterministic, so the two
//   graded executions produce byte-identical action logs.
//
// All price comparisons are exact bigint rational arithmetic (price =
// virtual_quote / virtual_token), so no float rounding can flip a buy,
// a floor-cut, or the candidate ordering on any coin.

import { runBot } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = 100_000_000n; // 0.10 SOL target per buy
const MIN_BUY_LAMPORTS = 2_000_000n; // skip dust-sized capped buys
const MIN_AGE_SLOTS = 100;
const MIN_REAL_QUOTE = 1_000_000_000n; // 1.0 SOL of real reserves
// TWEAK (after graded run 1: -0.032 SOL): raised from 0.3 SOL. The dev
// grade showed 26 of 133 round trips bought below 0.01 SOL — dust buys
// whose 1%-of-real cap binds under the 0.01 SOL round-trip minimum, so
// they pay fees yet never count toward the 20-mint guardrail. With real
// >= 1 SOL the 1% cap is >= 0.01 SOL, so every buy counts. Sim keeps
// the profit: +0.109 SOL / 126 fills vs +0.116 / 136 at 0.3 SOL, while
// deeper-drawdown (dd 0.6: -0.104) and take-profit (any TP: ~-0.14, it
// sells the one runner early) both destroy it in the sim.
const ROTATE_STALE_SLOTS = 3000;
const SLIPPAGE_BPS = 500;

// Entry: price <= 6/5 of create price. Drawdown: price <= high / 2.
// Floor-cut: price < 9/10 of create price.
const ENTRY_NUM = 6n;
const ENTRY_DEN = 5n;
const FLOOR_CUT_NUM = 9n;
const FLOOR_CUT_DEN = 10n;

interface CoinInfo {
  createVq: bigint; // virtual quote reserves at creation
  createVt: bigint; // virtual token reserves at creation
  highVq: bigint; // virtual quote reserves at the highest trade price seen
  highVt: bigint; // virtual token reserves at the highest trade price seen
  hasHigh: boolean;
  lastTradeSlot: number;
  devSold: boolean;
  done: boolean;
}

const info = new Map<string, CoinInfo>();

// Compare price p = pVq / pVt against q = qVq / qVt: -1, 0, or 1.
function cmpPrice(pVq: bigint, pVt: bigint, qVq: bigint, qVt: bigint): number {
  const left = pVq * qVt;
  const right = qVq * pVt;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// price <= base * num / den, with base = bVq / bVt. Exact.
function priceLeMult(vq: bigint, vt: bigint, bVq: bigint, bVt: bigint, num: bigint, den: bigint): boolean {
  return vq * bVt * den <= bVq * num * vt;
}

// price < base * num / den. Exact.
function priceLtMult(vq: bigint, vt: bigint, bVq: bigint, bVt: bigint, num: bigint, den: bigint): boolean {
  return vq * bVt * den < bVq * num * vt;
}

await runBot({
  onBatch(state, batch) {
    // Fold this slot's events into per-coin tracking.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        info.set(e.mint, {
          createVq: BigInt(e.virtual_quote_reserves),
          createVt: BigInt(e.virtual_token_reserves),
          highVq: 0n,
          highVt: 1n,
          hasHigh: false,
          lastTradeSlot: e.slot,
          devSold: false,
          done: false,
        });
      } else if (e.event === 'TradeEvent') {
        let inf = info.get(e.mint);
        if (inf === undefined) {
          inf = {
            createVq: BigInt(e.virtual_quote_reserves),
            createVt: BigInt(e.virtual_token_reserves),
            highVq: 0n,
            highVt: 1n,
            hasHigh: false,
            lastTradeSlot: e.slot,
            devSold: false,
            done: false,
          };
          info.set(e.mint, inf);
        }
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        if (!inf.hasHigh || cmpPrice(vq, vt, inf.highVq, inf.highVt) > 0) {
          inf.highVq = vq;
          inf.highVt = vt;
          inf.hasHigh = true;
        }
        inf.lastTradeSlot = e.slot;
        if (!e.is_buy && e.user === e.creator) {
          inf.devSold = true;
          inf.done = true;
        }
      } else {
        const inf = info.get(e.mint);
        if (inf !== undefined) inf.done = true;
      }
    }

    const orders: { side: 'buy' | 'sell'; mint: string; quote_lamports?: bigint; token_amount?: bigint; max_slippage_bps: number }[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const maxOpen = state.hello.caps.max_open_positions;
    const txFee = state.txFeeLamports();

    const pendingBuys = new Set<string>();
    const pendingSells = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
      else pendingSells.add(p.order.mint);
    }

    let openCount = state.committedPositionCount();
    // Cash left after pending orders fill, minus what this batch queues.
    let freeCash = state.freeCashLamports();

    // Candidates: floor coins, cheapest relative to create price first.
    const cands: { mint: string; vq: bigint; vt: bigint; createVq: bigint; createVt: bigint }[] = [];
    for (const [mint, inf] of info) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || inf.done) continue;
      if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
      if (curve.created_slot === null || state.slot - curve.created_slot < MIN_AGE_SLOTS) continue;
      if (curve.real_quote_reserves < MIN_REAL_QUOTE) continue;
      if (inf.devSold) {
        inf.done = true;
        continue;
      }
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (vt === 0n || vq === 0n) continue;
      if (!priceLeMult(vq, vt, inf.createVq, inf.createVt, ENTRY_NUM, ENTRY_DEN)) continue;
      // Deep drawdown: price <= high / 2 (skip the check before any trade).
      if (inf.hasHigh && cmpPrice(vq, vt, inf.highVq, inf.highVt * 2n) > 0) continue;
      cands.push({ mint, vq, vt, createVq: inf.createVq, createVt: inf.createVt });
    }
    // Cheapest first by price/create; mint string breaks ties deterministically.
    cands.sort(
      (a, b) =>
        cmpPrice(a.vq * a.createVt, a.vt * a.createVq, b.vq * b.createVt, b.vt * b.createVq) ||
        (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0),
    );

    for (const cand of cands) {
      if (orders.length >= maxOrders) break;
      if (openCount >= maxOpen) {
        // Rotate out the stalest dead-at-floor position, if any.
        let worst: string | null = null;
        let worstAge = -1;
        for (const mint of state.positions.keys()) {
          if (pendingSells.has(mint)) continue;
          const inf = info.get(mint);
          if (inf === undefined) continue;
          const age = state.slot - inf.lastTradeSlot;
          if (age > worstAge) {
            worstAge = age;
            worst = mint;
          }
        }
        if (worst !== null && worstAge >= ROTATE_STALE_SLOTS) {
          const pos = state.positions.get(worst);
          if (pos !== undefined) {
            orders.push({ side: 'sell', mint: worst, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
            pendingSells.add(worst);
            freeCash -= txFee;
            const inf = info.get(worst);
            if (inf !== undefined) inf.done = true;
            openCount -= 1;
          }
        } else {
          break;
        }
      }
      const cap = state.maxBuyLamports(cand.mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (freeCash < amount + txFee) continue;
      orders.push({ side: 'buy', mint: cand.mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      pendingBuys.add(cand.mint);
      freeCash -= amount + txFee;
      openCount += 1;
    }

    // Floor-cut exits: price fell below 0.90x create price.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (pendingSells.has(mint)) continue;
      const curve = state.curves.get(mint);
      const inf = info.get(mint);
      if (curve === undefined || curve.complete || inf === undefined) continue;
      if (priceLtMult(curve.virtual_quote_reserves, curve.virtual_token_reserves, inf.createVq, inf.createVt, FLOOR_CUT_NUM, FLOOR_CUT_DEN)) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        pendingSells.add(mint);
        freeCash -= txFee;
        inf.done = true;
      }
    }

    return orders;
  },

  onDone(state) {
    console.error(`FloorSnap done: cash=${state.cash} lamports, positions=${state.positions.size}`);
  },
});
