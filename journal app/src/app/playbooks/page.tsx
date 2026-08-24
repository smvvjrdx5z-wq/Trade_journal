import { createClient } from "@/lib/supabase/server";
import { deletePlaybook, getSettings, savePlaybook } from "../actions";
import { compute } from "@/lib/analytics";
import type { Playbook, Trade } from "@/lib/types";
import { fmtNum, fmtPct, fmtR, fmtSignedMoney, pnlClass } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PlaybooksPage() {
  const supabase = await createClient();
  const settings = await getSettings();

  const [{ data: playbookRows }, { data: tradeRows }] = await Promise.all([
    supabase.from("playbooks").select("*").order("created_at"),
    supabase.from("trades").select("*"),
  ]);
  const playbooks = (playbookRows ?? []) as Playbook[];
  const trades = (tradeRows ?? []) as Trade[];

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-xl font-semibold">Playbooks</h1>
      <p className="text-sm text-ink2">
        Your strategies with their rules. Tag trades to a playbook on the trade
        page, and each one gets its win rate, profit factor, expectancy and R.
      </p>

      {playbooks.map((p) => {
        const bucket = trades.filter((t) => t.playbook_id === p.id);
        const m = compute(bucket, 0, settings.min_sample_size);
        return (
          <div key={p.id} className="card space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">
                  {p.name}
                  {!p.active && <span className="chip ml-2">inactive</span>}
                </h2>
                {p.description && (
                  <p className="text-sm text-ink2 mt-1">{p.description}</p>
                )}
              </div>
              <form action={deletePlaybook}>
                <input type="hidden" name="id" value={p.id} />
                <button className="text-xs text-neg underline">Delete</button>
              </form>
            </div>

            {bucket.length > 0 ? (
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm border-t border-line pt-3">
                <span className="text-ink2">
                  {m.tradeCount} trades
                  {m.sampleWarning && (
                    <span title="Small sample — treat as noise"> ⚠</span>
                  )}
                </span>
                <span className={pnlClass(m.netPl)}>
                  {fmtSignedMoney(m.netPl)}
                </span>
                <span className="text-ink2">Win {fmtPct(m.winRate)}</span>
                <span className="text-ink2">PF {fmtNum(m.profitFactor)}</span>
                <span className="text-ink2">
                  Expectancy {fmtSignedMoney(m.expectancy)}
                </span>
                <span className="text-ink2">Avg {fmtR(m.avgR)}</span>
              </div>
            ) : (
              <p className="text-xs text-muted border-t border-line pt-3">
                No trades tagged to this playbook yet.
              </p>
            )}

            <details>
              <summary className="text-sm text-ink2 cursor-pointer">
                Rules & edit
              </summary>
              <form action={savePlaybook} className="space-y-3 mt-3">
                <input type="hidden" name="id" value={p.id} />
                <div>
                  <label className="label">Name</label>
                  <input name="name" defaultValue={p.name} required className="input" />
                </div>
                <div>
                  <label className="label">Description</label>
                  <input name="description" defaultValue={p.description} className="input" />
                </div>
                <div>
                  <label className="label">Rules — entry, exit, risk, invalidation</label>
                  <textarea name="rules" rows={5} defaultValue={p.rules} className="input" />
                </div>
                <label className="flex items-center gap-2 text-sm text-ink2">
                  <input type="checkbox" name="active" defaultChecked={p.active} />
                  Active
                </label>
                <button className="btn-ghost">Save changes</button>
              </form>
            </details>
          </div>
        );
      })}

      <form action={savePlaybook} className="card space-y-3">
        <h2 className="text-sm font-semibold">New playbook</h2>
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Name *</label>
            <input name="name" required className="input" placeholder="London breakout" />
          </div>
          <div>
            <label className="label">Description</label>
            <input name="description" className="input" placeholder="One-liner on when this edge exists" />
          </div>
        </div>
        <div>
          <label className="label">Rules</label>
          <textarea
            name="rules"
            rows={4}
            className="input"
            placeholder={"Entry: …\nStop: …\nTarget: …\nInvalidation: …"}
          />
        </div>
        <button className="btn">Add playbook</button>
      </form>
    </div>
  );
}
