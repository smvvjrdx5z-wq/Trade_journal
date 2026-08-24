import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  deleteTrade,
  getSettings,
  saveTradeJournal,
  uploadScreenshot,
} from "../../actions";
import type { Playbook, Tag, Trade, TagCategory } from "@/lib/types";
import {
  fmtDateTime,
  fmtDuration,
  fmtMoney,
  fmtNum,
  fmtR,
  fmtSignedMoney,
  pnlClass,
} from "@/lib/format";

export const dynamic = "force-dynamic";

const TAG_CATEGORIES: TagCategory[] = [
  "Setup",
  "Mistake",
  "Emotion",
  "Market Condition",
  "Management",
];

function Fact({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-sm font-medium tabular-nums ${className ?? ""}`}>{value}</p>
    </div>
  );
}

export default async function TradeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const settings = await getSettings();

  const [{ data: tradeRow }, { data: playbookRows }, { data: tagRows }, { data: tradeTagRows }] =
    await Promise.all([
      supabase.from("trades").select("*").eq("id", id).maybeSingle(),
      supabase.from("playbooks").select("*").order("name"),
      supabase.from("tags").select("*").order("name"),
      supabase.from("trade_tags").select("tag_id").eq("trade_id", id),
    ]);

  if (!tradeRow) notFound();
  const trade = tradeRow as Trade;
  const playbooks = (playbookRows ?? []) as Playbook[];
  const tags = (tagRows ?? []) as Tag[];
  const selectedTagIds = new Set((tradeTagRows ?? []).map((r) => r.tag_id));

  let screenshotUrl: string | null = null;
  if (trade.screenshot_path) {
    const { data } = await supabase.storage
      .from("screenshots")
      .createSignedUrl(trade.screenshot_path, 3600);
    screenshotUrl = data?.signedUrl ?? null;
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">
          {trade.symbol} {trade.direction} ·{" "}
          <span className="text-ink2 font-normal">
            {fmtDateTime(trade.open_time, settings.timezone)}
          </span>
        </h1>
        <form action={deleteTrade}>
          <input type="hidden" name="id" value={trade.id} />
          <button className="btn-ghost text-neg">Delete</button>
        </form>
      </div>

      <div className="card">
        <p className={`text-2xl font-semibold mb-4 ${pnlClass(trade.net_pl)}`}>
          {fmtSignedMoney(trade.net_pl)}{" "}
          <span className="text-sm font-normal text-muted">
            net · {trade.outcome}
            {trade.risk_is_estimated && trade.realized_r !== null
              ? " · R estimated (no stop attached)"
              : ""}
          </span>
        </p>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-x-4 gap-y-3">
          <Fact label="Volume" value={trade.volume} />
          <Fact label="Entry" value={fmtNum(trade.entry_price, trade.digits)} />
          <Fact label="Exit" value={fmtNum(trade.exit_price, trade.digits)} />
          <Fact label="Stop" value={trade.stop_loss ? fmtNum(trade.stop_loss, trade.digits) : "—"} />
          <Fact label="Target" value={trade.take_profit ? fmtNum(trade.take_profit, trade.digits) : "—"} />
          <Fact label="Duration" value={fmtDuration(trade.duration_minutes)} />
          <Fact label="Gross P&L" value={fmtMoney(trade.gross_pl)} className={pnlClass(trade.gross_pl)} />
          <Fact label="Commission" value={fmtMoney(trade.commission)} />
          <Fact label="Swap" value={fmtMoney(trade.swap)} />
          <Fact label="Risk $" value={trade.risk_amount ? fmtMoney(trade.risk_amount) : "—"} />
          <Fact label="Planned R" value={trade.planned_r ? fmtNum(trade.planned_r) : "—"} />
          <Fact
            label="Realized R"
            value={fmtR(trade.realized_r)}
            className={pnlClass(trade.realized_r)}
          />
          <Fact label="MAE" value={trade.mae !== null ? fmtMoney(trade.mae) : "—"} />
          <Fact label="MFE" value={trade.mfe !== null ? fmtMoney(trade.mfe) : "—"} />
          <Fact
            label="Return %"
            value={trade.return_pct !== null ? `${(trade.return_pct * 100).toFixed(2)}%` : "—"}
          />
          <Fact label="Session" value={trade.session} />
          <Fact label="Day" value={`${trade.day_of_week} ${trade.hour}:00`} />
          <Fact label="Position ID" value={trade.position_id ?? "manual"} />
        </div>
      </div>

      <div className="card">
        <h2 className="text-sm font-medium text-ink2 mb-3">Chart screenshot</h2>
        {screenshotUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={screenshotUrl}
            alt={`${trade.symbol} chart at time of trade`}
            className="rounded-md border border-line max-w-full"
          />
        ) : (
          <p className="text-sm text-muted mb-3">
            No screenshot yet. The MT5 bridge attaches the H4 chart
            automatically; for manual trades, upload one here.
          </p>
        )}
        <form action={uploadScreenshot} className="mt-3 flex items-center gap-3">
          <input type="hidden" name="id" value={trade.id} />
          <input type="file" name="screenshot" accept="image/*" className="text-sm text-ink2" />
          <button className="btn-ghost">Upload</button>
        </form>
      </div>

      <form action={saveTradeJournal} className="card space-y-4">
        <input type="hidden" name="id" value={trade.id} />
        <h2 className="text-sm font-medium text-ink2">
          Journal{" "}
          <span className="text-muted font-normal">
            — these columns are yours; a re-sync never overwrites them
          </span>
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div>
            <label className="label">Playbook</label>
            <select name="playbook_id" defaultValue={trade.playbook_id ?? ""} className="input">
              <option value="">—</option>
              {playbooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Setup grade</label>
            <select name="setup_grade" defaultValue={trade.setup_grade ?? ""} className="input">
              <option value="">—</option>
              {["A", "B", "C", "D", "F"].map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Execution grade</label>
            <select name="execution_grade" defaultValue={trade.execution_grade ?? ""} className="input">
              <option value="">—</option>
              {["A", "B", "C", "D", "F"].map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Confidence (1–5)</label>
            <input
              name="confidence"
              type="number"
              min={1}
              max={5}
              defaultValue={trade.confidence ?? ""}
              className="input"
            />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-ink2">
              <input
                type="checkbox"
                name="followed_plan"
                defaultChecked={trade.followed_plan ?? false}
              />
              Followed plan
            </label>
          </div>
        </div>

        <div>
          <p className="label">Tags</p>
          <div className="space-y-2">
            {TAG_CATEGORIES.map((category) => {
              const inCategory = tags.filter((t) => t.category === category);
              if (!inCategory.length) return null;
              return (
                <div key={category} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted w-32 shrink-0">{category}</span>
                  {inCategory.map((tag) => (
                    <label
                      key={tag.id}
                      className="chip cursor-pointer has-[:checked]:border-accent has-[:checked]:text-accent"
                    >
                      <input
                        type="checkbox"
                        name="tag_ids"
                        value={tag.id}
                        defaultChecked={selectedTagIds.has(tag.id)}
                        className="sr-only"
                      />
                      {tag.name}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="label">Entry reason — what I saw</label>
            <textarea name="entry_reason" rows={3} className="input" defaultValue={trade.entry_reason} />
          </div>
          <div>
            <label className="label">Exit reason — what actually happened</label>
            <textarea name="exit_reason" rows={3} className="input" defaultValue={trade.exit_reason} />
          </div>
        </div>
        <div>
          <label className="label">Lessons — would I take this again?</label>
          <textarea name="lessons" rows={3} className="input" defaultValue={trade.lessons} />
        </div>

        <button className="btn">Save journal</button>
      </form>
    </div>
  );
}
