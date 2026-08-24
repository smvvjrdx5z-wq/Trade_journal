import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSettings, saveDailyJournal } from "../../actions";
import { compute } from "@/lib/analytics";
import type { DailyJournal, Trade } from "@/lib/types";
import { fmtMoney, fmtPct, fmtR, fmtSignedMoney, pnlClass } from "@/lib/format";
import { StatTile } from "@/components/stat-tile";
import { TradeTable } from "@/components/trade-table";

export const dynamic = "force-dynamic";

function Check({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink2">
      <input type="checkbox" name={name} defaultChecked={checked} />
      {label}
    </label>
  );
}

export default async function JournalDayPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const supabase = await createClient();
  const settings = await getSettings();

  const [{ data: tradeRows }, { data: journalRow }] = await Promise.all([
    supabase
      .from("trades")
      .select("*")
      .eq("trade_date", date)
      .order("close_time"),
    supabase
      .from("daily_journal")
      .select("*")
      .eq("journal_date", date)
      .maybeSingle(),
  ]);
  const trades = (tradeRows ?? []) as Trade[];
  const journal = (journalRow ?? null) as DailyJournal | null;
  const m = compute(trades, 0, settings.min_sample_size);

  const dayResult =
    m.netPl > settings.breakeven_threshold
      ? "Win"
      : m.netPl < -settings.breakeven_threshold
        ? "Loss"
        : "Breakeven";

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-xl font-semibold">
        {date}
        {trades.length > 0 && (
          <span className={`ml-3 text-base font-medium ${pnlClass(m.netPl)}`}>
            {fmtSignedMoney(m.netPl)} · {dayResult} day
          </span>
        )}
      </h1>

      {trades.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatTile label="Trades" value={String(m.tradeCount)} sub={`${m.winners}W · ${m.losers}L · ${m.breakeven}BE`} />
          <StatTile label="Win rate" value={fmtPct(m.winRate)} />
          <StatTile label="Total R" value={fmtR(m.totalR)} tone={m.totalR > 0 ? "pos" : m.totalR < 0 ? "neg" : null} />
          <StatTile label="Best trade" value={fmtMoney(m.largestWin)} tone="pos" />
          <StatTile label="Worst trade" value={fmtMoney(m.largestLoss)} tone={m.largestLoss < 0 ? "neg" : null} />
        </div>
      )}

      <form action={saveDailyJournal} className="card space-y-5">
        <input type="hidden" name="journal_date" value={date} />
        <p className="text-sm text-ink2 rounded-md bg-page border border-line px-3 py-2">
          🗓️ Fill the pre-market section before your first trade. Come back
          after the close for the review — the stats above fill in
          automatically.
        </p>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Pre-market plan</h2>
          <Check name="checked_calendar" label="Checked the economic calendar for high-impact news" checked={journal?.checked_calendar ?? false} />
          <Check name="marked_levels" label="Marked key levels on the H4 and daily" checked={journal?.marked_levels ?? false} />
          <Check name="chose_playbooks" label="Decided which playbooks are in play today" checked={journal?.chose_playbooks ?? false} />
          <Check name="set_loss_limit" label="Set a maximum loss for the day and a maximum number of trades" checked={journal?.set_loss_limit ?? false} />
          <div>
            <label className="label mt-2">Bias and reasoning</label>
            <textarea name="bias" rows={3} className="input" defaultValue={journal?.bias ?? ""} />
          </div>
        </section>

        <section className="space-y-3 border-t border-line pt-4">
          <h2 className="text-sm font-semibold">Post-market review</h2>
          <div>
            <label className="label">What went well</label>
            <textarea name="went_well" rows={2} className="input" defaultValue={journal?.went_well ?? ""} />
          </div>
          <div>
            <label className="label">What went badly</label>
            <textarea name="went_badly" rows={2} className="input" defaultValue={journal?.went_badly ?? ""} />
          </div>
          <div>
            <label className="label">The one thing to do differently tomorrow</label>
            <textarea name="do_differently" rows={2} className="input" defaultValue={journal?.do_differently ?? ""} />
          </div>
        </section>

        <section className="space-y-2 border-t border-line pt-4">
          <h2 className="text-sm font-semibold">Rule check</h2>
          <Check name="all_from_playbook" label="Every trade came from a playbook" checked={journal?.all_from_playbook ?? false} />
          <Check name="risk_respected" label="No position exceeded the planned risk" checked={journal?.risk_respected ?? false} />
          <Check name="stopped_at_limit" label="Stopped trading at the daily loss limit" checked={journal?.stopped_at_limit ?? false} />
          <Check name="no_revenge" label="No revenge trades" checked={journal?.no_revenge ?? false} />
        </section>

        <div className="flex items-center gap-4 border-t border-line pt-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" name="reviewed" defaultChecked={journal?.reviewed ?? false} />
            Day reviewed
          </label>
          <button className="btn">Save journal</button>
        </div>
      </form>

      <div className="card">
        <h2 className="text-sm font-medium text-ink2 mb-3">Trades this day</h2>
        <TradeTable trades={trades} timezone={settings.timezone} />
      </div>
    </div>
  );
}
