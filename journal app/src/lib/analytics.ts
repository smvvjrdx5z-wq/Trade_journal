// Performance analytics: TradeZella-equivalent metrics and the composite score.
//
// A TypeScript port of bridge/src/tradejournal/analytics.py — same weights,
// same scoring bands, same interpolation refinements. Where the two disagree,
// the Python module (and docs/METRICS.md) is the source of truth.

import type { Trade } from "./types";

export const WEIGHTS = {
  profitFactor: 0.25,
  avgWinLoss: 0.2,
  maxDrawdown: 0.2,
  winRate: 0.15,
  recoveryFactor: 0.1,
  consistency: 0.1,
} as const;

// [lower_bound, upper_bound, score_at_lower, score_at_upper]
type Band = readonly [number, number, number, number];

const RATIO_BANDS: readonly Band[] = [
  [0.0, 1.0, 0.0, 20.0], // refinement: losing systems should not tie 1.7
  [1.0, 1.8, 20.0, 20.0], // TradeZella: "below 1.8 = 20"
  [1.8, 1.9, 50.0, 59.0],
  [1.9, 2.0, 60.0, 69.0],
  [2.0, 2.2, 70.0, 79.0],
  [2.2, 2.4, 80.0, 89.0],
  [2.4, 2.6, 90.0, 99.0],
];

const RECOVERY_BANDS: readonly Band[] = [
  [0.0, 1.0, 0.0, 0.0], // TradeZella: "below 1.0 = 0"
  [1.0, 2.0, 0.0, 50.0], // interpolated; undocumented upstream
  [2.0, 2.5, 50.0, 59.0],
  [2.5, 3.0, 60.0, 69.0],
  [3.0, 3.5, 70.0, 89.0],
];

const WIN_RATE_TOP_THRESHOLD = 60.0;

function clamp(value: number, low = 0, high = 100): number {
  return Math.max(low, Math.min(high, value));
}

function banded(value: number, bands: readonly Band[]): number {
  if (value <= bands[0][0]) return bands[0][2];
  for (const [low, high, scoreLow, scoreHigh] of bands) {
    if (low <= value && value < high) {
      if (high === low) return scoreHigh;
      const ratio = (value - low) / (high - low);
      return scoreLow + ratio * (scoreHigh - scoreLow);
    }
  }
  return 100.0;
}

export function scoreProfitFactor(profitFactor: number | null): number {
  if (profitFactor === null) return 0;
  return clamp(banded(profitFactor, RATIO_BANDS));
}

export function scoreAvgWinLoss(ratio: number | null): number {
  if (ratio === null) return 0;
  return clamp(banded(ratio, RATIO_BANDS));
}

export function scoreRecoveryFactor(recovery: number | null): number {
  if (recovery === null) return 0;
  return clamp(banded(recovery, RECOVERY_BANDS));
}

export function scoreWinRate(winRatePct: number): number {
  return clamp((winRatePct / WIN_RATE_TOP_THRESHOLD) * 100.0);
}

export function scoreMaxDrawdown(drawdownPct: number): number {
  return clamp(100.0 - drawdownPct);
}

function fmean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pstdev(values: number[]): number {
  const mean = fmean(values);
  return Math.sqrt(fmean(values.map((v) => (v - mean) ** 2)));
}

export function scoreConsistency(dailyPnl: number[]): number {
  if (dailyPnl.length < 2) return 0;
  const mean = fmean(dailyPnl);
  if (mean <= 0) return 0;
  return clamp(100.0 - (pstdev(dailyPnl) / mean) * 100.0);
}

export interface Metrics {
  tradeCount: number;
  winners: number;
  losers: number;
  breakeven: number;

  netPl: number;
  grossProfit: number;
  grossLoss: number;
  costs: number;

  profitFactor: number | null;
  winRate: number;
  dayWinRate: number;
  avgWin: number;
  avgLoss: number;
  avgWinLoss: number | null;
  expectancy: number;
  expectancyR: number | null;
  totalR: number;
  avgR: number | null;

  maxDrawdown: number;
  maxDrawdownPct: number;
  avgDrawdown: number;
  recoveryFactor: number | null;
  consistency: number;

  largestWin: number;
  largestLoss: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  currentStreak: number;

  avgHoldMinutes: number;
  loggedDays: number;
  longs: number;
  shorts: number;
  longWinRate: number;
  shortWinRate: number;
  avgVolume: number;

  zellaScore: number;
  scoreProfitFactor: number;
  scoreAvgWinLoss: number;
  scoreMaxDrawdown: number;
  scoreWinRate: number;
  scoreRecoveryFactor: number;
  scoreConsistency: number;

