import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtGpa, fmtPct, fmtScore, gradeFromPercent } from "./api";
import { Tooltip } from "./creditLabel.jsx";

const COURSE_COLOR_CANDIDATES = [
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
  "#60a5fa",
  "#fb7185",
  "#34d399",
  "#f97316",
  "#c084fc",
  "#2dd4bf",
  "#facc15",
  "#fb923c",
];
const DEFAULT_OVERALL_POINT_COLOR = "#c084fc";
// Keep only a small exclusion bubble around the primary color. Related hues
// such as yellow/orange/green remain available unless they are truly close.
const PRIMARY_COLOR_BUBBLE_RADIUS = 48;

function parseHexColor(value) {
  const match = String(value || "").trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return null;
  const hex = match[1].length === 3
    ? match[1].split("").map((part) => `${part}${part}`).join("")
    : match[1];
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function colorDistance(first, second) {
  const a = parseHexColor(first);
  const b = parseHexColor(second);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.sqrt(a.reduce((sum, value, index) => sum + ((value - b[index]) ** 2), 0));
}

function courseColorsForPrimary(primaryColor) {
  const primary = parseHexColor(primaryColor);
  const available = COURSE_COLOR_CANDIDATES.filter((color) => colorDistance(color, primaryColor) >= PRIMARY_COLOR_BUBBLE_RADIUS);
  const palette = available.length >= 3
    ? available
    : COURSE_COLOR_CANDIDATES.filter((color) => colorDistance(color, primaryColor) >= PRIMARY_COLOR_BUBBLE_RADIUS * 0.65);
  const colors = palette.length ? palette : COURSE_COLOR_CANDIDATES;
  if (!primary) return colors;
  const seed = (primary[0] * 31 + primary[1] * 17 + primary[2] * 13) % colors.length;
  return [...colors.slice(seed), ...colors.slice(0, seed)];
}

function mmdd(iso) {
  if (!iso) return "";
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(iso)) ? String(iso) : `${iso}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}/${day}`;
}

function courseKey(snapshotId, courseId) {
  return `c:${snapshotId}:${courseId}`;
}

function gpaKey(snapshotId) {
  return `g:${snapshotId}`;
}

