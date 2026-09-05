import { useEffect, useMemo, useState } from "react";
import { api, fmtGpa, fmtPct } from "./api";
import { Tooltip } from "./creditLabel.jsx";

const COURSE_COLORS = [
  "#4cc9f0",
  "#52b788",
  "#ffd166",
  "#f4a261",
  "#e76f51",
  "#a78bfa",
  "#f472b6",
  "#38bdf8",
  "#86efac",
  "#fbbf24",
];

function mmdd(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}`;
}

function courseKey(snapshotId, courseId) {
  return `c:${snapshotId}:${courseId}`;
}

function gpaKey(snapshotId) {
  return `g:${snapshotId}`;
}

const SNAPSHOT_UPDATE_KEY = "grade-calculator-snapshots-updated-v1";

function notifySnapshotUpdate() {
  window.dispatchEvent(new CustomEvent("grade-snapshots-updated"));
  try {
    window.localStorage.setItem(SNAPSHOT_UPDATE_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
}

function parseSelectedKeys(keys) {
  const course_points = [];
  const gpa_snapshot_ids = [];
  for (const key of keys) {
    if (key.startsWith("c:")) {
      const [, snapshotId, courseId] = key.split(":");
      course_points.push({ snapshot_id: Number(snapshotId), course_id: Number(courseId) });
    } else if (key.startsWith("g:")) {
      gpa_snapshot_ids.push(Number(key.slice(2)));
    }
  }
  return { course_points, gpa_snapshot_ids };
}

export default function SemesterProgressChart({ semesterId, locked = false, onLock, onToast, weightedGpa = false, currentGpa, currentWgpa }) {
  const [snapshots, setSnapshots] = useState([]);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [view, setView] = useState("classes");
  const [focused, setFocused] = useState(null);

  async function load() {
    if (!semesterId) return;
    const data = await api.semesterSnapshots(semesterId);
    setSnapshots(data);
  }

  useEffect(() => {
    setDeleting(false);
    setSelected(new Set());
    setFocused(null);
    setView("classes");
    load().catch((err) => onToast?.(err.message));
    function onUpdated() {
      load().catch(() => {});
    }
    function onStorage(event) {
      if (event.key !== SNAPSHOT_UPDATE_KEY) return;
      load().catch(() => {});
    }
    window.addEventListener("grade-snapshots-updated", onUpdated);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("grade-snapshots-updated", onUpdated);
      window.removeEventListener("storage", onStorage);
    };
  }, [semesterId]);

  useEffect(() => {
    if (!weightedGpa && view === "wgpa") {
      setView("gpa");
      setFocused(null);
    }
  }, [weightedGpa, view]);

  const displayedSnapshots = useMemo(() => {
    if (!snapshots.length) return snapshots;
    const latestIndex = snapshots.length - 1;
    return snapshots.map((snapshot, index) => {
      if (index !== latestIndex) return snapshot;
      const latest = { ...snapshot };
      // A checkpoint keeps its historical course points, while its latest
      // summary follows the current term so weight-tag edits are visible.
      if (currentGpa != null) latest.term_gpa = currentGpa;
      if (currentWgpa != null) latest.term_wgpa = currentWgpa;
      return latest;
    });
  }, [snapshots, currentGpa, currentWgpa]);

  async function recordGrades() {
    if (!semesterId || busy || locked || deleting) return;
    setBusy(true);
    try {
      await api.recordSemesterSnapshot(semesterId);
      await load();
    } catch (err) {
      onToast?.(err.message || "Could not record grades");
    } finally {
      setBusy(false);
    }
  }

  function togglePoint(key) {
    if (!deleting) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function onPointClick(event, key, point) {
    event.stopPropagation();
    if (deleting) {
      togglePoint(key);
      return;
    }
    setFocused(point);
  }

  async function onDeleteModeClick() {
    if (!deleting) {
      setDeleting(true);
      setSelected(new Set());
      setFocused(null);
      return;
    }
    const { course_points, gpa_snapshot_ids } = parseSelectedKeys(selected);
    if (!course_points.length && !gpa_snapshot_ids.length) {
      setDeleting(false);
      return;
    }
    setBusy(true);
    try {
      await api.deleteSemesterSnapshots(semesterId, { course_points, gpa_snapshot_ids });
      // Notify every mounted chart immediately. The current chart also reloads
      // below, while charts on other pages/terms fetch the updated checkpoints.
      notifySnapshotUpdate();
      setDeleting(false);
      setSelected(new Set());
      await load();
    } catch (err) {
      onToast?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  const series = useMemo(() => {
    const codes = new Map();
    for (const snap of displayedSnapshots) {
      for (const course of snap.courses || []) {
        if (!codes.has(course.course_id)) {
          codes.set(course.course_id, {
            courseId: course.course_id,
            code: course.code,
            color: COURSE_COLORS[codes.size % COURSE_COLORS.length],
          });
        }
      }
    }
    return [...codes.values()];
  }, [displayedSnapshots]);

  const width = 860;
  const height = 300;
  const margin = { top: 20, right: 24, bottom: 54, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const showClasses = view === "classes";
  const showWeighted = view === "wgpa";
  const gpaLabel = showWeighted ? "WGPA" : "GPA";
  const snapshotGpa = (snap) => (showWeighted ? snap.term_wgpa : snap.term_gpa);

  const percents = displayedSnapshots.flatMap((snap) =>
    (snap.courses || []).map((c) => c.percent).filter((n) => n != null && Number.isFinite(Number(n)))
  );
  const gpas = displayedSnapshots.map(snapshotGpa).filter((n) => n != null && Number.isFinite(Number(n)));
  const pctMin = percents.length ? Math.max(0, Math.floor(Math.min(...percents) / 5) * 5 - 5) : 0;
  const pctMax = percents.length ? Math.min(110, Math.ceil(Math.max(...percents) / 5) * 5 + 5) : 100;
  const gpaMin = gpas.length ? Math.max(0, Math.floor((Math.min(...gpas) - 0.1) * 4) / 4) : 0;
  const gpaMax = gpas.length ? Math.min(5, Math.ceil((Math.max(...gpas) + 0.1) * 4) / 4) : 4;

  const x = (index) =>
    margin.left + (displayedSnapshots.length === 1 ? plotWidth / 2 : (index / (displayedSnapshots.length - 1)) * plotWidth);
  const yPct = (value) => margin.top + ((pctMax - value) / (pctMax - pctMin || 1)) * plotHeight;
  const yGpa = (value) => margin.top + ((gpaMax - value) / (gpaMax - gpaMin || 1)) * plotHeight;

  const pctTicks = [];
  for (let value = pctMin; value <= pctMax + 1e-8; value += Math.max(5, Math.round((pctMax - pctMin) / 5) || 5)) {
    pctTicks.push(value);
  }
  const gpaTicks = [];
  const gpaStep = 0.125;
  for (let value = gpaMin; value <= gpaMax + 1e-8; value += gpaStep) {
    gpaTicks.push(Number(value.toFixed(3)));
  }

  function courseLine(courseId) {
    const segments = [];
    let segment = [];
    displayedSnapshots.forEach((snap, index) => {
      const course = (snap.courses || []).find((item) => item.course_id === courseId);
      if (course?.percent == null || !Number.isFinite(Number(course.percent))) {
        if (segment.length) segments.push(segment.join(" "));
        segment = [];
        return;
      }
      segment.push(`${x(index)},${yPct(Number(course.percent))}`);
    });
    if (segment.length) segments.push(segment.join(" "));
    return segments;
  }

  const gpaLine = (() => {
    const segments = [];
    let segment = [];
    displayedSnapshots.forEach((snap, index) => {
      const gpa = snapshotGpa(snap);
      if (gpa == null || !Number.isFinite(Number(gpa))) {
        if (segment.length) segments.push(segment.join(" "));
        segment = [];
        return;
      }
      segment.push(`${x(index)},${yGpa(Number(gpa))}`);
    });
    if (segment.length) segments.push(segment.join(" "));
    return segments;
  })();

  const active = hover == null ? null : displayedSnapshots[hover];

  const subtitle = locked
    ? "Progression locked. Unlock to record new checkpoints."
    : deleting
      ? "Click individual points to select them, then Save to delete."
      : showClasses
        ? "Class percents over recorded checkpoints. Click a point to see its score."
        : `${gpaLabel} over recorded checkpoints. Click a point to see its score.`;

  return (
    <section className={`panel grade-progress ${deleting ? "is-deleting" : ""}`} aria-label="Grade progression">
      <div className="gpa-trends-head">
        <div>
          <div className="tooltip-heading">
            <h2>Grade progression</h2>
            <Tooltip text={subtitle} />
            {snapshots.length ? (
              <div className="grade-progress-toggle" role="tablist" aria-label="Chart view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={showClasses}
                  className={showClasses ? "active" : ""}
                  onClick={() => {
                    setView("classes");
                    setFocused(null);
                  }}
                >
                  Grades
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "gpa"}
                  className={view === "gpa" ? "active" : ""}
                  onClick={() => {
                    setView("gpa");
                    setFocused(null);
                  }}
                >
                  GPA
                </button>
                {weightedGpa ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={showWeighted}
                    className={showWeighted ? "active" : ""}
                    onClick={() => {
                      setView("wgpa");
                      setFocused(null);
                    }}
                  >
                    WGPA
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="grade-progress-actions">
          <button
            className="btn small"
            type="button"
            onClick={() => onLock?.(!locked)}
          >
            {locked ? "Unlock" : "Lock"}
          </button>
          {snapshots.length ? (
            <button
              className={`btn small ${deleting ? "primary" : ""}`}
              type="button"
              disabled={busy || locked}
              onClick={onDeleteModeClick}
            >
              {deleting ? "Save" : "Delete points"}
            </button>
          ) : null}
          <button className="btn small" type="button" disabled={busy || locked || deleting} onClick={recordGrades}>
            {busy && !deleting ? "Recording…" : "Record grades"}
          </button>
        </div>
      </div>

      {!snapshots.length ? (
        <div className="grade-progress-empty">No recorded grades</div>
      ) : (
        <>
          <div className="gpa-trends-legend grade-progress-legend" aria-label="Chart legend">
            {showClasses
              ? series.map((item) => (
                  <span key={item.courseId}>
                    <i style={{ background: item.color }} />
                    {item.code}
                  </span>
                ))
              : (
                <span>
                  <i className="gpa" />
                  {gpaLabel}
                </span>
              )}
          </div>
          <div className="gpa-trends-chart">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={showClasses ? "Class percents over time" : `${gpaLabel} over time`}
              onMouseLeave={() => setHover(null)}
            >
              {showClasses
                ? pctTicks.map((tick) => (
                    <g key={`pct-${tick}`}>
                      <line
                        className="gpa-trend-grid"
                        x1={margin.left}
                        x2={width - margin.right}
                        y1={yPct(tick)}
                        y2={yPct(tick)}
                      />
                      <text className="gpa-trend-axis" x={margin.left - 10} y={yPct(tick) + 4} textAnchor="end">
                        {tick}
                      </text>
                    </g>
                  ))
                : gpaTicks.map((tick) => (
                    <g key={`gpa-${tick}`}>
                      <line
                        className="gpa-trend-grid"
                        x1={margin.left}
                        x2={width - margin.right}
                        y1={yGpa(tick)}
                        y2={yGpa(tick)}
                      />
                      <text className="gpa-trend-axis gpa-axis" x={margin.left - 10} y={yGpa(tick) + 4} textAnchor="end">
                        {fmtGpa(tick)}
                      </text>
                    </g>
                  ))}
              {showClasses
                ? series.flatMap((item) => courseLine(item.courseId).map((points, index) => (
                    <polyline
                      key={`${item.courseId}-${index}`}
                      className="grade-progress-line"
                      style={{ stroke: item.color }}
                      points={points}
                      fill="none"
                    />
                  )))
                : (
                  gpaLine.map((points, index) => <polyline key={`gpa-${index}`} className="gpa-trend-line cumulative grade-progress-gpa" points={points} fill="none" />)
                )}
              {displayedSnapshots.map((snap, index) => {
                const gpaMarked = selected.has(gpaKey(snap.id));
                const gpaFocused = focused?.kind === "gpa" && focused.snapshotId === snap.id;
                const gpaRadius = gpaMarked || gpaFocused || hover === index ? 8 : 6.5;
                return (
                <g key={snap.id} className="grade-progress-point">
                  <line
                    className="gpa-trend-hit"
                    x1={x(index)}
                    x2={x(index)}
                    y1={margin.top}
                    y2={margin.top + plotHeight}
                    onMouseEnter={() => setHover(index)}
                  />
                  {showClasses
                    ? series.map((item) => {
                        const course = (snap.courses || []).find((row) => row.course_id === item.courseId);
                        if (course?.percent == null || !Number.isFinite(Number(course.percent))) return null;
                        const key = courseKey(snap.id, item.courseId);
                        const marked = selected.has(key);
                        const isFocused =
                          focused?.kind === "course"
                          && focused.snapshotId === snap.id
                          && focused.courseId === item.courseId;
                        const radius = marked || isFocused || hover === index ? 8 : 6.5;
                        return (
                          <circle
                            key={item.courseId}
                            className={`grade-progress-dot ${marked || isFocused ? "is-selected" : ""}`}
                            cx={x(index)}
                            cy={yPct(Number(course.percent))}
                            r={radius}
                            fill={item.color}
                            onMouseEnter={() => setHover(index)}
                            onClick={(event) =>
                              onPointClick(event, key, {
                                kind: "course",
                                snapshotId: snap.id,
                                courseId: item.courseId,
                                code: item.code,
                                recordedAt: snap.recorded_at,
                                value: Number(course.percent),
                              })
                            }
                          />
                        );
                      })
                    : snapshotGpa(snap) != null && Number.isFinite(Number(snapshotGpa(snap))) ? (
                      <circle
                        className={`grade-progress-dot gpa ${gpaMarked || gpaFocused ? "is-selected" : ""}`}
                        cx={x(index)}
                        cy={yGpa(Number(snapshotGpa(snap)))}
                        r={gpaRadius}
                        onMouseEnter={() => setHover(index)}
                        onClick={(event) =>
                          onPointClick(event, gpaKey(snap.id), {
                            kind: "gpa",
                            metric: showWeighted ? "wgpa" : "gpa",
                            snapshotId: snap.id,
                            recordedAt: snap.recorded_at,
                            value: Number(snapshotGpa(snap)),
                          })
                        }
                      />
                    ) : null}
                  <text className="gpa-trend-axis term" x={x(index)} y={height - 20} textAnchor="middle">
                    {mmdd(snap.recorded_at)}
                  </text>
                </g>
                );
              })}
            </svg>
          </div>
          <div className="gpa-trends-detail" aria-live="polite">
            {focused ? (
              <>
                <strong>{mmdd(focused.recordedAt)}</strong>
                <span>
                  {focused.kind === "gpa" ? (focused.metric === "wgpa" ? "WGPA" : "GPA") : focused.code}{" "}
                  <b className="mono">
                    {focused.kind === "gpa" ? fmtGpa(focused.value) : fmtPct(focused.value)}
                  </b>
                </span>
              </>
            ) : active ? (
              <>
                <strong>{mmdd(active.recorded_at)}</strong>
                {showClasses ? (
                  (active.courses || [])
                    .filter((c) => c.percent != null)
                    .map((c) => (
                      <span key={c.course_id}>
                        {c.display_code || c.code} <b className="mono">{fmtPct(c.percent)}</b>
                      </span>
                    ))
                ) : (
                  <span>
                    {gpaLabel} <b className="mono">{fmtGpa(snapshotGpa(active))}</b>
                  </span>
                )}
              </>
            ) : (
              <span className="muted">
                {deleting ? "Click a point to select it" : "Click a point to see its score, or hover for values"}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
