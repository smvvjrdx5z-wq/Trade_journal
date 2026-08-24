import type { Metrics } from "@/lib/analytics";

const COMPONENTS: {
  key: keyof Metrics;
  label: string;
  weight: string;
}[] = [
  { key: "scoreProfitFactor", label: "Profit Factor", weight: "25%" },
  { key: "scoreAvgWinLoss", label: "Avg Win/Loss", weight: "20%" },
  { key: "scoreMaxDrawdown", label: "Max Drawdown", weight: "20%" },
  { key: "scoreWinRate", label: "Trade Win %", weight: "15%" },
  { key: "scoreRecoveryFactor", label: "Recovery Factor", weight: "10%" },
  { key: "scoreConsistency", label: "Consistency", weight: "10%" },
];

/** The composite score: hero figure plus its six weighted component bars. */
export function ZellaScore({ metrics }: { metrics: Metrics }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-4">
        <span className="text-4xl font-semibold text-ink">
          {metrics.tradeCount ? metrics.zellaScore.toFixed(1) : "—"}
        </span>
        <span className="text-sm text-muted">/ 100</span>
      </div>
      <div className="space-y-2.5">
        {COMPONENTS.map((c) => {
          const value = metrics[c.key] as number;
          return (
            <div key={c.key}>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-ink2">
                  {c.label}{" "}
                  <span className="text-muted">· {c.weight}</span>
                </span>
                <span className="text-ink font-medium tabular-nums">
                  {value.toFixed(0)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-page overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