function overlapSegmentPath(cx, cy, outerRadius, innerRadius, startAngle, endAngle) {
  const point = (radius, angle) => ({
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  });
  const outerStart = point(outerRadius, startAngle);
  const outerEnd = point(outerRadius, endAngle);
  if (innerRadius <= 0) {
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    return [
      `M ${cx} ${cy}`,
      `L ${outerStart.x} ${outerStart.y}`,
      `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
      "Z",
    ].join(" ");
  }
  const innerEnd = point(innerRadius, endAngle);
  const innerStart = point(innerRadius, startAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function notifySnapshotUpdate() {
  window.dispatchEvent(new CustomEvent("grade-snapshots-updated"));
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

export default function SemesterProgressChart({ semesterId, locked = false, onLock, onToast, weightedGpa = false, currentGpa, currentWgpa, currentScore, hasGpaOverrides = false, courses = [], targetGp = 4, gpaBasis = "credits", highSchoolMode = false, colorAssignmentGrades = true, showScore = false, primaryColor = DEFAULT_OVERALL_POINT_COLOR }) {
  const [snapshots, setSnapshots] = useState([]);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [view, setView] = useState("classes");
  const [axisSpacing, setAxisSpacing] = useState(() => {
    try {
      return window.localStorage.getItem("grade-progress-axis-spacing") === "value" ? "value" : "uniform";
    } catch {
      return "uniform";
    }
  });
  const [focused, setFocused] = useState(null);
  const [foregroundCourseId, setForegroundCourseId] = useState(null);
  const [foregroundOverall, setForegroundOverall] = useState(false);
  const [finalPointRecordedAt, setFinalPointRecordedAt] = useState(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!focused) return undefined;
    function clearOutsideChart(event) {
      if (!chartRef.current?.contains(event.target)) setFocused(null);
    }
    document.addEventListener("click", clearOutsideChart);
    return () => document.removeEventListener("click", clearOutsideChart);
  }, [focused]);

  async function load() {
    if (!semesterId) return;
    const data = await api.semesterSnapshots(semesterId);
    setSnapshots(data);
  }

  useEffect(() => {
    setDeleting(false);
    setSelected(new Set());
    setFocused(null);
    setForegroundCourseId(null);
    setForegroundOverall(false);
    setView("classes");
    load().catch((err) => onToast?.(err.message));
    function onUpdated() {
      load().catch(() => {});
    }
    window.addEventListener("grade-snapshots-updated", onUpdated);
    return () => {
      window.removeEventListener("grade-snapshots-updated", onUpdated);
    };
  }, [semesterId]);

  useEffect(() => {
    function onAxisSpacingChanged(event) {
      if (event.detail === "uniform" || event.detail === "value") setAxisSpacing(event.detail);
    }
    window.addEventListener("grade-progress-axis-spacing", onAxisSpacingChanged);
    return () => window.removeEventListener("grade-progress-axis-spacing", onAxisSpacingChanged);
  }, []);

  useEffect(() => {
    if (!weightedGpa && view === "wgpa") {
      setView("gpa");
      setFocused(null);
    }
    if (!showScore && (view === "score" || view === "class-score")) {
      setView("classes");
      setFocused(null);
    }
  }, [showScore, weightedGpa, view]);

  function setGlobalAxisSpacing(next) {
    if (next !== "uniform" && next !== "value") return;
    setAxisSpacing(next);
    try {
      window.localStorage.setItem("grade-progress-axis-spacing", next);
    } catch {
      // Local storage can be unavailable in private or embedded contexts.
    }
    window.dispatchEvent(new CustomEvent("grade-progress-axis-spacing", { detail: next }));
  }

  const showOverall = view === "gpa" || view === "wgpa" || view === "score";
  const showGrades = view === "classes";
  const showClasses = showGrades || view === "class-gp" || view === "class-score" || view === "gpa" || view === "score";
  const classMetric = view === "class-gp" || view === "gpa" ? "gp" : view === "class-score" || view === "score" ? "score" : "percent";
  const showOverallScore = view === "score";
  const showWeighted = view === "wgpa";
  const gpaLabel = showWeighted ? "WGPA" : "GPA";
  const coursesById = useMemo(() => new Map((courses || []).map((course) => [String(course.id), course])), [courses]);
  const classPointValue = (point, metric = classMetric) => {
    const percent = Number(point?.percent);
    if (!Number.isFinite(percent)) return null;
    if (metric === "percent") return percent;
    if (metric === "score" && Number.isFinite(Number(point?.score))) return Number(point.score);
    const course = coursesById.get(String(point.course_id));
    const grade = gradeFromPercent(percent, course?.scale, course?.grade_rounding ?? null);
    const gp = Number(grade.quality_points);
    if (!Number.isFinite(gp)) return null;
    if (metric === "gp") return gp;
    const units = highSchoolMode || gpaBasis === "classes" ? 1 : Number(course?.credits) || 0;
    return units > 0 ? Math.round(3 * (gp - Number(targetGp)) * units) : null;
  };
  const snapshotScore = (snapshot) => {
    if (Number.isFinite(Number(snapshot?.term_score))) return Number(snapshot.term_score);
    // Checkpoints recorded before the persisted score field was introduced
    // retain their prior display behavior until recorded again.
    return (snapshot?.courses || [])
      .map((point) => classPointValue(point, "score"))
      .filter((value) => value != null)
      .reduce((sum, value) => sum + value, 0);
  };
  const hasFinalValue = locked
    && hasGpaOverrides
    && (showOverallScore
      ? currentScore != null && Number.isFinite(Number(currentScore))
      : [currentGpa, currentWgpa].some((value) => value != null && Number.isFinite(Number(value))));

  useEffect(() => {
    if (hasFinalValue) {
      setFinalPointRecordedAt((value) => value || new Date().toISOString());
    } else {
      setFinalPointRecordedAt(null);
    }
  }, [hasFinalValue]);

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
      // The overall point is a derived, saved summary. It disappears only
      // after the final individual class point for that day is removed.
      if (point?.kind === "gpa") return;
      if (key) togglePoint(key);
      return;
    }
    setFocused(point);
    setForegroundCourseId(point?.kind === "course" ? point.courseId : null);
    setForegroundOverall(point?.kind === "gpa");
  }

  async function onDeleteModeClick() {
    if (!deleting) {
      setDeleting(true);
      setSelected(new Set());
      setFocused(null);
      setForegroundCourseId(null);
      setForegroundOverall(false);
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

  const width = 860;
  const baseHeight = 300;
  const maxHeight = 500;
  const margin = { top: 20, right: 24, bottom: 54, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const snapshotGpa = (snap) => (showWeighted ? snap.term_wgpa : snap.term_gpa);

  // Progression points use the raw GPA/WGPA stored with each checkpoint.
  // A locked semester with overrides also gets a temporary final point using
  // the effective GPA, without creating a persisted/deletable snapshot.
  const finalGpaSnapshot = showOverall && hasFinalValue && finalPointRecordedAt
    ? {
        id: "final-gpa",
        // Keep the final point on the same calendar day as the latest
        // recorded checkpoint rather than creating a new day on the axis.
        recorded_at: snapshots.at(-1)?.recorded_at || finalPointRecordedAt,
        term_gpa: currentGpa,
        term_wgpa: currentWgpa,
        term_score: currentScore,
        isFinalGpa: true,
      }
    : null;
  const displayedSnapshots = finalGpaSnapshot ? [...snapshots, finalGpaSnapshot] : snapshots;
  const overallPointColor = primaryColor || DEFAULT_OVERALL_POINT_COLOR;
  const courseColors = useMemo(() => courseColorsForPrimary(overallPointColor), [overallPointColor]);

  const series = useMemo(() => {
    const codes = new Map();
    for (const snap of displayedSnapshots) {
      for (const course of snap.courses || []) {
        if (!codes.has(course.course_id)) {
          codes.set(course.course_id, {
            courseId: course.course_id,
            code: course.code,
            color: courseColors[codes.size % courseColors.length],
          });
        }
      }
    }
    return [...codes.values()];
  }, [courseColors, displayedSnapshots]);

  const percents = displayedSnapshots.flatMap((snap) =>
    (snap.courses || []).map((c) => c.percent).filter((n) => n != null && Number.isFinite(Number(n)))
  );
  const gpas = displayedSnapshots.map(snapshotGpa).filter((n) => n != null && Number.isFinite(Number(n)));
  const classValues = displayedSnapshots.flatMap((snap) => (snap.courses || [])
    .map((point) => classPointValue(point))
    .filter((value) => value != null && Number.isFinite(Number(value))));
  const overallScores = displayedSnapshots.map((snap) => snap.isFinalGpa ? snap.term_score : snapshotScore(snap))
    .filter((value) => value != null && Number.isFinite(Number(value)));
  const hasRecordedValues = (showClasses && classValues.length > 0) || (showOverall && (showOverallScore ? overallScores.length > 0 : gpas.length > 0));
  const isPercentChart = showGrades;
  const graphValues = [
    ...(showClasses ? classValues : []),
    ...(showOverall ? (showOverallScore ? overallScores : gpas) : []),
  ];
  const valueMin = graphValues.length ? Math.min(...graphValues) : 0;
  const valueMax = graphValues.length ? Math.max(...graphValues) : (showOverallScore ? 0 : 4);

  // Keep a small buffer around the actual plotted range, but do not clamp a
  // class percentage or score chart to 0–100: bonuses can legitimately put a
  // grade outside the usual percentage range.
  const pctMin = percents.length ? Math.max(0, Math.floor(Math.min(...percents) / 5) * 5 - 5) : 0;
  const pctDataMax = percents.length ? Math.max(0, Math.max(...percents)) : 100;
  const allowedMajorSteps = [1, 2, 4, 5, 10, 20, 25];
  const pctCharHeight = 11;
  const minimumLabelPitch = pctCharHeight * 2;
  const maximumPlotHeight = maxHeight - margin.top - margin.bottom;
  const pctMajorStep = allowedMajorSteps.find((step) => {
    // Keep the tick sequence anchored to global zero-based multiples so 100
    // stays aligned whenever it falls inside the visible range. Add one
    // complete major interval above the next major point after the highest
    // grade (e.g. 97 -> 105 with a 5 step).
    const candidateMax = Math.ceil(pctDataMax / step) * step + step;
    const candidateRange = Math.max(1, candidateMax - pctMin);
    const requiredPlotHeight = (candidateRange / step) * minimumLabelPitch;
    return requiredPlotHeight <= maximumPlotHeight;
  }) || allowedMajorSteps[allowedMajorSteps.length - 1];
  const pctMax = Math.ceil(pctDataMax / pctMajorStep) * pctMajorStep + pctMajorStep;
  const pctRange = Math.max(1, pctMax - pctMin);
  const pctMinorStep = pctMajorStep / 2;
  const requiredPlotHeight = (pctRange / pctMajorStep) * minimumLabelPitch;
  const height = isPercentChart
    ? Math.min(maxHeight, Math.max(baseHeight, Math.ceil(margin.top + margin.bottom + requiredPlotHeight)))
    : baseHeight;
  const plotHeight = height - margin.top - margin.bottom;
  const scoreStep = valueMax - valueMin <= 10 ? 1 : valueMax - valueMin <= 50 ? 5 : 10;
  const metricMin = showOverallScore || classMetric === "score"
    ? Math.floor((valueMin - scoreStep) / scoreStep) * scoreStep
    : Math.max(0, Math.floor((valueMin - 0.25) * 4) / 4);
  const metricMax = showOverallScore || classMetric === "score"
    ? Math.ceil((valueMax + scoreStep) / scoreStep) * scoreStep
    : Math.min(5, Math.ceil((valueMax + 0.25) * 4) / 4);
  const metricStep = showOverallScore || classMetric === "score" ? scoreStep : 0.125;

  function snapshotTime(snap) {
    const raw = snap?.recorded_at;
    if (!raw) return 0;
    const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(raw)) ? String(raw) : `${raw}Z`;
    const value = new Date(normalized).getTime();
    return Number.isFinite(value) ? value : 0;
  }
  const snapshotTimes = displayedSnapshots.map(snapshotTime);
  const minTime = snapshotTimes.length ? Math.min(...snapshotTimes) : 0;
  const maxTime = snapshotTimes.length ? Math.max(...snapshotTimes) : 0;
  const x = (index, snap = displayedSnapshots[index]) => {
    const count = displayedSnapshots.length;
    const normalized = axisSpacing === "value" && maxTime > minTime
      ? (snapshotTime(snap) - minTime) / (maxTime - minTime)
      : count === 1 ? 0.5 : index / Math.max(1, count - 1);
    return margin.left + Math.max(0, Math.min(1, normalized)) * plotWidth;
  };
  const pointX = (snap, index) => x(index, snap);
  const yPct = (value) => margin.top + ((pctMax - value) / (pctMax - pctMin || 1)) * plotHeight;
  const yMetric = (value) => margin.top + ((metricMax - value) / (metricMax - metricMin || 1)) * plotHeight;
  const yValue = (value) => isPercentChart ? yPct(value) : yMetric(value);

  const pctTicks = [];
  const firstPctTick = Math.ceil((pctMin - 1e-8) / pctMinorStep) * pctMinorStep;
  for (let value = firstPctTick; value <= pctMax + 1e-8; value += pctMinorStep) {
    const tick = Number(value.toFixed(6));
    const major = Math.abs(tick / pctMajorStep - Math.round(tick / pctMajorStep)) < 1e-8;
    pctTicks.push({ value: tick, major });
  }
  const metricTicks = [];
  for (let value = metricMin; value <= metricMax + 1e-8; value += metricStep) {
    metricTicks.push(Number(value.toFixed(3)));
  }

  const progressionLineGroups = (() => {
    const groups = new Map();
    const overallSegments = [];
    const addSegment = (startIndex, endIndex, previousValue, currentValue, entry) => {
      if (previousValue == null || currentValue == null
        || !Number.isFinite(Number(previousValue)) || !Number.isFinite(Number(currentValue))) return;
      const key = `${startIndex}:${endIndex}:${Number(previousValue).toFixed(6)}:${Number(currentValue).toFixed(6)}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          startIndex,
          endIndex,
          previousValue: Number(previousValue),
          currentValue: Number(currentValue),
          entries: [],
        };
        groups.set(key, group);
      }
      group.entries.push(entry);
    };
    const courseValue = (snap, courseId) => {
      const course = (snap.courses || []).find((item) => item.course_id === courseId);
      if (course?.percent == null || !Number.isFinite(Number(course.percent))) return null;
      return classPointValue(course);
    };
    const overallLineValue = (snap) => showOverallScore
      ? (snap.isFinalGpa ? snap.term_score : snapshotScore(snap))
      : snapshotGpa(snap);

    if (showClasses) {
      series.forEach((item) => {
        let previousPoint = null;
        displayedSnapshots.forEach((snap, index) => {
          const value = courseValue(snap, item.courseId);
          if (value == null || !Number.isFinite(Number(value))) return;
          if (previousPoint) {
            addSegment(previousPoint.index, index, previousPoint.value, value, {
              kind: "course",
              courseId: item.courseId,
              color: item.color,
            });
          }
          previousPoint = { index, value };
        });
      });
    }
    if (showOverall) {
      let previousPoint = null;
      displayedSnapshots.forEach((snap, index) => {
        const value = overallLineValue(snap);
        if (value == null || !Number.isFinite(Number(value))) return;
        if (previousPoint) {
          overallSegments.push({
            startIndex: previousPoint.index,
            endIndex: index,
            previousValue: Number(previousPoint.value),
            currentValue: Number(value),
          });
        }
        previousPoint = { index, value };
      });
    }

    const classGroups = [...groups.values()].map((group) => {
      const color = group.entries.length > 1
        ? "var(--muted)"
        : group.entries[0]?.color;
      return {
        ...group,
        color,
        hasOverall: false,
      };
    });
    return [
      ...classGroups,
      ...overallSegments.map((segment) => ({ ...segment, color: overallPointColor, hasOverall: true })),
    ];
  })();

  // Draw the selected course once more after every ordinary line. This leaves
  // it visually foremost without changing the shared-value pie markers, which
  // are rendered later and therefore remain on top.
  const foregroundLineGroups = foregroundCourseId == null
    ? []
    : progressionLineGroups
      .filter((group) => !group.hasOverall && group.entries?.some((entry) => entry.courseId === foregroundCourseId))
      .map((group) => ({
        ...group,
        color: group.entries.find((entry) => entry.courseId === foregroundCourseId)?.color,
      }));

  const formatValue = (value) => {
    if (isPercentChart) return fmtPct(value);
    if (showOverallScore || classMetric === "score") return fmtScore(value);
    return fmtGpa(value);
  };
  const overallValue = (snap) => showOverallScore
    ? (snap.isFinalGpa ? snap.term_score : snapshotScore(snap))
    : snapshotGpa(snap);
  const chartTitle = showClasses
    ? classMetric === "gp" ? "Class GP over time" : classMetric === "score" ? "Class scores over time" : "Class percents over time"
    : showOverallScore ? "Overall score over time" : `${gpaLabel} over time`;
  // GPA and Score use the global grade-color setting for their target zones.
  // WGPA is intentionally excluded because weighted boosts do not represent
  // an assignment-grade threshold.
  const zoneColoring = colorAssignmentGrades && (view === "gpa" || view === "score");
  const targetLineValue = showOverallScore ? 0 : Number(targetGp);
  const targetY = yValue(targetLineValue);

  const active = hover == null ? null : displayedSnapshots[hover];

  const subtitle = locked
    ? "Progression locked. Unlock to record new checkpoints."
    : deleting
      ? "Click individual points to select them, then Save to delete."
      : showGrades
        ? "Class percents over recorded checkpoints."
        : showOverall
          ? `${gpaLabel === "WGPA" ? "WGPA" : showOverallScore ? "Class scores and overall Score" : "Class GP and GPA"} over recorded checkpoints.`
          : showClasses
            ? (classMetric === "gp" ? "Class GP values calculated from each recorded percent and the current cutoffs." : "Class scores over recorded checkpoints.")
            : `${showOverallScore ? "Overall score" : gpaLabel} over recorded checkpoints. Click a point to see its value.`;

  return (
    <section
      ref={chartRef}
      className={`panel grade-progress ${deleting ? "is-deleting" : ""} ${foregroundCourseId != null || foregroundOverall ? "has-foreground-series" : ""} ${foregroundOverall ? "has-foreground-overall" : ""}`}
      aria-label="Grade progression"
      onClick={(event) => {
        if (!event.target.closest?.(".grade-progress-dot, .grade-progress-overlap-segment")) {
          setFocused(null);
          setForegroundCourseId(null);
          setForegroundOverall(false);
        }
      }}
    >
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
                  aria-selected={showGrades}
                  className={showGrades ? "active" : ""}
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
                {showScore ? (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={showOverallScore}
                    className={showOverallScore ? "active" : ""}
                    onClick={() => {
                      setView("score");
                      setFocused(null);
                    }}
                  >
                    Score
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

      {!hasRecordedValues ? (
        <div className="grade-progress-empty">No recorded values</div>
      ) : (
        <>
          <div className="gpa-trends-legend grade-progress-legend" aria-label="Chart legend">
            {showClasses ? series.map((item) => (
              <span key={item.courseId}>
                <i style={{ background: item.color }} />
                {item.code}
              </span>
            )) : null}
            {showOverall ? (
              <>
                <span>
                  <i className="gpa" style={{ background: overallPointColor }} />
                  {showOverallScore ? "Score" : gpaLabel}
                </span>
                {finalGpaSnapshot ? (
                  <span>
                    <i className="final-gpa" />
                    Final {showOverallScore ? "Score" : gpaLabel}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="gpa-trends-chart">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={chartTitle}
              onMouseLeave={() => setHover(null)}
            >
              {zoneColoring ? (
                <>
                  <rect
                    className="grade-progress-zone grade-progress-zone-high"
                    x={margin.left}
                    y={margin.top}
                    width={plotWidth}
                    height={Math.max(0, Math.min(plotHeight, targetY - margin.top))}
                  />
                  <rect
                    className="grade-progress-zone grade-progress-zone-low"
                    x={margin.left}
                    y={Math.max(margin.top, targetY)}
                    width={plotWidth}
                    height={Math.max(0, margin.top + plotHeight - Math.max(margin.top, targetY))}
                  />
                </>
              ) : null}
              {showClasses && isPercentChart
                ? pctTicks.map((tick) => (
                    <g key={`pct-${tick.value}`}>
                      <line
                        className={`gpa-trend-grid ${tick.major ? "grade-progress-major-grid" : "grade-progress-minor-grid"}`}
                        x1={margin.left}
                        x2={width - margin.right}
                        y1={yPct(tick.value)}
                        y2={yPct(tick.value)}
                      />
                      {tick.major ? (
                        <text className="gpa-trend-axis" x={margin.left - 10} y={yPct(tick.value) + 4} textAnchor="end">
                          {tick.value}
                        </text>
                      ) : null}
                    </g>
                  ))
                : metricTicks.map((tick) => (
                    <g key={`gpa-${tick}`}>
                      <line
                        className="gpa-trend-grid"
                        x1={margin.left}
                        x2={width - margin.right}
                        y1={yMetric(tick)}
                        y2={yMetric(tick)}
                      />
                      <text className="gpa-trend-axis gpa-axis" x={margin.left - 10} y={yMetric(tick) + 4} textAnchor="end">
                        {showOverallScore || classMetric === "score" ? fmtScore(tick) : fmtGpa(tick)}
                      </text>
                    </g>
                  ))}
              {progressionLineGroups.map((group, index) => (
                <polyline
                  key={`progression-line-${group.startIndex}-${group.endIndex}-${index}`}
                  className={group.hasOverall ? `gpa-trend-line cumulative grade-progress-gpa ${showOverallScore ? "grade-progress-score" : ""}` : "grade-progress-line"}
                  style={{ stroke: group.color }}
                  points={`${pointX(displayedSnapshots[group.startIndex], group.startIndex)},${yValue(group.previousValue)} ${pointX(displayedSnapshots[group.endIndex], group.endIndex)},${yValue(group.currentValue)}`}
                  fill="none"
                />
              ))}
              {foregroundLineGroups.map((group, index) => (
                <polyline
                  key={`foreground-progression-line-${group.startIndex}-${group.endIndex}-${index}`}
                  className="grade-progress-line grade-progress-line-foreground"
                  style={{ stroke: group.color }}
                  points={`${pointX(displayedSnapshots[group.startIndex], group.startIndex)},${yValue(group.previousValue)} ${pointX(displayedSnapshots[group.endIndex], group.endIndex)},${yValue(group.currentValue)}`}
                  fill="none"
                  pointerEvents="none"
                />
              ))}
              {displayedSnapshots.map((snap, index) => {
                const gpaMarked = selected.has(gpaKey(snap.id));
                const gpaFocused = focused?.kind === "gpa" && focused.snapshotId === snap.id;
                const gpaRadius = gpaMarked || gpaFocused || hover === index ? 8 : 6.5;
                const coursePoints = showClasses
                  ? series.map((item) => {
                      const course = (snap.courses || []).find((row) => row.course_id === item.courseId);
                      const value = classPointValue(course);
                      if (value == null || !Number.isFinite(Number(value))) return null;
                      const key = courseKey(snap.id, item.courseId);
                      const focusPoint = {
                        kind: "course",
                        snapshotId: snap.id,
                        courseId: item.courseId,
                        code: item.code,
                        recordedAt: snap.recorded_at,
                        value,
                      };
                      return {
                        kind: "course",
                        item,
                        value,
                        key,
                        focusPoint,
                        marked: selected.has(key),
                        focused: focused?.kind === "course"
                          && focused.snapshotId === snap.id
                          && focused.courseId === item.courseId,
                      };
                    }).filter(Boolean)
                  : [];
                const overallPoint = showOverall && overallValue(snap) != null && Number.isFinite(Number(overallValue(snap)))
                  ? {
                      kind: "overall",
                      value: Number(overallValue(snap)),
                      key: snap.isFinalGpa ? null : gpaKey(snap.id),
                      color: overallPointColor,
                      label: snap.isFinalGpa ? `Final ${showOverallScore ? "Score" : gpaLabel}` : showOverallScore ? "Score" : gpaLabel,
                      focusPoint: {
                        kind: "gpa",
                        metric: showOverallScore ? "score" : showWeighted ? "wgpa" : "gpa",
                        snapshotId: snap.id,
                        recordedAt: snap.recorded_at,
                        value: Number(overallValue(snap)),
                        isFinalGpa: snap.isFinalGpa,
                      },
                      marked: !snap.isFinalGpa && gpaMarked,
                      focused: gpaFocused,
                    }
                  : null;
                const plottedPoints = [...coursePoints, ...(overallPoint ? [overallPoint] : [])];
                const pointGroups = [];
                const groupsByValue = new Map();
                plottedPoints.forEach((point) => {
                  const groupKey = point.value.toFixed(6);
                  let group = groupsByValue.get(groupKey);
                  if (!group) {
                    group = { value: point.value, points: [] };
                    groupsByValue.set(groupKey, group);
                    pointGroups.push(group);
                  }
                  group.points.push(point);
                });
                return (
                <g key={snap.id} className="grade-progress-point">
                  <line
                    className="gpa-trend-hit"
                    x1={pointX(snap, index)}
                    x2={pointX(snap, index)}
                    y1={margin.top}
                    y2={margin.top + plotHeight}
                    onMouseEnter={() => setHover(index)}
                  />
                  {plottedPoints.length
                    ? pointGroups.map((group) => {
                        const cx = pointX(snap, index);
                        const cy = yValue(group.value);
                        const focusedPoint = group.points.find((point) => (
                          (point.kind === "course" && point.item.courseId === foregroundCourseId)
                          || (point.kind === "overall" && foregroundOverall)
                        ));
                        // A focused series takes visual ownership of a shared
                        // value, replacing that value's pie with its solid dot.
                        const renderedPoints = focusedPoint ? [focusedPoint] : group.points;
                        if (renderedPoints.length === 1) {
                          const point = renderedPoints[0];
                          const radius = point.marked || point.focused || hover === index ? 9 : 7.5;
                          return (
                            <circle
                              key={`${point.kind}-${point.kind === "course" ? point.item.courseId : "overall"}`}
                              className={`grade-progress-dot ${point.kind === "course" && point.item.courseId === foregroundCourseId ? "is-foreground-course" : ""} ${point.kind === "overall" && foregroundOverall ? "is-foreground-overall" : ""} ${point.marked || point.focused ? "is-selected" : ""}`}
                              cx={cx}
                              cy={cy}
                              r={radius}
                              fill={point.kind === "course" ? point.item.color : point.color}
                              style={{ fill: point.kind === "course" ? point.item.color : point.color }}
                              tabIndex={0}
                              role="button"
                              aria-label={`${point.kind === "course" ? point.item.code : point.label} ${formatValue(point.value)}`}
                              onMouseEnter={() => setHover(index)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  onPointClick(event, point.key, point.focusPoint);
                                }
                              }}
                              onClick={(event) => onPointClick(event, point.key, point.focusPoint)}
                            />
                          );
                        }
                        const outerRadius = renderedPoints.some((point) => point.marked || point.focused) || hover === index ? 9 : 7.5;
                        const innerRadius = 0;
                        return (
                          <g
                            key={`overlap-${group.value}`}
                            className="grade-progress-overlap"
                            aria-label={`${mmdd(snap.recorded_at)}: ${group.points.map((point) => `${point.kind === "course" ? point.item.code : point.label} ${formatValue(point.value)}`).join(", ")}`}
                          >
                            <title>
                              {group.points.map((point) => `${point.kind === "course" ? point.item.code : point.label}: ${formatValue(point.value)}`).join("; ")}
                            </title>
                            {renderedPoints.map((point, pointIndex) => {
                              const slice = (Math.PI * 2) / renderedPoints.length;
                              const gap = Math.min(0.035, slice / 8);
                              const startAngle = -Math.PI / 2 + pointIndex * slice + gap;
                              const endAngle = -Math.PI / 2 + (pointIndex + 1) * slice - gap;
                              return (
                                <path
                                  key={`${point.kind}-${point.kind === "course" ? point.item.courseId : "overall"}`}
                                  className={`grade-progress-overlap-segment ${point.kind === "course" && point.item.courseId === foregroundCourseId ? "is-foreground-course" : ""} ${point.kind === "overall" && foregroundOverall ? "is-foreground-overall" : ""} ${point.marked || point.focused ? "is-selected" : ""}`}
                                  d={overlapSegmentPath(cx, cy, outerRadius, innerRadius, startAngle, endAngle)}
                                  fill={point.kind === "course" ? point.item.color : point.color}
                                  style={{ fill: point.kind === "course" ? point.item.color : point.color }}
                                  tabIndex={0}
                                  role="button"
                                  aria-label={`${point.kind === "course" ? point.item.code : point.label} ${formatValue(point.value)}`}
                                  onMouseEnter={() => setHover(index)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      onPointClick(event, point.key, point.focusPoint);
                                    }
                                  }}
                                  onClick={(event) => onPointClick(event, point.key, point.focusPoint)}
                                />
                              );
                            })}
                          </g>
                        );
                      })
                    : null}
                  <text className="gpa-trend-axis term" x={pointX(snap, index)} y={height - 20} textAnchor="middle">
                    {snap.isFinalGpa
                      ? mmdd(snap.recorded_at)
                      : displayedSnapshots[index + 1]?.isFinalGpa
                        ? ""
                        : mmdd(snap.recorded_at)}
                  </text>
                </g>
                );
              })}
            </svg>
          </div>
          <div className="grade-progress-axis-spacing" role="group" aria-label="Date spacing">
            <button
              type="button"
              className={axisSpacing === "uniform" ? "active" : ""}
              aria-label="Uniform date spacing"
              aria-pressed={axisSpacing === "uniform"}
              onClick={() => setGlobalAxisSpacing("uniform")}
            >
              <span className="grade-progress-axis-spacing-icon grade-progress-axis-spacing-icon-square" aria-hidden="true" />
            </button>
            <span aria-hidden="true">|</span>
            <button
              type="button"
              className={axisSpacing === "value" ? "active" : ""}
              aria-label="Date spacing by elapsed time"
              aria-pressed={axisSpacing === "value"}
              onClick={() => setGlobalAxisSpacing("value")}
            >
              <span className="grade-progress-axis-spacing-icon grade-progress-axis-spacing-icon-rectangle" aria-hidden="true" />
            </button>
          </div>
          <div className="gpa-trends-detail" aria-live="polite">
            {focused ? (
              <>
                <strong>{focused.isFinalGpa ? `Final ${showOverallScore ? "Score" : gpaLabel}` : mmdd(focused.recordedAt)}</strong>
                <span>
                  {focused.kind === "gpa" ? (focused.metric === "wgpa" ? "WGPA" : focused.metric === "score" ? "Score" : "GPA") : focused.code}{" "}
                  <b className="mono">
                    {focused.kind === "gpa" ? formatValue(focused.value) : formatValue(focused.value)}
                  </b>
                </span>
              </>
            ) : active ? (
              <>
                <strong>{active.isFinalGpa ? `Final ${showOverallScore ? "Score" : gpaLabel}` : mmdd(active.recorded_at)}</strong>
                {showClasses ? (
                  (active.courses || [])
                    .map((c) => ({ course: c, value: classPointValue(c) }))
                    .filter(({ value }) => value != null)
                    .map(({ course, value }) => (
                      <span key={course.course_id}>
                        {course.display_code || course.code} <b className="mono">{formatValue(value)}</b>
                      </span>
                    ))
                ) : null}
                {showOverall ? (
                  <span>
                    {showOverallScore ? "Score" : gpaLabel} <b className="mono">{formatValue(overallValue(active))}</b>
                  </span>
                ) : null}
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
