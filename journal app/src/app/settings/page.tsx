import { getSettings, regenerateIngestToken, saveSettings } from "../actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-xl font-semibold">Settings</h1>

      <form action={saveSettings} className="card space-y-4">
        <h2 className="text-sm font-semibold">Journal configuration</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Timezone (IANA name)</label>
            <input
              name="timezone"
              defaultValue={settings.timezone}
              className="input"
              placeholder="Europe/Berlin"
            />
            <p className="text-xs text-muted mt-1">
              Used for the journal calendar, day-of-week and hour grouping.
              Sessions always use UTC.
            </p>
          </div>
          <div>
            <label className="label">Default risk % (fraction)</label>
            <input
              name="default_risk_pct"
              type="number"
              step="any"
              min="0"
              max="1"
              defaultValue={settings.default_risk_pct}
              className="input"
            />
            <p className="text-xs text-muted mt-1">
              Assumed risk when a trade carried no stop loss (0.01 = 1% of
              balance). Those R-multiples are flagged as estimates.
            </p>
          </div>
          <div>
            <label className="label">Breakeven threshold</label>
            <input
              name="breakeven_threshold"
              type="number"
              step="any"
              min="0"
              defaultValue={settings.breakeven_threshold}
              className="input"
            />
            <p className="text-xs text-muted mt-1">
              Net P&L within ± this counts as breakeven, not a win or loss.
            </p>
          </div>
          <div>
            <label className="label">Minimum sample size</label>
            <input
              name="min_sample_size"
              type="number"
              min="1"
              defaultValue={settings.min_sample_size}
              className="input"
            />
            <p className="text-xs text-muted mt-1">
              Performance scopes with fewer trades get the ⚠ sample warning.
            </p>
          </div>
        </div>
        <button className="btn">Save settings</button>
      </form>

      <div className="card space-y-3">
        <h2 className="text-sm font-semibold">MT5 bridge ingest</h2>
        <p className="text-sm text-ink2">
          The app accepts the same JSON payloads the MetaTrader Expert Advisor
          spools to disk. Point the bridge (or any script) at{" "}
          <code className="text-xs bg-page border border-line rounded px-1 py-0.5">
            POST /api/ingest
          </code>{" "}
          with this token as a bearer token. Trades upsert by position ID, and
          your hand-written journal columns are never overwritten.
        </p>
        <div>
          <p className="label">Ingest token</p>
          <code className="block text-xs bg-page border border-line rounded-md px-3 py-2 break-all">
            {settings.ingest_token || "—"}
          </code>
        </div>
        <form action={regenerateIngestToken}>
          <button className="btn-ghost">Regenerate token</button>
        </form>
        <details>
          <summary className="text-sm text-ink2 cursor-pointer">
            Example request
          </summary>
          <pre className="text-xs bg-page border border-line rounded-md p-3 mt-2 overflow-x-auto">
{`curl -X POST https://<your-app>.vercel.app/api/ingest \\
  -H "Authorization: Bearer ${settings.ingest_token || "<token>"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "server_utc_offset_minutes": 120,
    "account": {"login": 12345, "company": "Broker", "currency": "USD",
                 "balance": 10250.00, "equity": 10250.00},
    "trade": {
      "position_id": 987654, "symbol": "EURUSD", "direction": "Long",
      "volume": 1.0, "open_time": "2026-08-24T10:00:00",
      "close_time": "2026-08-24T14:30:00",
      "entry_price": 1.1000, "exit_price": 1.1050,
      "stop_loss": 1.0950, "take_profit": 1.1100,
      "gross_pl": 500.0, "commission": -7.0, "swap": 0.0, "fee": 0.0,
      "net_pl": 493.0, "mae": -120.0, "mfe": 510.0,
      "tick_size": 0.00001, "tick_value": 1.0, "digits": 5,
      "magic": 0, "comment": ""
    }
  }'`}
          </pre>
        </details>
      </div>
    </div>
  );
}
