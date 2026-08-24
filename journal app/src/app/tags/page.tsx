import { createClient } from "@/lib/supabase/server";
import { createTag, deleteTag, getSettings } from "../actions";
import { compute } from "@/lib/analytics";
import type { Tag, TagCategory, Trade } from "@/lib/types";
import { fmtPct, fmtSignedMoney, pnlClass } from "@/lib/format";

export const dynamic = "force-dynamic";

const CATEGORIES: TagCategory[] = [
  "Setup",
  "Mistake",
  "Emotion",
  "Market Condition",
  "Management",
];

export default async function TagsPage() {
  const supabase = await createClient();
  const settings = await getSettings();

  const [{ data: tagRows }, { data: linkRows }, { data: tradeRows }] =
    await Promise.all([
      supabase.from("tags").select("*").order("name"),
      supabase.from("trade_tags").select("trade_id, tag_id"),
      supabase.from("trades").select("*"),
    ]);
  const tags = (tagRows ?? []) as Tag[];
  const trades = new Map(((tradeRows ?? []) as Trade[]).map((t) => [t.id, t]));

  const byTag = new Map<string, Trade[]>();
  for (const link of linkRows ?? []) {
    const trade = trades.get(link.trade_id);
    if (!trade) continue;
    const bucket = byTag.get(link.tag_id) ?? [];
    bucket.push(trade);
    byTag.set(link.tag_id, bucket);
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-xl font-semibold">Tags</h1>
      <p className="text-sm text-ink2">
        Setup, mistake, emotion, condition and management tags. Tag every trade
        and find out what actually costs you money.
      </p>

      {CATEGORIES.map((category) => {
        const inCategory = tags.filter((t) => t.category === category);
        if (!inCategory.length) return null;
        return (
          <div key={category} className="card">
            <h2 className="text-sm font-semibold mb-3">{category}</h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-line">
                    <th className="th">Tag</th>
                    <th className="th text-right">Trades</th>
                    <th className="th text-right">Win %</th>
                    <th className="th text-right">Net P&L</th>
                    <th className="th"></th>
                  </tr>
                </thead>
                <tbody>
                  {inCategory.map((tag) => {
                    const bucket = byTag.get(tag.id) ?? [];
                    const m = compute(bucket, 0, settings.min_sample_size);
                    return (
                      <tr key={tag.id} className="border-b border-line">
                        <td className="td">{tag.name}</td>
                        <td className="td text-right tabular-nums">
                          {bucket.length || "—"}
                        </td>
                        <td className="td text-right tabular-nums">
                          {bucket.length ? fmtPct(m.winRate) : "—"}
                        </td>
                        <td
                          className={`td text-right tabular-nums ${
                            bucket.length ? pnlClass(m.netPl) : "text-muted"
                          }`}
                        >
                          {bucket.length ? fmtSignedMoney(m.netPl) : "—"}
                        </td>
                        <td className="td text-right">
                          <form action={deleteTag}>
                            <input type="hidden" name="id" value={tag.id} />
                            <button
                              className="text-xs text-muted hover:text-neg underline"
                              title="Delete tag"
                            >
                              delete
                            </button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <form action={createTag} className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="label">New tag</label>
          <input name="name" required className="input w-52" placeholder="Name" />
        </div>
        <div>
          <label className="label">Category</label>
          <select name="category" className="input w-44">
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <button className="btn">Add tag</button>
      </form>
    </div>
  );
}