  sampleWarning: boolean;
  periodStart: string | null;
  periodEnd: string | null;
}

function emptyMetrics(): Metrics {
  return {
    tradeCount: 0,
    winners: 0,
    losers: 0,
    breakeven: 0,
    netPl: 0,
    grossProfit: 0,
    grossLoss: 0,
    costs: 0,
    profitFactor: null,
    winRate: 0,
    dayWinRate: 0,
    avgWin: 0,
    avgLoss: 0,
    avgWinLoss: null,
    expectancy: 0,
    expectancyR: null,
    totalR: 0,
    avgR: null,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    avgDrawdown: 0,
    recoveryFactor: null,
    consistency: 0,
    largestWin: 0,
    largestLoss: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    currentStreak: 0,
    avgHoldMinutes: 0,
    loggedDays: 0,
    longs: 0,
    shorts: 0,
    longWinRate: 0,
    shortWinRate: 0,
    avgVolume: 0,
    zellaScore: 0,
    scoreProfitFactor: 0,
    scoreAvgWinLoss: 0,
    scoreMaxDrawdown: 0,
    scoreWinRate: 0,
    scoreRecoveryFactor: 0,
    scoreConsistency: 0,
    sampleWarning: true,
    periodStart: null,
    periodEnd: null,
  };
}

function tradeCosts(t: Trade): number {
  return t.commission + t.swap + t.fee;
}

/** Net P&L per trading day, keyed on the trade's local calendar date. */
export function dailyPnl(trades: Trade[]): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const t of trades) {
    buckets.set(t.trade_date, (buckets.get(t.trade_date) ?? 0) + t.net_pl);
  }
  return buckets;
}

/**
 * Max drawdown (currency), max drawdown %, average drawdown.
 * Built from closed-trade equity, ordered by close time — what TradeZella
 * charts. Intraday float is not modelled.
 */
export function drawdownSeries(
  trades: Trade[],
  startingBalance: number
): [number, number, number] {
  if (!trades.length) return [0, 0, 0];

  const ordered = [...trades].sort((a, b) =>
    a.close_time.localeCompare(b.close_time)
  );
  let equity = startingBalance > 0 ? startingBalance : 0;
  let peak = equity;
  let maxDd = 0;
  let maxDdPct = 0;
  const observations: number[] = [];

  for (const trade of ordered) {
    equity += trade.net_pl;
    peak = Math.max(peak, equity);
    const drop = peak - equity;
    observations.push(drop);
    if (drop > maxDd) maxDd = drop;
    if (peak > 0) {
      const pct = (drop / peak) * 100.0;
      if (pct > maxDdPct) maxDdPct = pct;
    }
  }

  const active = observations.filter((d) => d > 0);
  const avgDd = active.length ? fmean(active) : 0;
  return [maxDd, maxDdPct, avgDd];
}

function streaks(outcomes: string[]): [number, number, number] {
  let maxWin = 0,
    maxLoss = 0,
    runWin = 0,
    runLoss = 0;
  for (const outcome of outcomes) {
    if (outcome === "Win") {
      runWin += 1;
      runLoss = 0;
      maxWin = Math.max(maxWin, runWin);
    } else if (outcome === "Loss") {
      runLoss += 1;
      runWin = 0;
      maxLoss = Math.max(maxLoss, runLoss);
    } else {
      runWin = runLoss = 0;
    }
  }
  const current = runWin ? runWin : runLoss ? -runLoss : 0;
  return [maxWin, maxLoss, current];
}

