export function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg" | null;
}) {
  const toneClass =
    tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-ink";
  return (
    <div className="card">
      <p className="text-xs text-muted mb-1">{label}</p>
      <p className={`text-2xl font-semibold ${toneClass}`}>{value}</p>
      {sub && <p className="text-xs text-muted mt-1">{sub}</p>}
    </div>
  );
}
