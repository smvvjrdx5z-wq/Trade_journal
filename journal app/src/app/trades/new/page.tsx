import { createClient } from "@/lib/supabase/server";
import { saveTrade } from "../../actions";
import type { Account } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function NewTradePage() {
  const supabase = await createClient();
  const { data: accountRows } = await supabase
    .from("accounts")
    .select("*")
    .order("created_at");
  const accounts = (accountRows ?? []) as Account[];

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Log a trade</h1>
      <p className="text-sm text-ink2">
        Outcome, session, duration, R-multiples and the journal calendar day are
        derived automatically — the same math the MT5 bridge runs. Give either a
        stop loss + tick data, or a manual “risk $”, to get an R-multiple.
      </p>

      <form action={saveTrade} className="card space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="label">Symbol *</label>
            <input name="symbol" required className="input" placeholder="EURUSD" />
          </div>
          <div>
            <label className="label">Direction</label>
            <select name="direction" className="input">
              <option>Long</option>
              <option>Short</option>
            </select>
          </div>
          <div>
            <label className="label">Volume (lots)</label>
            <input name="volume" type="number" step="any" min="0" className="input" defaultValue="1" />
          </div>
          <div>
            <label className="label">Account</label>
            <select name="account_id" className="input">
              <option value="">—</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Open time *</label>
            <input name="open_time" type="datetime-local" required className="input" />
          </div>
          <div>
            <label className="label">Close time *</label>
            <input name="close_time" type="datetime-local" required className="input" />
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="label">Entry price</label>
            <input name="entry_price" type="number" step="any" className="input" />
          </div>
          <div>
            <label className="label">Exit price</label>
            <input name="exit_price" type="number" step="any" className="input" />
          </div>
          <div>
            <label className="label">Stop loss</label>
            <input name="stop_loss" type="number" step="any" className="input" />
          </div>
          <div>
            <label className="label">Take profit</label>
            <input name="take_profit" type="number" step="any" className="input" />
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="label">Gross P&L *</label>
            <input name="gross_pl" type="number" step="any" required className="input" />
          </div>
          <div>
            <label className="label">Commission</label>
            <input name="commission" type="number" step="any" className="input" placeholder="-7.00" />
          </div>
          <div>
            <label className="label">Swap</label>
            <input name="swap" type="number" step="any" className="input" />
          </div>
          <div>
            <label className="label">Fee</label>
            <input name="fee" type="number" step="any" className="input" />
          </div>
        </div>

        <details>
          <summary className="text-sm text-ink2 cursor-pointer">
            Risk sizing (for R-multiples)
          </summary>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
            <div>
              <label className="label">Risk $ (manual)</label>
              <input name="risk_amount" type="number" step="any" className="input" placeholder="e.g. 100" />
            </div>
            <div>
              <label className="label">Tick size</label>
              <input name="tick_size" type="number" step="any" className="input" placeholder="0.00001" />
            </div>
            <div>
              <label className="label">Tick value</label>
              <input name="tick_value" type="number" step="any" className="input" placeholder="1" />
            </div>
          </div>
          <p className="text-xs text-muted mt-2">
            With a stop loss and tick data, risk is |entry − stop| ÷ tick size ×
            tick value × volume. A manual risk $ is used when tick data is
            absent. With neither, risk falls back to your default risk % of
            balance and the R is flagged as estimated.
          </p>
        </details>

        <button className="btn">Save trade</button>
      </form>
    </div>
  );
}
