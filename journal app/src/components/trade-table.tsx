import Link from "next/link";
import type { Trade } from "@/lib/types";
import {
  fmtDateTime,
  fmtDuration,
  fmtMoney,
  fmtR,
  pnlClass,
} from "@/lib/format";

export function TradeTable({
  trades,
  timezone,
}: {
  trades: Trade[];
  timezone: string;
}) {
  if (!trades.length) {
    return (
      <p className="text-sm text-muted py-8 text-center">
        No trades yet.{" "}
        <Link href="/trades/new" className="underline">
          Log the first one
        </Link>{" "}
        or point the MT5 bridge at <code>/api/ingest</code>.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th className="th">Opened</th>
            <th className="th">Symbol</th>
            <th className="th">Dir</th>
            <th className="th">Volume</th>
            <th className="th">Session</th>
            <th className="th">Duration</th>
            <th className="th text-right">Net P&L</th>
            <th className="th text-right">R</th>
            <th className="th">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-b border-line hover:bg-page">
              <td className="td">
                <Link
                  href={`/trades/${t.id}`}
                  className="text-accent hover:underline"
                >
                  {fmtDateTime(t.open_time, timezone)}
                </Link>
              </td>
              <td className="td font-medium">{t.symbol}</td>
              <td className="td">{t.direction}</td>
              <td className="td tabular-nums">{t.volume}</td>
              <td className="td text-ink2">{t.session}</td>
              <td className="td text-ink2">{fmtDuration(t.duration_minutes)}</td>
              <td className={`td text-right tabular-nums ${pnlClass(t.net_pl)}`}>
                {fmtMoney(t.net_pl)}
              </td>
              <td className={`td text-right tabular-nums ${pnlClass(t.realized_r)}`}>
                {fmtR(t.realized_r)}
              </td>
              <td className="td">
                <span
                  className={`chip ${
                    t.outcome === "Win"
                      ? "text-pos border-pos/40"
                      : t.outcome === "Loss"
                        ? "text-neg border-neg/40"
                        : ""
                  }`}
                >
                  {t.outcome}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
