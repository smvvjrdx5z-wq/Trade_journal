import { createClient } from "@/lib/supabase/server";
import { deleteAccount, saveAccount } from "../actions";
import type { Account, Trade } from "@/lib/types";
import { fmtDateTime, fmtMoney, fmtSignedMoney, pnlClass } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const supabase = await createClient();
  const [{ data: accountRows }, { data: tradeRows }] = await Promise.all([
    supabase.from("accounts").select("*").order("created_at"),
    supabase.from("trades").select("account_id, net_pl, close_time").order("close_time"),
  ]);
  const accounts = (accountRows ?? []) as Account[];
  const trades = (tradeRows ?? []) as Pick<Trade, "account_id" | "net_pl" | "close_time">[];

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-xl font-semibold">Accounts</h1>
      <p className="text-sm text-ink2">
        One row per broker login. The bridge updates balance and equity on
        every sync; net P&L and peak balance are computed from your trades.
      </p>

      {accounts.map((account) => {
        const mine = trades.filter((t) => t.account_id === account.id);
        let equity = Number(account.starting_balance);
        let peak = equity;
        let net = 0;
        for (const t of mine) {
          equity += Number(t.net_pl);
          net += Number(t.net_pl);
          peak = Math.max(peak, equity);
        }
        return (
          <div key={account.id} className="card space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">
                  {account.name}
                  <span className="chip ml-2">{account.account_type}</span>
                  {!account.active && <span className="chip ml-1">inactive</span>}
                </h2>
                <p className="text-xs text-muted mt-1">
                  {[account.broker, account.server, account.login ? `#${account.login}` : ""]
                    .filter(Boolean)
                    .join(" · ") || "No broker details"}
                  {account.last_synced_at &&
                    ` · last synced ${fmtDateTime(account.last_synced_at)}`}
                </p>
              </div>
              <form action={deleteAccount}>
                <input type="hidden" name="id" value={account.id} />
                <button className="text-xs text-neg underline">Delete</button>
              </form>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm border-t border-line pt-3">
              <div>
                <p className="text-xs text-muted">Starting balance</p>
                <p className="font-medium tabular-nums">{fmtMoney(account.starting_balance)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Current balance</p>
                <p className="font-medium tabular-nums">{fmtMoney(account.current_balance)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Current equity</p>
                <p className="font-medium tabular-nums">{fmtMoney(account.current_equity)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Net P&L ({mine.length} trades)</p>
                <p className={`font-medium tabular-nums ${pnlClass(net)}`}>{fmtSignedMoney(net)}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Peak balance</p>
                <p className="font-medium tabular-nums">{fmtMoney(peak)}</p>
              </div>
            </div>
            <details>
              <summary className="text-sm text-ink2 cursor-pointer">Edit</summary>
              <form action={saveAccount} className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                <input type="hidden" name="id" value={account.id} />
                <div>
                  <label className="label">Name</label>
                  <input name="name" defaultValue={account.name} required className="input" />
                </div>
                <div>
                  <label className="label">Login</label>
                  <input name="login" type="number" defaultValue={account.login ?? ""} className="input" />
                </div>
                <div>
                  <label className="label">Broker</label>
                  <input name="broker" defaultValue={account.broker} className="input" />
                </div>
                <div>
                  <label className="label">Server</label>
                  <input name="server" defaultValue={account.server} className="input" />
                </div>
                <div>
                  <label className="label">Currency</label>
                  <input name="currency" defaultValue={account.currency} className="input" />
                </div>
                <div>
                  <label className="label">Type</label>
                  <select name="account_type" defaultValue={account.account_type} className="input">
                    <option>Live</option>
                    <option>Demo</option>
                  </select>
                </div>
                <div>
                  <label className="label">Starting balance</label>
                  <input name="starting_balance" type="number" step="any" defaultValue={account.starting_balance} className="input" />
                </div>
                <div>
                  <label className="label">Current balance</label>
                  <input name="current_balance" type="number" step="any" defaultValue={account.current_balance} className="input" />
                </div>
                <div className="col-span-full">
                  <button className="btn-ghost">Save changes</button>
                </div>
              </form>
            </details>
          </div>
        );
      })}

      <form action={saveAccount} className="card space-y-3">
        <h2 className="text-sm font-semibold">New account</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="label">Name *</label>
            <input name="name" required className="input" placeholder="IC Markets · 12345" />
          </div>
          <div>
            <label className="label">Login</label>
            <input name="login" type="number" className="input" />
          </div>
          <div>
            <label className="label">Broker</label>
            <input name="broker" className="input" />
          </div>
          <div>
            <label className="label">Type</label>
            <select name="account_type" className="input">
              <option>Live</option>
              <option>Demo</option>
            </select>
          </div>
          <div>
            <label className="label">Currency</label>
            <input name="currency" defaultValue="USD" className="input" />
          </div>
          <div>
            <label className="label">Starting balance</label>
            <input name="starting_balance" type="number" step="any" className="input" placeholder="10000" />
          </div>
        </div>
        <button className="btn">Add account</button>
      </form>
    </div>
  );
}
