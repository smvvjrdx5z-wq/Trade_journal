import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getSettings } from "./actions";
import { compute, dailyPnl, equityCurve } from "@/lib/analytics";
import type { Trade } from "@/lib/types";
import { fmtMoney, fmtNum, fmtPct, fmtR, fmtSignedMoney } from "@/lib/format";
import { StatTile } from "@/components/stat-tile";
import { ZellaScore } from "@/components/zella-score";
import { EquityCurve } from "@/components/equity-curve";
import { DailyPnlBars } from "@/components/daily-pnl-bars";
import { TradeTable } from "@/components/trade-table";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();
  const settings = await getSettings();

  const [{ data: tradeRows }, { data: accounts }] = await Promise.all([
    supabase.from("trades").select("*").order("close_time", { ascending: true }),
    supabase.from("accounts").select("starting_balance"),
  ]);

  const trades = (tradeRows ?? []) as Trade[];
  const startingBalance = (accounts ?? []).reduce(
    (a, acc) => a + Number(acc.starting_balance || 0),
    0
  );

  const metrics = compute(trades, startingBalance, settings.min_sample_size);
  const curve = equityCurve(trades, startingBalance);
  const days = [...dailyPnl(trades).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([date, pnl]) => ({ date, pnl }));
  const recent = [...trades].reverse().slice(0, 8);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Link href="/trades/new" className="btn">
          Log trade
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatTile
          label="Net P&L"
          value={fmtSignedMoney(metrics.netPl)}
          tone={metrics.netPl > 0 ? "pos" : metrics.netPl < 0 ? "neg" : null}
          sub={`${metrics.tradeCount} trades · ${metrics.loggedDays} days`}
        />
        <StatTile
          label="Win rate"
          value={fmtPct(metrics.winRate)}
          sub={`Day win rate ${fmtPct(metrics.dayWinRate)}`}
        />
        <StatTile
          label="Profit factor"
          value={fmtNum(metrics.profitFactor)}
          sub={`Avg win/loss ${fmtNum(metrics.avgWinLoss)}`}
        />
        <StatTile
          label="Expectancy"
          value={fmtSignedMoney(metrics.expectancy)}
          sub={`Per trade · ${fmtR(metrics.expectancyR)}`}
        />
        <StatTile
          label="Max drawdown"
          value={fmtMoney(metrics.maxDrawdown)}
          sub={`${fmtPct(metrics.maxDrawdownPct)} of peak`}
          tone={metrics.maxDrawdown > 0 ? "neg" : null}
        />
        <StatTile
          label="Current streak"
          value={
            metrics.currentStreak === 0
              ? "—"
              : `${Math.abs(metrics.currentStreak)} ${
                  metrics.currentStreak > 0 ? "wins" : "losses"
                }`
          }
          tone={
            metrics.currentStreak > 0
              ? "pos"
              : metrics.currentStreak < 0
                ? "neg"
                : null
          }
          sub={`Best ${metrics.maxConsecutiveWins}W · worst ${metrics.maxConsecutiveLosses}L`}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card lg:col-span-2">
          <h2 className="text-sm font-medium text-ink2 mb-3">Equity curve</h2>
          <EquityCurve points={curve} />
        </div>
        <div className="card">
          <h2 className="text-sm font-medium text-ink2 mb-3">
            Zella Score
            {metrics.sampleWarning && metrics.tradeCount > 0 && (
              <span
                className="ml-2 chip"
                title={`Fewer than ${settings.min_sample_size} trades — treat as noise`}
              >
                ⚠ small sample
              </span>
            )}
          </h2>
          <ZellaScore metrics={metrics} />
        </div>
      </div>

      <div className="card">
        <h2 className="text-sm font-medium text-ink2 mb-3">
          Daily net P&L <span className="text-muted">· last 30 trading days</span>
        </h2>
        <DailyPnlBars days={days} />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-ink2">Recent trades</h2>
          <Link href="/trades" className="text-sm text-accent hover:underline">
            All trades →
          </Link>
        </div>
        <TradeTable trades={recent} timezone={settings.timezone} />
      </div>
    </div>
  );
}
