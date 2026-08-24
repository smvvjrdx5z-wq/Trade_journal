"use client";

import { useMemo, useState } from "react";
import { fmtSignedMoney } from "@/lib/format";

interface Day {
  date: string;
  pnl: number;
}

const W = 720;
const H = 200;
const PAD = { top: 10, right: 12, bottom: 24, left: 56 };

/** Daily net P&L: diverging bars around a zero baseline, tooltip per bar. */
export function DailyPnlBars({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const { bars, zeroY, ticks } = useMemo(() => {
    const values = days.map((d) => d.pnl);
    let hi = Math.max(...values, 0);
    let lo = Math.min(...values, 0);
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const span = hi - lo;
    hi += span * 0.08;
    lo -= span * 0.08;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
    const zeroY = y(0);
    const step = plotW / days.length;
    const barW = Math.max(2, Math.min(22, step - 2)); // 2px surface gap

    const bars = days.map((d, i) => {
      const x = PAD.left + step * i + (step - barW) / 2;
      const yv = y(d.pnl);
      return {
        x,
        w: barW,
        y: Math.min(yv, zeroY),
        h: Math.max(1, Math.abs(yv - zeroY)),
        positive: d.pnl >= 0,
        ...d,
      };
    });

    const ticks = [lo, lo / 2, 0, hi / 2, hi]
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .map((v) => ({ value: v, y: y(v) }));
    return { bars, zeroY, ticks };
  }, [days]);

  if (!days.length) {
    return (
      <p className="text-sm text-muted py-10 text-center">
        Daily P&L appears once trades are logged.
      </p>
    );
  }

  const h = hover !== null ? bars[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Net profit and loss per trading day"
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={t.y}
              y2={t.y}
              stroke="var(--grid)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={t.y + 3.5}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted)"
            >
              {fmtSignedMoney(Math.round(t.value))}
            </text>
          </g>
        ))}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--baseline)"
          strokeWidth={1}
        />
        {bars.map((b, i) => (
          <rect
            key={b.date}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx={2}
            fill={b.positive ? "var(--pos)" : "var(--neg)"}
            opacity={hover === null || hover === i ? 1 : 0.45}
            onMouseEnter={() => setHover(i)}
          />
        ))}
        <text x={PAD.left} y={H - 6} fontSize={10} fill="var(--muted)">
          {days[0].date}
        </text>
        <text
          x={W - PAD.right}
          y={H - 6}
          textAnchor="end"
          fontSize={10}
          fill="var(--muted)"
        >
          {days[days.length - 1].date}
        </text>
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-sm"
          style={{
            left: `${((h.x + h.w / 2) / W) * 100}%`,
            top: `${(h.y / H) * 100}%`,
            transform:
              h.x > W * 0.75
                ? "translate(calc(-100% - 8px), -110%)"
                : "translate(8px, -110%)",
          }}
        >
          <span className="text-muted">{h.date}</span>{" "}
          <span className="font-medium text-ink">{fmtSignedMoney(h.pnl)}</span>
        </div>
      )}
    </div>
  );
}
