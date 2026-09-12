import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, dashboardCourseGradeClass, fmtDelta, fmtGpa, fmtPct, fmtScore, letterClass, passFailGradeIsFailing, scoreClass } from "./api";
import { Tooltip, useCreditTerms, useGpaBasis, useShowScore } from "./creditLabel.jsx";
import { useAnimatedNumber } from "./useAnimatedNumber";
import { ExamImpactStats } from "./ExamImpact.jsx";
import { TERM_SEQUENCE, semesterSortValue, sortSemesters } from "./seasons.js";
import { buildCourseDisplayCodes } from "./courseNames.js";

function AnimatedValue({ value, format, integerFrames = false }) {
  const animated = useAnimatedNumber(value, 600, { integerFrames });
  return <>{format(animated)}</>;
}

const fmtAnimatedScore = (value) => fmtScore(value == null ? null : Number(Number(value).toFixed(2)));
const fmtAnimatedHundredth = (value) => fmtScore(value == null ? null : Number(Number(value).toFixed(2)));
const fmtUnitValue = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const text = Number(number.toFixed(3)).toString();
  return text.replace(/^(-?)0\./, "$1.");
};
const fmtGuessCount = (value) => {
  if (value == null || value === "") return "";
  if (typeof value === "string" && value.trim().endsWith(".")) {
    return value.replace(/^(-?)0\./, "$1.");
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number(number.toFixed(3)).toString().replace(/^(-?)0\./, "$1.");
};

function isGradedCreditSummaryCourse(course) {
  if (!course || course.gp_override === -1) return false;
  return course.quality_points != null || course.pass_fail_override != null || course.letter != null;
}

function isDashboardVisibleCourse(course) {
  return Boolean(course) && course.gp_override !== -1;
}

function isPassingCreditSummaryCourse(course) {
  if (course.credit_mode === "pass_fail") {
    const letter = course.pass_fail_override ?? course.letter;
    return Boolean(letter) && !passFailGradeIsFailing(course, letter);
  }
  const current = (course.scale || []).find((row) => row.letter === course.letter);
  const passing = (course.scale || []).find((row) => row.letter === (course.minimum_passing_letter || "C-"));
  if (!current || !passing) return Number(course.quality_points) > 0;
  return Number(current.min_percent) >= Number(passing.min_percent);
}

function fumblesBySemester(terms, fumbles, highSchoolMode = false, periodGroups = [], semesterTitles = []) {
  const groups = [];
  const seen = new Set();
  const courseNames = buildCourseDisplayCodes(terms, null, semesterTitles);
  const visibleCourseIds = new Set(
    (terms || []).flatMap((term) => (
      (term.courses || []).filter(isDashboardVisibleCourse).map((course) => String(course.id))
    )),
  );
  const labeledFumbles = (fumbles || [])
    .filter((row) => visibleCourseIds.has(String(row.course_id)))
    .map((row) => ({
      ...row,
      code: courseNames.get(row.course_id) || row.code,
    }));
  if (highSchoolMode) {
    const periodByCourseId = new Map();
    const periodBySemesterId = new Map();
    const periodOrder = new Map();
    (periodGroups || []).forEach((group, index) => {
      periodOrder.set(group.id, index);
      (group.terms || []).forEach((term) => periodBySemesterId.set(String(term.id), group));
      (group.courses || []).forEach((course) => periodByCourseId.set(String(course.id), group));
    });
    const byPeriod = new Map();
    for (const row of labeledFumbles) {
      const group = periodByCourseId.get(String(row.course_id)) || periodBySemesterId.get(String(row.semester_id));
      const key = group?.id || `semester-${row.semester_id}`;
      const current = byPeriod.get(key) || {
        term: { id: key, name: group?.name || row.semester_name || "Other" },
        rows: [],
        order: group ? periodOrder.get(group.id) : Number.MAX_SAFE_INTEGER,
      };
      current.rows.push(row);
      byPeriod.set(key, current);
    }
    return [...byPeriod.values()].sort((a, b) => a.order - b.order);
  }
  for (const term of terms || []) {
    const rows = labeledFumbles.filter((row) => row.semester_id === term.id);
    if (!rows.length) continue;
    groups.push({ term, rows });
    for (const row of rows) seen.add(row.id);
  }
  const leftover = labeledFumbles.filter((row) => !seen.has(row.id));
  if (leftover.length) {
    groups.push({ term: { id: "other", name: "Other" }, rows: leftover });
  }
  return groups;
}

function FumbleCourseSelect({ terms, fumbles, value, onChange, highSchoolMode = false, periodGroups = [], overallClasses = [], scale = [], semesterTitles = [] }) {
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const rootRef = useRef(null);
  const groups = useMemo(
    () => {
      if (!highSchoolMode) {
        return (terms || [])
          .map((term) => ({ ...term, courses: (term.courses || []).filter(isDashboardVisibleCourse) }))
          .filter((term) => term.courses.length);
      }
      const overallByPeriod = new Map();
      (overallClasses || []).forEach((course) => {
        if (course?.id == null) return;
        const key = String(course.period);
        const current = overallByPeriod.get(key) || [];
        current.push(course);
        overallByPeriod.set(key, current);
      });
      return (periodGroups || [])
        .map((group) => ({
          ...group,
          // Multi-term classes must be represented by their overall period
          // result, not by an individual term row.
          courses: overallByPeriod.get(String(group.period_key)) || [],
        }))
        .filter((group) => group.courses.length);
    }, [highSchoolMode, overallClasses, periodGroups, terms]
  );
  const displayCodes = useMemo(() => buildCourseDisplayCodes(terms, null, semesterTitles), [semesterTitles, terms]);
  const selectableCourses = useMemo(
    () => groups.flatMap((group) => group.courses || []),
    [groups],
  );
  const menuWidthCh = useMemo(() => {
    const longestLabel = selectableCourses.reduce((longest, course) => {
      const code = displayCodes.get(course.id) || course.display_code || course.code || "Class";
      const { actualGp, actualLetter } = fumbleCourseGrade(course, scale);
      const label = `${code} (${actualLetter ? `${actualLetter}${actualGp != null ? ` ${fmtGpa(actualGp)}` : ""}` : "--"})`;
      return Math.max(longest, label.length);
    }, 0);
    // Size from every available class, including collapsed groups, so opening
    // or selecting a different class never changes the menu width.
    return Math.min(50, Math.max(24, longestLabel + 2));
  }, [displayCodes, scale, selectableCourses]);
  const selected = selectableCourses.find((course) => String(course.id) === String(value))
    || (terms || [])
      .flatMap((term) => term.courses || [])
      .filter(isDashboardVisibleCourse)
      .find((course) => String(course.id) === String(value));
  const selectedGrade = fumbleCourseGrade(selected, scale);
  const addedCourseIds = new Set((fumbles || []).map((fumble) => String(fumble.course_id)));

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setOpenGroups((current) => {
      if (current.size) return current;
      const selectedTerm = groups.find((term) =>
        term.courses.some((course) => String(course.id) === String(value))
      );
      const first = selectedTerm || groups[0];
      return first ? new Set([first.id]) : current;
    });
  }, [open, groups, value]);

  function toggleGroup(id) {
    setOpenGroups((current) => {
      if (current.has(id)) return new Set();
      return new Set([id]);
    });
  }

  return (
    <div
      className="fumble-course-select"
      ref={rootRef}
      style={{ "--fumble-course-menu-width": `${menuWidthCh}ch` }}
    >
      <button
        type="button"
        className="select exam-multi-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={`fumble-course-selected-label ${selected ? "" : "muted"}`}>
          {selected ? displayCodes.get(selected.id) || selected.display_code || selected.code : "Class"}
        </span>
        {selected ? (
          <span className={`fumble-course-selected-grade ${selectedGrade.actualLetter ? letterClass(selectedGrade.actualLetter) : "fumble-grade-empty"}`}>
            ({selectedGrade.actualLetter
              ? `${selectedGrade.actualLetter}${selectedGrade.actualGp != null ? ` ${fmtGpa(selectedGrade.actualGp)}` : ""}`
              : "--"})
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="exam-multi-menu fumble-course-menu"
          role="listbox"
        >
          {groups.length === 0 ? (
            <div className="muted exam-multi-empty">No classes</div>
          ) : (
            groups.map((group) => {
              const expanded = openGroups.has(group.id);
              return (
                <div key={group.id} className="fumble-course-group">
                  <button
                    type="button"
                    className="fumble-course-term"
                    aria-expanded={expanded}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <span className={`term-accordion-chevron ${expanded ? "open" : ""}`}>▸</span>
                    {group.name}
                  </button>
                  {expanded
                    ? group.courses.map((course) => (
                        <button
                          key={course.id}
                          type="button"
                          role="option"
                          aria-selected={String(course.id) === String(value)}
                          className={`exam-multi-option fumble-course-option ${
                            addedCourseIds.has(String(course.id)) ? "is-added" : ""
                          }`}
                          onClick={() => {
                            onChange(String(course.id));
                            setOpen(false);
                          }}
                        >
                          <span className="fumble-course-option-name">
                            {displayCodes.get(course.id) || course.display_code || course.code}
                          </span>
                          {(() => {
                            const { actualGp, actualGrade, actualLetter } = fumbleCourseGrade(course, scale);
                            return (
                              <span className={`fumble-course-option-grade ${actualLetter ? letterClass(actualLetter) : "fumble-grade-empty"}`}>
                                ({actualLetter
                                  ? `${actualLetter}${actualGp != null ? ` ${fmtGpa(actualGp)}` : ""}`
                                  : "--"})
                              </span>
                            );
                          })()}
                        </button>
                      ))
                    : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
const fmtAnimatedCredits = (value) => (value == null ? "—" : Number(Number(value).toFixed(2)));

const FALLBACK_LETTERS = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];
const CREDITS = [1, 2, 3, 4];
const GRADE_SORT_KEYS = new Set(["letter", "gpa"]);

function highSchoolScoreForTerms(terms, targetGp = 4) {
  const includedTerms = (terms || []).filter((term) => term.included);
  if (!includedTerms.length) return null;
  return highSchoolScoreForCourses(
    includedTerms.flatMap((term) => term.courses || []),
    includedTerms.length,
    targetGp,
  );
}

function highSchoolScoreForCourses(courses, termCount, targetGp = 4) {
  if (!termCount) return null;
  const classes = new Map();
  (courses || []).forEach((course) => {
    if (!isDashboardVisibleCourse(course)) return;
    const key = String(course.code || "").trim().toLowerCase();
    if (!key) return;
    const current = classes.get(key) || { count: 0, final: null, latestId: -1 };
    current.count += 1;
    const id = Number(course.id) || 0;
    if (course.quality_points != null && course.gp_override !== -1 && (!current.final || id >= current.latestId)) {
      current.final = course;
      current.latestId = id;
    }
    classes.set(key, current);
  });
  const graded = [...classes.values()].filter((item) => item.final);
  if (!graded.length) return null;
  return graded.reduce((sum, item) => {
    const units = item.count / termCount;
    const qualityPoints = item.final.base_quality_points ?? item.final.quality_points;
    return sum + Math.round((Number(qualityPoints) - Number(targetGp)) * 3) * units;
  }, 0);
}

function highSchoolAcademicYearKey(term) {
  const year = Number(term?.year) || 0;
  return String(year - (["spring", "summer"].includes(String(term?.season || "").toLowerCase()) ? 1 : 0));
}

function configuredHighSchoolTermCount(term, highSchoolTerms = [], highSchoolTermsByPeriod = {}) {
  const periodTerms = highSchoolTermsByPeriod?.[highSchoolAcademicYearKey(term)];
  if (Array.isArray(periodTerms) && periodTerms.length) return periodTerms.length;
  return Array.isArray(highSchoolTerms) && highSchoolTerms.length ? highSchoolTerms.length : 0;
}

function highSchoolPeriodTermCount(terms, highSchoolTerms = [], highSchoolTermsByPeriod = {}) {
  const actualCount = Array.isArray(terms) ? terms.length : 0;
  const configuredCount = (terms || []).reduce(
    (largest, term) => Math.max(largest, configuredHighSchoolTermCount(term, highSchoolTerms, highSchoolTermsByPeriod)),
    0,
  );
  return Math.max(actualCount, configuredCount);
}

function lettersFromScale(scale) {
  const letters = (Array.isArray(scale) ? scale : [])
    .filter((row) => row.letter !== "F")
    .map((row) => row.letter);
  return letters.length ? letters : FALLBACK_LETTERS;
}

function gradeFill(letter) {
  const cls = letterClass(letter) || "grade-f";
  return `var(--${cls})`;
}

function polar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function annularPath(cx, cy, outerR, innerR, startAngle, endAngle) {
  const sweep = endAngle - startAngle;
  if (sweep >= 359.999) {
    return [
      `M ${cx} ${cy - outerR}`,
      `A ${outerR} ${outerR} 0 1 1 ${cx} ${cy + outerR}`,
      `A ${outerR} ${outerR} 0 1 1 ${cx} ${cy - outerR}`,
      `M ${cx} ${cy - innerR}`,
      `A ${innerR} ${innerR} 0 1 0 ${cx} ${cy + innerR}`,
      `A ${innerR} ${innerR} 0 1 0 ${cx} ${cy - innerR}`,
      "Z",
    ].join(" ");
  }
  const [ox1, oy1] = polar(cx, cy, outerR, startAngle);
  const [ox2, oy2] = polar(cx, cy, outerR, endAngle);
  const [ix2, iy2] = polar(cx, cy, innerR, endAngle);
  const [ix1, iy1] = polar(cx, cy, innerR, startAngle);
  const large = sweep > 180 ? 1 : 0;
  return [
    `M ${ox1} ${oy1}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${ox2} ${oy2}`,
    `L ${ix2} ${iy2}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${ix1} ${iy1}`,
    "Z",
  ].join(" ");
}

function buildSlices(rows, valueKey) {
  const active = rows.filter((d) => d[valueKey] > 0);
  const total = active.reduce((sum, d) => sum + d[valueKey], 0);
  if (!total) return { slices: [], total: 0 };
  let angle = 0;
  const slices = active.map((d) => {
    const sweep = (d[valueKey] / total) * 360;
    const start = angle;
    angle += sweep;
    return {
      letter: d.letter,
      value: d[valueKey],
      pct: d[valueKey] / total,
      credits: d.credit_hours,
      creditPct: d.credit_pct,
      courses: d.courses,
      coursePct: d.course_pct,
      displayValue: d.displayValue,
      start,
      end: angle,
      color: d.color || gradeFill(d.letter),
    };
  });
  return { slices, total };
}

function scoreDistributionFromCourses(courses, chartDistribution) {
  const groups = new Map();
  for (const course of courses || []) {
    if (!isDashboardVisibleCourse(course)) continue;
    const letter = course.credit_mode === "pass_fail"
      ? (course.pass_fail_override || course.letter)
      : course.letter;
    const score = Number(course.score);
    if (!letter || !Number.isFinite(score)) continue;
    const current = groups.get(letter) || {
      letter,
      score: 0,
      courses: 0,
      credit_hours: 0,
      course,
    };
    current.score += score;
    current.courses += 1;
    current.credit_hours += Number(course.credits) || 0;
    groups.set(letter, current);
  }

  const order = new Map((chartDistribution || []).map((row, index) => [row.letter, index]));
  const rows = [...groups.values()]
    .sort((a, b) => (order.get(a.letter) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.letter) ?? Number.MAX_SAFE_INTEGER))
    .map((group) => ({
      letter: group.letter,
      score_abs: Math.abs(group.score),
      courses: group.courses,
      credit_hours: group.credit_hours,
      displayValue: fmtScore(group.score),
      color: chartDistribution.find((row) => row.letter === group.letter)?.color
        || `var(--${dashboardCourseGradeClass(group.course)})`,
    }));
  return {
    ...buildSlices(rows, "score_abs"),
    netScore: [...groups.values()].reduce((sum, group) => sum + group.score, 0),
  };
}

/** Keep letters through the lowest grade that still has credits; drop everything below. */
function truncateDistribution(distribution) {
  let last = -1;
  for (let i = 0; i < distribution.length; i += 1) {
    if (distribution[i].credit_hours > 0) last = i;
  }
  if (last < 0) return [];
  return distribution.slice(0, last + 1);
}

function distributionCoursePercent(course) {
  return course?.percent ?? course?.overall_percent;
}

function DistributionTable({ distribution, courses = [], displayCodes = new Map(), simplified = false, periodMode = false, showUnits = false, courseHref, termLabel = "Semester" }) {
  const creditTerms = useCreditTerms();
  const classBasis = useGpaBasis() === "classes";
  const uniformCredits = courses.length > 0 && new Set(courses.map((course) => Number(course.credits) || 0)).size === 1;
  const hideCreditColumns = periodMode || showUnits || classBasis || uniformCredits;
  const [expanded, setExpanded] = useState({});
  const passFailCourses = courses.filter((course) => course.credit_mode === "pass_fail");
  const hasPassFail = passFailCourses.length > 0;
  const passFailGroups = new Map();
  passFailCourses.forEach((course) => {
    const label = course.pass_fail_override || course.letter || "—";
    const group = passFailGroups.get(label) || { label, courses: [], credit_hours: 0 };
    group.courses.push(course);
    group.credit_hours += Number(course.credits) || 0;
    passFailGroups.set(label, group);
  });
  const passFailRows = [...passFailGroups.values()].map((group) => ({
    ...group,
    className: dashboardCourseGradeClass(group.courses[0]),
  }));
  const passFailCredits = passFailRows.reduce((sum, row) => sum + row.credit_hours, 0);
  const passFailLabels = new Set(
    passFailCourses
      .map((course) => course.pass_fail_override || course.letter)
      .filter(Boolean)
  );
  // Pass/fail courses are rendered below with their configured labels (S/U,
  // or a custom pair). Do not also render the generic fallback row from an
  // older distribution payload, or the same courses are counted twice.
  const rowsThroughPassFail = truncateDistribution(distribution).filter(
    (row) => !(hasPassFail && (row.letter === "Pass/Fail" || passFailLabels.has(row.letter)))
  );
  // The distribution payload may include a populated pass/fail row after a
  // run of empty standard-letter rows. Trim those empty rows after removing
  // pass/fail so the pass/fail row can follow the lowest actual letter.
  let lastStandardRow = -1;
  rowsThroughPassFail.forEach((row, index) => {
    if ((Number(row.credit_hours) || 0) > 0 || (Number(row.courses) || 0) > 0) lastStandardRow = index;
  });
  const rows = rowsThroughPassFail.slice(0, lastStandardRow + 1);
  if (!rows.length && !hasPassFail) return null;
  const expandableRows = rows.filter((row) => courses.some((course) => course.letter === row.letter));
  const passFailKeys = passFailRows.map((row) => `Pass/Fail:${row.label}`);
  const expandableKeys = [
    ...expandableRows.map((row) => row.letter),
    ...passFailKeys,
  ];
  const allExpanded = expandableKeys.length > 0 && expandableKeys.every((key) => expanded[key]);
  const tableCreditTotal = rows.reduce((sum, row) => sum + (Number(row.credit_hours) || 0), 0) + passFailCredits;
  const tableCourseTotal = rows.reduce((sum, row) => sum + (Number(row.courses) || 0), 0) + passFailCourses.length;
  const toggleAll = () => {
    const next = {};
    expandableKeys.forEach((key) => {
      next[key] = !allExpanded;
    });
    setExpanded(next);
  };
  return (
    <table style={{ marginTop: 16 }}>
      <thead>
        <tr>
          <th>
            {!simplified ? (
              <button className="table-expander-all" type="button" onClick={toggleAll} aria-label="Expand or collapse all grades">
              {allExpanded ? "−" : "+"}
            </button>
            ) : null}
            Letter
          </th>
          {showUnits ? <th>Units</th> : null}
          {!hideCreditColumns ? <th>{creditTerms.label}</th> : null}
          {!hideCreditColumns ? <th>% {creditTerms.plural}</th> : null}
          <th>Courses</th>
          <th>% courses</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => {
          const gradeCourses = courses.filter((course) => course.letter === d.letter);
          const isExpanded = !!expanded[d.letter];
          return (
            <Fragment key={d.letter}>
              <tr className={gradeCourses.length === 0 ? "distribution-empty-row" : ""}>
                <td>
                  {!simplified && gradeCourses.length > 0 ? (
                    <button
                      className="table-row-chevron"
                      type="button"
                      onClick={() => setExpanded((current) => ({ ...current, [d.letter]: !current[d.letter] }))}
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} ${d.letter} classes`}
                      aria-expanded={isExpanded}
                    >
                      ▸
                    </button>
                  ) : !simplified ? (
                    <span className="table-row-chevron" aria-hidden="true" />
                  ) : null}
                  <span className={`letter ${letterClass(d.letter)}`}>{d.letter}</span>
                </td>
                {showUnits ? <td className="mono">{fmtUnitValue(d.credit_hours)}</td> : null}
                {!hideCreditColumns ? <td className="mono">{fmtUnitValue(d.credit_hours)}</td> : null}
                {!hideCreditColumns ? <td className="mono">{fmtPct(tableCreditTotal ? (d.credit_hours / tableCreditTotal) * 100 : 0, 1)}%</td> : null}
                <td className="mono">{d.courses}</td>
                <td className="mono">{fmtPct(tableCourseTotal ? (d.courses / tableCourseTotal) * 100 : 0, 1)}%</td>
              </tr>
              {!simplified && isExpanded ? (
                <tr className="distribution-detail-row">
              <td colSpan={showUnits ? 4 : (hideCreditColumns ? 3 : 5)}>
                    <div className="distribution-course distribution-course-head">
                      <span>Class</span>
                      <span>Grade</span>
                      <span>{periodMode ? "Period" : termLabel}</span>
                      {!periodMode ? <span>{creditTerms.label}</span> : null}
                    </div>
                    {gradeCourses.map((course) => (
                      <div className="distribution-course" key={course.id}>
                        <span>
                          <Link to={courseHref?.(course) || `/courses/${course.id}`}>
                            {displayCodes.get(course.id) || course.display_code || course.code || course.course_code || course.name || "Class"}
                          </Link>
                        </span>
                        <span className="course-letter-display">
                          <span className="mono">{distributionCoursePercent(course) == null ? "-%" : `${fmtPct(distributionCoursePercent(course), 2)}%`}</span>
                          {course.gp_override != null || course.pass_fail_override != null ? <span className="grade-override-marker percentage-override-marker" aria-label="Grade overridden">*</span> : null}
                        </span>
                        <span>{(periodMode ? course.period : course.semester) || course.semester || "—"}</span>
                        {!periodMode ? <span className="mono">{fmtUnitValue(course.credits)}</span> : null}
                      </div>
                    ))}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
        {passFailRows.map((row) => {
          const rowKey = `Pass/Fail:${row.label}`;
          const isExpanded = !!expanded[rowKey];
          return (
            <Fragment key={rowKey}>
              <tr>
                <td>
                  {!simplified ? (
                    <button
                      className="table-row-chevron"
                      type="button"
                      onClick={() => setExpanded((current) => ({ ...current, [rowKey]: !current[rowKey] }))}
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} ${row.label} classes`}
                      aria-expanded={isExpanded}
                    >
                      ▸
                    </button>
                  ) : null}
                  <span className={`letter ${row.className}`}>{row.label}</span>
                </td>
                {showUnits ? <td className="mono">{fmtUnitValue(row.credit_hours)}</td> : null}
                {!hideCreditColumns ? <td className="mono">{fmtUnitValue(row.credit_hours)}</td> : null}
                {!hideCreditColumns ? <td className="mono">{fmtPct(tableCreditTotal ? (row.credit_hours / tableCreditTotal) * 100 : 0, 1)}%</td> : null}
                <td className="mono">{row.courses.length}</td>
                <td className="mono">{fmtPct(tableCourseTotal ? (row.courses.length / tableCourseTotal) * 100 : 0, 1)}%</td>
              </tr>
              {!simplified && isExpanded ? (
                <tr className="distribution-detail-row">
                  <td colSpan={showUnits ? 4 : (hideCreditColumns ? 3 : 5)}>
                    <div className="distribution-course distribution-course-head">
                      <span>Class</span>
                      <span>Grade</span>
                      <span>{periodMode ? "Period" : termLabel}</span>
                      {!periodMode ? <span>{creditTerms.label}</span> : null}
                    </div>
                    {row.courses.map((course) => (
                      <div className="distribution-course" key={course.id}>
                        <span>
                          <Link to={courseHref?.(course) || `/courses/${course.id}`}>
                            {displayCodes.get(course.id) || course.display_code || course.code || course.course_code || course.name || "Class"}
                          </Link>
                        </span>
                        <span className="course-letter-display">
                          <span className={`letter ${dashboardCourseGradeClass(course)}`}>{course.pass_fail_override || course.letter || "—"}</span>
                        </span>
                        <span>{(periodMode ? course.period : course.semester) || course.semester || "—"}</span>
                        {!periodMode ? <span className="mono">{fmtUnitValue(course.credits)}</span> : null}
                      </div>
                    ))}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function DonutChart({ title, slices, total, centerTotal = total, centerValueClass = "", hoverValueFirst = false, unit, hoverUnit = unit, hoverDetailValue, hoverDetailUnit, emptyLabel, compact = false, onHover }) {
  const [hover, setHover] = useState(null);
  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 86;
  const innerR = 52;

  if (!slices.length) {
    return (
      <div className="donut-card">
        <div className="donut-title">{title}</div>
        <p className="muted" style={{ margin: "48px 0" }}>
          {emptyLabel}
        </p>
      </div>
    );
  }

  const tip = hover || null;
  const hoverDetail = (slice) => {
    if (typeof hoverDetailValue === "function") {
      const value = fmtUnitValue(hoverDetailValue(slice));
      return value ? `${value}${hoverDetailUnit ? ` ${hoverDetailUnit}` : ""}` : "";
    }
    return `${fmtPct(slice.pct * 100, 1)}%`;
  };

  return (
    <div className={`donut-card ${compact ? "compact" : ""}`}>
      <div className="donut-title">{title}</div>
      <div className="donut-figure">
        <svg
          className="pie-chart"
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          role="img"
          aria-label={`${title} grade distribution`}
          onMouseLeave={() => {
            setHover(null);
            onHover?.(null);
          }}
        >
          {slices.map((s) => (
            <path
              key={s.letter}
              d={annularPath(cx, cy, outerR, innerR, s.start, s.end)}
              fill={s.color}
              className={`donut-slice ${hover?.letter === s.letter ? "active" : ""}`}
              onMouseEnter={() => {
                setHover(s);
                onHover?.(s);
              }}
            >
              <title>
                {s.letter}: {s.displayValue ?? s.value} {unit} ({hoverDetail(s)})
              </title>
            </path>
          ))}
        </svg>
        <div className="donut-center">
          {!compact && tip ? (
            <>
              <div className={`donut-center-letter letter ${letterClass(tip.letter)}`}>{tip.letter}</div>
              {hoverValueFirst ? (
                <>
                  <div className={`donut-center-value mono ${scoreClass(tip.displayValue ?? tip.value)}`}>{tip.displayValue ?? tip.value}{hoverUnit ? ` ${hoverUnit}` : ""}</div>
                  <div className="donut-center-label">{hoverDetail(tip)}</div>
                </>
              ) : (
                <>
                  <div className="donut-center-value mono">{fmtPct(tip.pct * 100, 1)}%</div>
                  <div className="donut-center-label">{tip.displayValue ?? tip.value} {unit}</div>
                </>
              )}
            </>
          ) : (
            <>
              <div className={`donut-center-value mono ${centerValueClass}`}>{centerTotal}</div>
              <div className="donut-center-label">{unit}</div>
            </>
          )}
        </div>
      </div>
      {!compact ? (
        <div className={`donut-tooltip muted ${tip ? "has-detail" : ""}`.trim()}>
          {tip ? (
            <>
              <strong>
                {hoverDetail(tip)} <span className={`letter ${letterClass(tip.letter)}`}>{tip.letter}</span>
              </strong>
              <span>{tip.displayValue ?? tip.value} {hoverUnit || unit}</span>
            </>
          ) : "Hover a slice for details"}
        </div>
      ) : null}
    </div>
  );
}

function GradeDistributionCharts({ distribution, courses = [], compact = false, showScoreChart = false, scoreTotal = null }) {
  const [hover, setHover] = useState(null);
  const creditTerms = useCreditTerms();
  const chartDistribution = useMemo(
    () => (courses.length ? distributionFromCourses(courses, FALLBACK_LETTERS, true) : distribution),
    [courses, distribution]
  );
  const byCredits = useMemo(() => buildSlices(chartDistribution, "credit_hours"), [chartDistribution]);
  const byCourses = useMemo(() => buildSlices(chartDistribution, "courses"), [chartDistribution]);
  const byScore = useMemo(() => scoreDistributionFromCourses(courses, chartDistribution), [courses, chartDistribution]);
  const uniformCredits = courses.length > 0 && new Set(courses.map((course) => Number(course.credits) || 0)).size === 1;
  const classBasis = useGpaBasis() === "classes";
  const showCreditChart = !uniformCredits && !classBasis;
  const scoreDetailValue = classBasis ? (slice) => slice.courses : (slice) => slice.credits;
  const chartCount = Number(showCreditChart) + 1 + Number(showScoreChart);
  const rowClasses = [
    "dist-charts-row",
    showScoreChart ? `score-chart-count-${chartCount}` : "",
    uniformCredits && !showScoreChart ? "single" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="dist-charts">
      <div className={rowClasses}>
        {showCreditChart ? (
          <DonutChart
            title={creditTerms.label}
            slices={byCredits.slices}
            total={byCredits.total}
            unit={creditTerms.plural}
            emptyLabel={`No graded ${creditTerms.plural} yet.`}
            compact={compact}
            onHover={(slice) => setHover(slice ? { ...slice, unit: creditTerms.plural } : null)}
          />
        ) : null}
        <DonutChart
          title="Courses"
          slices={byCourses.slices}
          total={byCourses.total}
          unit="courses"
          emptyLabel="No graded courses yet."
          compact={compact}
          onHover={(slice) => setHover(slice ? { ...slice, unit: "courses" } : null)}
        />
        {showScoreChart ? (
          <DonutChart
            title="Score"
            slices={byScore.slices}
            total={byScore.total}
            centerTotal={fmtScore(scoreTotal ?? byScore.netScore)}
            centerValueClass={scoreClass(scoreTotal ?? byScore.netScore)}
            hoverValueFirst
            hoverUnit=""
            hoverDetailValue={scoreDetailValue}
            hoverDetailUnit={creditTerms.plural}
            unit="score"
            emptyLabel="No scores yet."
            compact={compact}
            onHover={(slice) => setHover(slice ? {
              ...slice,
              unit: "score",
              hoverDetail: `${fmtUnitValue(scoreDetailValue(slice))} ${creditTerms.plural}`,
            } : null)}
          />
        ) : null}
      </div>
      {compact ? (
        <div className="distribution-hover-hint donut-tooltip muted">
          {hover ? (
            <>
              <strong>
                {hover.hoverDetail || `${fmtPct(hover.pct * 100, 1)}%`} <span className={`letter ${letterClass(hover.letter)}`}>{hover.letter}</span>
              </strong>
              <span>{hover.displayValue ?? hover.value} {hover.unit}</span>
            </>
          ) : "Hover a slice for details"}
        </div>
      ) : null}
    </div>
  );
}

function pluralizeTermLabel(label) {
  const text = String(label || "Term").trim();
  if (/s$/i.test(text)) return text;
  if (/y$/i.test(text)) return `${text.slice(0, -1)}ies`;
  return `${text}s`;
}

function shortTermName(term) {
  if (term.isAcademicPeriod) return term.name;
  const year = String(term.year || "").slice(-2);
  const season = String(term.season || "").slice(0, 3);
  return `${season.charAt(0).toUpperCase()}${season.slice(1)} ’${year}`;
}

function trendCourseQualityPoints(course, weighted, periodMode, weightTags) {
  if (course?.gp_override === -1) return null;
  const base = periodMode ? (course?.base_quality_points ?? course?.quality_points) : course?.quality_points;
  if (base == null) return null;
  if (!weighted) return Number(base);
  if (periodMode) return Number(course.period_weighted_quality_points ?? course.quality_points);
  const tag = (weightTags || []).find((item) => item.id === course.gpa_weight_tag);
  return Number(base) + (Number(tag?.boost) || 0);
}

function trendTermGpa(term, weighted, classBasis, periodMode, weightTags, gpaCap) {
  const stored = weighted ? term?.term_wgpa : term?.term_gpa;
  if (stored != null && Number.isFinite(Number(stored))) return Number(stored);
  const pairs = [];
  for (const course of term?.courses || []) {
    const qualityPoints = trendCourseQualityPoints(course, weighted, periodMode, weightTags);
    if (qualityPoints == null) continue;
    const units = classBasis ? 1 : (Number(course.credits) || 0);
    if (units) pairs.push([units, qualityPoints]);
  }
  if (!pairs.length) return null;
  const totalUnits = pairs.reduce((sum, [units]) => sum + units, 0);
  const value = pairs.reduce((sum, [units, qualityPoints]) => sum + units * qualityPoints, 0) / totalUnits;
  return gpaCap == null ? value : Math.min(value, Number(gpaCap));
}

function GpaTrendChart({ terms, overallClasses = [], gpaCap, periodMode = false, periodOrder = [], semesterTitles = [], weightedGpa = false, showScore = true, weightTags = [], termLabel = "Semester" }) {
  const [hover, setHover] = useState(null);
  const [metric, setMetric] = useState("gpa");
  const classBasis = useGpaBasis() === "classes";
  const metricLabel = metric === "score" ? "Score" : metric === "wgpa" ? "WGPA" : "GPA";
  const termPluralLabel = pluralizeTermLabel(termLabel);
  const lowerTermLabel = String(termLabel || "Term").toLowerCase();

  useEffect(() => {
    if ((!weightedGpa && metric === "wgpa") || (!showScore && metric === "score")) {
      setMetric("gpa");
      setHover(null);
    }
  }, [showScore, weightedGpa, metric]);

  const points = useMemo(() => {
    // Keep excluded terms in the ordered axis data so their labels remain
    // visible, but only retain included terms that have a value to plot.
    const candidates = (terms || [])
      .filter((term) => !term.included || (
        metric === "score"
          ? term.term_score != null
          : trendTermGpa(term, metric === "wgpa", classBasis, periodMode, weightTags, gpaCap) != null
      ));
    const orderedTerms = periodMode
      ? [...candidates].sort((a, b) => {
        const aRank = periodOrder.indexOf(a.name);
        const bRank = periodOrder.indexOf(b.name);
        if (aRank >= 0 || bRank >= 0) {
          if (aRank < 0) return 1;
          if (bRank < 0) return -1;
          if (aRank !== bRank) return aRank - bRank;
        }
        return 0;
      })
      : sortSemesters(candidates, semesterTitles, false);
    let qualityPoints = 0;
    let weightedQualityPoints = 0;
    let credits = 0;
    let cumulativeScore = 0;
    const overallByPeriod = new Map();
    if (periodMode) {
      for (const course of overallClasses || []) {
        const periodKey = String(course.period ?? "");
        if (!periodKey) continue;
        const periodCourses = overallByPeriod.get(periodKey) || [];
        periodCourses.push(course);
        overallByPeriod.set(periodKey, periodCourses);
      }
    }
    return orderedTerms.map((term) => {
      if (!term.included) {
        return {
          ...term,
          semesterGpa: null,
          semesterWgpa: null,
          cumulativeGpa: null,
          cumulativeWgpa: null,
          semesterScore: null,
          cumulativeScore: null,
        };
      }
      const cumulativeCourses = periodMode
        ? overallByPeriod.get(String(term.period_key ?? "")) || []
        : term.courses || [];
      for (const course of cumulativeCourses) {
        const gpaPoints = periodMode
          ? Number(course.quality_points)
          : trendCourseQualityPoints(course, false, periodMode, weightTags);
        const wgpaPoints = periodMode
          ? Number(course.weighted_quality_points ?? course.quality_points)
          : trendCourseQualityPoints(course, true, periodMode, weightTags);
        if (gpaPoints == null && wgpaPoints == null) continue;
        const courseCredits = classBasis
          ? 1
          : periodMode
            ? (Number(course.units) || 0)
            : (Number(course.credits) || 0);
        if (!courseCredits) continue;
        qualityPoints += Number(gpaPoints || 0) * courseCredits;
        weightedQualityPoints += Number(wgpaPoints || 0) * courseCredits;
        credits += courseCredits;
      }
      const semesterGpa = trendTermGpa(term, false, classBasis, periodMode, weightTags, gpaCap);
      const semesterWgpa = trendTermGpa(term, true, classBasis, periodMode, weightTags, gpaCap);
      const semesterScore = Number(term.term_score);
      const metricValue = metric === "score"
        ? semesterScore
        : metric === "wgpa"
          ? semesterWgpa
          : semesterGpa;
      cumulativeScore += Number.isFinite(semesterScore) ? semesterScore : 0;
      return {
        ...term,
        semesterGpa,
        semesterWgpa,
        cumulativeGpa: Number.isFinite(metricValue) && credits
          ? Math.min(qualityPoints / credits, gpaCap == null ? Infinity : Number(gpaCap))
          : null,
        cumulativeWgpa: Number.isFinite(metricValue) && credits
          ? Math.min(weightedQualityPoints / credits, gpaCap == null ? Infinity : Number(gpaCap))
          : null,
        semesterScore: Number.isFinite(semesterScore) ? semesterScore : null,
        cumulativeScore: Number.isFinite(metricValue) ? cumulativeScore : null,
      };
    });
  }, [terms, overallClasses, gpaCap, metric, classBasis, periodMode, periodOrder, semesterTitles, weightTags]);

  const semesterKey = metric === "score" ? "semesterScore" : metric === "wgpa" ? "semesterWgpa" : "semesterGpa";
  const cumulativeKey = metric === "score" ? "cumulativeScore" : metric === "wgpa" ? "cumulativeWgpa" : "cumulativeGpa";
  const hasPlottedPoints = points.some((point) => Number.isFinite(point[semesterKey]) || Number.isFinite(point[cumulativeKey]));

  if (!hasPlottedPoints) {
    return (
      <section className="panel gpa-trends" aria-label="GPA trends">
        <div className="gpa-trends-head">
          <div>
            <h2>GPA trends</h2>
            <p className="muted">Included {termPluralLabel.toLowerCase()}, oldest to newest.</p>
          </div>
        </div>
        <div className="gpa-trends-chart gpa-trends-empty">
          <p className="muted">Include a graded {lowerTermLabel} to see GPA trends.</p>
        </div>
      </section>
    );
  }

  const width = 800;
  const height = 270;
  const margin = { top: 20, right: 24, bottom: 54, left: 52 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const formatMetric = metric === "score" ? fmtScore : fmtGpa;
  const values = points.flatMap((point) => [point[semesterKey], point[cumulativeKey]]).filter(Number.isFinite);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = rawMax - rawMin;
  const targetTickCount = Math.max(4, Math.floor(plotHeight / 34));
  const roughTickStep = spread / targetTickCount;
  const niceTickSteps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
  const tickStep = niceTickSteps.find((step) => step >= roughTickStep) || 1000;
  let yMin = metric === "score" ? Math.floor((rawMin - 0.1) / tickStep) * tickStep : Math.max(0, Math.floor((rawMin - 0.1) / tickStep) * tickStep);
  let yMax = Math.ceil((rawMax + 0.1) / tickStep) * tickStep;
  if (yMax <= yMin) yMax = yMin + tickStep;
  const yTicks = [];
  for (let value = yMin; value <= yMax + 1e-8; value += tickStep) {
    yTicks.push(Number(value.toFixed(3)));
  }
  const x = (index) =>
    margin.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value) => margin.top + ((yMax - value) / (yMax - yMin)) * plotHeight;
  const line = (key) => points
    .map((point, index) => Number.isFinite(point[key]) ? `${x(index)},${y(point[key])}` : null)
    .filter(Boolean)
    .join(" ");
  const active = hover == null ? null : points[hover];

  return (
    <section className="panel gpa-trends" aria-label="GPA trends">
      <div className="gpa-trends-head">
          <div>
            <h2>GPA trends</h2>
            <p className="muted">Included {termPluralLabel.toLowerCase()}, oldest to newest.</p>
          </div>
        <div className="gpa-trends-toggle" role="group" aria-label="Trend metric">
          <button className={metric === "gpa" ? "active" : ""} type="button" onClick={() => { setMetric("gpa"); setHover(null); }}>
            GPA
          </button>
          {weightedGpa ? (
            <button className={metric === "wgpa" ? "active" : ""} type="button" onClick={() => { setMetric("wgpa"); setHover(null); }}>
              WGPA
            </button>
          ) : null}
          {showScore ? (
            <button className={metric === "score" ? "active" : ""} type="button" onClick={() => { setMetric("score"); setHover(null); }}>
              Score
            </button>
          ) : null}
        </div>
        <div className="gpa-trends-legend" aria-label="Chart legend">
          <span><i className="semester" />{termLabel} {metricLabel}</span>
          <span><i className="cumulative" />Cumulative {metricLabel}</span>
        </div>
      </div>
      <div className="gpa-trends-chart">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${termLabel} and cumulative ${metricLabel} over time`}
          onMouseLeave={() => setHover(null)}
        >
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                className={`gpa-trend-grid ${tick === 0 ? "zero" : ""}`}
                x1={margin.left}
                x2={width - margin.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className="gpa-trend-axis" x={margin.left - 10} y={y(tick) + 4} textAnchor="end">
                {formatMetric(tick)}
              </text>
            </g>
          ))}
          <clipPath id="gpa-trend-reveal">
            <rect
              className="gpa-trend-reveal"
              style={{ transformOrigin: `${margin.left}px 0px` }}
              x={margin.left}
              y={0}
              width={plotWidth}
              height={height}
            />
          </clipPath>
          <g clipPath="url(#gpa-trend-reveal)">
            <polyline className="gpa-trend-line semester" points={line(semesterKey)} />
            <polyline className="gpa-trend-line cumulative" points={line(cumulativeKey)} />
          </g>
          {points.map((point, index) => (
            <g key={point.id}>
              {Number.isFinite(point[semesterKey]) || Number.isFinite(point[cumulativeKey]) ? (
                <line
                  className="gpa-trend-hit"
                  x1={x(index)}
                  x2={x(index)}
                  y1={margin.top}
                  y2={margin.top + plotHeight}
                  onMouseEnter={() => setHover(index)}
                />
              ) : null}
              {Number.isFinite(point[semesterKey]) ? (
                <circle
                  className="gpa-trend-dot semester"
                  cx={x(index)}
                  cy={y(point[semesterKey])}
                  r={hover === index ? 6 : 4}
                  onMouseEnter={() => setHover(index)}
                />
              ) : null}
              {Number.isFinite(point[cumulativeKey]) ? (
                <circle
                  className="gpa-trend-dot cumulative"
                  cx={x(index)}
                  cy={y(point[cumulativeKey])}
                  r={hover === index ? 6 : 4}
                  onMouseEnter={() => setHover(index)}
                />
              ) : null}
              <text
                className="gpa-trend-axis term"
                x={index === 0 ? margin.left : index === points.length - 1 ? width - margin.right : x(index)}
                y={height - 20}
                textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
              >
                {shortTermName(point)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="gpa-trends-detail" aria-live="polite">
        {active ? (
          <>
            <strong>{active.name}</strong>
            <span>{termLabel} {metricLabel} <b className="mono">{formatMetric(active[semesterKey])}</b></span>
            <span>Cumulative {metricLabel} <b className="mono">{formatMetric(active[cumulativeKey])}</b></span>
          </>
        ) : (
          <span className="muted">Hover a {lowerTermLabel} for exact {metricLabel}s</span>
        )}
      </div>
    </section>
  );
}

function subjectPrefix(code) {
  const match = String(code || "")
    .trim()
    .match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : String(code || "?").toUpperCase();
}

function distributionFromCourses(courses, letterOrder = FALLBACK_LETTERS, includePassFailLabels = false) {
  const graded = courses.filter((c) => isDashboardVisibleCourse(c) && c.letter && (c.quality_points != null || c.credit_mode === "pass_fail"));
  const regular = graded.filter((c) => c.credit_mode !== "pass_fail");
  const passFail = graded.filter((c) => c.credit_mode === "pass_fail");
  const totalCredits = graded.reduce((sum, c) => sum + (Number(c.credits) || 0), 0);
  const totalCourses = graded.length;
  const extra = [
    ...new Set(
      regular
        .map((c) => c.letter)
        .filter((letter) => letter && !letterOrder.includes(letter))
    ),
  ];
  const rows = [...new Set([...letterOrder, "F", ...extra])].map((letter) => {
    const matched = regular.filter((c) => c.letter === letter);
    const creditHours = matched.reduce((sum, c) => sum + (Number(c.credits) || 0), 0);
    return {
      letter,
      credit_hours: creditHours,
      courses: matched.length,
      credit_pct: totalCredits ? creditHours / totalCredits : 0,
      course_pct: totalCourses ? matched.length / totalCourses : 0,
    };
  });
  if (passFail.length && includePassFailLabels) {
    const passFailGroups = new Map();
    passFail.forEach((course) => {
      const label = course.pass_fail_override || course.letter;
      const current = passFailGroups.get(label) || { courses: [], credits: 0 };
      current.courses.push(course);
      current.credits += Number(course.credits) || 0;
      passFailGroups.set(label, current);
    });
    passFailGroups.forEach((group, label) => {
      rows.push({
        letter: label,
        credit_hours: group.credits,
        courses: group.courses.length,
        credit_pct: totalCredits ? group.credits / totalCredits : 0,
        course_pct: totalCourses ? group.courses.length / totalCourses : 0,
        color: `var(--${dashboardCourseGradeClass(group.courses[0])})`,
      });
    });
  } else if (passFail.length) {
    const creditHours = passFail.reduce((sum, c) => sum + (Number(c.credits) || 0), 0);
    rows.push({
      letter: "Pass/Fail",
      credit_hours: creditHours,
      courses: passFail.length,
      credit_pct: totalCredits ? creditHours / totalCredits : 0,
      course_pct: totalCourses ? passFail.length / totalCourses : 0,
    });
  }
  return rows;
}

function CourseCodeStats({ terms, letterOrder = FALLBACK_LETTERS, embedded = false, minCredits, setMinCredits, courseHref, semesterTitles = [], termLabel = "Semester" }) {
  const creditTerms = useCreditTerms();
  const gpaBasis = useGpaBasis();
  const showScore = useShowScore();
  const showCredits = gpaBasis !== "classes";
  const displayCodes = useMemo(() => buildCourseDisplayCodes(terms, null, semesterTitles), [semesterTitles, terms]);
  const [sortKey, setSortKey] = useState(showScore ? "score" : "gpa");
  const [sortDesc, setSortDesc] = useState(true);
  const [openCode, setOpenCode] = useState(null);

  useEffect(() => {
    if (!showScore && sortKey === "score") setSortKey("gpa");
  }, [showScore, sortKey]);

  const min = Number(minCredits) || 0;

  const rows = useMemo(() => {
    const buckets = new Map();
    for (const term of terms.filter((t) => t.included)) {
      for (const course of term.courses) {
        if (course.quality_points == null && course.credit_mode !== "pass_fail") continue;
        const code = subjectPrefix(course.code);
        const cur = buckets.get(code) || {
          code,
          items: [],
          courses: 0,
          credits: 0,
          gpaCredits: 0,
          score: 0,
          qpCredits: 0,
        };
        const credits = showCredits ? (Number(course.credits) || 0) : 1;
        cur.items.push({ ...course, semester: term.name });
        cur.courses += 1;
        cur.credits += credits;
        cur.score += course.score || 0;
        if (course.quality_points > 0) {
          cur.gpaCredits += credits;
          cur.qpCredits += course.quality_points * credits;
        }
        buckets.set(code, cur);
      }
    }
    return [...buckets.values()].map((row) => ({
      ...row,
      gpa: row.gpaCredits > 0 ? row.qpCredits / row.gpaCredits : null,
      distribution: distributionFromCourses(row.items, letterOrder),
    }));
  }, [terms, letterOrder, showCredits]);

  const filtered = useMemo(() => {
    const list = rows.filter((r) => r.credits >= min);
    const key = {
      code: (r) => r.code,
      courses: (r) => r.courses,
      credits: (r) => r.credits,
      score: (r) => r.score,
      gpa: (r) => r.gpa ?? -1,
    }[sortKey];
    return [...list].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      if (av === bv) return a.code.localeCompare(b.code);
      const cmp = av > bv ? 1 : -1;
      return sortDesc ? -cmp : cmp;
    });
  }, [rows, min, sortKey, sortDesc]);

  const bestByScore = useMemo(
    () => [...rows].filter((r) => r.credits >= min).sort((a, b) => b.score - a.score || b.gpa - a.gpa).slice(0, 5),
    [rows, min]
  );
  const bestByGpa = useMemo(
    () =>
      [...rows]
        .filter((r) => r.credits >= min && r.gpa != null)
        .sort((a, b) => b.gpa - a.gpa || b.score - a.score)
        .slice(0, 5),
    [rows, min]
  );

  function toggleSort(next) {
    if (sortKey === next) setSortDesc((d) => !d);
    else {
      setSortKey(next);
      setSortDesc(next !== "code");
    }
  }

  function toggleCode(code) {
    setOpenCode((prev) => (prev === code ? null : code));
  }

  const cols = [
    ["code", "Code"],
    ["courses", "Courses"],
    showCredits ? ["credits", creditTerms.label] : null,
    showScore ? ["score", "Score"] : null,
    ["gpa", "GPA"],
  ].filter(Boolean);

  return (
    <section className={embedded ? "" : "panel"} style={{ marginTop: embedded ? 0 : 16 }}>
      {filtered.length === 0 ? (
        <div className="empty">
          No subject codes with at least {min} {creditTerms.plural}.
        </div>
      ) : (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="code-stats-table">
            <thead>
              <tr>
                {cols.map(([key, label]) => (
                  <th key={key}>
                    <button className={sortKey === key ? "active" : ""} onClick={() => toggleSort(key)}>
                      {label}
                      {sortKey === key ? (sortDesc ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const open = openCode === r.code;
                return (
                  <Fragment key={r.code}>
                    <tr
                      className={`code-stats-row ${open ? "open" : ""}`}
                      onClick={() => toggleCode(r.code)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && toggleCode(r.code)}
                    >
                      <td>
                        <span className={`term-accordion-chevron ${open ? "open" : ""}`}>▸</span>{" "}
                        <strong>{r.code}</strong>
                      </td>
                      <td className="mono">{r.courses}</td>
                      {showCredits ? <td className="mono">{fmtUnitValue(r.credits)}</td> : null}
                      {showScore ? (
                        <td className={`mono ${scoreClass(r.score)}`}>{fmtScore(r.score)}</td>
                      ) : null}
                      <td className="mono">{fmtGpa(r.gpa)}</td>
                    </tr>
                    {open ? (
                      <tr className="code-stats-detail">
                        <td colSpan={cols.length}>
                          <div className="code-detail-panel" onClick={(e) => e.stopPropagation()}>
                            {r.items.length > 1 ? (
                              <div className="distribution-summary-grid">
                                <GradeDistributionCharts distribution={r.distribution} courses={r.items} showScoreChart={showScore} compact />
                                <DistributionTable distribution={r.distribution} courses={r.items} displayCodes={displayCodes} simplified courseHref={courseHref} termLabel={termLabel} />
                              </div>
                            ) : null}
                            <table className="level-course-table">
                              <thead>
                                <tr>
                                  <th>Class</th>
                                  <th>Percent</th>
                                  {showCredits ? <th>{creditTerms.label}</th> : null}
                                  <th>Letter grade</th>
                                  <th>Score</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.items.map((course) => (
                                  <tr key={`code-${r.code}-${course.id}`}>
                                    <td>
                                      <Link to={courseHref?.(course) || `/courses/${course.id}`}>
                                        {displayCodes.get(course.id) || course.display_code || course.code || "Class"}
                                      </Link>
                                    </td>
                                    <td className={`mono ${course.gp_override === -1 ? "letter-neutral" : dashboardCourseGradeClass(course)}`}>
                                      {fmtPct(course.percent)}
                                    </td>
                                    {showCredits ? <td className="mono">{fmtUnitValue(course.credits)}</td> : null}
                                    <td>
                                      <span className="course-letter-display">
                                        <span className={`letter ${dashboardCourseGradeClass(course)}`}>{course.letter || "—"}</span>
                                        {course.gp_override != null || course.pass_fail_override != null ? <span className="grade-override-marker" aria-label="Grade overridden">*</span> : null}
                                      </span>
                                    </td>
                                    <td className={`mono ${scoreClass(course.score)}`}>{fmtScore(course.score)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CourseLevelStats({ rows, terms, letterOrder = FALLBACK_LETTERS, embedded = false, courseHref, semesterTitles = [], termLabel = "Semester" }) {
  const creditTerms = useCreditTerms();
  const gpaBasis = useGpaBasis();
  const showScore = useShowScore();
  const showCredits = gpaBasis !== "classes";
  const [sortKey, setSortKey] = useState(showScore ? "score" : "gpa");
  const [sortDesc, setSortDesc] = useState(true);
  const [openLevels, setOpenLevels] = useState(() => new Set());

  useEffect(() => {
    if (!showScore && sortKey === "score") setSortKey("gpa");
  }, [showScore, sortKey]);

  const levelScores = useMemo(() => {
    const totals = new Map();
    for (const term of terms || []) {
      if (!term.included) continue;
      for (const course of term.courses || []) {
        const level = course.level_band || "other";
        totals.set(level, (totals.get(level) || 0) + (Number(course.score) || 0));
      }
    }
    return totals;
  }, [terms]);

  const displayRows = (rows || []).map((row) => ({
    ...row,
    score: row.score == null ? levelScores.get(row.level) || 0 : row.score,
  }));

  const coursesByLevel = useMemo(() => {
    const grouped = new Map();
    for (const term of terms || []) {
      if (!term.included) continue;
      for (const course of term.courses || []) {
        const level = course.level_band || "other";
        const items = grouped.get(level) || [];
        items.push({ ...course, semester: term.name });
        grouped.set(level, items);
      }
    }
    for (const items of grouped.values()) {
      items.sort((a, b) => {
        const aCode = String(a.code || a.display_code || "").trim();
        const bCode = String(b.code || b.display_code || "").trim();
        const aPrefix = subjectPrefix(aCode);
        const bPrefix = subjectPrefix(bCode);
        const prefixCompare = aPrefix.localeCompare(bPrefix);
        if (prefixCompare) return prefixCompare;
        const aNumber = Number(aCode.match(/(\d+(?:\.\d+)?)/)?.[1] || Infinity);
        const bNumber = Number(bCode.match(/(\d+(?:\.\d+)?)/)?.[1] || Infinity);
        return aNumber - bNumber || aCode.localeCompare(bCode);
      });
    }
    return grouped;
  }, [terms]);

  const displayCodes = useMemo(() => buildCourseDisplayCodes(terms, null, semesterTitles), [semesterTitles, terms]);

  if (!displayRows.length) return null;

  const sortedRows = [...displayRows].sort((a, b) => {
    const key = {
      level: (row) => (row.level === "other" ? "" : Number(row.level)),
      courses: (row) => row.courses,
      credits: (row) => row.credits,
      score: (row) => row.score,
      gpa: (row) => row.gpa ?? -1,
    }[sortKey];
    const av = key(a);
    const bv = key(b);
    if (av === bv) return a.level.localeCompare(b.level);
    const cmp = av > bv ? 1 : -1;
    return sortDesc ? -cmp : cmp;
  });

  const allLevelsOpen = sortedRows.length > 0 && sortedRows.every((row) => openLevels.has(row.level));

  function toggleSort(next) {
    if (sortKey === next) setSortDesc((current) => !current);
    else {
      setSortKey(next);
      setSortDesc(next !== "level");
    }
  }

  const cols = [
    ["level", "Level"],
    ["courses", "Courses"],
    showCredits ? ["credits", creditTerms.label] : null,
    showScore ? ["score", "Score"] : null,
    ["gpa", "GPA"],
  ].filter(Boolean);

  return (
    <section className={embedded ? "" : "panel"} style={{ marginTop: embedded ? 0 : 16 }}>
      {!embedded ? <h2>Course levels</h2> : null}
      <div className="table-wrap">
        <table className="code-stats-table">
          <thead>
            <tr>
              {cols.map(([key, label]) => (
                <th key={key}>
                  {key === "level" ? (
                    <div className="level-table-header">
                      <button
                        className="table-expander-all"
                        type="button"
                        aria-label={allLevelsOpen ? "Collapse all course levels" : "Expand all course levels"}
                        title={allLevelsOpen ? "Collapse all" : "Expand all"}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenLevels(allLevelsOpen ? new Set() : new Set(sortedRows.map((row) => row.level)));
                        }}
                      >
                        {allLevelsOpen ? "−" : "+"}
                      </button>
                      <button className={sortKey === key ? "active" : ""} onClick={() => toggleSort(key)}>
                        {label}
                        {sortKey === key ? (sortDesc ? " ↓" : " ↑") : ""}
                      </button>
                    </div>
                  ) : (
                    <button className={sortKey === key ? "active" : ""} onClick={() => toggleSort(key)}>
                      {label}
                      {sortKey === key ? (sortDesc ? " ↓" : " ↑") : ""}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const open = openLevels.has(row.level);
              const levelCourses = coursesByLevel.get(row.level) || [];
              return (
                <Fragment key={row.level}>
                  <tr
                    className={`code-stats-row ${open ? "open" : ""}`}
                    onClick={() => setOpenLevels((current) => {
                      const next = new Set(current);
                      if (next.has(row.level)) next.delete(row.level);
                      else next.add(row.level);
                      return next;
                    })}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenLevels((current) => {
                          const next = new Set(current);
                          if (next.has(row.level)) next.delete(row.level);
                          else next.add(row.level);
                          return next;
                        });
                      }
                    }}
                  >
                    <td>
                      <span className={`term-accordion-chevron ${open ? "open" : ""}`}>▸</span>{" "}
                      <strong>{row.level === "other" ? "Other" : `${row.level}-level`}</strong>
                    </td>
                    <td className="mono">{row.courses}</td>
                    {showCredits ? <td className="mono">{fmtUnitValue(row.credits)}</td> : null}
                    {showScore ? <td className={`mono ${scoreClass(row.score)}`}>{fmtScore(row.score)}</td> : null}
                    <td className="mono">{fmtGpa(row.gpa)}</td>
                  </tr>
                  {open ? (
                    <tr className="code-stats-detail">
                      <td colSpan={cols.length}>
                        <div className="level-course-dropdown" onClick={(e) => e.stopPropagation()}>
                          {levelCourses.length > 1 ? (
                            <div className="distribution-summary-grid">
                              <GradeDistributionCharts
                                distribution={distributionFromCourses(levelCourses, letterOrder)}
                                courses={levelCourses}
                                showScoreChart={showScore}
                                compact
                              />
                              <DistributionTable
                                distribution={distributionFromCourses(levelCourses, letterOrder)}
                                courses={levelCourses}
                                displayCodes={displayCodes}
                                simplified
                                courseHref={courseHref}
                                termLabel={termLabel}
                              />
                            </div>
                          ) : null}
                          <table className="level-course-table">
                            <thead>
                              <tr>
                                <th>Class</th>
                                <th>Percent</th>
                                {showCredits ? <th>{creditTerms.label}</th> : null}
                                <th>Letter grade</th>
                                <th>Score</th>
                              </tr>
                            </thead>
                            <tbody>
                              {levelCourses.map((course) => (
                                <tr key={`${row.level}-${course.id}`}>
                                  <td>
                                    <Link to={courseHref?.(course) || `/courses/${course.id}`}>
                                      {displayCodes.get(course.id) || course.display_code || course.code || "Class"}
                                    </Link>
                                  </td>
                                  <td className={`mono ${course.gp_override === -1 ? "letter-neutral" : dashboardCourseGradeClass(course)}`}>
                                    {fmtPct(course.percent)}
                                  </td>
                                  {showCredits ? <td className="mono">{fmtUnitValue(course.credits)}</td> : null}
                                  <td>
                                    <span className="course-letter-display">
                                      <span className={`letter ${dashboardCourseGradeClass(course)}`}>{course.letter || "—"}</span>
                                      {course.gp_override != null || course.pass_fail_override != null ? <span className="grade-override-marker" aria-label="Grade overridden">*</span> : null}
                                    </span>
                                  </td>
                                  <td className={`mono ${scoreClass(course.score)}`}>{fmtScore(course.score)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ClassLabelStats({ terms, classLabels = [], courseLabels = {}, letterOrder = FALLBACK_LETTERS, embedded = false, highSchoolMode = false, periodNames = {}, highSchoolTerms = [], highSchoolTermsByPeriod = {}, targetGp = 4, courseHref, semesterTitles = [], termLabel = "Semester" }) {
  const creditTerms = useCreditTerms();
  const gpaBasis = useGpaBasis();
  const showScore = useShowScore();
  const useCredits = gpaBasis !== "classes";
  const showCredits = !highSchoolMode && useCredits;
  const [sortKey, setSortKey] = useState("label");
  const [sortDesc, setSortDesc] = useState(false);
  const [openLabels, setOpenLabels] = useState(() => new Set());
  const displayCodes = useMemo(() => buildCourseDisplayCodes(terms, null, semesterTitles), [semesterTitles, terms]);
  const rows = useMemo(() => {
    const definitions = new Map((classLabels || []).map((label) => [String(label.id), label]));
    const grouped = new Map();
    const periodKey = (term) => {
      if (!highSchoolMode) return String(term.id);
      const configuredPeriod = String(periodNames[String(term.id)] || "").trim();
      if (configuredPeriod && configuredPeriod !== "Academic period") return `period:${configuredPeriod}`;
      return `year:${highSchoolAcademicYearKey(term)}`;
    };
    const periodLabel = (term) => (
      periodNames[String(term.id)]
      || String(term.name || "")
        .replace(/^\d{4}\s+/, "")
        .replace(/\s+(Fall|Spring|Summer)$/i, "")
    );
    const periodTermCounts = new Map();
    for (const term of terms || []) {
      if (!term.included) continue;
      const key = periodKey(term);
      periodTermCounts.set(
        key,
        Math.max(periodTermCounts.get(key) || 0, highSchoolMode ? configuredHighSchoolTermCount(term, highSchoolTerms, highSchoolTermsByPeriod) : 1, 1),
      );
    }
    for (const term of terms || []) {
      if (!term.included) continue;
      for (const course of term.courses || []) {
        for (const labelId of courseLabels?.[String(course.id)] || []) {
          const label = definitions.get(String(labelId));
          if (!label) continue;
          const labelRow = grouped.get(label.id) || {
            id: label.id,
            label: label.name,
            classes: new Map(),
          };
          const classKey = highSchoolMode
            ? `${periodKey(term)}:${String(course.code || course.id).trim().toLowerCase()}`
            : String(course.id);
          const current = labelRow.classes.get(classKey) || {
            occurrenceCount: 0,
            periodKey: periodKey(term),
            period: periodLabel(term),
            latestCourse: null,
            finalCourse: null,
            latestOrder: -1,
            finalOrder: -1,
          };
          const order = (highSchoolMode ? semesterSortValue(term) : semesterSortValue(term, semesterTitles)) + Number(course.id || 0) / 1000000;
          current.occurrenceCount += 1;
          if (order >= current.latestOrder) {
            current.latestCourse = course;
            current.latestOrder = order;
          }
          if (course.quality_points != null && course.gp_override !== -1 && order >= current.finalOrder) {
            current.finalCourse = course;
            current.finalOrder = order;
          }
          labelRow.classes.set(classKey, current);
          grouped.set(label.id, labelRow);
        }
      }
    }
    return [...grouped.values()].map((row) => {
      const items = [...row.classes.values()].map((classRow) => {
        const course = classRow.finalCourse || classRow.latestCourse;
        const units = highSchoolMode
          ? classRow.occurrenceCount / Math.max(periodTermCounts.get(classRow.periodKey) || 1, 1)
          : Number(course?.credits) || 0;
        const baseQualityPoints = course?.base_quality_points ?? course?.quality_points;
        return {
          ...course,
          semester: classRow.period,
          period: classRow.period,
          credits: useCredits && highSchoolMode ? units : (useCredits ? Number(course?.credits) || 0 : 1),
          units,
          score: highSchoolMode && baseQualityPoints != null
            ? Math.round((Number(baseQualityPoints) - Number(targetGp)) * 3) * units
            : Number(course?.score) || 0,
        };
      });
      const credits = items.reduce((sum, course) => sum + (useCredits ? Number(course.credits) || 0 : 1), 0);
      const qpCredits = items.reduce((sum, course) => {
        const qualityPoints = course.base_quality_points ?? course.quality_points;
        return qualityPoints != null ? sum + Number(qualityPoints) * (useCredits ? Number(course.credits) || 0 : 1) : sum;
      }, 0);
      const gpaCredits = items.reduce((sum, course) => {
        const qualityPoints = course.base_quality_points ?? course.quality_points;
        return qualityPoints != null && course.gp_override !== -1
          ? sum + (useCredits ? Number(course.credits) || 0 : 1)
          : sum;
      }, 0);
      return {
        id: row.id,
        label: row.label,
        items,
        courses: items.length,
        credits,
        score: items.reduce((sum, course) => sum + (Number(course.score) || 0), 0),
        gpa: gpaCredits ? qpCredits / gpaCredits : null,
        distribution: distributionFromCourses(items, letterOrder),
      };
    });
  }, [classLabels, courseLabels, highSchoolMode, highSchoolTerms, highSchoolTermsByPeriod, letterOrder, periodNames, semesterTitles, targetGp, terms, useCredits]);

  if (!classLabels.length) {
    return <div className="empty">Create class labels in Settings to use this view.</div>;
  }
  if (!rows.length) {
    return <div className="empty">No classes have been assigned to a label.</div>;
  }

  const sortedRows = [...rows].sort((a, b) => {
    const key = {
      label: (row) => row.label.toLowerCase(),
      courses: (row) => row.courses,
      credits: (row) => row.credits,
      score: (row) => row.score,
      gpa: (row) => row.gpa ?? -1,
    }[sortKey];
    const av = key(a);
    const bv = key(b);
    if (av === bv) return a.label.localeCompare(b.label);
    const cmp = av > bv ? 1 : -1;
    return sortDesc ? -cmp : cmp;
  });

  function toggleSort(next) {
    if (sortKey === next) setSortDesc((current) => !current);
    else {
      setSortKey(next);
      setSortDesc(next !== "label");
    }
  }

  const cols = [
    ["label", "Class Label"],
    ["courses", "Classes"],
    showCredits ? ["credits", highSchoolMode ? "Units" : creditTerms.label] : null,
    showScore ? ["score", "Score"] : null,
    ["gpa", "GPA"],
  ].filter(Boolean);

  return (
    <section className={embedded ? "" : "panel"} style={{ marginTop: embedded ? 0 : 16 }}>
      {!embedded ? <h2>Class labels</h2> : null}
      <div className="table-wrap">
        <table className="code-stats-table">
          <thead>
            <tr>
              {cols.map(([key, label]) => (
                <th key={key}>
                  <button className={sortKey === key ? "active" : ""} type="button" onClick={() => toggleSort(key)}>
                    {label}{sortKey === key ? (sortDesc ? " ↓" : " ↑") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const open = openLabels.has(row.id);
              return (
                <Fragment key={row.id}>
                  <tr
                    className={`code-stats-row ${open ? "open" : ""}`}
                    onClick={() => setOpenLabels((current) => {
                      const next = new Set(current);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenLabels((current) => {
                          const next = new Set(current);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        });
                      }
                    }}
                  >
                    <td><span className={`term-accordion-chevron ${open ? "open" : ""}`}>▸</span> <strong>{row.label}</strong></td>
                    <td className="mono">{row.courses}</td>
                    {showCredits ? <td className="mono">{fmtUnitValue(row.credits)}</td> : null}
                    {showScore ? <td className={`mono ${scoreClass(row.score)}`}>{fmtScore(row.score)}</td> : null}
                    <td className="mono">{fmtGpa(row.gpa)}</td>
                  </tr>
                  {open ? (
                    <tr className="code-stats-detail">
                      <td colSpan={cols.length}>
                        <div className="level-course-dropdown">
                          {row.items.length > 1 ? (
                            <div className="distribution-summary-grid">
                              <GradeDistributionCharts distribution={row.distribution} courses={row.items} showScoreChart={showScore} compact />
                              <DistributionTable
                                distribution={row.distribution}
                                courses={row.items}
                                displayCodes={displayCodes}
                                simplified
                                periodMode={highSchoolMode}
                                courseHref={courseHref}
                                termLabel={termLabel}
                              />
                            </div>
                          ) : null}
                          <table className="level-course-table">
                            <thead>
                              <tr><th>Class</th><th>{highSchoolMode ? "Period" : termLabel}</th><th>Percent</th>{showCredits ? <th>{highSchoolMode ? "Units" : creditTerms.label}</th> : null}<th>Letter grade</th></tr>
                            </thead>
                            <tbody>
                              {row.items.map((course) => (
                                <tr key={`${row.id}-${course.id}`}>
                                  <td><Link to={courseHref?.(course) || `/courses/${course.id}`}>{displayCodes.get(course.id) || course.display_code || course.code || "Class"}</Link></td>
                                  <td>{highSchoolMode ? course.period : course.semester}</td>
                                  <td className={`mono ${course.gp_override === -1 ? "letter-neutral" : dashboardCourseGradeClass(course)}`}>{fmtPct(course.percent)}</td>
                                  {showCredits ? <td className="mono">{fmtUnitValue(highSchoolMode ? course.units : course.credits)}</td> : null}
                                  <td><span className={`letter ${dashboardCourseGradeClass(course)}`}>{course.letter || "—"}</span></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function gradeScaleRowForGp(scale, gp) {
  const value = Number(gp);
  if (!Number.isFinite(value)) return null;
  return (scale || []).find((row) => Math.abs(Number(row.quality_points) - value) < 1e-6) || null;
}

function fumbleCourseGrade(course, scale) {
  // Use the serialized final/base result first so grade overrides are shown
  // as the class's actual grade. Natural values are only the fallback.
  const actualGp = course?.base_quality_points
    ?? course?.quality_points
    ?? course?.natural_quality_points;
  // A missing percent and GPA means the class has not been graded. Do not
  // let a stale/default letter make an ungraded class look like an F.
  const hasGrade = course?.percent != null || actualGp != null || course?.pass_fail_override != null;
  if (!hasGrade) return { actualGp: null, actualGrade: null, actualLetter: null };
  const actualGrade = gradeScaleRowForGp(scale, actualGp);
  return {
    actualGp,
    actualGrade,
    actualLetter: course?.letter || actualGrade?.letter || course?.natural_letter,
  };
}

function FumbleShouldSelect({ fumble, scale, apply }) {
  const options = (scale || []).filter((row) => row.letter !== "F");
  const notTaken = fumble.should_have_been_gp == null;
  const selectedGrade = gradeScaleRowForGp(scale, fumble.should_have_been_gp);

  return (
    <span className={`fumble-should-select-wrap ${notTaken ? "is-not-taken" : ""}`}>
      <select
        className={`fumble-should-select mono ${selectedGrade ? letterClass(selectedGrade.letter) : ""}`}
        value={notTaken ? "na" : String(fumble.should_have_been_gp)}
        aria-label={`Should have been grade for ${fumble.code}`}
        onChange={async (event) => {
          await apply(await api.patchFumble(fumble.id, {
            should_have_been_gp: event.target.value === "na" ? null : Number(event.target.value),
          }));
        }}
      >
        <option value="na">Not take</option>
        {options.map((row) => (
          <option key={row.letter} value={row.quality_points} className={letterClass(row.letter)}>
            {fmtGpa(row.quality_points)}
          </option>
        ))}
      </select>
      {notTaken ? <span className="fumble-should-display mono" aria-hidden="true">—</span> : null}
    </span>
  );
}

function SignedValue({ value, compact = false }) {
  const formatted = fmtScore(value).replace(compact ? /^([+-]?)0\./ : /$^/, "$1.");
  if (formatted === "—") return <span className="signed-number">—</span>;
  const hasSign = formatted.startsWith("+") || formatted.startsWith("-");
  return (
    <span className="signed-number">
      <span className="signed-number-sign">{hasSign ? formatted[0] : "\u00a0"}</span>
      <span>{hasSign ? formatted.slice(1) : formatted}</span>
    </span>
  );
}

function FumblesPanel({ data, showScore, weightedGpa = false, fumbleCourse, setFumbleCourse, fumbleGp, setFumbleGp, fumbleAlreadyAdded, apply, highSchoolMode = false, periodGroups = [], semesterTitles = [], courseHref }) {
  const creditTerms = useCreditTerms();
  const selectedFumbleGrade = data.default_scale.find((row) => String(row.quality_points) === String(fumbleGp));
  const showWeightedGpa = weightedGpa && data.weighted_overall_gpa != null;
  const showCreditDelta = data.fumbles?.some((fumble) => (
    fumble.should_have_been_gp == null
    || (fumble.did_get == null && fumble.should_have_been_gp != null)
  )) || false;
  const hasNotTaken = data.fumbles?.some((fumble) => fumble.should_have_been_gp == null)
    || Number(data.fumble_credits_delta) !== 0;
  const showAdjustedDelta = showScore || showCreditDelta || hasNotTaken;
  const adjustedUnitValues = [data.gpa_credits, data.fumble_credits_delta, data.gpa_credits_with_fumbles]
    .map(Number)
    .filter(Number.isFinite);
  const hasPartialUnits = highSchoolMode
    && adjustedUnitValues.some((value) => Math.abs(value - Math.round(value)) > 1e-6);
  const adjustedCreditsLabel = hasPartialUnits ? "Units" : creditTerms.label;
  const scoreDelta =
    data.score_with_fumbles == null || data.overall_score == null
      ? null
      : data.score_with_fumbles - data.overall_score;

  return (
    <div className="panel fumbles-panel" style={{ marginTop: 16 }}>
      <h2>Fumbles</h2>
      <p className="muted">What if a class had been a higher letter.</p>
      <div className="row fumble-entry-row" style={{ marginBottom: 10 }}>
        <FumbleCourseSelect
          terms={data.terms}
          fumbles={data.fumbles}
          value={fumbleCourse}
          onChange={setFumbleCourse}
          highSchoolMode={highSchoolMode}
          periodGroups={periodGroups}
          overallClasses={data.overall_classes}
          scale={data.default_scale}
          semesterTitles={semesterTitles}
        />
        <div className="fumble-target-controls">
          <span className="fumble-transition-arrow" aria-hidden="true">→</span>
          <select
            className={`select fumble-grade-select ${letterClass(selectedFumbleGrade?.letter)}`}
            value={fumbleGp}
            onChange={(e) => setFumbleGp(e.target.value)}
          >
            {data.default_scale.filter((s) => s.letter !== "F").map((s) => (
              <option key={s.letter} value={s.quality_points} className={letterClass(s.letter)}>
                {s.letter} ({fmtGpa(s.quality_points)})
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            disabled={!fumbleCourse || fumbleAlreadyAdded}
            onClick={async () => {
              if (!fumbleCourse || fumbleAlreadyAdded) return;
              await apply(await api.createFumble({ course_id: Number(fumbleCourse), should_have_been_gp: Number(fumbleGp) }));
            }}
          >
            {fumbleAlreadyAdded ? "Added" : "Add"}
          </button>
        </div>
      </div>
      <table className={`fumble-table with-credit-delta ${showScore ? "with-score" : ""}`}>
        <thead>
          <tr>
            <th>Class</th>
            <th>Actual</th>
            <th>Should've</th>
            <th className={`fumble-delta-heading ${showCreditDelta ? "" : "fumble-credit-delta-hidden"}`}>Δ Credits</th>
            {showScore ? <th className="fumble-delta-heading">Δ Score</th> : null}
            <th />
          </tr>
        </thead>
        {fumblesBySemester(data.terms, data.fumbles, highSchoolMode, periodGroups, semesterTitles).map((group) => (
          <tbody key={group.term.id}>
            <tr className="fumble-semester-head">
              <th colSpan={5 + (showScore ? 1 : 0)}>{group.term.name}</th>
            </tr>
            {group.rows.map((f) => (
              <tr key={f.id}>
                <td>
                  <Link to={courseHref?.({ id: f.course_id, semester_id: f.semester_id }) || `/courses/${f.course_id}`}>
                    {f.code}
                  </Link>
                </td>
                <td className={`mono ${f.did_get == null ? "fumble-grade-empty" : gradeScaleRowForGp(data.default_scale, f.did_get) ? letterClass(gradeScaleRowForGp(data.default_scale, f.did_get).letter) : ""}`}>
                  {f.did_get == null ? "--" : fmtGpa(f.did_get)}
                </td>
                <td><FumbleShouldSelect fumble={f} scale={data.default_scale} apply={apply} /></td>
                <td className={`mono fumble-delta-cell ${showCreditDelta ? "" : "fumble-credit-delta-hidden"}`}>
                  {f.should_have_been_gp == null && f.credits != null && Number.isFinite(Number(f.credits))
                    ? fmtAnimatedCredits(-Math.abs(Number(f.credits)))
                    : f.did_get == null && f.should_have_been_gp != null && f.credits != null && Number.isFinite(Number(f.credits))
                      ? fmtAnimatedCredits(Number(f.credits))
                      : null}
                </td>
                {showScore ? (
                  <td className={`mono fumble-delta-cell ${f.should_have_been_gp == null ? "score-zero" : scoreClass(f.delta)}`}>
                    <SignedValue value={f.delta} compact />
                  </td>
                ) : null}
                <td><button className="btn small danger" onClick={async () => apply(await api.deleteFumble(f.id))}>×</button></td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      {data.fumbles?.length ? (
        <div className="fumble-adjusted">
          <div className={`fumble-adjusted-grid ${showAdjustedDelta ? "with-score-delta" : ""}`}>
            <div />
            <div className="fumble-adjusted-heading">Actual</div>
            {showAdjustedDelta ? <div className="fumble-adjusted-heading">Δ</div> : null}
            <div className="fumble-adjusted-heading">Adjusted</div>
            {showScore ? (
              <>
                <div className="fumble-adjusted-row-label">Score</div>
                <div className="mono"><SignedValue value={data.overall_score} /></div>
                <div className={`mono ${scoreClass(scoreDelta)}`}><SignedValue value={scoreDelta} compact /></div>
                <div className="mono"><SignedValue value={data.score_with_fumbles} /></div>
              </>
            ) : null}
            {showCreditDelta || hasNotTaken ? (
              <>
                <div className="fumble-adjusted-row-label">{adjustedCreditsLabel}</div>
                <div className="mono">{fmtAnimatedCredits(data.gpa_credits)}</div>
                <div className="mono">{fmtAnimatedCredits(data.fumble_credits_delta)}</div>
                <div className="mono">{fmtAnimatedCredits(data.gpa_credits_with_fumbles)}</div>
              </>
            ) : null}
            <div className="fumble-adjusted-row-label">GPA</div>
            <div className="mono">{fmtGpa(data.overall_gpa)}</div>
            {showAdjustedDelta ? <div /> : null}
            <div className="mono">{fmtGpa(data.gpa_with_fumbles)}</div>
            {showWeightedGpa ? (
              <>
                <div className="fumble-adjusted-row-label">WGPA</div>
                <div className="mono">{fmtGpa(data.weighted_overall_gpa)}</div>
                {showAdjustedDelta ? <div /> : null}
                <div className="mono">{fmtGpa(data.weighted_gpa_with_fumbles)}</div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WeightingStats({ terms, overallClasses = [], weightTags = [], letterOrder = FALLBACK_LETTERS, termNames = {}, periodNames = {}, termLabel = "Period", highSchoolMode = false, highSchoolTerms = [], highSchoolTermsByPeriod = {}, embedded = false, courseHref, semesterTitles = [] }) {
  const [openTags, setOpenTags] = useState(() => new Set());
  const displayCodes = useMemo(() => buildCourseDisplayCodes(terms, null, semesterTitles), [semesterTitles, terms]);
  const rows = useMemo(() => {
    const definitions = new Map((weightTags || []).map((tag) => [String(tag.id), tag]));
    const periodLabel = (term) => {
      if (!highSchoolMode) return String(term.name || termNames[String(term.id)] || "").trim() || "—";
      return (
        periodNames[String(term.id)]
        || String(term.name || "")
          .replace(/^\d{4}\s+/, "")
          .replace(/\s+(Fall|Spring|Summer)$/i, "")
      );
    };
    const isGradedCourse = (course) => isDashboardVisibleCourse(course)
      && (course.quality_points != null || course.credit_mode === "pass_fail");
    const overallById = new Map(
      (overallClasses || []).map((course) => [String(course.id), course]),
    );
    const overallByCode = new Map(
      (overallClasses || [])
        .map((course) => [String(course.code || "").trim().toLowerCase(), course])
        .filter(([code]) => code),
    );
    const fullUnitsFor = (course) => {
      const overall = overallById.get(String(course.id))
        || overallByCode.get(String(course.code || "").trim().toLowerCase());
      const units = Number(overall?.units);
      return Number.isFinite(units) && units > 0
        ? units
        : Number(course.gpa_units ?? course.credits) || 0;
    };
    const entries = [];

    if (highSchoolMode && (overallClasses || []).length) {
      // High-school overall classes are already collapsed to one final row
      // per class and academic period. Use them here so weighting totals cover
      // every period, while recovering weighting tags from the term rows.
      const weightingByPeriodCode = new Map();
      const weightingByCourseId = new Map();
      const periodLabels = new Map();
      for (const term of terms || []) {
        const periodGroupKey = highSchoolAcademicYearKey(term);
        const label = String(periodNames[String(term.id)] || "").trim()
          || periodLabel(term);
        if (label && label !== "—" && !periodLabels.has(periodGroupKey)) {
          periodLabels.set(periodGroupKey, label);
        }
        if (!term.included) continue;
        for (const course of term.courses || []) {
          const code = String(course.code || "").trim().toLowerCase();
          if (!code && course.id == null) continue;
          const tagId = String(course.gpa_weight_tag || "unweighted");
          const definition = definitions.get(tagId);
          const boost = Number(course.gpa_weight_boost ?? definition?.boost ?? 0) || 0;
          const candidate = {
            tagId,
            boost,
            tagName: definition?.name || course.gpa_weight_tag_name,
          };
          if (course.id != null) weightingByCourseId.set(String(course.id), candidate);
          if (code) {
            const key = `${periodGroupKey}:${code}`;
            const current = weightingByPeriodCode.get(key);
            if (!current || boost >= current.boost) weightingByPeriodCode.set(key, candidate);
          }
        }
      }
      for (const course of overallClasses || []) {
        if (!isGradedCourse(course)) continue;
        const code = String(course.code || "").trim().toLowerCase();
        const periodGroupKey = String(course.period ?? "");
        const weighting = weightingByPeriodCode.get(`${periodGroupKey}:${code}`)
          || weightingByCourseId.get(String(course.id))
          || { tagId: "unweighted", boost: 0 };
        const period = periodLabels.get(periodGroupKey) || String(course.period || "—");
        entries.push({
          ...course,
          units: Number(course.units) || 0,
          semester: period,
          period,
          gpa_weight_tag: weighting.tagId,
          gpa_weight_tag_name: definitions.get(weighting.tagId)?.name || weighting.tagName,
          gpa_weight_boost: weighting.boost,
        });
      }
    } else if (!highSchoolMode) {
      for (const term of terms || []) {
        if (!term.included) continue;
        for (const course of term.courses || []) {
          if (!isGradedCourse(course)) continue;
          entries.push({
            ...course,
            units: fullUnitsFor(course),
            semester: term.name,
            period: periodLabel(term),
          });
        }
      }
    }

    const groups = new Map();
    (weightTags || []).forEach((tag) => {
      groups.set(String(tag.id), {
        id: String(tag.id),
        label: tag.name,
        items: [],
        courses: 0,
        units: 0,
        points: 0,
        graded: 0,
      });
    });
    for (const course of entries) {
      const tagId = String(course.gpa_weight_tag || "unweighted");
      const definition = definitions.get(tagId);
      const row = groups.get(tagId) || {
        id: tagId,
        label: definition?.name || course.gpa_weight_tag_name || (tagId === "unweighted" ? "CP" : tagId),
      items: [],
      courses: 0,
      units: 0,
      points: 0,
        graded: 0,
      };
      row.items.push(course);
      row.courses += 1;
      row.units += Number(course.units ?? course.gpa_units ?? course.credits) || 0;
      if (course.quality_points != null && course.gp_override !== -1) {
        row.points += Number(course.base_quality_points ?? course.quality_points);
        row.graded += 1;
      }
      groups.set(tagId, row);
    }
    return [...groups.values()].map((row) => ({
      ...row,
      distribution: distributionFromCourses(
        row.items.map((course) => ({ ...course, credits: course.units ?? course.gpa_units ?? course.credits })),
        letterOrder,
      ),
    }));
  }, [highSchoolMode, highSchoolTerms, highSchoolTermsByPeriod, letterOrder, overallClasses, periodNames, termNames, terms, weightTags]);

  if (!rows.length) return <p className="muted">No weighting labels configured.</p>;
  const showUnits = !highSchoolMode && rows.some((row) => row.items.some((course) => {
    const units = Number(course.units ?? course.gpa_units ?? course.credits) || 0;
    return Math.abs(units - Math.round(units)) > 1e-9;
  }));

  return (
    <section className={embedded ? "" : "panel"} style={{ marginTop: embedded ? 0 : 16 }}>
      {!embedded ? <h2>Weighting</h2> : null}
      <div className="table-wrap">
        <table className="code-stats-table">
          <thead>
            <tr><th>Weighting</th><th>Classes</th>{showUnits ? <th>Units</th> : null}<th>GPA</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const open = openTags.has(row.id);
              return (
                <Fragment key={row.id}>
                  <tr
                    className={`code-stats-row ${open ? "open" : ""}`}
                    onClick={() => setOpenTags((current) => {
                      const next = new Set(current);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpenTags((current) => {
                          const next = new Set(current);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        });
                      }
                    }}
                  >
                    <td><span className={`term-accordion-chevron ${open ? "open" : ""}`}>▸</span>{" "}<strong>{row.label}</strong></td>
                    <td className="mono">{row.courses}</td>
                    {showUnits ? <td className="mono">{fmtUnitValue(row.units)}</td> : null}
                    <td className="mono">{row.graded ? fmtGpa(row.points / row.graded) : "—"}</td>
                  </tr>
                  {open ? (
                    <tr className="code-stats-detail">
                      <td colSpan={showUnits ? 4 : 3}>
                        <div className="level-course-dropdown" onClick={(event) => event.stopPropagation()}>
                          {row.items.length ? (
                            <div className="distribution-summary-grid">
                              <GradeDistributionCharts distribution={row.distribution} courses={row.items.map((course) => ({ ...course, credits: course.units ?? course.gpa_units ?? course.credits }))} showScoreChart={showScore} compact />
                              <DistributionTable
                                distribution={row.distribution}
                                courses={row.items.map((course) => ({ ...course, credits: course.units ?? course.gpa_units ?? course.credits }))}
                                displayCodes={displayCodes}
                                simplified
                                periodMode={highSchoolMode}
                                showUnits={showUnits}
                                courseHref={courseHref}
                                termLabel={termLabel}
                              />
                            </div>
                          ) : <p className="muted">No classes use this weighting yet.</p>}
                          {row.items.length ? (
                            <table className="level-course-table">
                              <thead><tr><th>Class</th><th>{highSchoolMode ? "Period" : termLabel}</th>{showUnits ? <th>Units</th> : null}<th>Letter grade</th><th>GPA</th></tr></thead>
                              <tbody>
                                {row.items.map((course) => (
                                  <tr key={`${row.id}-${course.id}`}>
                                    <td><Link to={courseHref?.(course) || `/courses/${course.id}`}>{displayCodes.get(course.id) || course.display_code || course.code || "Class"}</Link></td>
                                    <td>{course.period}</td>
                                    {showUnits ? <td className="mono">{fmtUnitValue(course.units ?? course.gpa_units ?? course.credits)}</td> : null}
                                    <td><span className={`letter ${dashboardCourseGradeClass(course)}`}>{course.letter || "—"}</span></td>
                                    <td className="mono">{fmtGpa(course.base_quality_points ?? course.quality_points)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function GpaDashboard({ onChange, classLabels = [], courseLabels = {}, semesterIds = null, termNames = {}, periodNames = {}, periodOrder = [], gradebookId = "default", semesterTitles = [], highSchoolMode = false, highSchoolTerms = [], highSchoolTermsByPeriod = {}, classType = "alphanumeric", weightedGpa = false, termLabel = "Period", minCreditsValue = "1", onMinCreditsChange }) {
  const creditTerms = useCreditTerms();
  const classBasis = useGpaBasis() === "classes";
  const showScore = useShowScore();
  const [data, setData] = useState(null);
  const [view, setView] = useState("semester");
  const [summaryView, setSummaryView] = useState("grade");
  const [minCredits, setMinCredits] = useState(String(minCreditsValue || "1"));
  const [sort, setSort] = useState("code");
  const [desc, setDesc] = useState(false);
  const [fumbleCourse, setFumbleCourse] = useState("");
  const [fumbleGp, setFumbleGp] = useState("4.333");
  const [guessDraft, setGuessDraft] = useState({});
  const [openTerms, setOpenTerms] = useState({});
  const courseHref = (course) => {
    const params = new URLSearchParams({ gradebook: gradebookId });
    if (course.semester_id != null) params.set("term", String(course.semester_id));
    return `/courses/${course.id}?${params.toString()}`;
  };
  const [showAllGuessLetters, setShowAllGuessLetters] = useState(false);
  const namedCourses = classType === "named";
  const guessSeeded = useRef(false);
  const dashboardTerms = useMemo(
    () => (data?.terms || []).map((term) => {
      const courses = (term.courses || []).filter(isDashboardVisibleCourse);
      return { ...term, courses, course_count: courses.length };
    }),
    [data],
  );
  const orderedTerms = useMemo(
    () => highSchoolMode ? dashboardTerms : sortSemesters(dashboardTerms, semesterTitles),
    [dashboardTerms, highSchoolMode, semesterTitles]
  );
  const displayCodes = useMemo(() => buildCourseDisplayCodes(orderedTerms, null, semesterTitles), [orderedTerms, semesterTitles]);
  const displayTermName = (term) => {
    const configuredName = String(termNames[String(term.id)] || "").trim();
    const rawName = String(term.name || "").trim();
    if (!highSchoolMode) {
      if (configuredName && Number.isFinite(Number(term.year))) return `${term.year} ${configuredName}`;
      return rawName || configuredName || "—";
    }
    return configuredName || rawName.replace(/^\d{4}\s+/, "") || "—";
  };
  const displayCoursePeriod = (term) => {
    if (!highSchoolMode) return displayTermName(term);
    const periodName = periodNames[String(term.id)];
    if (periodName) return String(periodName).trim();
    return displayTermName(term);
  };
  const overallPeriodRollups = useMemo(() => {
    if (!highSchoolMode) return new Map();
    const groups = new Map();
    (data?.overall_classes || []).forEach((item) => {
      if (item?.quality_points == null) return;
      const key = String(item.period);
      const current = groups.get(key) || { count: 0, units: 0, qualityPoints: 0, weightedQualityPoints: 0 };
      const units = Number(item.units) || 0;
      current.count += 1;
      current.units += units;
      current.qualityPoints += Number(item.quality_points) * units;
      current.weightedQualityPoints += Number(item.weighted_quality_points ?? item.quality_points) * units;
      groups.set(key, current);
    });
    return groups;
  }, [data, highSchoolMode]);
  const periodGroups = useMemo(() => {
    if (!highSchoolMode) {
      return orderedTerms.map((term) => ({
        ...term,
        name: termNames[String(term.id)]
          ? `${term.year} ${termNames[String(term.id)]}`
          : term.name,
        terms: [term],
        courses: (term.courses || []).map((course) => ({
          ...course,
          semester: displayTermName(term),
          semesterOrder: semesterSortValue(term, semesterTitles),
        })),
        overall_class_count: term.course_count ?? term.courses?.length ?? 0,
      }));
    }
    const groups = new Map();
    for (const term of orderedTerms) {
      const key = periodNames[String(term.id)] || "Other";
      const group = groups.get(key) || { id: `period-${key}`, name: key, terms: [], courses: [], included: true };
      group.terms.push(term);
      group.courses.push(...(term.courses || []).map((course) => ({
        ...course,
        semester: displayTermName(term),
        semesterOrder: semesterSortValue(term),
      })));
      group.included = group.included && term.included;
      groups.set(key, group);
    }
    const configuredRanks = new Map(
      (periodOrder || []).map((name, index) => [String(name || "").trim().toLowerCase(), index]),
    );
    const latestTermOrder = (group) => Math.max(
      ...(group.terms || []).map((term) => Number(term.year) * 10 + (TERM_SEQUENCE[term.season] || 0)),
      Number.NEGATIVE_INFINITY,
    );
    return [...groups.values()].map((group) => {
      const courseGroups = new Map();
      group.courses.forEach((course) => {
        const key = String(course.code || "").trim().toLowerCase();
        if (!key) return;
        const current = courseGroups.get(key) || {
          occurrenceCount: 0,
          latestCourse: null,
          finalCourse: null,
          weightBoost: 0,
        };
        current.occurrenceCount += 1;
        current.weightBoost = Math.max(current.weightBoost, Number(course.gpa_weight_boost) || 0);
        if (!current.latestCourse || course.semesterOrder >= current.latestCourse.semesterOrder) current.latestCourse = course;
        if (
          course.quality_points != null
          && course.gp_override !== -1
          && (!current.finalCourse || course.semesterOrder >= current.finalCourse.semesterOrder)
        ) {
          current.finalCourse = course;
        }
        courseGroups.set(key, current);
      });
      const rawCourses = group.courses;
      const termCount = highSchoolPeriodTermCount(group.terms, highSchoolTerms, highSchoolTermsByPeriod);
      const periodKey = highSchoolAcademicYearKey(group.terms?.[0]);
      const backendPeriodScore = data?.high_school_period_scores?.[periodKey];
      const backendPeriodRollup = overallPeriodRollups.get(periodKey);
      const courses = [...courseGroups.values()].map((courseGroup) => {
        const course = courseGroup.finalCourse || courseGroup.latestCourse;
        const units = termCount ? courseGroup.occurrenceCount / termCount : 0;
        const weightedQualityPoints = course?.quality_points == null
          ? null
          : Number(course.base_quality_points ?? course.quality_points) + courseGroup.weightBoost;
        return {
          ...course,
          period_units: Number(units.toFixed(3)),
          period_weighted_quality_points: weightedQualityPoints,
        };
      });
      const graded = courses.filter((course) => course.quality_points != null && course.gp_override !== -1);
      const units = (course) => classBasis ? 1 : (Number(course.credits) || 0);
      const total = graded.reduce((sum, course) => sum + units(course), 0);
      return {
        ...group,
        period_key: periodKey,
        courses,
        overall_class_count: highSchoolMode
          ? (backendPeriodRollup?.count ?? 0)
          : courses.length,
        term_gpa: backendPeriodRollup?.units
          ? backendPeriodRollup.qualityPoints / backendPeriodRollup.units
          : total
          ? graded.reduce((sum, course) => sum + Number(course.base_quality_points ?? course.quality_points) * units(course), 0) / total
          : null,
        term_wgpa: backendPeriodRollup?.units
          ? backendPeriodRollup.weightedQualityPoints / backendPeriodRollup.units
          : total
          ? graded.reduce((sum, course) => sum + Number(course.period_weighted_quality_points ?? course.quality_points) * units(course), 0) / total
          : null,
        term_score: highSchoolMode
          ? backendPeriodScore != null
            ? Number(backendPeriodScore)
            : highSchoolScoreForCourses(rawCourses, termCount, data.target_gp)
          : null,
      };
    }).sort((a, b) => {
      const aRank = configuredRanks.get(String(a.name || "").trim().toLowerCase());
      const bRank = configuredRanks.get(String(b.name || "").trim().toLowerCase());
      if (aRank != null || bRank != null) {
        if (aRank == null) return 1;
        if (bRank == null) return -1;
        if (aRank !== bRank) return bRank - aRank;
      }
      return latestTermOrder(b) - latestTermOrder(a);
    });
  }, [classBasis, data, highSchoolMode, highSchoolTerms, highSchoolTermsByPeriod, orderedTerms, overallPeriodRollups, periodNames, periodOrder, semesterTitles, termNames]);
  const selectedFumbleGroup = highSchoolMode
    ? periodGroups.find((group) => group.courses?.some((course) => String(course.id) === String(fumbleCourse)))
    : null;
  const selectedFumbleCode = highSchoolMode
    ? selectedFumbleGroup?.courses.find((course) => String(course.id) === String(fumbleCourse))?.code
    : null;
  const fumbleAlreadyAdded = data?.fumbles?.some(
    (fumble) => {
      if (String(fumble.course_id) === String(fumbleCourse)) return true;
      if (!highSchoolMode || !selectedFumbleGroup || !selectedFumbleCode) return false;
      return String(fumble.code || "").trim().toLowerCase() === String(selectedFumbleCode).trim().toLowerCase()
        && periodNames[String(fumble.semester_id)] === selectedFumbleGroup.name;
    }
  );
  const distributionCourses = useMemo(() => {
    if (!highSchoolMode) {
      return orderedTerms
        .filter((term) => term.included)
        .flatMap((term) => (
          (term.courses || []).map((course) => ({ ...course, semester: displayTermName(term) }))
        ));
    }

    // High-school term rows hold the per-term inputs, while the dashboard
    // grade for a class is the final result across its academic period. Use
    // those overall class rows here so older periods are represented too.
    const periodLabels = new Map();
    for (const term of orderedTerms) {
      const key = highSchoolAcademicYearKey(term);
      const label = String(periodNames[String(term.id)] || "").trim()
        || displayTermName(term);
      if (label && !periodLabels.has(key)) periodLabels.set(key, label);
    }
    for (const group of periodGroups || []) {
      if (group.period_key == null || !group.name || group.name === "Other") continue;
      periodLabels.set(String(group.period_key), group.name);
    }
    const includedPeriods = new Set(
      (periodGroups || [])
        .filter((group) => group.included)
        .map((group) => String(group.period_key)),
    );

    return (data?.overall_classes || [])
      .filter((course) => includedPeriods.has(String(course.period)) && course?.letter && course.quality_points != null)
      .map((course) => {
        const units = Number(course.units) || 0;
        const qualityPoints = Number(course.quality_points);
        const target = Number(data.target_gp);
        return {
          ...course,
          credits: units,
          period: periodLabels.get(String(course.period)) || String(course.period || "—"),
          semester: periodLabels.get(String(course.period)) || String(course.period || "—"),
          score: Number.isFinite(qualityPoints) && Number.isFinite(target)
            ? Math.round((qualityPoints - target) * 3) * units
            : 0,
        };
      });
  }, [data, highSchoolMode, orderedTerms, periodGroups, periodNames, termNames]);
  const summaryDistribution = useMemo(
    () => distributionFromCourses(distributionCourses, lettersFromScale(data?.default_scale), true),
    [data, distributionCourses, highSchoolMode]
  );
  const hasClasses = distributionCourses.length > 0;
  const periodScores = periodGroups.filter((group) => group.included && group.term_score != null);
  const overallScore = highSchoolMode && periodScores.length
    ? periodScores.reduce((sum, group) => sum + Number(group.term_score || 0), 0)
    : data?.overall_score;
  const overallClassCount = highSchoolMode
    ? periodGroups.reduce((sum, group) => sum + (group.included ? Number(group.overall_class_count || 0) : 0), 0)
    : null;
  const overallClassUnits = highSchoolMode
    ? periodGroups.reduce((sum, group) => (
      sum + (group.included ? Number(overallPeriodRollups.get(String(group.period_key))?.units || 0) : 0)
    ), 0)
    : null;
  const trendTerms = highSchoolMode
    ? periodGroups.map((group) => ({
      ...group,
      id: group.id,
      name: group.name,
      courses: group.courses,
      isAcademicPeriod: true,
    }))
    : orderedTerms.map((term) => ({ ...term, name: displayTermName(term) }));
  useEffect(() => {
    setMinCredits(String(minCreditsValue || "1"));
  }, [minCreditsValue]);

  function updateMinCredits(value) {
    setMinCredits(value);
    onMinCreditsChange?.(value);
  }

  async function load() {
    setData(await api.gpa(semesterIds ? { semester_ids: semesterIds } : {}));
  }

  async function apply() {
    await onChange?.();
    await load();
  }

  useEffect(() => {
    load().catch(console.error);
  }, [semesterIds?.join(",")]);

  useEffect(() => {
    if (!showScore && sort === "score") {
      setSort("code");
      setDesc(false);
    }
  }, [showScore, sort]);

  useEffect(() => {
    if (namedCourses && summaryView === "codes") setSummaryView("grade");
    if (namedCourses && summaryView === "levels") setSummaryView("grade");
    if (!weightedGpa && summaryView === "weighting") setSummaryView("grade");
  }, [namedCourses, weightedGpa, summaryView]);

  useEffect(() => {
    if (!data?.default_scale?.length) return;
    const values = data.default_scale.map((row) => String(row.quality_points));
    if (!values.includes(String(fumbleGp))) {
      const top = data.default_scale.find((row) => row.letter !== "F") || data.default_scale[0];
      setFumbleGp(String(top.quality_points));
    }
  }, [data, fumbleGp]);

  // Saved guesses live on the server; seed the draft once so edits merge instead of wiping them.
  useEffect(() => {
    const grid = data?.future_guess?.grid;
    if (guessSeeded.current || !grid) return;
    guessSeeded.current = true;
    if (weightedGpa && grid.weighted) {
      const weighted = Object.fromEntries(
        Object.entries(grid.weighted).map(([tagId, letters]) => [
          tagId,
          Object.fromEntries(Object.entries(letters || {}).filter(([, count]) => Number(count))),
        ])
      );
      setGuessDraft({ weighted });
      return;
    }
    if (weightedGpa) {
      const legacy = grid["1"] || {};
      if (Object.keys(legacy).some((letter) => Number(legacy[letter]))) {
        setGuessDraft({
          weighted: {
            unweighted: Object.fromEntries(Object.entries(legacy).filter(([, count]) => Number(count))),
          },
        });
      }
      return;
    }
    const seeded = {};
    for (const [credits, counts] of Object.entries(grid)) {
      const used = Object.fromEntries(Object.entries(counts).filter(([, count]) => Number(count)));
      if (Object.keys(used).length) seeded[credits] = used;
    }
    setGuessDraft(seeded);
  }, [data, weightedGpa]);

  useEffect(() => {
    if (!data?.terms) return;
    setOpenTerms((prev) => {
      const next = { ...prev };
      for (const term of data.terms) {
        if (next[term.id] === undefined) next[term.id] = false;
      }
      return next;
    });
  }, [data]);

  const flatCourses = useMemo(() => {
    if (!data) return [];
    const rows = orderedTerms.flatMap((t) =>
      t.courses.map((c) => ({
        ...c,
        semester: displayCoursePeriod(t),
        periodKey: displayCoursePeriod(t),
        included: t.included,
        semesterOrder: highSchoolMode ? semesterSortValue(t) : semesterSortValue(t, semesterTitles),
      }))
    );
    if (highSchoolMode) {
      const periodTermCounts = new Map();
      orderedTerms.forEach((term) => {
        const period = displayCoursePeriod(term);
        periodTermCounts.set(
          period,
          Math.max(
            periodTermCounts.get(period) || 0,
            configuredHighSchoolTermCount(term, highSchoolTerms, highSchoolTermsByPeriod),
            1,
          ),
        );
      });
      const groups = new Map();
      rows.forEach((course) => {
        const code = String(course.code || "").trim().toLowerCase();
        const key = `${course.periodKey}\u0000${code}`;
        const current = groups.get(key);
        if (!current) {
          groups.set(key, {
            ...course,
            periodKey: course.periodKey,
            occurrenceCount: 1,
            scoreTotal: Number(course.score) || 0,
            latestCourse: course,
            finalCourse: course.quality_points != null ? course : null,
          });
          return;
        }
        current.occurrenceCount += 1;
        current.scoreTotal += Number(course.score) || 0;
        current.included = current.included && course.included;
        if (course.semesterOrder >= current.latestCourse.semesterOrder) current.latestCourse = course;
        if (
          course.quality_points != null
          && (!current.finalCourse || course.semesterOrder >= current.finalCourse.semesterOrder)
        ) {
          current.finalCourse = course;
        }
      });
      return [...groups.values()].map((group) => {
        const finalCourse = group.finalCourse || group.latestCourse;
        const termCount = periodTermCounts.get(group.periodKey) || group.occurrenceCount;
        const units = group.occurrenceCount / termCount;
        return {
          ...finalCourse,
          semester: group.periodKey,
          displayCode: finalCourse.code,
          included: group.included,
          score: finalCourse.quality_points != null
            ? Math.round((Number(finalCourse.quality_points) - Number(data.target_gp ?? 4)) * 3) * units
            : null,
          gpa_units: units,
          semesterOrder: group.latestCourse.semesterOrder,
        };
      });
    }
    const occurrences = new Map();
    rows.forEach((course) => {
      const code = String(course.code || "").toLowerCase();
      occurrences.set(code, (occurrences.get(code) || 0) + 1);
    });
    const occurrenceIndex = new Map();
    [...rows]
      .sort((a, b) => a.semesterOrder - b.semesterOrder || a.id - b.id)
      .forEach((course) => {
        const code = String(course.code || "").toLowerCase();
        const index = (occurrenceIndex.get(code) || 0) + 1;
        occurrenceIndex.set(code, index);
        course.displayCode = occurrences.get(code) > 1 ? `${course.code} (${index})` : course.code;
      });
    const key = {
      code: (c) => c.code.toLowerCase(),
      percent: (c) => c.percent ?? -1,
      letter: (c) => c.quality_points ?? -1,
      gpa: (c) => c.quality_points ?? -1,
      credits: (c) => highSchoolMode ? (c.gpa_units ?? 0) : (c.credits ?? 0),
      score: (c) => c.score ?? -999,
      // Sort by the normalized year/season order instead of the display label.
      // TERM_SEQUENCE is Spring -> Summer -> Fall (with Winter before Spring),
      // so same-year semesters remain chronological in either direction.
      semester: (c) => c.semesterOrder ?? Number.NEGATIVE_INFINITY,
    }[sort];
    return [...rows].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      if (av === bv) return 0;
      const cmp = av > bv ? 1 : -1;
      return desc ? -cmp : cmp;
    });
  }, [data, highSchoolMode, highSchoolTerms, highSchoolTermsByPeriod, orderedTerms, periodNames, semesterTitles, sort, desc, termNames]);

  const highSchoolUnitBreakdown = useMemo(() => {
    if (!highSchoolMode) return [];
    const counts = new Map();
    const includedPeriods = new Set(
      periodGroups
        .filter((group) => group.included)
        .map((group) => String(group.period_key))
    );
    (data?.overall_classes || []).forEach((course) => {
      if (course.quality_points == null) return;
      if (!includedPeriods.has(String(course.period))) return;
      const units = Number(course.units);
      if (!Number.isFinite(units) || units <= 0) return;
      const key = fmtUnitValue(units);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([units, count]) => ({ units, count }))
      .sort((a, b) => Number(b.units) - Number(a.units));
  }, [data, highSchoolMode, periodGroups]);

  const creditBreakdown = useMemo(() => {
    if (highSchoolMode) return null;
    const courses = orderedTerms
      .filter((term) => term.included)
      .flatMap((term) => term.courses || [])
      .filter(isGradedCreditSummaryCourse);
    const summarize = (items) => ({
      classes: items.length,
      credits: items.reduce((sum, course) => sum + (Number(course.credits) || 0), 0),
    });
    const passed = courses.filter(isPassingCreditSummaryCourse);
    const failed = courses.filter((course) => !isPassingCreditSummaryCourse(course));
    return {
      forCredit: summarize(courses.filter((course) => course.credit_mode !== "pass_fail")),
      passFail: summarize(courses.filter((course) => course.credit_mode === "pass_fail")),
      passed: summarize(passed),
      failed: summarize(failed),
    };
  }, [data, highSchoolMode, orderedTerms]);

  function toggleSort(next) {
    if (GRADE_SORT_KEYS.has(next)) {
      if (GRADE_SORT_KEYS.has(sort)) setDesc((d) => !d);
      else {
        setSort("gpa");
        setDesc(true);
      }
      return;
    }
    if (sort === next) setDesc((d) => !d);
    else {
      setSort(next);
      setDesc(next !== "code" && next !== "semester");
    }
  }

  if (!data) return <p className="muted">Loading…</p>;

  const letters = lettersFromScale(data.default_scale);
  const targetGradePoints = new Map((data.default_scale || []).map((row) => [row.letter, row.quality_points]));
  const isHighSchool = data.gradebook_type === "high_school";
  const futureGuessWeights = weightedGpa
    ? (data.gpa_weight_tags || []).map((tag) => ({
      ...tag,
      label: tag.id === "unweighted" ? "CP" : tag.name,
    }))
    : [];
  const weightedGuessMode = futureGuessWeights.length > 1;
  const plannedCourses = letters.reduce(
    (sum, letter) => sum + (Number(guessValue(letter)) || 0),
    0
  );
  // Planning usually only touches the top letters, so hide the long tail until it is used.
  const visibleGuessLetters = showAllGuessLetters
    ? letters
    : letters.filter((letter, index) => index < 6 || Number(guessValue(letter)));

  function guessValue(letter) {
    if (weightedGuessMode) {
      return futureGuessWeights.reduce(
        (sum, tag) => sum + (Number(guessDraft.weighted?.[tag.id]?.[letter]) || 0),
        0
      ) || "";
    }
    if (guessDraft["1"]?.[letter] !== undefined) return guessDraft["1"][letter];
    return CREDITS.reduce((sum, ch) => sum + ch * (Number(guessDraft[ch]?.[letter] ?? guessDraft[String(ch)]?.[letter]) || 0), 0) || "";
  }

  function guessWeightValue(tagId, letter) {
    return fmtGuessCount(guessDraft.weighted?.[tagId]?.[letter] ?? "");
  }

  async function commitGuess(tagId, letter, value) {
    if (weightedGuessMode) {
      const next = { ...(data?.future_guess?.grid || {}), ...guessDraft };
      next.weighted = { ...(next.weighted || {}) };
      next.weighted[tagId] = { ...(next.weighted[tagId] || {}) };
      next.weighted[tagId][letter] = Number(value) || 0;
      setGuessDraft(next);
      await apply(await api.patchSettings({ future_guess: next }));
      return;
    }
    const next = { ...(data?.future_guess?.grid || {}), ...guessDraft };
    next["1"] = { ...(next["1"] || {}) };
    next["1"][letter] = Number(value) || 0;
    for (const ch of CREDITS.slice(1)) delete next[String(ch)];
    setGuessDraft(next);
    await apply(await api.patchSettings({ future_guess: next }));
  }

  async function clearGuess() {
    setGuessDraft({});
    await apply(await api.patchSettings({ future_guess: {} }));
  }

  function toggleTerm(id) {
    setOpenTerms((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function expandAllTerms() {
    setOpenTerms(Object.fromEntries(orderedTerms.map((t) => [t.id, true])));
    setSemestersSectionOpen(true);
  }

  function collapseAllTerms() {
    setOpenTerms(Object.fromEntries(orderedTerms.map((t) => [t.id, false])));
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>GPA Dashboard</h1>
        </div>
        <div className="row">
          {showScore ? (
            <>
              <label className="muted">
                Target
                <select
                  className={`select letter-select ${letterClass(data.target_letter)}`}
                  style={{ display: "block", marginTop: 4 }}
                  value={data.target_letter}
                  onChange={async (e) => apply(await api.patchSettings({ target_letter: e.target.value }))}
                >
                  {letters.map((l) => (
                    <option key={l} value={l} className={letterClass(l)}>
                      {l} ({fmtGpa(targetGradePoints.get(l))})
                    </option>
                  ))}
                </select>
              </label>
              <label className="muted">
                {pluralizeTermLabel(termLabel)} remaining
                <input
                  className="input"
                  style={{ display: "block", marginTop: 4, width: 90 }}
                  defaultValue={data.semesters_remaining}
                  onBlur={async (e) =>
                    apply(await api.patchSettings({ semesters_remaining: Number(e.target.value) }))
                  }
                />
              </label>
            </>
          ) : null}
        </div>
      </div>

      <div className={`grid-stats gpa-dashboard-stats ${weightedGpa ? "has-weighted-gpa" : "without-weighted-gpa"}`}>
        <div className="stat">
          <div className="label">Overall GPA</div>
          <div className="value">
            <AnimatedValue value={data.overall_gpa} format={fmtGpa} />
          </div>
        </div>
        {weightedGpa ? <div className="stat">
          <div className="label">Overall WGPA</div>
          <div className="value">
            <AnimatedValue value={data.weighted_overall_gpa} format={fmtGpa} />
          </div>
        </div> : null}
        <div
          className="stat stat-info-hover"
          tabIndex={0}
          aria-describedby="credits-taken-tip"
        >
          <div className="label">{classBasis ? "Classes" : creditTerms.label}</div>
          <div className="value">
            <AnimatedValue value={highSchoolMode ? overallClassCount : classBasis ? distributionCourses.length : data.total_credits} integerFrames={!highSchoolMode && !classBasis} format={highSchoolMode || classBasis ? ((value) => Math.round(Number(value) || 0)) : fmtAnimatedCredits} />
          </div>
          <p className="stat-info-hover-bubble" id="credits-taken-tip" role="note">
              {highSchoolMode ? (
                <>
                  <span>Total units: {fmtUnitValue(overallClassUnits)}</span>
                  {highSchoolUnitBreakdown.length ? highSchoolUnitBreakdown.map((row) => (
                    <span key={row.units}>{row.units}-unit classes: {row.count}</span>
                  )) : <span>No graded units yet</span>}
                </>
              ) : (
                <>
                  {creditBreakdown ? (
                    <>
                      <span>For-credit classes: {creditBreakdown.forCredit.classes} · {fmtUnitValue(creditBreakdown.forCredit.credits)} {creditTerms.plural}</span>
                      <span>Pass/fail classes: {creditBreakdown.passFail.classes} · {fmtUnitValue(creditBreakdown.passFail.credits)} {creditTerms.plural}</span>
                      <span>Passed classes: {creditBreakdown.passed.classes} · {fmtUnitValue(creditBreakdown.passed.credits)} {creditTerms.plural}</span>
                      <span>Failed classes: {creditBreakdown.failed.classes} · {fmtUnitValue(creditBreakdown.failed.credits)} {creditTerms.plural}</span>
                    </>
                  ) : <span>No graded classes yet</span>}
                </>
              )}
          </p>
        </div>
        {showScore ? (
          <div className="stat">
            <div className="label">
              {isHighSchool ? "Score" : "Overall score"}
              <Tooltip text={isHighSchool
                ? "How far your classes sit above or below an A target using Unweighted GPA. A full academic-year A+ contributes +1 point above an A target; a class present in one of two semesters contributes +0.5."
                : "How far your classes sit above or below your target letter (A = 4.000). Each class adds about (Grade Point − Target GPA) × credits × 3. Positive means your GPA is greater than target, and negative means your GPA is less than target."} />
            </div>
            <div className={`value ${scoreClass(overallScore)}`}>
              <AnimatedValue value={hasClasses ? overallScore : null} integerFrames={!highSchoolMode && !classBasis} format={fmtAnimatedScore} />
            </div>
          </div>
        ) : null}
        {showScore ? (
          <div
            className="stat"
          >
            <div className="label">
              Buffer / {String(termLabel).toLowerCase()}
              <Tooltip text={`Your overall score spread across the ${data.semesters_remaining} ${Number(data.semesters_remaining) === 1 ? String(termLabel).toLowerCase() : pluralizeTermLabel(termLabel).toLowerCase()} you have left. Green/positive means you are ahead of target (${data.target_letter}) and can afford that much score drop each term; red/negative means you need to gain that much score each term.`} />
            </div>
            <div className={`value ${scoreClass(data.score_per_semester)}`}>
              <AnimatedValue value={hasClasses ? data.score_per_semester : null} format={fmtAnimatedHundredth} />
            </div>
          </div>
        ) : null}
      </div>

      {view === "semester" ? (
        <section className="panel course-grouping-panel term-accordion" style={{ marginBottom: 16 }}>
          <div className="view-toggle-row">
            <div className="view-toggle" role="group" aria-label="Course grouping">
              <button className="btn small primary" type="button" aria-pressed={true}>
                Group by {termLabel}
              </button>
              <button className="btn small" type="button" aria-pressed={false} onClick={() => setView("class")}>
                Sort by class
              </button>
            </div>
            <div className="term-accordion-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="btn small"
                type="button"
                onClick={() => {
                  expandAllTerms();
                }}
              >
                Expand all
              </button>
              <button className="btn small" type="button" onClick={collapseAllTerms}>
                Collapse all
              </button>
            </div>
          </div>
          <div className="term-accordion-body" style={{ paddingTop: 12 }}>
              {periodGroups.map((term) => {
                const open = !!openTerms[term.id];
                const termUnitValue = highSchoolMode || classBasis
                  ? (highSchoolMode ? term.overall_class_count : term.courses.length)
                  : term.term_credits;
                const termUnitLabel = highSchoolMode || classBasis
                  ? "classes"
                  : (Number(termUnitValue) === 1 ? creditTerms.singular : creditTerms.plural);
                return (
                  <section className="panel term-accordion" key={term.id} style={{ marginBottom: 10 }}>
                    <div
                      className="term-accordion-head"
                      onClick={() => toggleTerm(term.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && toggleTerm(term.id)}
                    >
                      <div>
                        <h2 className="term-accordion-title">
                          <span className={`term-accordion-chevron ${open ? "open" : ""}`}>▸</span>
                          {term.name}
                        </h2>
                        <p className={`term-accordion-meta ${term.included ? "" : "term-accordion-meta-excluded"}`}>
                          GPA {fmtGpa(term.term_gpa)}
                          {weightedGpa ? <> · WGPA {fmtGpa(term.term_wgpa)}</> : null}
                          {" "}· {highSchoolMode || classBasis ? termUnitValue : fmtUnitValue(termUnitValue)} {termUnitLabel}
                          {showScore ? (
                            <>
                              {" "}
                              · score{" "}
                              <span className={`mono ${term.included ? scoreClass(term.term_score) : "muted"}`}>
                                {fmtScore(term.term_score)}
                              </span>
                            </>
                          ) : null}
                        </p>
                      </div>
                      <div className="term-accordion-actions" onClick={(e) => e.stopPropagation()}>
                        <label className="checkbox term-include-checkbox">
                          <input
                            className="term-include-checkbox-input"
                            type="checkbox"
                            checked={term.included}
                            onChange={async (e) => {
                              await Promise.all(term.terms.map((item) => api.patchSemester(item.id, { included: e.target.checked })));
                              await load();
                              await onChange?.();
                            }}
                          />
                          Include
                        </label>
                      </div>
                    </div>
                    {open ? (
                      <div className="term-accordion-body">
                        <CourseTable courses={term.courses} displayCodes={displayCodes} weightedGpa={weightedGpa} weightTags={data.gpa_weight_tags} highSchoolMode={highSchoolMode} courseHref={courseHref} />
                      </div>
                    ) : null}
                  </section>
                );
              })}
          </div>
        </section>
      ) : (
        <div className="panel course-grouping-panel">
          <div className="view-toggle-row">
            <div className="view-toggle" role="group" aria-label="Course grouping">
              <button className="btn small" type="button" aria-pressed={false} onClick={() => setView("semester")}>
                Group by {termLabel}
              </button>
              <button className="btn small primary" type="button" aria-pressed={true}>
                Sort by class
              </button>
            </div>
          </div>
          <CourseTable courses={flatCourses} showSemester sort={sort} desc={desc} onSort={toggleSort} displayCodes={displayCodes} weightedGpa={weightedGpa} weightTags={data.gpa_weight_tags} highSchoolMode={highSchoolMode} courseHref={courseHref} termLabel={termLabel} />
        </div>
      )}

      <GpaTrendChart
        terms={trendTerms}
        overallClasses={data.overall_classes}
        gpaCap={data.gpa_cap}
        periodMode={highSchoolMode}
        periodOrder={periodOrder}
        semesterTitles={semesterTitles}
        weightedGpa={weightedGpa}
        showScore={showScore}
        weightTags={data.gpa_weight_tags}
        termLabel={termLabel}
      />

      <section className="panel dashboard-summary-panel" style={{ marginTop: 16 }}>
        <div className="dashboard-summary-toggle-row">
          <span className="muted">Sort By:</span>
          <div className="view-toggle" role="group" aria-label="Dashboard summary view">
            {[
              ["grade", "Course Grade"],
              ...(namedCourses ? [] : [["codes", "Course Codes"]]),
              ...(namedCourses ? [] : [["levels", "Course Levels"]]),
              ...(weightedGpa ? [["weighting", "Weighting"]] : []),
              ["labels", "Class Labels"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={`btn small ${summaryView === key ? "primary" : ""}`}
                type="button"
                aria-pressed={summaryView === key}
                onClick={() => setSummaryView(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {summaryView === "grade" ? (
          <div>
            <div>
              <GradeDistributionCharts distribution={summaryDistribution} courses={distributionCourses} showScoreChart={showScore} scoreTotal={overallScore} />
              <DistributionTable
                distribution={summaryDistribution}
                courses={distributionCourses}
                displayCodes={displayCodes}
                periodMode={highSchoolMode}
                courseHref={courseHref}
                termLabel={termLabel}
              />
            </div>
          </div>
        ) : summaryView === "codes" ? (
          <div>
            <CourseCodeStats
              terms={orderedTerms}
              letterOrder={letters}
              embedded
              minCredits={minCredits}
              setMinCredits={updateMinCredits}
              semesterTitles={semesterTitles}
              termLabel={termLabel}
              courseHref={courseHref}
            />
            <label className="muted dashboard-min-credits dashboard-min-credits-bottom">
              Min {creditTerms.plural}
              <input
                className="input"
                type="number"
                min="0"
                step="1"
                value={minCredits}
                onChange={(e) => updateMinCredits(e.target.value)}
              />
              <Tooltip text="Only include in the table course codes that have at least this many credits of." />
            </label>
          </div>
        ) : summaryView === "weighting" ? (
          <WeightingStats terms={orderedTerms} overallClasses={data.overall_classes} weightTags={data.gpa_weight_tags} letterOrder={letters} termNames={termNames} periodNames={periodNames} termLabel={termLabel} highSchoolMode={highSchoolMode} highSchoolTerms={highSchoolTerms} highSchoolTermsByPeriod={highSchoolTermsByPeriod} semesterTitles={semesterTitles} embedded courseHref={courseHref} />
        ) : summaryView === "levels" ? (
          <CourseLevelStats rows={data.level_stats} terms={orderedTerms} letterOrder={letters} semesterTitles={semesterTitles} termLabel={termLabel} embedded courseHref={courseHref} />
        ) : (
          <ClassLabelStats terms={orderedTerms} classLabels={classLabels} courseLabels={courseLabels} letterOrder={letters} highSchoolMode={highSchoolMode} periodNames={periodNames} highSchoolTerms={highSchoolTerms} highSchoolTermsByPeriod={highSchoolTermsByPeriod} semesterTitles={semesterTitles} termLabel={termLabel} targetGp={data.target_gp} embedded courseHref={courseHref} />
        )}
      </section>

      <div className="gpa-planning-panels">
              <FumblesPanel
                data={{ ...data, terms: orderedTerms }}
          showScore={showScore}
          weightedGpa={weightedGpa}
          fumbleCourse={fumbleCourse}
          setFumbleCourse={setFumbleCourse}
          fumbleGp={fumbleGp}
          setFumbleGp={setFumbleGp}
          fumbleAlreadyAdded={fumbleAlreadyAdded}
          apply={apply}
                highSchoolMode={highSchoolMode}
                periodGroups={periodGroups}
                semesterTitles={semesterTitles}
                courseHref={courseHref}
              />

        {data.exam_impact?.cumulative?.courses ? (
          <section className="panel exam-impact-panel" style={{ marginTop: 16 }}>
          <div className="tooltip-heading">
            <h2>Exam impact</h2>
            <Tooltip side="right" text="Summary on how your final exam scores impacted your grades, including the average difference in grades and the number of classes whose letter grade went up or down after an exam" />
          </div>
          <ExamImpactStats summary={data.exam_impact.cumulative} />
          <table className="exam-impact-term-table">
            <thead>
              <tr>
                <th>{termLabel}</th>
                <th>Avg exam vs tests</th>
                <th>Letters up</th>
                <th>Letters down</th>
                <th>Unchanged</th>
              </tr>
            </thead>
            <tbody>
              {(data.exam_impact.terms || [])
                .filter((term) => term.included && term.rows?.length)
                .map((term) => (
                  <tr key={term.semester_id}>
                    <td>
                      <Link to={`/courses?gradebook=${gradebookId}&term=${term.semester_id}#exam-impact`}>{term.name}</Link>
                    </td>
                    <td className={`mono ${scoreClass(term.avg_delta)}`}>{fmtDelta(term.avg_delta)}</td>
                    <td className="mono pos">{term.letter_up || ""}</td>
                    <td className="mono neg">{term.letter_down || ""}</td>
                    <td className="mono">{term.letter_same || 0}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          </section>
        ) : null}

        <section className="panel term-accordion future-guess-panel" style={{ marginTop: 16 }}>
        <div className="term-accordion-head">
          <div>
            <h2 className="term-accordion-title">
              Future guess
            </h2>
            <p className="term-accordion-meta">
            {highSchoolMode
              ? "Enter as units, so a full year class is 1, half year class .5, etc."
              : `How many remaining courses at each letter and ${creditTerms.singular} load.`}
            </p>
          </div>
        </div>
        <div className="guess-body">
            <div className="guess-toolbar">
              <div className="row">
                {letters.length > visibleGuessLetters.length || showAllGuessLetters ? (
                  <button className="btn small" type="button" onClick={() => setShowAllGuessLetters((v) => !v)}>
                    {showAllGuessLetters ? "Show top letters" : "Show all letters"}
                  </button>
                ) : null}
                <button className="btn small" type="button" disabled={!plannedCourses} onClick={clearGuess}>
                  Clear
                </button>
              </div>
            </div>
            <div className="table-wrap">
              <table className={`guess-grid ${weightedGuessMode ? "guess-grid-weighted" : ""}`}>
                <thead>
                  <tr>
                    <th>Letter</th>
                    {weightedGuessMode
                      ? futureGuessWeights.map((tag) => <th key={tag.id}>{tag.label}</th>)
                      : <th>{creditTerms.label}</th>}
                  </tr>
                </thead>
                <tbody>
                  {visibleGuessLetters.map((letter) => {
                    const credits = Number(guessValue(letter)) || 0;
                    return (
                      <tr key={letter} className={credits ? "has-plan" : ""}>
                        <td>
                          <span className={`letter ${letterClass(letter)}`}>{letter}</span>
                        </td>
                        {weightedGuessMode
                          ? futureGuessWeights.map((tag) => (
                              <td key={tag.id}>
                                <input
                                  className={`input guess-cell ${Number(guessWeightValue(tag.id, letter)) ? "filled" : ""}`}
                                  type="number"
                                  inputMode="decimal"
                                  min="0"
                                  step="any"
                                  placeholder="0"
                                  aria-label={`${letter} ${tag.label}`}
                                  value={fmtGuessCount(guessWeightValue(tag.id, letter))}
                                  onChange={(e) =>
                                    setGuessDraft({
                                      ...guessDraft,
                                      weighted: {
                                        ...(guessDraft.weighted || {}),
                                        [tag.id]: { ...(guessDraft.weighted?.[tag.id] || {}), [letter]: e.target.value },
                                      },
                                    })
                                  }
                                  onBlur={(e) => commitGuess(tag.id, letter, e.target.value)}
                                />
                              </td>
                            ))
                          : (
                            <td>
                              <input
                                className={`input guess-cell ${Number(guessValue(letter)) ? "filled" : ""}`}
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                placeholder="0"
                                aria-label={`${letter} ${creditTerms.plural}`}
                                value={fmtGuessCount(guessValue(letter))}
                                onChange={(e) =>
                                  setGuessDraft({
                                    ...guessDraft,
                                    "1": { ...(guessDraft["1"] || {}), [letter]: e.target.value },
                                  })
                                }
                                onBlur={(e) => commitGuess(null, letter, e.target.value)}
                              />
                            </td>
                          )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="fumble-adjusted future-guess-adjusted">
              <div className="fumble-adjusted-grid with-score-delta">
                <div />
                <div className="fumble-adjusted-heading">Actual</div>
                <div className="fumble-adjusted-heading">Δ</div>
                <div className="fumble-adjusted-heading">Adjusted</div>
                {showScore ? (
                  <>
                    <div className="fumble-adjusted-row-label">Score</div>
                    <div className="mono"><SignedValue value={data.overall_score} /></div>
                    <div className={`mono ${scoreClass(data.future_guess.delta_score)}`}>
                      <SignedValue value={data.future_guess.delta_score} compact />
                    </div>
                    <div className={`mono ${scoreClass(data.future_guess.adjusted_score)}`}>
                      <SignedValue value={data.future_guess.adjusted_score} />
                    </div>
                  </>
                ) : null}
                <div className="fumble-adjusted-row-label">{highSchoolMode ? "Units" : creditTerms.label}</div>
                <div className="mono">{fmtGuessCount(data.gpa_credits)}</div>
                <div className="mono">{Number(data.future_guess.extra_credits) > 0 ? fmtGuessCount(data.future_guess.extra_credits) : "—"}</div>
                <div className="mono">{data.future_guess.adjusted_credits == null ? "—" : fmtGuessCount(data.future_guess.adjusted_credits)}</div>
                <div className="fumble-adjusted-row-label">GPA</div>
                <div className="mono">{fmtGpa(data.overall_gpa)}</div>
                <div />
                <div className="mono">{fmtGpa(data.future_guess.adjusted_gpa)}</div>
                {weightedGpa && data.weighted_overall_gpa != null ? (
                  <>
                    <div className="fumble-adjusted-row-label">WGPA</div>
                    <div className="mono">{fmtGpa(data.weighted_overall_gpa)}</div>
                    <div />
                    <div className="mono">{fmtGpa(data.future_guess.adjusted_wgpa)}</div>
                  </>
                ) : null}
              </div>
            </div>
        </div>
        </section>
      </div>
    </>
  );
}

function CourseTable({ courses, showSemester = false, sort = null, desc = false, onSort = null, displayCodes = new Map(), weightedGpa = false, weightTags = [], highSchoolMode = false, courseHref, termLabel = "Semester" }) {
  const creditTerms = useCreditTerms();
  const gpaBasis = useGpaBasis();
  const showScore = useShowScore();
  const showCredits = highSchoolMode || gpaBasis !== "classes";
  const creditLabel = highSchoolMode ? "Units" : creditTerms.label;
  if (!courses.length) return <div className="empty">No classes in this view.</div>;

  const sortable = typeof onSort === "function";
  const cols = [
    showSemester ? ["semester", termLabel] : null,
    ["code", "Class"],
    showCredits ? ["credits", creditLabel] : null,
    ["percent", "%"],
    ["letter", "Letter"],
    ["gpa", "GP"],
    weightedGpa ? ["wgpa", "WGP"] : null,
    showScore ? ["score", "Score"] : null,
  ].filter(Boolean);

  return (
    <table>
      <thead>
        <tr>
          {cols.map(([key, label]) => (
            <th key={key}>
              {sortable && key !== "wgpa" ? (
                <button
                  className={sort === key || (GRADE_SORT_KEYS.has(key) && GRADE_SORT_KEYS.has(sort)) ? "active" : ""}
                  onClick={() => onSort(key)}
                >
                  {label}
                  {sort === key || (GRADE_SORT_KEYS.has(key) && GRADE_SORT_KEYS.has(sort)) ? (desc ? " ↓" : " ↑") : ""}
                </button>
              ) : (
                label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(sortable ? courses : [...courses].sort((a, b) => {
          const aName = displayCodes.get(a.id) || a.display_code || a.displayCode || a.code || "";
          const bName = displayCodes.get(b.id) || b.display_code || b.displayCode || b.code || "";
          return String(aName).localeCompare(String(bName), undefined, { numeric: true, sensitivity: "base" })
            || Number(a.id || 0) - Number(b.id || 0);
        })).map((c) => (
          <tr key={c.id}>
            {showSemester ? <td className="muted">{c.semester}</td> : null}
            <td>
              <Link to={courseHref?.(c) || `/courses/${c.id}`}>{displayCodes.get(c.id) || c.display_code || c.displayCode || c.code}</Link>
            </td>
            {showCredits ? <td className="mono">{c.gp_override === -1 ? "—" : fmtUnitValue(highSchoolMode ? c.period_units ?? c.gpa_units ?? 0 : c.credits)}</td> : null}
            <td className={`mono ${c.gp_override === -1 ? "letter-neutral" : dashboardCourseGradeClass(c)}`}>{fmtPct(c.percent)}</td>
            <td className="course-letter-cell">
              <span className="course-letter-display">
                <span className={`letter ${c.gp_override === -1 ? "letter-neutral" : dashboardCourseGradeClass(c)}`}>
                  {c.letter || "—"}
                </span>
                {c.gp_override != null || c.pass_fail_override != null ? <span className="grade-override-marker" aria-label="Grade overridden">*</span> : null}
              </span>
            </td>
            <td className="mono">{fmtGpa(c.quality_points)}</td>
            {weightedGpa ? <td className="mono">{fmtGpa(c.quality_points == null || c.gp_override === -1 ? null : highSchoolMode ? c.period_weighted_quality_points ?? c.quality_points : Number(c.quality_points) + (Number(weightTags.find((tag) => tag.id === c.gpa_weight_tag)?.boost) || 0))}</td> : null}
            {showScore ? <td className={`mono ${scoreClass(c.score)}`}>{fmtScore(c.score)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
