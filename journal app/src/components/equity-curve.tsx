"use client";

import { useMemo, useRef, useState } from "react";
import { fmtMoney } from "@/lib/format";

interface Point {
  time: string;
  equity: number;
}

const W = 720;
const H = 240;
const PAD = { top: 12, right: 12, bottom: 24, left: 56 };

/** Closed-trade equity curve: single series, crosshair + tooltip on hover. */
export function EquityCurve({ points }: { points: Point[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { path, xs, ys, ticks, min, max } = useMemo(() => {
    const values = points.map((p) => p.equity);
    let lo = Math.min(...values, 0);
    let hi = Math.max(...values, 0);
    if (lo === hi) {
      lo -= 1;
      hi += 1;
    }
    const span = hi - lo;
    lo -= span * 0.05;
    hi += span * 0.05;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const xs = points.map(
      (_, i) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW)
    );
    const ys = points.map(
      (p) => PAD.top + plotH - ((p.equity - lo) / (hi - lo)) * plotH
    );
    const path = xs.map((x, i) => `${i ? "L" : "M"}${x},${ys[i]}`).join("");

    const tickCount = 4;
    const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
      const value = lo + ((hi - lo) * i) / tickCount;
      return {
        value,
        y: PAD.top + plotH - ((value - lo) / (hi - lo)) * plotH,
      };
    });
    return { path, xs, ys, ticks, min: lo, max: hi };
  }, [points]);

  if (!points.length) {
    return (
      <p className="text-sm text-muted py-10 text-center">
        The equity curve appears once trades are logged.
      </p>
    );
  }

  function onMove(e: React.MouseEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    xs.forEach((px, i) => {
      const d = Math.abs(px - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setHover(best);
  }

  const h = hover !== null ? points[hover] : null;
  const flip = hover !== null && xs[hover] > W * 0.7;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Equity curve of closed trades"
        onMouseMove={onMove}
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
              {fmtMoney(t.value, 0)}
            </text>
          </g>
        ))}
        {/* zero baseline when it is inside the range */}
        {min < 0 && max > 0 && (
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={
              PAD.top +
              (H - PAD.top - PAD.bottom) -
              ((0 - min) / (max - min)) * (H - PAD.top - PAD.bottom)
            }
            y2={
              PAD.top +
              (H - PAD.top - PAD.bottom) -
              ((0 - min) / (max - min)) * (H - PAD.top - PAD.bottom)
            }
            stroke="var(--baseline)"
            strokeWidth={1}
          />
        )}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} />
        {hover !== null && (
          <g>
            <line
              x1={xs[hover]}
              x2={xs[hover]}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
            <circle
              cx={xs[hover]}
              cy={ys[hover]}
              r={4}
              fill="var(--accent)"
              stroke="var(--surface-1)"
              strokeWidth={2}
            />
          </g>
        )}
        <text
          x={PAD.left}
          y={H - 6}
          fontSize={10}
          fill="var(--muted)"
        >
          {new Date(points[0].time).toLocaleDateString()}
        </text>
        <text
          x={W - PAD.right}
          y={H - 6}
          textAnchor="end"
          fontSize={10}
          fill="var(--muted)"
        >
          {new Date(points[points.length - 1].time).toLocaleDateString()}
        </text>
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-sm"
          style={{
            left: `${(xs[hover] / W) * 100}%`,
            top: `${(ys[hover] / H) * 100}%`,
            transform: flip
              ? "translate(calc(-100% - 10px), -50%)"
              : "translate(10px, -50%)",
          }}
        >
          <span className="text-muted">
            {new Date(h.time).toLocaleDateString()}
          </span>{" "}
          <span className="font-medium text-ink">{fmtMoney(h.equity)}</span>
        </div>
      )}
    </div>
  );
}
