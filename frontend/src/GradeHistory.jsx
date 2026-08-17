import { useMemo, useState } from "react";
import { fmtPct, letterClass } from "./api";

export function GradeHistoryChart({ snapshots, title = "Grade history" }) {
  const [hover, setHover] = useState(null);
  const points = useMemo(
    () =>
      (snapshots || [])
        .filter((row) => row.percent != null && Number.isFinite(Number(row.percent)))
        .map((row) => ({
          ...row,
          percent: Number(row.percent),
          at: new Date(row.recorded_at),
        })),
    [snapshots]
  );

  if (!points.length) {
    return <p className="muted">No recorded grades yet. Use Record grades when you want a checkpoint.</p>;
  }

  const width = 800;
  const height = 240;
  const margin = { top: 16, right: 20, bottom: 40, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = points.map((p) => p.percent);
  let yMin = Math.min(0, Math.floor(Math.min(...values) / 5) * 5);
  let yMax = Math.max(100, Math.ceil(Math.max(...values) / 5) * 5);
  if (yMax <= yMin) yMax = yMin + 5;
  const x = (index) =>
    margin.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;
  const line = points.map((point, index) => `${x(index)},${y(point.percent)}`).join(" ");
  const active = hover == null ? null : points[hover];
  const yTicks = [];
  const step = yMax - yMin > 40 ? 20 : 10;
  for (let tick = yMin; tick <= yMax + 1e-8; tick += step) yTicks.push(tick);

  return (
    <section className="panel gpa-trends" aria-label={title}>
      <div className="gpa-trends-head">
        <div>
          <h2>{title}</h2>
          <p className="muted">Saved checkpoints only — exam what-ifs are not recorded.</p>
        </div>
      </div>
      <div className="gpa-trends-chart">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Course percent over recorded checkpoints"
          onMouseLeave={() => setHover(null)}
        >
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                className="gpa-trend-grid"
                x1={margin.left}
                x2={width - margin.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className="gpa-trend-axis" x={margin.left - 10} y={y(tick) + 4} textAnchor="end">
                {tick}
              </text>
            </g>
          ))}
          <polyline className="gpa-trend-line cumulative" points={line} />
          {points.map((point, index) => (
            <g key={point.id}>
              <circle
                className="gpa-trend-dot cumulative"
                cx={x(index)}
                cy={y(point.percent)}
                r={hover === index ? 6 : 4}
                onMouseEnter={() => setHover(index)}
              />
              <text className="gpa-trend-axis term" x={x(index)} y={height - 12} textAnchor="middle">
                {formatStamp(point.at)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="gpa-trends-detail" aria-live="polite">
        {active ? (
          <>
            <span className={`letter ${letterClass(active.letter)}`}>{active.letter || "—"}</span>
            <span className="mono">{fmtPct(active.percent)}%</span>
            <span className="muted">{active.at.toLocaleString()}</span>
          </>
        ) : (
          <span className="muted">Hover a point for the recorded letter</span>
        )}
      </div>
    </section>
  );
}

function formatStamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
