import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSettings } from "../actions";
import type { Trade } from "@/lib/types";
import { TradeTable } from "@/components/trade-table";
import { SESSION_ORDER } from "@/lib/trade-math";

export const dynamic = "force-dynamic";

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<{ symbol?: string; outcome?: string; session?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const settings = await getSettings();

  let query = supabase
    .from("trades")
    .select("*")
    .order("close_time", { ascending: false });
  if (params.symbol) query = query.eq("symbol", params.symbol);
  if (params.outcome) query = query.eq("outcome", params.outcome);
  if (params.session) query = query.eq("session", params.session);

  const [{ data: tradeRows }, { data: symbolRows }] = await Promise.all([
    query,
    supabase.from("trades").select("symbol"),
  ]);
  const trades = (tradeRows ?? []) as Trade[];
  const symbols = [...new Set((symbolRows ?? []).map((r) => r.symbol))].sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Trades</h1>
        <Link href="/trades/new" className="btn">
          Log trade
        </Link>
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="symbol">
            Symbol
          </label>
          <select
            id="symbol"
            name="symbol"
            defaultValue={params.symbol ?? ""}
            className="input w-36"
          >
            <option value="">All</option>
            {symbols.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="outcome">
            Outcome
          </label>
          <select
            id="outcome"
            name="outcome"
            defaultValue={params.outcome ?? ""}
            className="input w-36"
          >
            <option value="">All</option>
            <option>Win</option>
            <option>Loss</option>
            <option>Breakeven</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="session">
            Session
          </label>
          <select
            id="session"
            name="session"
            defaultValue={params.session ?? ""}
            className="input w-40"
          >
            <option value="">All</option>
            {SESSION_ORDER.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <button className="btn-ghost">Filter</button>
        <Link href="/trades" className="text-sm text-muted underline pb-2.5">
          Reset
        </Link>
        <p className="ml-auto pb-2.5 text-sm text-muted">
          {trades.length} trade{trades.length === 1 ? "" : "s"}
        </p>
      </form>

      <div className="card">
        <TradeTable trades={trades} timezone={settings.timezone} />
      </div>
    </div>
  );
}
