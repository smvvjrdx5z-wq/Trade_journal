// Trade enrichment: the write-time derivations models.py performs in the
// Python bridge — session, outcome, calendar fields, risk and R-multiples.

import type { Direction, Outcome } from "./types";

// Session windows in UTC, expressed as [start_hour, end_hour). A window whose
// start is greater than its end wraps around midnight.
export const DEFAULT_SESSIONS: Record<string, [number, number]> = {
  Asia: [23, 7],
  London: [7, 12],
  "New York": [12, 16],
  "London Close": [16, 20],
  "Off Hours": [20, 23],
};

export const SESSION_ORDER = [
  "Asia",
  "London",
  "New York",
  "London Close",
  "Off Hours",
];

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** Map a UTC timestamp to a named trading session. */
export function classifySession(when: Date): string {
  const hour = when.getUTCHours();
  for (const [name, [start, end]] of Object.entries(DEFAULT_SESSIONS)) {
    if (start <= end) {
      if (start <= hour && hour < end) return name;
    } else if (hour >= start || hour < end) {
      return name;
    }
  }
  return "Off Hours";
}

/** Calendar date (YYYY-MM-DD), weekday name and hour of `when` in `timeZone`. */
export function localCalendar(
  when: Date,
  timeZone: string
): { date: string; dayOfWeek: string; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      weekday: "long",
    }).formatToParts(when);
  } catch {
    // Unknown zone name: fall back to UTC rather than failing the write.
    return localCalendar(when, "UTC");
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    dayOfWeek: get("weekday"),
    hour: Number(get("hour")) % 24,
  };
}

/** Convert an absolute price distance into account currency. */
export function priceToMoney(
  priceDelta: number,
  tickSize: number | null,
  tickValue: number | null,
  volume: number
): number {
  if (!tickSize || !tickValue || tickSize <= 0 || tickValue <= 0) return 0;
  return (Math.abs(priceDelta) / tickSize) * tickValue * volume;
}

export interface EnrichInput {
  direction: Direction;
  volume: number;
  open_time: Date;
  close_time: Date;
  entry_price: number;
  exit_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  net_pl: number;
  tick_size: number | null;
  tick_value: number | null;
  /** Explicit money risked; used when tick data is absent (manual entries). */
  manual_risk_amount?: number | null;
}

export interface EnrichSettings {
  timezone: string;
  breakeven_threshold: number;
  default_risk_pct: number;
  balance_at_open?: number | null;
}

export interface Enriched {
  outcome: Outcome;
  session: string;
  trade_date: string;
  day_of_week: string;
  hour: number;
  duration_minutes: number;
  risk_amount: number | null;
  risk_is_estimated: boolean;
  planned_r: number | null;
  realized_r: number | null;
  return_pct: number | null;
}

/** Compute R-multiples, outcome, session and calendar fields — models.py enrich(). */
export function enrichTrade(t: EnrichInput, s: EnrichSettings): Enriched {
  const local = localCalendar(t.open_time, s.timezone);
  const session = classifySession(t.open_time);
  const durationMinutes = Math.max(
    0,
    (t.close_time.getTime() - t.open_time.getTime()) / 60000
  );

  let outcome: Outcome = "Breakeven";
  if (t.net_pl > s.breakeven_threshold) outcome = "Win";
  else if (t.net_pl < -s.breakeven_threshold) outcome = "Loss";

  // Initial risk: distance from entry to the original stop, in money.
  let riskAmount = 0;
  let riskIsEstimated = false;
  const stop = t.stop_loss ?? 0;
  const target = t.take_profit ?? 0;

  if (stop > 0 && t.entry_price > 0 && t.tick_size && t.tick_value) {
    riskAmount = priceToMoney(
      t.entry_price - stop,
      t.tick_size,
      t.tick_value,
      t.volume
    );
  } else if (t.manual_risk_amount && t.manual_risk_amount > 0) {
    riskAmount = t.manual_risk_amount;
  } else if (s.balance_at_open) {
    // No stop was attached. Fall back to the configured risk budget so
    // R-multiples stay comparable, and flag it as an estimate.
    riskAmount = Math.abs(s.balance_at_open) * s.default_risk_pct;
    riskIsEstimated = true;
  } else {
    riskAmount = 0;
    riskIsEstimated = true;
  }

  const realizedR = riskAmount > 0 ? t.net_pl / riskAmount : null;

  let plannedR: number | null = null;
  if (stop > 0 && target > 0 && t.entry_price > 0) {
    const riskDist = Math.abs(t.entry_price - stop);
    const rewardDist = Math.abs(target - t.entry_price);
    plannedR = riskDist > 0 ? rewardDist / riskDist : null;
  }

  const returnPct = s.balance_at_open ? t.net_pl / s.balance_at_open : null;

  return {
    outcome,
    session,
    trade_date: local.date,
    day_of_week: local.dayOfWeek,
    hour: local.hour,
    duration_minutes: durationMinutes,
    risk_amount: riskAmount > 0 ? riskAmount : null,
    risk_is_estimated: riskIsEstimated,
    planned_r: plannedR,
    realized_r: realizedR,
    return_pct: returnPct,
  };
}
