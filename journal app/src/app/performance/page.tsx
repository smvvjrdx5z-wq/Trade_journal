import { createClient } from "@/lib/supabase/server";
import { getSettings } from "../actions";
import { compute, groupBy, type Metrics } from "@/lib/analytics";
import { SESSION_ORDER, WEEKDAYS } from "@/lib/trade-math";
import type { Playbook, Tag, Trade } from "@/lib/types";
import { fmtMoney, fmtNum, fmtPct, fmtR, fmtSignedMoney, pnlClass } from "@/lib/format";

export const dynamic = "force-dynamic";

interface ScopeRow {
  label: string;
  metrics: Metrics;
}

function ScopeTable({
  title,
  rows,
  note,
}: {
  title: string;
  rows: ScopeRow[];
  note?: string;
}) {
  if (!rows.length) return null;
  return (
    <div className="card">
      <h2 className="text-sm font-medium text-ink2 mb-1">{title}</h2>
      {note && <p className="text-xs text-muted mb-2">{note}</p>}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th className="th">Scope</th>
              <th className="th text-right">Trades</th>
              <th className="th text-right">Net P&L</th>
              <th className="th text-right">Win %</th>
              <th className="th text-right">Profit Factor</th>
              <th className="th text-right">Expectancy</th>
              <th className="th text-right">Avg R</th>
              <th className="th text-right">Max DD</th>
              <th className="th text-right">Zella</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, metrics: m }) => (
              <tr key={label} className="border-b border-line">
                <td className="td font-medium">{label}</td>
                <td className="td text-right tabular-nums">{m.tradeCount}</td>
                <td className={`td text-right tabular-nums ${pnlClass(m.netPl)}`}>
                  {fmtSignedMoney(m.netPl)}
                </td>
                <td className="td text-right tabular-nums">{fmtPct(m.winRate)}</td>
                <td className="td text-right tabular-nums">{fmtNum(m.profitFactor)}</td>
                <td className={`td text-right tabular-nums ${pnlClass(m.expectancy)}`}>
                  {fmtMoney(m.expectancy)}
                </td>
                <td className={`td text-right tabular-nums ${pnlClass(m.avgR)}`}>
                  {fmtR(m.avgR)}
                </td>
                <td className="td text-right tabular-nums">{fmtMoney(m.maxDrawdown)}</td>
                <td className="td text-right tabular-nums font-medium">
                  {m.zellaScore.toFixed(1)}
                </td>
                <td className="td">
                  {m.sampleWarning && (
                    <span className="chip" title="Below the minimum sample size — treat as noise">
                      ⚠
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function PerformancePage() {
  const supabase = await createClient();
  const settings = await getSettings();

  const [
    { data: tradeRows },
    { data: accountRows },
    { data: tradeTagRows },
    { data: tagRows },
    { data: playbookRows },
  ] = await Promise.all([
    supabase.from("trades").select("*").order("close_time"),
    supabase.from("accounts").select("starting_balance"),
    supabase.from("trade_tags").select("trade_id, tag_id"),
    supabase.from("tags").select("*"),
    supabase.from("playbooks").select("*"),
  ]);

  const trades = (tradeRows ?? []) as Trade[];
  const starting = (accountRows ?? []).reduce(
    (a, acc) => a + Number(acc.starting_balance || 0),
    0
  );
  const tagName = new Map(((tagRows ?? []) as Tag[]).map((t) => [t.id, t.name]));
  const playbookName = new Map(
    ((playbookRows ?? []) as Playbook[]).map((p) => [p.id, p.name])
  );

  const calc = (bucket: Trade[]) =>
    compute(bucket, starting, settings.min_sample_size);
  const toRows = (
    groups: Map<string, Trade[]>,
    order?: string[]
  ): ScopeRow[] => {
    const rows = [...groups.entries()].map(([label, bucket]) => ({
      label,
      metrics: calc(bucket),
    }));
    if (order) {
      rows.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    } else {
      rows.sort((a, b) => a.label.localeCompare(b.label));
    }
    return rows;
  };

  // Tag scope: bucket trades through the join table.
  const tradeById = new Map(trades.map((t) => [t.id, t]));
  const byTag = new Map<string, Trade[]>();
  for (const link of tradeTagRows ?? []) {
    const trade = tradeById.get(link.trade_id);
    const name = tagName.get(link.tag_id);
    if (!trade || !name) continue;
    const bucket = byTag.get(name) ?? [];
    bucket.push(trade);
    byTag.set(name, bucket);
  }

  const monthRows = toRows(
    groupBy(trades, (t) => t.trade_date.slice(0, 7))
  ).reverse();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Performance</h1>
      <p className="text-sm text-ink2 max-w-3xl">
        Every scope recomputed live from your trades — the Zella Score and full
        metric suite, sliced the same eight ways as the Notion dashboard. Rows
        flagged ⚠ have fewer than {settings.min_sample_size} trades.
      </p>

      <ScopeTable title="All time" rows={[{ label: "All Time", metrics: calc(trades) }]} />
      <ScopeTable title="By month" rows={monthRows} />
      <ScopeTable title="By symbol" rows={toRows(groupBy(trades, (t) => t.symbol))} />
      <ScopeTable
        title="By session"
        rows={toRows(groupBy(trades, (t) => t.session), SESSION_ORDER)}
        note="Sessions are classified on the UTC open hour: Asia 23–07, London 07–12, New York 12–16, London Close 16–20, Off Hours 20–23."
      />
      <ScopeTable
        title="By day of week"
        rows={toRows(groupBy(trades, (t) => t.day_of_week), WEEKDAYS)}
      />
      <ScopeTable
        title="By playbook"
        rows={toRows(
          groupBy(trades, (t) =>
            t.playbook_id ? (playbookName.get(t.playbook_id) ?? null) : null
          )
        )}
        note="Tag trades to a playbook on the trade page to populate this."
      />
      <ScopeTable title="By tag" rows={toRows(byTag)} />
      <ScopeTable
        title="By setup grade"
        rows={toRows(groupBy(trades, (t) => t.setup_grade), ["A", "B", "C", "D", "F"])}
      />
    </div>
  );
}
