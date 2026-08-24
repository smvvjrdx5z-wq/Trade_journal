import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSettings } from "../actions";
import { dailyPnl, groupBy } from "@/lib/analytics";
import { localCalendar } from "@/lib/trade-math";
import type { DailyJournal, Trade } from "@/lib/types";
import { fmtSignedMoney, pnlClass } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function JournalListPage() {
  const supabase = await createClient();
  const settings = await getSettings();

  const [{ data: tradeRows }, { data: journalRows }] = await Promise.all([
    supabase.from("trades").select("*"),
    supabase.from("daily_journal").select("*"),
  ]);
  const trades = (tradeRows ?? []) as Trade[];
  const journals = new Map(
    ((journalRows ?? []) as DailyJournal[]).map((j) => [j.journal_date, j])
  );

  const byDay = groupBy(trades, (t) => t.trade_date);
  const pnl = dailyPnl(trades);
  const allDates = [
    ...new Set([...byDay.keys(), ...journals.keys()]),
  ].sort((a, b) => b.localeCompare(a));

  const today = localCalendar(new Date(), settings.timezone).date;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Daily Journal</h1>
        <Link href={`/journal/${today}`} className="btn">
          Open today
        </Link>
      </div>
      <p className="text-sm text-ink2">
        One page per trading day: pre-market plan, post-market review and rule
        check. The stats fill in automatically from your trades.
      </p>

      {allDates.length === 0 && (
        <p className="text-sm text-muted py-8 text-center card">
          Nothing here yet — open today&apos;s page and write your plan.
        </p>
      )}

      <div className="space-y-2">
        {allDates.map((date) => {
          const dayTrades = byDay.get(date) ?? [];
          const journal = journals.get(date);
          const dayPnl = pnl.get(date) ?? 0;
          const winners = dayTrades.filter((t) => t.outcome === "Win").length;
          return (
            <Link
              key={date}
              href={`/journal/${date}`}
              className="card flex items-center gap-4 hover:border-accent"
            >
              <span className="font-medium w-28">{date}</span>
              <span className="text-sm text-ink2 w-28">
                {dayTrades.length} trade{dayTrades.length === 1 ? "" : "s"}
              </span>
              <span className="text-sm text-ink2 w-24">
                {dayTrades.length ? `${winners}W ${dayTrades.filter((t) => t.outcome === "Loss").length}L` : ""}
              </span>
              <span className={`text-sm font-medium tabular-nums ${pnlClass(dayPnl)}`}>
                {dayTrades.length ? fmtSignedMoney(dayPnl) : ""}
              </span>
              <span className="ml-auto flex gap-1.5">
                {journal?.bias && <span className="chip">planned</span>}
                {journal?.reviewed ? (
                  <span className="chip text-pos border-pos/40">reviewed ✓</span>
                ) : (
                  <span className="chip">unreviewed</span>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