/** Aggregate a set of trades into the full metric suite. */
export function compute(
  trades: Trade[],
  startingBalance = 0,
  minSampleSize = 20
): Metrics {
  const m = emptyMetrics();
  if (!trades.length) return m;

  const ordered = [...trades].sort((a, b) =>
    a.close_time.localeCompare(b.close_time)
  );
  m.tradeCount = ordered.length;
  m.periodStart = ordered[0].trade_date;
  m.periodEnd = ordered[ordered.length - 1].trade_date;
  m.sampleWarning = ordered.length < minSampleSize;

  const wins = ordered.filter((t) => t.outcome === "Win");
  const losses = ordered.filter((t) => t.outcome === "Loss");
  m.winners = wins.length;
  m.losers = losses.length;
  m.breakeven = m.tradeCount - m.winners - m.losers;

  m.netPl = ordered.reduce((a, t) => a + t.net_pl, 0);
  m.grossProfit = wins.reduce((a, t) => a + t.net_pl, 0);
  m.grossLoss = Math.abs(losses.reduce((a, t) => a + t.net_pl, 0));
  m.costs = ordered.reduce((a, t) => a + tradeCosts(t), 0);

  m.profitFactor = m.grossLoss > 0 ? m.grossProfit / m.grossLoss : null;
  m.winRate = (m.winners / m.tradeCount) * 100.0;
  m.avgWin = wins.length ? fmean(wins.map((t) => t.net_pl)) : 0;
  m.avgLoss = losses.length ? Math.abs(fmean(losses.map((t) => t.net_pl))) : 0;
  m.avgWinLoss = m.avgLoss > 0 ? m.avgWin / m.avgLoss : null;

  // Expectancy: (win rate x avg win) - (loss rate x avg loss)
  const winFrac = m.winners / m.tradeCount;
  const lossFrac = m.losers / m.tradeCount;
  m.expectancy = winFrac * m.avgWin - lossFrac * m.avgLoss;

  const rValues = ordered
    .map((t) => t.realized_r)
    .filter((r): r is number => r !== null && r !== undefined);
  if (rValues.length) {
    m.totalR = rValues.reduce((a, b) => a + b, 0);
    m.avgR = fmean(rValues);
    m.expectancyR = m.avgR;
  }

  m.largestWin = Math.max(...ordered.map((t) => t.net_pl), 0);
  m.largestLoss = Math.min(...ordered.map((t) => t.net_pl), 0);
  m.avgHoldMinutes = fmean(ordered.map((t) => t.duration_minutes));
  m.avgVolume = fmean(ordered.map((t) => t.volume));

  const longs = ordered.filter((t) => t.direction === "Long");
  const shorts = ordered.filter((t) => t.direction === "Short");
  m.longs = longs.length;
  m.shorts = shorts.length;
  if (longs.length) {
    m.longWinRate =
      (longs.filter((t) => t.outcome === "Win").length / longs.length) * 100.0;
  }
  if (shorts.length) {
    m.shortWinRate =
      (shorts.filter((t) => t.outcome === "Win").length / shorts.length) *
      100.0;
  }

  const days = dailyPnl(ordered);
  m.loggedDays = days.size;
  if (days.size) {
    const winningDays = [...days.values()].filter((pnl) => pnl > 0).length;
    m.dayWinRate = (winningDays / days.size) * 100.0;
  }

  [m.maxDrawdown, m.maxDrawdownPct, m.avgDrawdown] = drawdownSeries(
    ordered,
    startingBalance
  );
  m.recoveryFactor = m.maxDrawdown > 0 ? m.netPl / m.maxDrawdown : null;

  const dailyValues = [...days.keys()].sort().map((k) => days.get(k)!);
  m.consistency = scoreConsistency(dailyValues);

  [m.maxConsecutiveWins, m.maxConsecutiveLosses, m.currentStreak] = streaks(
    ordered.map((t) => t.outcome)
  );

  // --- Composite score ----------------------------------------------------
  m.scoreProfitFactor = scoreProfitFactor(m.profitFactor);
  m.scoreAvgWinLoss = scoreAvgWinLoss(m.avgWinLoss);
  m.scoreMaxDrawdown = scoreMaxDrawdown(m.maxDrawdownPct);
  m.scoreWinRate = scoreWinRate(m.winRate);
  m.scoreRecoveryFactor = scoreRecoveryFactor(m.recoveryFactor);
  m.scoreConsistency = m.consistency;

  m.zellaScore =
    Math.round(
      (m.scoreProfitFactor * WEIGHTS.profitFactor +
        m.scoreAvgWinLoss * WEIGHTS.avgWinLoss +
        m.scoreMaxDrawdown * WEIGHTS.maxDrawdown +
        m.scoreWinRate * WEIGHTS.winRate +
        m.scoreRecoveryFactor * WEIGHTS.recoveryFactor +
        m.scoreConsistency * WEIGHTS.consistency) *
        10
    ) / 10;

  return m;
}

/** Bucket trades by an arbitrary key function, skipping empty keys. */
export function groupBy(
  trades: Trade[],
  key: (t: Trade) => string | null | undefined
): Map<string, Trade[]> {
  const out = new Map<string, Trade[]>();
  for (const trade of trades) {
    const value = key(trade);
    if (value === null || value === undefined || value === "") continue;
    const bucket = out.get(value) ?? [];
    bucket.push(trade);
    out.set(value, bucket);
  }
  return out;
}

/** Closed-trade equity curve points, ordered by close time. */
export function equityCurve(
  trades: Trade[],
  startingBalance = 0
): { time: string; equity: number }[] {
  const ordered = [...trades].sort((a, b) =>
    a.close_time.localeCompare(b.close_time)
  );
  let equity = startingBalance;
  return ordered.map((t) => {
    equity += t.net_pl;
    return { time: t.close_time, equity };
  });
}
