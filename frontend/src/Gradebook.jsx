import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  api,
  assignmentPercent,
  courseGradeClass,
  defaultExamCategoryId,
  examNeededRows,
  fmtGpa,
  fmtPct,
  fmtScore,
  gradeFromPercent,
  letterClass,
  letterFromPercent,
  projectPercentFromExam,
  pointsExamNeededRows,
  pointsPercentFromExam,
  parseScoreExpression,
  passFailGradeAffectsGpa,
  scoreClass,
  trueGradeFromCourse,
} from "./api";
import { PassFailScaleEditor, ScaleRowsEditor } from "./ScaleEditor.jsx";
import { Tooltip, useShowScore } from "./creditLabel.jsx";
import { buildCourseDisplayCodes } from "./courseNames.js";
import { sortSemesters } from "./seasons.js";

function highSchoolAcademicYearKey(semester) {
  if (!semester) return "";
  return String(["spring", "summer"].includes(semester.season) ? Number(semester.year) - 1 : semester.year);
}

function highSchoolAcademicYearLabel(semester) {
  const start = Number(semester?.year) - (semester?.season === "spring" || semester?.season === "summer" ? 1 : 0);
  return Number.isFinite(start)
    ? `${start}–${String(start + 1).slice(-2)}`
    : "Academic year";
}
import { FlagIcon, FlagSummaryButton, flaggedAssignmentsForCourse, flagsForAssignment } from "./flags.jsx";
import { useToasts } from "./notifications.jsx";

const DEFAULT_AGG_OPTIONS = [
  ["average", "Average"],
  ["points_ratio", "Points"],
];

const ROUNDING_OPTIONS = [
  ["", "No rounding"],
  ["0", "Whole number (92.5 → 93)"],
  ["1", "One decimal (92.45 → 92.5)"],
];

const ROUNDING_NOTE = {
  0: "a whole number",
  1: "one decimal",
};

const ASSIGNMENT_SINGULARS = {
  readings: "Reading",
  quizzes: "Quiz",
  tests: "Test",
  exams: "Exam",
  projects: "Project",
  homeworks: "Homework",
  hws: "HW",
  assignments: "Assignment",
};

function defaultAssignmentBase(categoryName) {
  const name = String(categoryName || "").trim();
  if (!name) return "Assignment";
  const singular = ASSIGNMENT_SINGULARS[name.toLowerCase()];
  if (!singular) return name;
  if (name === name.toUpperCase()) return singular.toUpperCase();
  if (name === name.toLowerCase()) return singular.toLowerCase();
  return singular;
}

function incrementNumberedName(name) {
  const match = String(name || "").trim().match(/^(.*\S)\s+(\d+)$/);
  return match ? `${match[1]} ${Number(match[2]) + 1}` : "";
}

function defaultAssignmentName(category) {
  const assignments = category?.assignments || [];
  const previousName = [...assignments].reverse().map((assignment) => assignment?.name).find((name) => String(name || "").trim());
  const numberedName = incrementNumberedName(previousName);
  if (numberedName) return numberedName;
  return `${defaultAssignmentBase(category?.name)} ${assignments.length + 1}`;
}

function fmtWeightPct(weight) {
  if (weight == null || Number.isNaN(weight)) return "—";
  const pct = Number((weight * 100).toPrecision(12));
  if (Number.isInteger(pct)) return String(pct);
  return String(pct);
}

function formatGradeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatCompactReplacementNumber(value) {
  return formatGradeNumber(value).replace(/^(\-?)0\./, "$1.");
}

function formatBonusNumber(value) {
  return formatGradeNumber(value).replace(/^(-?)0\./, "$1.");
}

function formatBonusPercent(value) {
  const text = formatBonusNumber(value);
  return Number(value) < 0 ? `${text}%` : `+${text}%`;
}

function pctFromWeight(weight) {
  if (weight == null || Number.isNaN(Number(weight))) return "";
  return String(Number((Number(weight) * 100).toPrecision(12)));
}

function categoryDraftFromCat(cat) {
  const usesPerItem = cat?.weight_per_item != null;
  return {
    name: cat?.name || "",
    weightMode: usesPerItem ? "per_item" : "weight",
    weightPct: usesPerItem
      ? pctFromWeight(cat.weight_per_item) || "0"
      : cat
        ? pctFromWeight(cat.weight) || "0"
        : "20",
    aggregation: cat?.aggregation || "average",
    dropCount: String(cat?.drop_count ?? 0),
    replaceCount: String(cat?.replace_with_category_id != null ? (cat.replace_count ?? 1) : 0),
    replaceWithCategoryId: cat?.replace_with_category_id ? String(cat.replace_with_category_id) : "",
  };
}

function categoryHasEnteredData(category) {
  return (category?.assignments || []).some((assignment) => {
    const name = String(assignment.name ?? "").trim();
    const grade = String(assignment.display ?? "").trim();
    return Boolean(name || grade);
  });
}

function pointsCategoryPercent(category, course = null) {
  let earned = 0;
  let possible = 0;
  let hasScore = false;
  const assignments = course
    ? pointsCourseKeptAssignments(course).get(category?.id) || []
    : category?.assignments || [];
  for (const assignment of assignments) {
    if (assignment.is_bonus || assignment.earned == null) continue;
    const denominator = Number(assignment.possible);
    earned += Number(assignment.earned);
    possible += Number.isFinite(denominator) && denominator > 0 ? denominator : 100;
    hasScore = true;
  }
  return hasScore && possible > 0 ? (100 * earned) / possible : null;
}

function pointsCoursePercent(course) {
  let earned = 0;
  let possible = 0;
  let bonusPoints = 0;
  let bonusPercent = 0;
  for (const category of course?.categories || []) {
    if (category.is_bonus_category) {
      for (const assignment of category.assignments || []) {
        if (assignment.earned == null) continue;
        if (Number(assignment.possible) === 0) bonusPoints += Number(assignment.earned);
      }
      if (!(category.assignments || []).some((assignment) => Number(assignment.possible) === 0)) {
        bonusPercent += Number(category.percent) || 0;
      }
      continue;
    }
    for (const assignment of category.assignments || []) {
      if (assignment.is_bonus || assignment.earned == null) continue;
      earned += Number(assignment.earned);
      const denominator = Number(assignment.possible);
      possible += Number.isFinite(denominator) && denominator > 0 ? denominator : 100;
    }
  }
  return possible > 0 ? (100 * (earned + bonusPoints)) / possible + bonusPercent : null;
}

function pointsCourseKeptAssignments(course) {
  const scoredByCategory = (course?.categories || [])
    .filter((category) => !category.is_bonus_category)
    .map((category) => ({
      category,
      assignments: (category.assignments || []).filter(
        (assignment) => !assignment.is_bonus && assignment.earned != null
      ),
    }));
  const kept = new Map(scoredByCategory.map(({ category, assignments }) => [category.id, assignments]));
  if (!scoredByCategory.some(({ category }) => Number(category.drop_count) > 0)) return kept;

  let low = -1000000;
  let high = 1000000;
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const ratio = (low + high) / 2;
    let earned = 0;
    let possible = 0;
    for (const { category, assignments } of scoredByCategory) {
      const selected = rankedPointsAssignments(assignments, Number(category.drop_count) || 0, ratio);
      earned += selected.reduce((sum, assignment) => sum + Number(assignment.earned), 0);
      possible += selected.reduce((sum, assignment) => sum + pointsPossibleForAssignment(assignment), 0);
    }
    if (earned - ratio * possible >= 0) low = ratio;
    else high = ratio;
  }
  for (const { category, assignments } of scoredByCategory) {
    kept.set(category.id, rankedPointsAssignments(assignments, Number(category.drop_count) || 0, low));
  }
  return kept;
}

function pointsCourseSummary(course) {
  let earned = 0;
  let possible = 0;
  let bonusPoints = 0;
  let bonusPercent = 0;
  const keptByCategory = pointsCourseKeptAssignments(course);
  for (const category of course?.categories || []) {
    if (category.is_bonus_category) {
      const hasPointBonus = (category.assignments || []).some(
        (assignment) => assignment.earned != null && Number(assignment.possible) === 0
      );
      if (hasPointBonus) {
        for (const assignment of category.assignments || []) {
          if (assignment.earned != null && Number(assignment.possible) === 0) {
            bonusPoints += Number(assignment.earned);
          }
        }
      } else {
        bonusPercent += Number(category.percent) || 0;
      }
      continue;
    }
    for (const assignment of keptByCategory.get(category.id) || []) {
      earned += Number(assignment.earned);
      possible += pointsPossibleForAssignment(assignment);
    }
  }
  if (possible <= 0) return null;
  const percentBonusPoints = (bonusPercent / 100) * possible;
  return {
    classEarned: earned,
    classPossible: possible,
    bonusPoints: bonusPoints + percentBonusPoints,
    totalEarned: earned + bonusPoints + percentBonusPoints,
    totalPossible: possible,
    bonusPercent,
  };
}

function speculativeAssignment(assignment, raw) {
  if (raw && typeof raw === "object" && raw.composite) {
    const fields = speculativeCompositeFields(raw.composite, raw.categoryAggregation);
    return {
      ...assignment,
      composite: raw.composite,
      display: fields.score_text || "",
      score_input: fields.score_text || "",
      earned: fields.earned,
      possible: fields.possible,
    };
  }
  const text = String(raw ?? "").trim();
  if (!text) return { ...assignment, display: "", score_input: "", earned: null };

  const expression = parseScoreExpression(text);
  if (expression && Number.isFinite(expression.earned) && Number.isFinite(expression.possible)) {
    return { ...assignment, display: text, score_input: text, earned: expression.earned, possible: expression.possible };
  }

  const ratio = text.match(/^(-?\d+(?:\.\d+)?)\s*[/,]\s*(-?\d+(?:\.\d+)?)$/);
  if (ratio) {
    const earned = Number(ratio[1]);
    const possible = Number(ratio[2]);
    if (Number.isFinite(earned) && Number.isFinite(possible) && possible !== 0) {
      return { ...assignment, display: text, score_input: text, earned, possible };
    }
    return assignment;
  }

  const percent = Number(text);
  return Number.isFinite(percent)
    ? { ...assignment, display: text, score_input: text, earned: percent, possible: assignment.possible ?? 100 }
    : assignment;
}

function speculativeCompositeFields(composite, categoryAggregation) {
  const mode = composite?.mode || "percent";
  const items = (composite?.items || []).map((item) => {
    const raw = String(item?.score || "").trim();
    if (!raw) return null;
    let earned = null;
    let possible = null;
    let percent = null;
    if (mode === "points") {
      const ratio = raw.replace(/^=/, "").match(/^(-?\d+(?:\.\d+)?)\s*[/,]\s*(-?\d+(?:\.\d+)?)$/);
      if (!ratio || Number(ratio[2]) <= 0) return null;
      earned = Number(ratio[1]);
      possible = Number(ratio[2]);
      percent = (100 * earned) / possible;
    } else if (raw.startsWith("=") || raw.includes("/") || raw.includes(",")) {
      const parsed = raw.startsWith("=")
        ? parseScoreExpression(raw)
        : raw.match(/^(-?\d+(?:\.\d+)?)\s*[/,]\s*(-?\d+(?:\.\d+)?)$/)?.slice(1).map(Number);
      if (!parsed) return null;
      earned = Array.isArray(parsed) ? parsed[0] : parsed.earned;
      possible = Array.isArray(parsed) ? parsed[1] : parsed.possible;
      if (!Number.isFinite(earned) || !Number.isFinite(possible) || possible === 0) return null;
      percent = (100 * earned) / possible;
    } else {
      percent = Number(raw.replace(/%$/, ""));
      if (!Number.isFinite(percent)) return null;
    }
    return { earned, possible, percent, weight: Number(item?.weight) || 1 };
  }).filter(Boolean);
  if (!items.length) return { earned: null, possible: null, score_text: null };

  const drop = Math.min(Math.max(Number(composite?.drop_count) || 0, 0), Math.max(items.length - 1, 0));
  const kept = [...items].sort((a, b) => a.percent - b.percent).slice(drop);
  if (mode === "points") {
    const earned = sumNumbers(kept.map((item) => item.earned));
    const possible = sumNumbers(kept.map((item) => item.possible));
    return {
      earned,
      possible,
      score_text: `${categoryAggregation === "points_ratio" ? "" : "="}${formatGradeNumber(earned)}/${formatGradeNumber(possible)}`,
    };
  }

  const totalWeight = sumNumbers(kept.map((item) => item.weight));
  const percent = mode === "weighted_percent"
    ? sumNumbers(kept.map((item) => item.percent * item.weight)) / totalWeight
    : sumNumbers(kept.map((item) => item.percent)) / kept.length;
  if (categoryAggregation === "points_ratio" && mode === "percent" && Number(composite?.total_points) > 0) {
    const possible = Number(composite.total_points);
    const earned = (percent * possible) / 100;
    return { earned, possible, score_text: `${formatGradeNumber(earned)}/${formatGradeNumber(possible)}` };
  }
  return {
    earned: percent,
    possible: 100,
    score_text: categoryAggregation === "points_ratio" ? `${formatGradeNumber(percent)}/100` : formatGradeNumber(percent),
  };
}

function speculativeCategoryPercent(category, categories, seen = new Set()) {
  if (category.is_bonus_category) {
    return (category.assignments || [])
      .filter((assignment) => assignment.is_bonus && assignment.earned != null)
      .reduce((sum, assignment) => sum + Number(assignment.earned), 0);
  }

  const regular = (category.assignments || [])
    .filter((assignment) => !assignment.is_bonus)
    .map((assignment) => assignmentPercent({
      display: assignment.display,
      earned: assignment.earned,
      possible: assignment.possible,
      isBonus: false,
    }))
    .filter((percent) => percent != null);
  if (!regular.length) return null;

  const drop = Math.min(Math.max(Number(category.drop_count) || 0, 0), regular.length - 1);
  const scores = [...regular].sort((a, b) => b - a).slice(0, regular.length - drop);
  const nextSeen = new Set(seen).add(category.id);
  if (category.replace_with_category_id != null && !nextSeen.has(category.replace_with_category_id)) {
    const replacementCategory = categories.find((item) => item.id === category.replace_with_category_id);
    const replacement = replacementCategory
      ? speculativeCategoryPercent(replacementCategory, categories, nextSeen)
      : null;
    const replacements = Math.min(
      Math.max(Number(category.replace_count ?? 0) || 0, 0),
      scores.length,
    );
    if (replacement != null) {
      for (let index = 0; index < replacements; index += 1) {
        const lowest = Math.min(...scores);
        scores.splice(scores.indexOf(lowest), 1, replacement);
      }
    }
  }

  const assignmentBonuses = (category.assignments || [])
    .filter((assignment) => assignment.is_bonus && assignment.bonus_type !== "category" && assignment.earned != null)
    .reduce((sum, assignment) => sum + Number(assignment.earned), 0);
  const categoryBonuses = (category.assignments || [])
    .filter((assignment) => assignment.is_bonus && assignment.bonus_type === "category" && assignment.earned != null)
    .reduce((sum, assignment) => sum + Number(assignment.earned), 0);
  return (sumNumbers(scores) + assignmentBonuses) / scores.length + categoryBonuses;
}

function sumNumbers(values) {
  return values.reduce((sum, value) => sum + Number(value), 0);
}

function speculativeCourseFromScores(course, scores) {
  if (!course || !Object.keys(scores).length) return course;
  const mappedCategories = (course.categories || []).map((category) => ({
    ...category,
    assignments: (category.assignments || []).map((assignment) => (
      Object.prototype.hasOwnProperty.call(scores, assignment.id)
        ? speculativeAssignment(assignment, scores[assignment.id])
      : assignment
    )),
  }));
  const categories = mappedCategories.map((category) => ({
    ...category,
    percent: course.grading_mode === "weighted"
      ? speculativeCategoryPercent(category, mappedCategories)
      : category.percent,
  }));
  const next = { ...course, categories, speculative: true };
  if (course.grading_mode === "weighted") {
    const summary = weightedCourseSummary(next);
    next.percent = summary ? summary.classPercent + summary.bonusPercent : null;
  } else {
    const summary = pointsCourseSummary(next);
    next.percent = summary ? (100 * summary.totalEarned) / summary.totalPossible : null;
  }
  return next;
}

function weightedCourseSummary(course) {
  const regular = (course?.categories || []).filter((category) => !category.is_bonus_category);
  const used = regular
    .map((category) => [
      Number(category.effective_weight ?? category.weight),
      course?.speculative ? speculativeCategoryPercent(category, course.categories) : Number(category.percent),
    ])
    .filter(([weight, percent]) => Number.isFinite(weight) && weight > 0 && Number.isFinite(percent));
  if (!used.length) return null;
  const weightTotal = used.reduce((sum, [weight]) => sum + weight, 0);
  if (!weightTotal) return null;
  const classPercent = used.reduce((sum, [weight, percent]) => sum + weight * percent, 0) / weightTotal;
  const bonusCategory = (course.categories || []).find((category) => category.is_bonus_category);
  const bonusPercent = course.bonus_mode === "category"
    ? (course?.speculative ? Number(speculativeCategoryPercent(bonusCategory, course.categories)) || 0 : Number(bonusCategory?.percent) || 0)
    : course.bonus_mode === "none" || course.bonus_mode === "static_points"
      ? 0
      : Number(course.bonus_points) || 0;
  return { classPercent, bonusPercent };
}

function PointsSummary({ summary, tone, speculative = false }) {
  if (!summary) return null;
  const bonusLabel = summary.bonusPercent > 0 && summary.bonusPoints > 0
    ? `${formatGradeNumber(summary.bonusPoints)} (${formatGradeNumber(summary.bonusPercent)}%)`
    : formatGradeNumber(summary.bonusPoints);
  const hasBonus = summary.bonusPoints !== 0 || summary.bonusPercent !== 0;
  return (
    <span className="grade-hero-points-wrap">
      <strong className={`mono grade-hero-points ${tone} ${speculative ? "speculative-grade" : ""}`.trim()}>
        = {formatGradeNumber(summary.totalEarned)}/{formatGradeNumber(summary.totalPossible)}
      </strong>
      {hasBonus ? (
        <span className="grade-hero-points-popover" role="tooltip">
          <span><span>Class:</span><strong>{formatGradeNumber(summary.classEarned)}</strong></span>
          <span><span>Bonus:</span><strong>{bonusLabel}</strong></span>
          <span className="grade-hero-points-total"><span>Total:</span><strong>{formatGradeNumber(summary.totalEarned)}</strong></span>
        </span>
      ) : null}
    </span>
  );
}

function PercentSummary({ summary, tone, percent, speculative = false }) {
  if (!summary || summary.bonusPercent === 0) {
    return <strong className={`mono grade-hero-pct ${tone} ${speculative ? "speculative-grade" : ""}`.trim()}>{fmtPct(percent)}%</strong>;
  }
  return (
    <span className="grade-hero-percent-wrap">
      <strong className={`mono grade-hero-pct ${tone} ${speculative ? "speculative-grade" : ""}`.trim()}>{fmtPct(percent)}%</strong>
      <span className="grade-hero-points-popover grade-hero-percent-popover" role="tooltip">
        <span><span>Class:</span><strong>{fmtPct(summary.classPercent)}%</strong></span>
        <span><span>Bonus:</span><strong>{fmtPct(summary.bonusPercent)}%</strong></span>
      </span>
    </span>
  );
}

function isPointsScore(raw, allowZeroDenominator = false, allowSinglePoints = false) {
  const text = String(raw || "").trim();
  const expression = parseScoreExpression(text);
  if (expression) return allowZeroDenominator || expression.possible !== 0;
  if (allowSinglePoints && /^\d+(?:\.\d+)?$/.test(text)) return true;
  const match = text.match(/^-?\d+(?:\.\d+)?\s*[/,]\s*-?\d+(?:\.\d+)?$/);
  const denominator = match ? Number(match[0].split(/[\/,]/)[1]) : null;
  return Boolean(match && (allowZeroDenominator || denominator !== 0));
}

function draftToPayload(draft) {
  const pct = Number(draft.weightPct);
  const weightValue = Number.isFinite(pct) ? pct / 100 : 0;
  const drop = Number(draft.dropCount);
  const replace = Number(draft.replaceCount);
  const replaceCount = Number.isFinite(replace) && replace >= 0 ? Math.floor(replace) : 0;
  const perItem = draft.weightMode === "per_item";
  return {
    name: draft.name.trim(),
    weight: perItem ? 0 : weightValue,
    weight_per_item: perItem ? weightValue : null,
    aggregation: draft.aggregation,
    drop_count: Number.isFinite(drop) && drop >= 0 ? Math.floor(drop) : 0,
    replace_count: replaceCount,
    replace_with_category_id: replaceCount > 0 && draft.replaceWithCategoryId ? Number(draft.replaceWithCategoryId) : null,
  };
}

function valuesDiffer(a, b) {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  if (typeof a === "number" || typeof b === "number") {
    return Math.abs(Number(a) - Number(b)) > 1e-6;
  }
  return a !== b;
}

function courseHasOverride(course, trueGrade) {
  if (course?.credit_mode === "pass_fail") {
    const automatic = trueGradeFromCourse({ ...course, pass_fail_override: null });
    return course.pass_fail_override != null && course.pass_fail_override !== automatic.letter;
  }
  if (course?.gp_override == null) return false;
  return (
    valuesDiffer(course.letter, trueGrade.letter)
    || valuesDiffer(course.quality_points, trueGrade.qualityPoints)
    || valuesDiffer(course.score, trueGrade.score)
  );
}

function GradeHeroMeta({ letter, qualityPoints, score, showScore, struck = false, overrideLabel = false, tone = "", isPassFail = false, showPassFailMetrics = false, speculative = false }) {
  const showMetrics = !isPassFail || showPassFailMetrics;
  return (
    <div className={`grade-hero-meta ${struck ? "is-struck" : ""}`}>
      <span className={`letter letter-hero-circle ${struck ? "is-struck-letter" : tone || letterClass(letter)} ${speculative ? "speculative-grade" : ""}`.trim()}>
        {letter || "—"}
      </span>
      <div className="grade-hero-gp-score">
        {showMetrics ? <span className={`mono grade-hero-gpa ${speculative ? "speculative-grade" : ""}`.trim()}>{fmtGpa(qualityPoints)}</span> : null}
        {showScore && showMetrics ? (
          <span className={`grade-hero-score ${struck ? "" : scoreClass(score)} ${speculative ? "speculative-grade" : ""}`.trim()}>
            Score: <span className="mono">{fmtScore(score)}</span>
          </span>
        ) : null}
        {overrideLabel ? <span className="grade-hero-override-label">Override</span> : null}
      </div>
    </div>
  );
}

function SpeculationSummaryReporter({ summary, onChange }) {
  useEffect(() => {
    onChange?.(summary);
  }, [onChange, summary?.letter, summary?.percentText, summary?.speculative, summary?.tone]);
  return null;
}

function ClassLabelsPicker({ course, classLabels, selectedLabels, onLabelsChange }) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef(null);
  const selected = new Set((selectedLabels || []).map(String));
  const selectedNames = classLabels
    .filter((label) => selected.has(String(label.id)))
    .map((label) => label.name);

  useEffect(() => {
    if (!open) return undefined;
    function closePicker(event) {
      if (!pickerRef.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closePicker);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closePicker);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="course-settings-labels-picker" ref={pickerRef}>
      <span className="course-settings-labels-caption">Class Labels:</span>
      <button
        className="input course-settings-labels-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Class Labels: ${selectedNames.length ? selectedNames.join(", ") : "None"}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="course-settings-labels-value">
          {selectedNames.length ? selectedNames.join(", ") : "None"}
        </span>
        <span className="course-settings-labels-arrow" aria-hidden="true" />
      </button>
      {open ? (
        <div className="course-settings-labels-popover" role="listbox" aria-label={`Class Labels for ${course.code}`}>
          {classLabels.map((label) => (
            <label className="course-settings-label-option" key={label.id}>
              <input
                type="checkbox"
                checked={selected.has(String(label.id))}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(String(label.id));
                  else next.delete(String(label.id));
                  onLabelsChange?.([...next]);
                }}
              />
              <span>{label.name}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function Gradebook({ onChange, colorAssignmentGrades = true, flags = [], classLabels = [], courseLabels = {}, onAppearanceChange, colorFlaggedAssignments = false, readableTextBackground = true, gradebookId = "default", semesterTitles = [], speculationMode = false, onSpeculationSummaryChange, highSchoolMode = false, academicPeriodNames = {}, highSchoolTerms = [], highSchoolTermsByPeriod = {}, classType = "alphanumeric", weightedGpa = false }) {
  const showScore = useShowScore();
  const { warning, push } = useToasts();
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [course, setCourse] = useState(null);
  const [semesters, setSemesters] = useState([]);
  const [allCourses, setAllCourses] = useState([]);
  const [error, setError] = useState("");
  const [nameEditorOpen, setNameEditorOpen] = useState(false);
  const [department, setDepartment] = useState("");
  const [courseNumber, setCourseNumber] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [creditsDraft, setCreditsDraft] = useState("");
  const [showGradingMenu, setShowGradingMenu] = useState(false);
  const [showScale, setShowScale] = useState(false);
  const [showDynamic, setShowDynamic] = useState(false);
  const [showExamCalc, setShowExamCalc] = useState(false);
  const [openCats, setOpenCats] = useState({});
  const [profiles, setProfiles] = useState([]);
  const [presets, setPresets] = useState([]);
  const [aggOptions, setAggOptions] = useState(DEFAULT_AGG_OPTIONS);
  const [categoryModal, setCategoryModal] = useState(null);
  const [dragCatId, setDragCatId] = useState(null);
  const [speculativeScores, setSpeculativeScores] = useState({});
  const dragCatIdRef = useRef(null);
  const dragStartOrderRef = useRef(null);
  const categoriesRef = useRef([]);
  const scrollToCategoryIdRef = useRef(null);
  const handledAssignmentHashRef = useRef("");
  const gradingMenuRef = useRef(null);

  function highSchoolTermName(semester) {
    if (!semester) return "Term";
    const periodKey = highSchoolAcademicYearKey(semester);
    const periodTerms = highSchoolTermsByPeriod?.[periodKey] || [];
    const allTerms = Object.values(highSchoolTermsByPeriod || {}).flat();
    const terms = [...periodTerms, ...(highSchoolTerms || []), ...allTerms];
    const season = String(semester.season || "").trim().toLowerCase();
    const match = terms.find((term) => String(term?.season || term?.id || "").trim().toLowerCase() === season);
    if (match?.name) return match.name;
    const semesterLabel = String(semester.name || "").replace(/^\d{4}\s+/, "").trim().toLowerCase();
    const nameMatch = terms.find((term) => String(term?.name || "").trim().toLowerCase() === semesterLabel);
    if (nameMatch?.name) return nameMatch.name;
    const fallbackSeason = season && /^[a-z]+$/.test(season) ? `${season.charAt(0).toUpperCase()}${season.slice(1)}` : "";
    return fallbackSeason || semester.name || "Term";
  }

  useEffect(() => {
    if (!speculationMode) setSpeculativeScores({});
  }, [speculationMode]);

  useEffect(() => {
    if (!showGradingMenu) return undefined;
    function closeGradingMenu(event) {
      if (!gradingMenuRef.current?.contains(event.target)) setShowGradingMenu(false);
    }
    document.addEventListener("pointerdown", closeGradingMenu);
    return () => document.removeEventListener("pointerdown", closeGradingMenu);
  }, [showGradingMenu]);

  function suppressNextClick() {
    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.removeEventListener("click", stop, true);
    };
    window.addEventListener("click", stop, true);
    window.setTimeout(() => window.removeEventListener("click", stop, true), 500);
  }

  async function load() {
    const [c, s, m, allCourses] = await Promise.all([api.course(id), api.semesters(), api.meta(), api.courses()]);
    const orderedSemesters = highSchoolMode ? s : sortSemesters(s, semesterTitles);
    const displayCodes = buildCourseDisplayCodes(orderedSemesters, allCourses, semesterTitles);
    setCourse({ ...c, display_code: displayCodes.get(c.id) || c.display_code });
    setAllCourses(allCourses);
    setCreditsDraft(String(c.credits ?? ""));
    setSemesters(orderedSemesters);
    setProfiles(m.scale_profiles || []);
    setPresets(m.scale_presets || []);
    const ids = Array.isArray(m.aggregations) && m.aggregations.length ? m.aggregations : ["average", "points_ratio"];
    const labels = m.aggregation_labels || {};
    setAggOptions(ids.map((aggId) => [aggId, labels[aggId] || aggId]));
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [highSchoolMode, id, semesterTitles]);

  function relatedHighSchoolCourses() {
    if (!highSchoolMode || !course) return [course].filter(Boolean);
    const periodKey = highSchoolAcademicYearKey(semesters.find((semester) => String(semester.id) === String(course.semester_id)));
    const code = String(course.code || "").trim().toLowerCase();
    return allCourses.filter((item) => (
      String(item.code || "").trim().toLowerCase() === code
      && String(highSchoolAcademicYearKey(semesters.find((semester) => String(semester.id) === String(item.semester_id)))) === String(periodKey)
    ));
  }

  useEffect(() => {
    if (!course?.categories) return;
    setOpenCats((prev) => {
      const next = { ...prev };
      for (const cat of course.categories) {
        if (next[cat.id] === undefined) next[cat.id] = true;
      }
      return next;
    });
  }, [course?.categories]);

  useEffect(() => {
    const assignmentId = location.hash.startsWith("#assignment-")
      ? location.hash.slice("#assignment-".length)
      : "";
    const hash = location.hash;
    if (!assignmentId || !course?.categories?.length || handledAssignmentHashRef.current === hash) return;
    handledAssignmentHashRef.current = hash;

    function clearAssignmentHash() {
      if (window.location.hash !== hash) return;
      window.history.replaceState(null, "", `${location.pathname}${location.search}`);
    }

    function clearOnScrollKey(event) {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
        clearAssignmentHash();
      }
    }

    window.addEventListener("wheel", clearAssignmentHash, { passive: true });
    window.addEventListener("touchmove", clearAssignmentHash, { passive: true });
    window.addEventListener("keydown", clearOnScrollKey);
    window.requestAnimationFrame(() => {
      const row = [...document.querySelectorAll("tr[data-assignment-id]")].find(
        (node) => String(node.dataset.assignmentId) === assignmentId
      );
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    return () => {
      window.removeEventListener("wheel", clearAssignmentHash);
      window.removeEventListener("touchmove", clearAssignmentHash);
      window.removeEventListener("keydown", clearOnScrollKey);
    };
  }, [course?.id, location.hash, location.pathname, location.search]);

  useEffect(() => {
    const categoryId = scrollToCategoryIdRef.current;
    if (!categoryId || !course?.categories?.some((cat) => cat.id === categoryId)) return;
    scrollToCategoryIdRef.current = null;
    window.requestAnimationFrame(() => {
      document.querySelector(`.cat-card[data-cat-id="${categoryId}"]`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, [course?.categories]);

  categoriesRef.current = course?.categories || [];

  function beforeCategoryId(clientY, draggingId) {
    const nodes = document.querySelectorAll(".cards .cat-card[data-cat-id]");
    for (const node of nodes) {
      const id = Number(node.dataset.catId);
      if (id === draggingId) continue;
      const rect = node.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return id;
    }
    return null;
  }

  function onCategoryDragStart(event, catId) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragCatIdRef.current = catId;
    dragStartOrderRef.current = (course.categories || []).map((c) => c.id);
    setDragCatId(catId);
    suppressNextClick();
  }

  function onCategoryDragMove(event) {
    const draggingId = dragCatIdRef.current;
    if (draggingId == null) return;
    const beforeId = beforeCategoryId(event.clientY, draggingId);
    setCourse((current) => {
      if (!current) return current;
      const categories = moveCategoryBefore(current.categories, draggingId, beforeId);
      if (categories === current.categories) return current;
      categoriesRef.current = categories;
      return { ...current, categories };
    });
  }

  async function onCategoryDragEnd() {
    if (dragCatIdRef.current == null) return;
    dragCatIdRef.current = null;
    setDragCatId(null);
    const start = dragStartOrderRef.current;
    dragStartOrderRef.current = null;
    const ids = categoriesRef.current.map((c) => c.id);
    if (!start || (ids.length === start.length && ids.every((catId, index) => catId === start[index]))) {
      return;
    }
    try {
      const next = await api.reorderCategories(Number(id), ids);
      setCourse(next);
      onChange?.();
      setError("");
    } catch (err) {
      setError(err.message);
      load().catch((loadErr) => setError(loadErr.message));
    }
  }

  async function saveCourse(patch) {
    const previous = course;
    const switchingToWeighted = patch.grading_mode === "weighted" && patch.grading_mode !== previous.grading_mode;
    const incompatibleBonus = switchingToWeighted && (
      previous.bonus_mode === "static_points"
      || (previous.categories || []).some(
        (category) => category.is_bonus_category && category.aggregation === "points_ratio"
      )
    );
    let next = await api.patchCourse(id, incompatibleBonus
      ? { ...patch, bonus_mode: "none", bonus_points: 0 }
      : patch);
    if (highSchoolMode && patch.gpa_weight_tag != null) {
      await Promise.all(relatedHighSchoolCourses()
        .filter((item) => String(item.id) !== String(id))
        .map((item) => api.patchCourse(item.id, { gpa_weight_tag: patch.gpa_weight_tag })));
    }
    if (patch.grading_mode && patch.grading_mode !== previous.grading_mode) {
      const toPoints = patch.grading_mode === "points";
      if (!toPoints && previous.grading_mode === "points") {
        for (const category of previous.categories || []) {
          if (!category.is_bonus_category && category.aggregation === "points_ratio") {
            next = await api.patchCategory(category.id, { aggregation: "average" });
          }
        }
      }
      for (const category of previous.categories || []) {
        for (const assignment of category.assignments || []) {
          let raw = String(assignment.score_input || assignment.display || "").trim();
          if (!raw) continue;
          if (!toPoints && incompatibleBonus && category.is_bonus_category && assignment.is_bonus && assignment.possible === 0) {
            continue;
          }
          if (toPoints) {
            if (raw.startsWith("=")) raw = raw.slice(1).trim();
            if (!raw.includes("/") && !raw.includes(",")) {
              raw = `${raw}/${category.is_bonus_category && assignment.is_bonus ? 0 : 100}`;
            }
          } else if ((raw.includes("/") || raw.includes(",")) && !raw.startsWith("=")) {
            raw = `=${raw}`;
          }
          try {
            next = await api.patchAssignment(assignment.id, { score: raw });
          } catch (err) {
            console.error(err);
      }
    }
  }
    }
    setCourse(next);
    if (patch.code != null) {
      // Course names are shared by every occurrence of a class in this
      // gradebook. Reload the matching records so display labels and overall
      // rollups reflect the rename immediately as well.
      await load();
    }
    onChange?.();
  }

  function openNameEditor() {
    const match = String(course?.code || "").trim().match(/^([A-Za-z]+)\s*(.*)$/);
    setDepartment(match?.[1] || "MAE");
    setCourseNumber(match?.[2] || "");
    setNameDraft(String(course?.code || ""));
    setCreditsDraft(String(course?.credits ?? ""));
    setNameEditorOpen(true);
  }

  async function saveNameEditor(event) {
    event.preventDefault();
    if (classType === "named") {
      if (!nameDraft.trim()) return;
      await saveCourse({ code: nameDraft.trim() });
      setNameEditorOpen(false);
      return;
    }
    if (!department.trim() || !courseNumber.trim()) return;
    await saveCourse({
      code: `${department.trim().toUpperCase()} ${courseNumber.trim()}`,
    });
    setNameEditorOpen(false);
  }

  async function saveCategorySettings(payload) {
    let next =
      categoryModal?.mode === "edit" && categoryModal.cat
        ? await api.patchCategory(categoryModal.cat.id, payload)
        : await api.createCategory({ course_id: Number(id), ...payload });
    const previous = categoryModal?.cat;
    if (
      previous
      && previous.aggregation !== "points_ratio"
      && payload.aggregation === "points_ratio"
      && !previous.is_bonus_category
    ) {
      for (const assignment of previous.assignments || []) {
        let raw = String(assignment.score_input || assignment.display || "").trim();
        if (!raw) continue;
        if (raw.startsWith("=")) raw = raw.slice(1).trim();
        if (!raw.includes("/") && !raw.includes(",")) raw = `${raw}/100`;
        next = await api.patchAssignment(assignment.id, { score: raw });
      }
    }
    setCourse(next);
    onChange?.();
    setCategoryModal(null);
  }

  async function renameCategory(categoryId, name) {
    const nextName = String(name || "").trim();
    const current = (course.categories || []).find((category) => category.id === categoryId);
    if (!current || !nextName || nextName === current.name) return;
    const next = await api.patchCategory(categoryId, { name: nextName });
    setCourse(next);
    onChange?.();
  }

  async function deleteCategory(category) {
    let next = await api.deleteCategory(category.id);
    if (category.is_bonus_category) {
      next = await api.patchCourse(course.id, { bonus_mode: "none", bonus_points: 0 });
    }
    setCourse(next);
    onChange?.();
  }

  function queueCategoryDelete(category) {
    push({
      id: `delete-category-${category.id}`,
      type: "persistent",
      title: "Delete category?",
      message: `Delete ${category.name} and its assignments? This can not be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await deleteCategory(category);
        } catch (err) {
          warning(err.message);
        }
      },
    });
  }

  async function deleteCategoryFromModal() {
    const category = categoryModal?.cat;
    if (!category) return;
    setCategoryModal(null);
    if (!categoryHasEnteredData(category)) {
      try {
        await deleteCategory(category);
      } catch (err) {
        warning(err.message);
      }
      return;
    }
    queueCategoryDelete(category);
  }

  function expandAllCategories() {
    if (!course) return;
    setOpenCats(Object.fromEntries(course.categories.map((c) => [c.id, true])));
  }

  function collapseAllCategories() {
    if (!course) return;
    setOpenCats(Object.fromEntries(course.categories.map((c) => [c.id, false])));
  }

  const [examCatId, setExamCatId] = useState(undefined);
  const [examScoreRaw, setExamScoreRaw] = useState("");

  useEffect(() => {
    setExamScoreRaw("");
    setExamCatId(undefined);
  }, [id]);

  useEffect(() => {
    if (!course?.categories) return;
    const eligible = course.categories.filter((c) => !c.is_bonus_category);
    const ids = new Set(eligible.map((c) => c.id));
    if (examCatId === undefined) {
      const savedId = course.exam_category_id;
      setExamCatId(savedId != null && ids.has(savedId) ? savedId : defaultExamCategoryId(eligible));
      return;
    }
    if (examCatId != null && !ids.has(examCatId)) {
      setExamCatId(null);
    }
  }, [course, examCatId]);

  const displayCourse = speculativeCourseFromScores(course, speculativeScores);
  if (!course) return <p className="muted">{error || "Loading…"}</p>;
  const bonusCategory = course.categories.find((category) => category.is_bonus_category);
  const bonusMode = course.grading_mode === "points" && (course.bonus_mode === "static" || course.bonus_mode == null)
    ? "static_percent"
    : course.bonus_mode || (bonusCategory ? "category" : "static");
  const displayCoursePercent = displayCourse.percent;
  const pointsSummary = displayCourse.grading_mode === "points" ? pointsCourseSummary(displayCourse) : null;
  const percentSummary = displayCourse.grading_mode === "weighted" ? weightedCourseSummary(displayCourse) : null;
  const actualGradeCourse = displayCourse.credit_mode === "pass_fail"
    ? { ...displayCourse, pass_fail_override: null }
    : displayCourse;
  const trueGrade = trueGradeFromCourse({ ...actualGradeCourse, percent: displayCoursePercent });
  const speculationPreview = speculationMode && Object.keys(speculativeScores).length > 0;
  const hasOverride = courseHasOverride(course, trueGrade);
  const showFailingPassFailMetrics = !speculationPreview && passFailGradeAffectsGpa(displayCourse, displayCourse.letter);
  const pctLetter = hasOverride ? course.letter : trueGrade.letter || course.letter;
  const actualGradeTone = displayCourse.credit_mode === "pass_fail"
    ? courseGradeClass(actualGradeCourse)
    : letterClass(trueGrade.letter);
  const pctTone = speculationMode
    ? actualGradeTone
    : displayCourse.credit_mode === "pass_fail" ? courseGradeClass(displayCourse) : letterClass(pctLetter);
  const flaggedItems = flaggedAssignmentsForCourse(course, flags);
  const speculationLetter = trueGrade.letter || course.letter || "—";
  const speculationTone = actualGradeTone;
  const speculationSummary = {
    letter: speculationLetter,
    percentText: fmtPct(displayCoursePercent),
    tone: speculationTone,
    speculative: speculationPreview,
  };

  async function setBonusMode(mode) {
    if (bonusCategory && mode !== "category") {
      const removeBonusCategory = async () => {
        await deleteCategory(bonusCategory);
        const next = await api.patchCourse(course.id, {
          bonus_mode: mode,
          ...(mode === "none" ? { bonus_points: 0 } : {}),
        });
        setCourse(next);
        onChange?.();
      };
      if (categoryHasEnteredData(bonusCategory)) {
        push({
          id: `delete-category-${bonusCategory.id}`,
          type: "persistent",
          title: "Delete category?",
          message: `Delete ${bonusCategory.name} and its assignments? This can not be undone.`,
          confirmLabel: "Delete",
          onConfirm: async () => {
            try {
              await removeBonusCategory();
            } catch (err) {
              warning(err.message);
            }
          },
        });
      } else {
        await removeBonusCategory();
      }
      return;
    }
    if (mode === "category" && !bonusCategory) {
      const createdCourse = await api.createCategory({
        course_id: course.id,
        name: "Bonus",
        weight: 0,
        aggregation: course.grading_mode === "points" ? "points_ratio" : "average",
        include_bonus: true,
        is_bonus_category: true,
      });
      const createdBonusCategory = createdCourse.categories?.find((category) => category.is_bonus_category);
      scrollToCategoryIdRef.current = createdBonusCategory?.id ?? null;
      setCourse(await api.patchCourse(course.id, { bonus_mode: "category", bonus_points: 0 }));
      onChange?.();
      return createdCourse;
    }
    const next = await api.patchCourse(course.id, {
      bonus_mode: mode,
      ...(mode === "none" || mode === "category" ? { bonus_points: 0 } : {}),
    });
    setCourse(next);
    onChange?.();
  }

  async function saveExamCategory(nextId) {
    const previousId = examCatId;
    setExamCatId(nextId);
    try {
      const next = await api.patchCourse(course.id, { exam_category_id: nextId });
      setCourse(next);
      onChange?.();
    } catch (err) {
      setExamCatId(previousId);
      setError(err.message);
    }
  }

  return (
    <div className={speculationMode ? "gradebook speculation-mode" : "gradebook"}>
      <SpeculationSummaryReporter summary={speculationSummary} onChange={onSpeculationSummaryChange} />
      <div className="gradebook-header">
        <div className="gradebook-header-title">
          <p className="muted">
            <Link to={`/courses?gradebook=${gradebookId}&term=${course.semester_id}`}>
              {highSchoolMode ? `${academicPeriodNames[String(highSchoolAcademicYearKey(semesters.find((s) => s.id === course.semester_id)))] || highSchoolAcademicYearLabel(semesters.find((s) => s.id === course.semester_id))} / ${highSchoolTermName(semesters.find((s) => s.id === course.semester_id))}` : (semesters.find((s) => s.id === course.semester_id)?.name || "Semester")}
            </Link>{" "}
            /
          </p>
          <div className="gradebook-title-row">
            <h1>{classType === "named" ? course.code : (course.display_code || course.code)}</h1>
            <div className="course-settings-menu">
              <button
                className="course-name-edit-btn"
                type="button"
                aria-label="Class settings"
                aria-expanded={nameEditorOpen}
                onClick={() => (nameEditorOpen ? setNameEditorOpen(false) : openNameEditor())}
              >
                ✎
              </button>
              {nameEditorOpen ? (
                <form
                  className="course-settings-popover"
                  onSubmit={saveNameEditor}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <h2>Class settings</h2>
                  <div className="course-settings-popover-fields">
                    {classType === "named" ? <label className="muted course-settings-code-field">
                      <span>Name</span>
                      <input className="input" aria-label="Name" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
                    </label> : <label
                      className="muted course-settings-code-field"
                      style={{ "--course-department-width": `${Math.max(6, department.length + 4)}ch` }}
                    >
                      <span className="course-settings-code-labels"><span>Course</span><span>Code</span></span>
                      <div className="course-settings-code-group">
                        <input
                          className="input"
                          aria-label="Course"
                          style={{ width: `${Math.max(6, department.length + 4)}ch`, maxWidth: "100%" }}
                          value={department}
                          onChange={(e) => setDepartment(e.target.value)}
                        />
                        <input
                          className="input"
                          aria-label="Code"
                          type="text"
                          inputMode="numeric"
                          value={courseNumber}
                          onChange={(e) => setCourseNumber(e.target.value.replace(/\D/g, ""))}
                        />
                      </div>
                    </label>}
                    {course.gpa_basis !== "classes" ? <label className="muted course-settings-credits-field">
                      Credits:
                      <input
                        className="input"
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={creditsDraft}
                        onChange={(e) => setCreditsDraft(e.target.value)}
                        onBlur={async () => {
                          const credits = Number(creditsDraft);
                          if (!Number.isFinite(credits) || credits <= 0 || credits === Number(course.credits)) return;
                          try {
                            await saveCourse({ credits });
                          } catch (err) {
                            setCreditsDraft(String(course.credits ?? ""));
                            setError(err.message);
                          }
                        }}
                      />
                    </label> : null}
                    {weightedGpa ? (
                      <label className="muted course-settings-credits-field">
                        WGPA Weight:
                        <select
                          className="select"
                          value={course.gpa_weight_tag || "unweighted"}
                          onChange={async (e) => {
                            try {
                              await saveCourse({ gpa_weight_tag: e.target.value });
                            } catch (err) {
                              setError(err.message);
                            }
                          }}
                        >
                          {(course.gpa_weight_tags || []).map((tag) => (
                            <option key={tag.id} value={tag.id}>{tag.name}{Number(tag.boost) ? ` (+${tag.boost})` : ""}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {classLabels.length ? (
                      <div className="muted course-settings-labels-field">
                        <ClassLabelsPicker
                          course={course}
                          classLabels={classLabels}
                          selectedLabels={[...new Set(relatedHighSchoolCourses().flatMap((item) => courseLabels?.[String(item.id)] || []))]}
                          onLabelsChange={(labelIds) => onAppearanceChange?.((current) => ({
                            ...current,
                            courseLabels: {
                              ...(current.courseLabels || {}),
                              ...Object.fromEntries(relatedHighSchoolCourses().map((item) => [String(item.id), labelIds])),
                            },
                          }))}
                        />
                      </div>
                    ) : null}
                  </div>
                  <div className="modal-actions">
                    <button
                      className="btn danger"
                      type="button"
                      onClick={() => {
                        push({
                          id: `delete-course-${course.id}`,
                          type: "persistent",
                          title: "Delete class?",
                          message: `Delete ${course.code}? This can not be undone.`,
                          confirmLabel: "Delete",
                          onConfirm: async () => {
                            try {
                              await api.deleteCourse(course.id);
                              window.dispatchEvent(new Event("grade-snapshots-updated"));
                              onChange?.();
                              navigate(`/courses?gradebook=${gradebookId}&term=${course.semester_id}`);
                            } catch (err) {
                              warning(err.message);
                            }
                          },
                        });
                      }}
                    >
                      Delete class
                    </button>
                    <div className="row">
                      <button className="btn" type="button" onClick={() => setNameEditorOpen(false)}>Cancel</button>
                      <button className="btn primary" type="submit">Save</button>
                    </div>
                  </div>
                </form>
              ) : null}
            </div>
            <div className={`grade-hero ${displayCourse.credit_mode === "pass_fail" && !showFailingPassFailMetrics ? "no-secondary-values" : ""}`.trim()}>
              {hasOverride && !speculationMode ? (
                <>
                  <GradeHeroMeta
                    letter={trueGrade.letter}
                    qualityPoints={trueGrade.qualityPoints}
                    score={trueGrade.score}
                    showScore={showScore}
                    tone={courseGradeClass(displayCourse)}
                    isPassFail={displayCourse.credit_mode === "pass_fail"}
                    showPassFailMetrics={false}
                    struck
                    speculative={speculationPreview}
                  />
                  <GradeHeroMeta
                    letter={course.letter}
                    qualityPoints={displayCourse.quality_points}
                    score={displayCourse.score}
                    showScore={showScore}
                    tone={courseGradeClass(displayCourse)}
                    isPassFail={displayCourse.credit_mode === "pass_fail"}
                    showPassFailMetrics={showFailingPassFailMetrics}
                    overrideLabel
                    speculative={speculationPreview}
                  />
                </>
              ) : (
                <GradeHeroMeta
                  letter={trueGrade.letter}
                  qualityPoints={displayCourse.credit_mode === "pass_fail" ? displayCourse.quality_points : trueGrade.qualityPoints}
                  score={displayCourse.credit_mode === "pass_fail" ? displayCourse.score : trueGrade.score}
                  showScore={showScore}
                  tone={speculationMode ? actualGradeTone : courseGradeClass(displayCourse)}
                  isPassFail={displayCourse.credit_mode === "pass_fail"}
                  showPassFailMetrics={showFailingPassFailMetrics}
                  speculative={speculationPreview}
                />
              )}
              {percentSummary ? (
                <PercentSummary
                  summary={percentSummary}
                  tone={pctTone}
                  percent={displayCoursePercent}
                  speculative={speculationPreview}
                />
              ) : (
                <strong className={`mono grade-hero-pct ${pctTone} ${speculationPreview ? "speculative-grade" : ""}`.trim()}>
                  {fmtPct(displayCoursePercent)}%
                </strong>
              )}
              {pointsSummary ? <PointsSummary summary={pointsSummary} tone={pctTone} speculative={speculationPreview} /> : null}
            </div>
          </div>
        </div>

        <div className="gradebook-header-toolbar">
          <div className="panel row course-settings">
            <div ref={gradingMenuRef} className={`course-settings-grading-menu ${showGradingMenu ? "is-open" : ""}`}>
              <span className="muted course-settings-grading-menu-label">Credit &amp; Grading</span>
              <button
                className="btn course-settings-grading-trigger"
                type="button"
                aria-expanded={showGradingMenu}
                aria-haspopup="menu"
                onClick={() => setShowGradingMenu((open) => !open)}
              >
                <span className="course-settings-grading-current">
                  {course.credit_mode === "pass_fail" ? "Pass/Fail" : "Letter Grade"}
                  <span aria-hidden="true"> · </span>
                  {course.grading_mode === "points" ? "Points" : "Weighted"}
                </span>
              </button>
              {showGradingMenu ? (
                <div className="course-settings-grading-popover" role="menu">
                  <label className="muted" role="none">
                    <span>
                      Class Type:
                      <Tooltip text="Letter Grade assigns A–F letter grades; Pass/Fail assigns a passing or failing status." />
                    </span>
                    <select
                      className="select select-left-arrow course-settings-class-type-select"
                      value={course.credit_mode || "for_credit"}
                      onChange={async (event) => {
                        try {
                          await saveCourse({ credit_mode: event.target.value });
                        } catch (err) {
                          setError(err.message);
                        }
                      }}
                    >
                      <option value="for_credit">Letter Grade</option>
                      <option value="pass_fail">Pass/Fail</option>
                    </select>
                  </label>
                  <label className="muted" role="none">
                    <span>
                      Category Grading:
                      <Tooltip text="Weighted combines category grades by their weights; Points combines earned points over possible points." />
                    </span>
                    <select
                      className="select select-left-arrow course-settings-category-grading-select"
                      value={course.grading_mode === "points" ? "points" : "weighted"}
                      onChange={(e) => {
                        const mode = e.target.value;
                        if (mode === "points") setShowDynamic(false);
                        saveCourse({ grading_mode: mode });
                      }}
                    >
                      <option value="weighted">Weighted</option>
                      <option value="points">Points</option>
                    </select>
                  </label>
                </div>
              ) : null}
            </div>
            <div className={`course-settings-bonus-group bonus-mode-${bonusMode}${bonusMode === "none" ? " is-none" : ""}`}>
              <label className="muted course-settings-bonus">
                Bonus Type
                <select
                  className="select select-left-arrow"
                  value={bonusMode}
                  onChange={(e) => setBonusMode(e.target.value).catch((err) => setError(err.message))}
                >
                  {course.grading_mode === "points" ? (
                    <>
                      <option value="static_points">Overall Pts:</option>
                      <option value="static_percent">Overall %:</option>
                    </>
                  ) : <option value="static">Overall:</option>}
                  <option value="category">Category:</option>
                  <option value="none">None</option>
                </select>
              </label>
              {bonusMode === "static" || bonusMode === "static_points" || bonusMode === "static_percent" ? (
                <div className="course-settings-bonus-value">
                  <input
                    key={`${bonusMode}-bonus`}
                    className="input"
                    aria-label="Total bonus"
                    defaultValue={
                      bonusMode === "static_points"
                        ? formatGradeNumber(course.bonus_points)
                        : formatBonusPercent(course.bonus_points)
                    }
                    onFocus={(e) => {
                      if (bonusMode !== "static_points") {
                        e.target.value = e.target.value.replace(/^\+/, "").replace(/%$/, "");
                      }
                    }}
                    onBlur={(e) => {
                      const value = Number(String(e.target.value).replace(/%/g, ""));
                      const bonus = Number.isFinite(value) ? value : 0;
                      e.target.value = bonusMode === "static_points"
                        ? formatGradeNumber(bonus)
                        : formatBonusPercent(bonus);
                      saveCourse({
                        bonus_points: bonus,
                        bonus_mode: bonusMode === "static_points" ? "static_points" : bonusMode === "static_percent" ? "static_percent" : "static",
                      });
                    }}
                  />
                </div>
              ) : bonusMode === "category" ? (
                <div className="course-settings-bonus-value">
                  <input
                    key="category-bonus"
                    className="input"
                    aria-label="Total bonus"
                    value={bonusCategory?.percent == null ? "+0%" : `+${formatBonusNumber(bonusCategory.percent)}%`}
                    readOnly
                    aria-readonly="true"
                  />
                </div>
              ) : null}
            </div>
            <div className="course-settings-actions">
              <button
                className={`btn course-settings-cutoffs ${showScale ? "primary" : ""}`}
                type="button"
                aria-pressed={showScale}
                aria-expanded={showScale}
                onClick={() => {
                  setShowScale((v) => !v);
                  setShowDynamic(false);
                }}
              >
                Cutoffs
              </button>
              {course.grading_mode === "points" ? null : (
              <button
                className={`btn course-settings-cutoffs ${showDynamic ? "primary" : ""}`}
                type="button"
                aria-pressed={showDynamic}
                aria-expanded={showDynamic}
                onClick={() => {
                  setShowDynamic((v) => !v);
                  setShowScale(false);
                }}
              >
                Dynamic Weight
              </button>
              )}
            </div>
            {flaggedItems.length ? (
              <div className="gradebook-flag-summary">
                <FlagSummaryButton items={flaggedItems} flags={flags} gradebookId={gradebookId} />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {showScale ? (
        <ScaleEditor
          course={course}
          profiles={profiles}
          presets={presets}
          onSave={async (rows, passFail, minimumPassingLetter) => {
            try {
              setCourse(await api.updateScale(course.id, rows, passFail || course.pass_fail, minimumPassingLetter || course.minimum_passing_letter));
              setError("");
            } catch (err) {
              setError(err.message);
            }
          }}
          onApply={async ({ profileId, presetId }) => {
            try {
              setCourse(await api.resetScale(course.id, profileId ? { scale_profile_id: profileId } : { preset_id: presetId }));
              setError("");
            } catch (err) {
              setError(err.message);
            }
          }}
          onRoundingChange={(grade_rounding) => saveCourse({ grade_rounding })}
        />
      ) : null}

      {showDynamic && course.grading_mode !== "points" ? (
        <DynamicWeightingEditor
          course={course}
          onChange={async (next) => {
            setCourse(next);
            onChange?.();
          }}
          onError={setError}
        />
      ) : null}

      <div className="row gradebook-cat-toolbar">
        {course.categories.length > 0 ? (
          <>
            <button className="btn small" type="button" onClick={expandAllCategories}>
              Expand all
            </button>
            <button className="btn small" type="button" onClick={collapseAllCategories}>
              Collapse all
            </button>
          </>
        ) : null}
        <button
          className={`btn small exam-needed-toggle ${showExamCalc ? "primary" : ""}`}
          type="button"
          aria-pressed={showExamCalc}
          aria-expanded={showExamCalc}
          onClick={() => setShowExamCalc((v) => !v)}
        >
          <span className={`term-accordion-chevron ${showExamCalc ? "open" : ""}`}>▸</span>
          Exam Grade Needed Table
        </button>
      </div>
      <div className={showExamCalc ? "split" : undefined}>
        <div className={`cards ${dragCatId != null ? "is-reordering" : ""}`}>
          {course.categories.map((cat) => {
            const displayCat = displayCourse.categories.find((item) => item.id === cat.id) || cat;
            return (
            <CategoryCard
              key={`${cat.id}-${course.grading_mode}-${cat.aggregation}`}
              cat={displayCat}
              course={displayCourse}
              scale={displayCourse.scale}
              colorAssignmentGrades={colorAssignmentGrades}
              flags={flags}
              colorFlaggedAssignments={colorFlaggedAssignments}
              readableTextBackground={readableTextBackground}
              weightsLocked={!!course.dynamic_weighting_enabled}
              hideWeights={course.grading_mode === "points"}
              pointsMode={course.grading_mode === "points"}
              dragging={dragCatId === cat.id}
              open={!!openCats[cat.id]}
              onToggle={() => setOpenCats((prev) => ({ ...prev, [cat.id]: !prev[cat.id] }))}
              onEdit={() => setCategoryModal({ mode: "edit", cat })}
              onRename={renameCategory}
              onDragStart={(event) => onCategoryDragStart(event, cat.id)}
              onDragMove={onCategoryDragMove}
              onDragEnd={onCategoryDragEnd}
              onChange={async (next) => {
                setCourse(next);
                onChange?.();
              }}
              speculationMode={speculationMode}
              speculativeScores={speculativeScores}
              onSpeculativeScoreChange={(assignmentId, raw) => {
                setSpeculativeScores((current) => ({ ...current, [assignmentId]: raw }));
              }}
              onSpeculativeCompositeChange={(assignmentId, composite) => {
                setSpeculativeScores((current) => ({
                  ...current,
                  [assignmentId]: { composite, categoryAggregation: cat.aggregation },
                }));
              }}
            />
            );
          })}
          <button className="btn" type="button" onClick={() => setCategoryModal({ mode: "create" })}>
            Add category
          </button>
        </div>
        {showExamCalc ? (
          <ExamCalc
            course={course}
            examCatId={examCatId}
            examScoreRaw={examScoreRaw}
            onExamCatId={saveExamCategory}
            onExamScoreRaw={setExamScoreRaw}
          />
        ) : null}
      </div>
      {categoryModal ? (
        <CategorySettingsModal
          mode={categoryModal.mode}
          cat={categoryModal.cat}
          categories={course.categories}
          aggOptions={aggOptions}
          weightsLocked={!!course.dynamic_weighting_enabled}
          hideWeights={course.grading_mode === "points"}
          pointsMode={course.grading_mode === "points"}
          bonusCategory={Boolean(categoryModal.cat?.is_bonus_category)}
          onClose={() => setCategoryModal(null)}
          onSubmit={saveCategorySettings}
          onDelete={deleteCategoryFromModal}
        />
      ) : null}
    </div>
  );
}

function newOptionId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `opt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function weightsFromCourse(categories) {
  return Object.fromEntries(
    (categories || [])
      .filter((cat) => !cat.is_bonus_category)
      .map((cat) => [String(cat.id), Number(cat.weight) || 0])
  );
}

function projectPercentWithWeights(course, weightByCatId) {
  const used = [];
  for (const cat of course.categories || []) {
    if (cat.is_bonus_category) continue;
    const weight = Number(weightByCatId[String(cat.id)] ?? weightByCatId[cat.id] ?? 0);
    if (cat.percent != null && weight) used.push([weight, cat.percent]);
  }
  if (!used.length) return null;
  const wsum = used.reduce((sum, [w]) => sum + w, 0);
  if (!wsum) return null;
  return used.reduce((sum, [w, p]) => sum + w * p, 0) / wsum + (Number(course.bonus_points) || 0);
}

function DynamicWeightingEditor({ course, onChange, onError }) {
  const categories = course.categories || [];
  const enabled = !!course.dynamic_weighting_enabled;
  const serverOptions = course.dynamic_weighting?.options || [];
  const [options, setOptions] = useState(serverOptions);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const appliedId = course.dynamic_weighting_applied_option_id;

  useEffect(() => {
    setOptions(course.dynamic_weighting?.options || []);
  }, [course.id, course.dynamic_weighting_enabled, course.dynamic_weighting]);

  async function persist(nextEnabled, nextOptions) {
    try {
      const next = await api.patchCourse(course.id, {
        dynamic_weighting_enabled: nextEnabled,
        dynamic_weighting: { options: nextOptions.map(({ id, weights }) => ({ id, weights })) },
      });
      onChange(next);
      onError?.("");
    } catch (err) {
      onError?.(err.message);
    }
  }

  function setWeight(optionId, categoryId, pctText) {
    const pct = Number(pctText);
    const fraction = Number.isFinite(pct) ? pct / 100 : 0;
    setOptions((current) =>
      current.map((opt) =>
        opt.id === optionId
          ? { ...opt, weights: { ...opt.weights, [String(categoryId)]: fraction } }
          : opt
      )
    );
  }

  async function commitOptions(nextOptions) {
    setOptions(nextOptions);
    await persist(enabled, nextOptions);
  }

  function addOption() {
    const base = options[options.length - 1]?.weights || weightsFromCourse(categories);
    const next = [
      ...options,
      {
        id: newOptionId(),
        weights: Object.fromEntries(categories.map((cat) => [String(cat.id), Number(base[String(cat.id)]) || 0])),
      },
    ];
    commitOptions(next);
  }

  function removeOption(optionId) {
    if (options.length <= 1) return;
    commitOptions(options.filter((opt) => opt.id !== optionId));
  }

  const scored = options.map((opt) => ({
    ...opt,
    percent: projectPercentWithWeights(course, opt.weights ?? {}),
  }));
  const bestId = (() => {
    const withScores = scored.filter((opt) => opt.percent != null);
    if (!withScores.length) return appliedId;
    return withScores.reduce((best, opt) => (opt.percent > best.percent ? opt : best)).id;
  })();

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="tooltip-heading">
        <h2>Dynamic weighting</h2>
        <Tooltip text="Compare alternate category weight schemes. When enabled, the scheme with the highest course grade is applied automatically, and category weight fields are locked." />
      </div>
      <label className="checkbox" style={{ marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={async (event) => {
            const nextEnabled = event.target.checked;
            const nextOptions =
              nextEnabled && options.length === 0
                ? [{ id: newOptionId(), weights: weightsFromCourse(categories) }]
                : options;
            setOptions(nextOptions);
            await persist(nextEnabled, nextOptions);
          }}
        />
        Enable Dynamic Weight
      </label>
      {enabled ? (
        categories.length === 0 ? (
          <p className="muted">Add categories before setting dynamic weights.</p>
        ) : (
          <div className="dynamic-weight-table-wrap">
            <table className={`dynamic-weight-table${scored.length === 1 ? " has-single-option" : ""}`}>
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="dynamic-weight-section-percent">Section %</th>
                  {scored.map((opt, index) => (
                    <th
                      key={opt.id}
                      className={opt.id === bestId ? "dynamic-weight-best" : undefined}
                    >
                      <div className="dynamic-weight-option-head">
                        <span>Option {index + 1}</span>
                        {scored.length > 1 ? (
                          <button
                            className="btn small"
                            type="button"
                            aria-label={`Remove option ${index + 1}`}
                            onClick={() => removeOption(opt.id)}
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    </th>
                  ))}
                  <th className="dynamic-weight-add-col">
                    <button className="btn small" type="button" onClick={addOption} aria-label="Add option">
                      +
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {categories.filter((cat) => !cat.is_bonus_category).map((cat) => (
                  <tr key={cat.id}>
                    <th scope="row">{cat.name}</th>
                    <td className="mono dynamic-weight-section-percent">
                      {cat.percent == null ? "—" : `${fmtPct(cat.percent)}%`}
                    </td>
                    {scored.map((opt) => (
                      <td
                        key={opt.id}
                        className={opt.id === bestId ? "dynamic-weight-best" : undefined}
                      >
                        <input
                          className="input"
                          inputMode="decimal"
                          value={pctFromWeight(opt.weights?.[String(cat.id)] ?? 0)}
                          onChange={(event) => setWeight(opt.id, cat.id, event.target.value)}
                          onBlur={() => commitOptions(optionsRef.current)}
                        />
                      </td>
                    ))}
                    <td className="dynamic-weight-add-col" />
                  </tr>
                ))}
                <tr className="dynamic-weight-grade-row">
                  <th scope="row">Course grade</th>
                  <td />
                  {scored.map((opt) => (
                    <td
                      key={opt.id}
                      className={`mono ${opt.id === bestId ? "dynamic-weight-best" : ""}`}
                    >
                      {opt.percent == null ? "—" : `${fmtPct(opt.percent)}%`}
                    </td>
                  ))}
                  <td className="dynamic-weight-add-col" />
                </tr>
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}

function ScaleEditor({ course, profiles, presets, onSave, onApply, onRoundingChange }) {
  const [rows, setRows] = useState(course.scale.map((r) => ({ ...r })));
  const [passFail, setPassFail] = useState(course.pass_fail || { rows: [{ label: "S", min_percent: 70 }, { label: "U", min_percent: 0 }] });
  const [minimumPassingLetter, setMinimumPassingLetter] = useState(course.minimum_passing_letter || "C-");
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef(null);
  const linkedProfile = (profiles || []).find((profile) => profile.id === course.scale_profile_id);
  const selectedProfileId = course.scale_profile_id == null
    ? ""
    : linkedProfile?.preset_id
      ? `preset:${linkedProfile.preset_id}`
      : `profile:${course.scale_profile_id}`;
  const [selectedScaleValue, setSelectedScaleValue] = useState(selectedProfileId);
  const primaryProfile = (profiles || []).find((profile) => profile.is_primary);

  useEffect(() => {
    setRows(course.scale.map((r) => ({ ...r })));
    setPassFail(course.pass_fail || { rows: [{ label: "S", min_percent: 70 }, { label: "U", min_percent: 0 }] });
  }, [course.scale, course.pass_fail]);

  useEffect(() => {
    setSelectedScaleValue(selectedProfileId);
  }, [course.scale_profile_id]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  function changeRows(nextRows) {
    setRows(nextRows);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await onSave(nextRows, passFail, minimumPassingLetter);
      } finally {
        setSaving(false);
      }
    }, 300);
  }

  function changePassFail(next) {
    setPassFail(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await onSave(rows, next, minimumPassingLetter);
      } finally {
        setSaving(false);
      }
    }, 300);
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2>Grade cutoffs</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        This class only. Pick a saved default to copy it here. Custom cutoff edits save automatically and stop following that default.
      </p>
      <div className="scale-config-row">
        <label className="muted scale-default-field">
          Default scale
          <select
            className="select scale-default-select"
            style={{ display: "block", marginTop: 6, width: "min(100%, 360px)" }}
            value={selectedScaleValue}
            disabled={saving}
            onChange={async (event) => {
              const value = event.target.value;
              setSelectedScaleValue(value);
              setSaving(true);
              try {
                if (!value) await onSave(rows);
                else if (value.startsWith("preset:")) await onApply({ presetId: value.slice(7) });
                else await onApply({ profileId: Number(value.slice(8)) });
              } finally {
                setSaving(false);
              }
            }}
          >
            <option value="">Custom</option>
            {(profiles || []).some((profile) => !profile.preset_id) ? (
              <optgroup label="Custom Scales">
                {(profiles || []).filter((profile) => !profile.preset_id).map((profile) => (
                  <option
                    key={`profile:${profile.id}`}
                    value={`profile:${profile.id}`}
                    className={profile.is_primary ? "current-default-option" : undefined}
                  >
                    {profile.is_primary ? "★ " : ""}{profile.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="Default Scales">
              {(presets || []).map((preset) => (
                <option
                  key={`preset:${preset.id}`}
                  value={`preset:${preset.id}`}
                  className={primaryProfile?.preset_id === preset.id ? "current-default-option" : undefined}
                >
                  {primaryProfile?.preset_id === preset.id ? "★ " : ""}{preset.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="muted scale-rounding">
          Grade Rounding
          <select
            className="select"
            value={course.grade_rounding == null ? "" : String(course.grade_rounding)}
            onChange={(e) =>
              onRoundingChange?.(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            {ROUNDING_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grade-scale-table">
        <ScaleRowsEditor
          rows={rows}
          onChange={changeRows}
          minimumPassingLetter={minimumPassingLetter}
          onMinimumPassingLetterChange={(letter) => {
            setMinimumPassingLetter(letter);
            onSave(rows, passFail, letter);
          }}
        />
        <PassFailScaleEditor passFail={passFail} scale={rows} onChange={changePassFail} />
      </div>
    </div>
  );
}

function ExamCalc({ course, examCatId, examScoreRaw, onExamCatId, onExamScoreRaw }) {
  const rounding = course.grade_rounding ?? null;
  const resolvedId = examCatId ?? null;
  const selected = resolvedId != null;
  const pointsMode = course.grading_mode === "points";
  const [examTotalPointsRaw, setExamTotalPointsRaw] = useState("");
  const examPct = assignmentPercent({ display: examScoreRaw, isBonus: false });
  const projected = useMemo(() => {
    if (pointsMode) return pointsPercentFromExam(course, examTotalPointsRaw, examScoreRaw);
    return selected ? projectPercentFromExam(course, resolvedId, examPct) : null;
  }, [course, resolvedId, examPct, selected, pointsMode, examTotalPointsRaw, examScoreRaw]);
  const grade = gradeFromPercent(projected, course.scale, rounding);
  const needed = useMemo(
    () => (pointsMode ? pointsExamNeededRows(course, examScoreRaw) : selected ? examNeededRows(course, resolvedId) : []),
    [course, resolvedId, selected, pointsMode, examScoreRaw]
  );
  const blankRows = useMemo(
    () => (course.scale || []).filter((row) => row.letter !== "F").map((row) => ({ letter: row.letter })),
    [course.scale]
  );
  const examCat = course.categories.find((c) => c.id === resolvedId);
  const hasWeight = pointsMode
    ? Number(examTotalPointsRaw) > 0
    : Boolean(examCat && (examCat.weight || examCat.weight_per_item || examCat.effective_weight));
  const tableRows = pointsMode
    ? (Number(examTotalPointsRaw) > 0 ? needed : blankRows)
    : selected ? needed : blankRows;

  return (
    <div className="panel">
      <p className="muted">
        Course grade if this exam scores a given percent, and what you need for each cutoff.
        {rounding != null
          ? ` Targets assume the final percent is rounded to ${ROUNDING_NOTE[rounding] || "the set precision"}.`
          : ""}
      </p>
      {course.categories.length === 0 ? (
        <p className="muted">Add a category for the exam first.</p>
      ) : (
        <>
          <div className="exam-calc-fields">
              {pointsMode ? null : <label className="muted">
              Exam category
              <select
                className="select"
                style={{ display: "block", marginTop: 4, width: "100%" }}
                value={resolvedId ?? ""}
                onChange={(e) => onExamCatId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">None</option>
                {course.categories.filter((cat) => !cat.is_bonus_category).map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </label>}
            {pointsMode ? (
              <label className="muted">
                Total Points on Exam
                <input
                  className="input"
                  style={{ display: "block", marginTop: 4, width: "100%" }}
                  inputMode="decimal"
                  placeholder="20"
                  value={examTotalPointsRaw}
                  onChange={(e) => setExamTotalPointsRaw(e.target.value)}
                />
              </label>
            ) : null}
            <label className="muted">
              Exam score
              <input
                className="input"
                style={{ display: "block", marginTop: 4, width: "100%" }}
                placeholder={pointsMode ? "16" : examCat?.aggregation === "points_ratio" ? "19/20" : "95 or =19/20"}
                value={examScoreRaw}
                onChange={(e) => onExamScoreRaw(e.target.value)}
              />
            </label>
          </div>
          {(pointsMode ? examTotalPointsRaw.trim() && examScoreRaw.trim() && projected != null : selected && examScoreRaw.trim() && projected != null) ? (
            <div className="exam-preview">
              <span className={`letter ${letterClass(grade.letter)}`}>{grade.letter || "—"}</span>
              <strong className={`mono exam-pct ${letterClass(grade.letter)}`}>{fmtPct(projected)}%</strong>
              <span className="mono">{fmtGpa(grade.quality_points)}</span>
            </div>
          ) : (pointsMode ? examTotalPointsRaw.trim() && examScoreRaw.trim() && projected == null : selected && examScoreRaw.trim() && projected == null) ? (
            <p className="muted">
              {course.grading_mode === "points"
                ? "Enter a valid score to preview the course grade."
                : "Enter a valid score and give this category a weight."}
            </p>
          ) : null}
          {!pointsMode && selected && !hasWeight ? (
            <p className="muted">This category has no weight, so it can not change the course grade.</p>
          ) : tableRows.length === 0 ? (
            <p className="muted">Add grade cutoffs to see exam targets.</p>
          ) : (
            <table className="exam-cutoff-table">
              <thead>
                <tr className="exam-cutoff-head-row">
                  <th className="exam-cutoff-exam-head">{pointsMode ? "Points / Exam %" : "Exam %"}</th>
                  <th className="exam-cutoff-letter-head">Letter</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => (
                  <tr key={row.letter}>
                    <td
                      className={`mono exam-cutoff-exam-cell ${
                        row.needed > 100 ? "neg" : row.needed < 0 ? "pos" : ""
                      }`}
                    >
              {pointsMode
                ? row.needed_points == null
                  ? ""
                  : `${fmtPct(row.needed_percent)}% / ${fmtPct(row.needed_points)}`
                        : row.needed == null ? "" : fmtPct(row.needed)}
                    </td>
                    <td className="exam-cutoff-letter-cell">
                      <span className={`letter ${letterClass(row.letter)}`}>{row.letter}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function CategorySettingsModal({
  mode,
  cat,
  categories,
  aggOptions,
  weightsLocked = false,
  hideWeights = false,
  pointsMode = false,
  bonusCategory = false,
  onClose,
  onSubmit,
  onDelete,
}) {
  const [draft, setDraft] = useState(() => categoryDraftFromCat(mode === "edit" ? cat : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isBonusSettings = bonusCategory && Boolean(cat?.is_bonus_category);
  const aggregationOptions = pointsMode && !isBonusSettings
    ? [["points_ratio", "Points"]]
    : (aggOptions || DEFAULT_AGG_OPTIONS);
  const effectiveAggregation = isBonusSettings
    ? draft.aggregation
    : pointsMode
      ? "points_ratio"
      : draft.aggregation;
  const pointsRatio = effectiveAggregation === "points_ratio";
  const others = (categories || []).filter((item) => item.id !== cat?.id && !item.is_bonus_category);

  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function update(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function save(event) {
    event.preventDefault();
    const payload = draftToPayload(draft);
    if (isBonusSettings) {
      payload.aggregation = effectiveAggregation;
      payload.include_bonus = true;
      payload.is_bonus_category = true;
    } else if (pointsMode) {
      payload.aggregation = "points_ratio";
    }
    if (pointsRatio && !isBonusSettings) {
      payload.weight = Number(draft.weightPct) / 100;
      payload.weight_per_item = null;
    }
    if (!payload.name) {
      setError("Name is required.");
      return;
    }
    if (weightsLocked || hideWeights) {
      delete payload.weight;
      delete payload.weight_per_item;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await onDelete();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <form
        className="modal-panel"
        onClick={(event) => event.stopPropagation()}
        onSubmit={save}
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-closet-title"
      >
        <h2 id="category-closet-title">
          {mode === "create" ? "New category" : "Category settings"}
        </h2>
        <div className="modal-fields">
          {isBonusSettings ? null : hideWeights ? null : weightsLocked ? (
            <p className="muted modal-field-wide" style={{ margin: 0 }}>
              Weights are controlled by Dynamic Weight.
            </p>
          ) : null}
          <label className="muted modal-field-wide">
            Name
            <input
              className="input"
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
              autoFocus
            />
          </label>
          {isBonusSettings ? (pointsMode ? (
            <label className="muted modal-field-wide">
              Bonus mode
              <select
                className="select"
                value={effectiveAggregation === "points_ratio" ? "points" : "percent"}
                onChange={(event) => update({ aggregation: event.target.value === "points" ? "points_ratio" : "average" })}
              >
                <option value="percent">Bonus Percent</option>
                <option value="points">Bonus Points</option>
              </select>
            </label>
          ) : null) : (
            <>
              {hideWeights ? null : weightsLocked ? null : (
                <div className="modal-field-wide category-weight-field">
                  <div className="category-weight-row">
                    <label className="muted category-weight-mode">
                      <span className="category-field-label">
                        Weighted Type
                        <Tooltip text="Category Weight makes the weight of the category constant. Per item weight makes the weight scale to the number of graded items in the category; for example, for a test category, if Per item weight is selected and set to 15%, entering just Test 1 will make weight 15%, and having Test 1 and Test 2 will make weight 30%." />
                      </span>
                      <select
                        className="select"
                        value={pointsRatio ? "weight" : draft.weightMode}
                        disabled={weightsLocked}
                        onChange={(event) => update({ weightMode: event.target.value })}
                      >
                        <option value="weight">Category Weight</option>
                        {!pointsRatio ? <option value="per_item">Per item weight</option> : null}
                      </select>
                    </label>
                    <label className="muted category-weight-percent">
                      Percent
                      <input
                        className="input"
                        inputMode="decimal"
                        value={draft.weightPct}
                        disabled={weightsLocked}
                        onChange={(event) => update({ weightPct: event.target.value })}
                        aria-label="Percent"
                      />
                    </label>
                  </div>
                </div>
              )}
              <label className="muted">
                <span className="category-field-label">
                  Aggregation
                  <Tooltip text="Average allows grades to be entered as a percent and makes the section grade equal to the mean of those grades. Points allows grades to be entered as points and makes the section grade equal to the (Total Numerator Points) / (Total Denominator Points)" />
                </span>
                <select
                  className="select"
                  value={effectiveAggregation}
                  disabled={pointsMode}
                  onChange={(event) => update({ aggregation: event.target.value })}
                >
                  {aggregationOptions.map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="muted">
                <span className="category-field-label">
                  Drop X Lowest Grades
                  <Tooltip text="Drop the lowest grades in the category, removing them from overall calculation. Dropped grades are visible struckthrough, and when in Points aggregation, the grades with worst impact on grade are dynamically calculated." />
                </span>
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="1"
                  value={draft.dropCount}
                  onChange={(event) => update({ dropCount: event.target.value })}
                />
              </label>
              <label className="muted modal-field-wide category-replace-field">
                <span>Replace lowest</span>
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="1"
                  value={draft.replaceCount}
                  onChange={(event) => update({ replaceCount: event.target.value })}
                />
                <span>using</span>
                <select
                  className="select"
                  value={draft.replaceWithCategoryId}
                  onChange={(event) => update({ replaceWithCategoryId: event.target.value })}
                >
                  <option value="">None</option>
                  {others.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <Tooltip text="Replace the lowest undropped grades with the value of a given category. Note: Replacing a whole category grade with another category grade can also be done through clever Dynamic Weighting" />
              </label>
            </>
          )}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="modal-actions">
          {mode === "edit" ? (
            <button className="btn danger" type="button" disabled={busy} onClick={remove}>
              Delete category
            </button>
          ) : (
            <span />
          )}
          <div className="row">
            <button className="btn" type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" type="submit" disabled={busy}>
              Save
            </button>
          </div>
        </div>
      </form>
    </div>,
    document.body
  );
}

function pointsPossibleForAssignment(assignment) {
  const possible = Number(assignment.possible);
  return Number.isFinite(possible) && possible > 0 ? possible : 100;
}

function rankedPointsAssignments(assignments, drop, ratio) {
  const fixed = assignments.filter((a) => Number(a.possible) <= 0);
  const eligible = assignments.filter((a) => Number(a.possible) > 0);
  const keep = eligible.length - Math.min(Math.max(drop, 0), Math.max(eligible.length - 1, 0));
  return fixed.concat(
    [...eligible]
      .sort((a, b) => (
        (Number(b.earned) - ratio * pointsPossibleForAssignment(b))
        - (Number(a.earned) - ratio * pointsPossibleForAssignment(a))
      ))
      .slice(0, keep)
  );
}

function droppedAssignmentIds(cat, course = null, pointsMode = false) {
  if (!cat?.drop_count) return new Set();

  const scored = cat.assignments
    .filter((a) => !a.is_bonus && (!pointsMode || Number(a.possible) > 0))
    .map((a) => ({
      id: a.id,
      percent: assignmentPercent({
        display: a.display,
        earned: a.earned,
        possible: a.possible,
        isBonus: false,
      }),
    }))
    .filter((a) => a.percent != null);

  const n = scored.length;
  if (n === 0) return new Set();

  const toDrop = Math.min(Math.max(cat.drop_count, 0), n - 1);
  if (toDrop === 0) return new Set();

  if (cat.aggregation === "points_ratio") {
    const categoryItems = cat.assignments.filter((a) => !a.is_bonus && a.earned != null && Number(a.possible) > 0);
    let ratio = 0;
    if (pointsMode && course) {
      let low = -1000000;
      let high = 1000000;
      for (let iteration = 0; iteration < 70; iteration += 1) {
        ratio = (low + high) / 2;
        let earned = 0;
        let possible = 0;
        for (const category of course.categories || []) {
          const items = category.assignments.filter((a) => !a.is_bonus && a.earned != null && Number(a.possible) > 0);
          const kept = rankedPointsAssignments(items, category.drop_count, ratio);
          earned += kept.reduce((sum, item) => sum + Number(item.earned), 0);
          possible += kept.reduce((sum, item) => sum + pointsPossibleForAssignment(item), 0);
        }
        if (earned - ratio * possible >= 0) low = ratio;
        else high = ratio;
      }
      ratio = low;
    } else {
      let low = -1000000;
      let high = 1000000;
      for (let iteration = 0; iteration < 70; iteration += 1) {
        ratio = (low + high) / 2;
        const kept = rankedPointsAssignments(categoryItems, cat.drop_count, ratio);
        const earned = kept.reduce((sum, item) => sum + Number(item.earned), 0);
        const possible = kept.reduce((sum, item) => sum + pointsPossibleForAssignment(item), 0);
        if (earned - ratio * possible >= 0) low = ratio;
        else high = ratio;
      }
      ratio = low;
    }
    const kept = new Set(rankedPointsAssignments(categoryItems, cat.drop_count, ratio).map((item) => item.id));
    return new Set(categoryItems.filter((item) => !kept.has(item.id)).map((item) => item.id));
  }

  const sorted = [...scored].sort((a, b) => {
    return a.percent - b.percent || a.id - b.id;
  });
  return new Set(sorted.slice(0, toDrop).map((a) => a.id));
}

function replacementAssignmentScores(cat, course, droppedIds) {
  if (!cat?.replace_with_category_id || !course?.categories?.length) return new Map();
  const replacementCategory = course.categories.find(
    (category) => category.id === cat.replace_with_category_id
  );
  if (!replacementCategory) return new Map();
  const replacement = speculativeCategoryPercent(replacementCategory, course.categories);
  if (replacement == null) return new Map();

  const replacements = Math.max(Number(cat.replace_count ?? 0) || 0, 0);
  if (!replacements) return new Map();
  const eligible = (cat.assignments || [])
    .filter((assignment) => !assignment.is_bonus && !droppedIds.has(assignment.id))
    .map((assignment) => ({
      id: assignment.id,
      possible: (() => {
        const explicit = Number(assignment.possible);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const parsed = parseScoreExpression(String(assignment.display ?? ""));
        return parsed && Number.isFinite(parsed.possible) && parsed.possible > 0 ? parsed.possible : 100;
      })(),
      percent: assignmentPercent({
        display: assignment.display,
        earned: assignment.earned,
        possible: assignment.possible,
        isBonus: false,
      }),
    }))
    .filter((assignment) => assignment.percent != null)
    .sort((a, b) => a.percent - b.percent || a.id - b.id);

  return new Map(
    eligible
      .filter((assignment) => replacement > assignment.percent)
      .slice(0, replacements)
      .map((assignment) => [
        assignment.id,
        {
          percent: replacement,
          display: cat.aggregation === "points_ratio"
            ? `${formatCompactReplacementNumber((replacement / 100) * assignment.possible)}/${formatCompactReplacementNumber(assignment.possible)}`
            : formatCompactReplacementNumber(replacement),
        },
      ])
  );
}

function moveCategoryBefore(categories, fromId, beforeId) {
  const from = categories.findIndex((cat) => cat.id === fromId);
  if (from < 0) return categories;
  const next = categories.slice();
  const [item] = next.splice(from, 1);
  let to = beforeId == null ? next.length : next.findIndex((cat) => cat.id === beforeId);
  if (to < 0) to = next.length;
  next.splice(to, 0, item);
  if (next.every((cat, index) => cat.id === categories[index].id)) return categories;
  return next;
}

function defaultComposite() {
  return { mode: "percent", drop_count: 0, items: [{ name: "", score: "", weight: "" }] };
}

function defaultCompositeItemName(items, currentIndex) {
  const numberedNames = (items || []).reduce((highest, item, index) => {
    if (index === currentIndex) return highest;
    const match = String(item?.name || "").trim().match(/^(.*\S)\s+(\d+)$/);
    if (!match) return highest;
    const number = Number(match[2]);
    return number > highest.number ? { base: match[1], number } : highest;
  }, { base: "Part", number: 0 });
  return `${numberedNames.base} ${numberedNames.number + 1}`;
}

function compositeItemPercent(score, mode) {
  const text = String(score || "").trim();
  if (!text) return null;
  if (text.startsWith("=")) {
    const expression = parseScoreExpression(text);
    if (!expression || !Number.isFinite(expression.earned) || !Number.isFinite(expression.possible) || expression.possible === 0) return null;
    return (expression.earned / expression.possible) * 100;
  }
  if (mode === "points" || text.includes("/") || text.includes(",")) {
    const parts = text.split(/[\/,]/).map(Number);
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1]) || parts[1] === 0) return null;
    return (parts[0] / parts[1]) * 100;
  }
  const percent = Number(text.replace(/%$/, ""));
  return Number.isFinite(percent) ? percent : null;
}

function droppedCompositeItemIndexes(items, dropCount, mode) {
  const scored = (items || [])
    .map((item, index) => ({
      index,
      percent: compositeItemPercent(item?.score, mode),
    }))
    .filter((item) => item.percent != null);
  const toDrop = Math.min(
    Math.max(Number(dropCount) || 0, 0),
    Math.max(scored.length - 1, 0),
  );
  return new Set(
    scored
      .sort((a, b) => a.percent - b.percent || a.index - b.index)
      .slice(0, toDrop)
      .map((item) => item.index),
  );
}

function compositeScoreDisplay(score, mode, editing) {
  const raw = String(score || "");
  if (editing) return raw;
  if (mode === "points") {
    const expression = raw.startsWith("=") ? parseScoreExpression(raw) : null;
    if (expression && Number.isFinite(expression.earned) && Number.isFinite(expression.possible)) {
      return `${formatGradeNumber(expression.earned)}/${formatGradeNumber(expression.possible)}`;
    }
    return raw;
  }
  const percent = compositeItemPercent(raw, mode);
  return percent == null ? raw : formatGradeNumber(percent);
}

function convertCompositeItemsForMode(items, fromMode, toMode) {
  if (fromMode === toMode || !items?.length) return items;
  const toPoints = toMode === "points";
  const fromPoints = fromMode === "points";
  if (!toPoints && !fromPoints) return items;
  return items.map((item) => {
    const score = String(item.score || "").trim();
    if (!score) return item;
    if (fromPoints && !toPoints) {
      return score.startsWith("=") ? item : { ...item, score: `=${score}` };
    }
    if (toPoints) {
      if (score.startsWith("=")) return { ...item, score: score.slice(1).trim() };
      if (score.includes("/") || score.includes(",")) return item;
      const percent = score.replace(/%$/, "").trim();
      return { ...item, score: `${percent}/100` };
    }
    return item;
  });
}

function AssignmentComment({ assignmentId, comment, autoEdit = false, onChange, onEditComplete, activeAnnotationKey, activeKey, onActiveChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment || "");
  const wrapRef = useRef(null);
  const editorRef = useRef(null);
  const saveInProgress = useRef(false);
  const hoverCloseTimer = useRef(null);

  useEffect(() => () => {
    clearTimeout(hoverCloseTimer.current);
  }, []);

  useEffect(() => {
    if (!autoEdit) return;
    setDraft(comment || "");
    setEditing(true);
  }, [autoEdit]);

  useEffect(() => {
    if (!editing || !editorRef.current) return;
    editorRef.current.style.height = "auto";
    editorRef.current.style.height = `${editorRef.current.scrollHeight}px`;
  }, [draft, editing]);

  async function saveComment() {
    if (saveInProgress.current) return;
    saveInProgress.current = true;
    try {
      const value = draft.trim();
      const next = await api.patchAssignment(assignmentId, { comment: value || null });
      onChange(next);
      setEditing(false);
      onEditComplete?.();
    } catch (err) {
      console.error(err);
    } finally {
      saveInProgress.current = false;
    }
  }

  const hasComment = Boolean(String(comment || "").trim());
  if (!hasComment && !editing && !autoEdit) return null;

  const hovered = activeAnnotationKey === activeKey;

  function keepCommentHoverOpen() {
    clearTimeout(hoverCloseTimer.current);
    onActiveChange(activeKey);
  }

  function scheduleCommentHoverClose() {
    clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = setTimeout(() => onActiveChange(null), 180);
  }

  return (
    <span
      className={`assignment-comment ${hovered ? "is-hovered" : ""}`.trim()}
      ref={wrapRef}
      onMouseEnter={keepCommentHoverOpen}
      onMouseLeave={scheduleCommentHoverClose}
    >
      <button
        className="assignment-comment-icon"
        type="button"
        aria-label={editing ? "Edit assignment comment" : "View assignment comment"}
        onClick={(event) => {
          event.stopPropagation();
          onActiveChange(activeKey);
          setDraft(comment || "");
          setEditing(true);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 4.5h14A2.5 2.5 0 0 1 21.5 7v8A2.5 2.5 0 0 1 19 17.5h-7.6L6 21.2v-3.7H5A2.5 2.5 0 0 1 2.5 15V7A2.5 2.5 0 0 1 5 4.5Z" />
          <path d="M7 9h10M7 13h7" />
        </svg>
      </button>
      {editing ? (
        <div className="assignment-comment-popover assignment-comment-editor">
          <textarea
            className="input"
            ref={editorRef}
            value={draft}
            maxLength={500}
            autoFocus
            aria-label="Assignment comment"
            placeholder="Add a comment"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => {
              if (!wrapRef.current?.contains(event.relatedTarget)) saveComment();
            }}
          />
          <span className="assignment-comment-count">{draft.length}/500</span>
        </div>
      ) : hasComment && hovered ? (
        <button
          className="assignment-comment-popover assignment-comment-preview"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setDraft(comment || "");
            setEditing(true);
          }}
        >
          {comment}
        </button>
      ) : null}
    </span>
  );
}

function AssignmentFlag({ flag, onDelete, activeAnnotationKey, activeKey, onActiveChange }) {
  const wrapRef = useRef(null);
  const hoverCloseTimer = useRef(null);
  const hovered = activeAnnotationKey === activeKey;

  useEffect(() => () => clearTimeout(hoverCloseTimer.current), []);

  function keepFlagHoverOpen() {
    clearTimeout(hoverCloseTimer.current);
    onActiveChange(activeKey);
  }

  function scheduleFlagHoverClose() {
    clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = setTimeout(() => onActiveChange(null), 180);
  }

  return (
    <span
      className={`assignment-flag ${hovered ? "is-hovered" : ""}`.trim()}
      ref={wrapRef}
      onMouseEnter={keepFlagHoverOpen}
      onMouseLeave={scheduleFlagHoverClose}
    >
      <button
        className="assignment-flag-icon"
        type="button"
        aria-label={`View ${flag.name} flag`}
        onClick={(event) => {
          event.stopPropagation();
          onActiveChange(activeKey);
        }}
      >
        <FlagIcon color={flag.color} size={17} />
      </button>
      {hovered ? (
        <div className="assignment-flag-popover" role="tooltip">
          <span>{flag.name}</span>
          <button
            className="assignment-flag-delete"
            type="button"
            aria-label={`Remove ${flag.name} flag`}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            ×
          </button>
        </div>
      ) : null}
    </span>
  );
}

function AssignmentActionMenu({ composite, averageCategory, isBonus, bonusType, hasComment, flags = [], assignedFlagIds = [], onToggleFlag, onToggleBonus, onConvert, onNormal, onAddComment, onDeleteComment }) {
  const [open, setOpen] = useState(false);
  const [selectedBonusType, setSelectedBonusType] = useState(bonusType || "assignment");
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function closeOnOutside(event) {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={`assignment-action-menu ${open ? "is-open" : ""}`.trim()} ref={wrapRef}>
      <button
        className="btn small assignment-kebab"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Assignment actions"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        ⋮
      </button>
      {open ? (
        <div className="assignment-kebab-menu" role="menu">
          <div className="assignment-kebab-tooltip-row">
            <button
              className="assignment-kebab-item"
              type="button"
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                if (hasComment) onDeleteComment();
                else onAddComment();
              }}
            >
              {hasComment ? "Delete Comment" : "Add Comment"}
            </button>
            <Tooltip text="Write an assignment-specific note" side="right" />
          </div>
          {flags.length ? (
            <div className="assignment-kebab-tooltip-row">
              <div className="assignment-flag-action" role="group" aria-label="Assignment flags">
                <span>Add Flag:</span>
                <select
                  className="select"
                  value=""
                  aria-label="Add or remove assignment flag"
                  onChange={(event) => {
                    const flagId = event.target.value;
                    if (flagId) onToggleFlag?.(flagId);
                  }}
                >
                  <option value="">Choose…</option>
                  {flags.map((flag) => (
                    <option key={flag.id} value={flag.id} style={{ color: flag.color }}>
                      {assignedFlagIds.includes(String(flag.id)) ? "Remove " : "Add "}{flag.name}
                    </option>
                  ))}
                </select>
              </div>
              <Tooltip text="Flag an assignment as a highlighted reminder to do something with it" side="right" />
            </div>
          ) : null}
          <div className="assignment-kebab-tooltip-row">
            <button
              className="assignment-kebab-item"
              type="button"
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                (composite ? onNormal : onConvert)();
              }}
            >
              {composite ? "Make Normal Grade" : "Convert to Composite Grade"}
            </button>
            <Tooltip text="Composite Grade allows you to effectively make an assignment into its own category, allowing easy entry of complex point-based assignment parts or an assignment list that drops the lowest grades" side="right" />
          </div>
          {averageCategory ? (
            isBonus ? (
              <button
                className="assignment-kebab-item"
                type="button"
                role="menuitem"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  onToggleBonus(null);
                }}
              >
                Remove Bonus
              </button>
            ) : (
              <div className="assignment-kebab-tooltip-row">
                <div
                  className="assignment-bonus-action"
                  role="menuitem"
                  tabIndex={0}
                  onClick={(event) => {
                    if (event.target.tagName === "SELECT") return;
                    event.stopPropagation();
                    setOpen(false);
                    onToggleBonus(selectedBonusType);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpen(false);
                      onToggleBonus(selectedBonusType);
                    }
                  }}
                >
                  <span>Make</span>
                  <select
                    className="select"
                    value={selectedBonusType}
                    onChange={(event) => setSelectedBonusType(event.target.value)}
                    aria-label="Bonus type"
                  >
                    <option value="assignment">Assignment</option>
                    <option value="category">Category</option>
                  </select>
                  <span>Bonus</span>
                </div>
                <Tooltip text="Assignment Bonus (+) spreads out the given bonus percent across every item in the category, so for N items, adding an Assignment Bonus X will increase category by X/N. Category Bonus (++) adds a flat percent boost to the whole category" side="right" />
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CompositeEditor({ assignment, categoryAggregation, colorAssignmentGrades, scale, onSave, speculationMode = false, onSpeculativeChange }) {
  const initial = assignment.composite || defaultComposite();
  const [mode, setMode] = useState(initial.mode);
  const [dropCount, setDropCount] = useState(String(initial.drop_count ?? 0));
  const [totalPoints, setTotalPoints] = useState(String(initial.total_points ?? 100));
  const [editingWeightIndex, setEditingWeightIndex] = useState(null);
  const [editingScoreIndex, setEditingScoreIndex] = useState(null);
  const [speculativeEditedScoreIndexes, setSpeculativeEditedScoreIndexes] = useState(new Set());
  const [items, setItems] = useState(
    (initial.items || []).length
      ? [
          ...initial.items.map((item) => ({ name: item.name || "", score: item.score || "", weight: item.weight ?? 1 })),
      { name: "", score: "", weight: "" },
        ]
      : defaultComposite().items
  );
  const draftRef = useRef({ mode, dropCount, totalPoints, items });
  const saveTimer = useRef(null);
  const target = categoryAggregation === "points_ratio" ? "Points" : "Grade as a Percent";
  const scorePlaceholder = mode === "points" ? "19/20" : "95 or =19/20";
  const droppedItemIndexes = useMemo(
    () => droppedCompositeItemIndexes(items, dropCount, mode),
    [items, dropCount, mode],
  );

  useEffect(() => {
    if (speculationMode) return;
    const saved = assignment.composite || defaultComposite();
    const meaningfulSavedItems = (saved.items || []).filter((item) => (
      String(item?.name || "").trim() || String(item?.score || "").trim()
    ));
    const savedItems = meaningfulSavedItems.length
      ? [
          ...meaningfulSavedItems.map((item) => ({ name: item.name || "", score: item.score || "", weight: item.weight ?? 1 })),
          { name: "", score: "", weight: "" },
        ]
      : defaultComposite().items;
    setMode(saved.mode);
    setDropCount(String(saved.drop_count ?? 0));
    setTotalPoints(String(saved.total_points ?? 100));
    setItems(savedItems);
    draftRef.current = {
      mode: saved.mode,
      dropCount: String(saved.drop_count ?? 0),
      totalPoints: String(saved.total_points ?? 100),
      items: savedItems,
    };
    setEditingWeightIndex(null);
    setEditingScoreIndex(null);
    setSpeculativeEditedScoreIndexes(new Set());
  }, [assignment.id, assignment.composite, speculationMode]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  function updateDraft(patch) {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setMode(next.mode);
    setDropCount(next.dropCount);
    setTotalPoints(next.totalPoints);
    setItems(next.items);
    clearTimeout(saveTimer.current);
    const composite = {
      mode: next.mode,
      drop_count: Number.isFinite(Number(next.dropCount)) ? Math.max(0, Math.floor(Number(next.dropCount))) : 0,
      total_points: Number.isFinite(Number(next.totalPoints)) && Number(next.totalPoints) > 0
        ? Number(next.totalPoints)
        : null,
      items: next.items,
    };
    if (speculationMode) {
      onSpeculativeChange?.(composite);
      return;
    }
    saveTimer.current = setTimeout(() => {
      onSave(composite);
    }, 350);
  }

  function updateItem(index, key, value) {
    const nextItems = draftRef.current.items.map((item, itemIndex) => (
      itemIndex === index ? { ...item, [key]: value } : item
    ));
    let current = nextItems[index];
    if (key === "score" && String(value || "").trim() && !String(current.name || "").trim()) {
      current = { ...current, name: defaultCompositeItemName(nextItems, index) };
      nextItems[index] = current;
    }
    if (
      index === nextItems.length - 1
      && (
        String(current.name || "").trim()
        || String(current.score || "").trim()
        || (key === "weight" && String(current.weight ?? "").trim())
      )
    ) {
      nextItems.push({ name: "", score: "", weight: "" });
    }
    updateDraft({
      items: nextItems,
    });
    if (speculationMode && key === "score") {
      setSpeculativeEditedScoreIndexes((current) => new Set(current).add(index));
    }
  }

  function changeMode(nextMode) {
    const previousMode = draftRef.current.mode;
    updateDraft({
      mode: nextMode,
      items: convertCompositeItemsForMode(draftRef.current.items, previousMode, nextMode),
    });
  }

  return (
    <div className="composite-editor" onClick={(event) => event.stopPropagation()}>
      <div className="composite-editor-topline">
        <label className="muted composite-mode-field">
          Composite
          <select
            className="select"
            style={{
              width: mode === "weighted_percent" ? "228px" : mode === "percent" ? "170px" : "82px",
            }}
            value={mode}
            onChange={(event) => changeMode(event.target.value)}
          >
            <option value="points">Points</option>
            <option value="percent">Grades as Percent</option>
            <option value="weighted_percent">Weighted Grades as Percent</option>
          </select>
          <span className="mono">to {target}</span>
          {mode === "percent" && categoryAggregation === "points_ratio" ? (
            <>
              <span className="mono">out of:</span>
            <input
              className="input composite-total-points-input"
              type="number"
              min="0"
              step="any"
              value={totalPoints}
              onChange={(event) => updateDraft({ totalPoints: event.target.value })}
              onBlur={() => {
                const value = Number(totalPoints);
                updateDraft({ totalPoints: Number.isFinite(value) && value > 0 ? String(value) : "100" });
              }}
            />
            </>
          ) : null}
        </label>
        <label className="muted composite-drop-field">
          Drop Lowest:
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            value={dropCount}
            onChange={(event) => updateDraft({ dropCount: event.target.value })}
          />
        </label>
      </div>
      <table className="cat-scores composite-items-table">
        <thead>
          <tr>
            <th className="col-name">Sub-Assignment Name</th>
            {mode === "weighted_percent" ? <th className="col-composite-weight">Weight %</th> : null}
            <th className="col-score">Grade</th>
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const itemPercent = colorAssignmentGrades ? compositeItemPercent(item.score, mode) : null;
            const itemTone = itemPercent == null ? "" : letterClass(letterFromPercent(itemPercent, scale));
            return (
              <tr className={droppedItemIndexes.has(index) ? "cat-score-dropped" : undefined} key={index}>
              <td className="col-name">
                <input
                  className="input"
                  placeholder="Name"
                  value={item.name}
                  onChange={(event) => updateItem(index, "name", event.target.value)}
                />
              </td>
              {mode === "weighted_percent" ? (
                <td className="col-composite-weight">
                  <input
                    className="input mono"
                    type="text"
                    inputMode="decimal"
                    placeholder="10%"
                    value={editingWeightIndex === index
                      ? String(item.weight ?? "").replace(/%+$/, "")
                      : item.weight === "" ? "" : `${String(item.weight).replace(/%+$/, "")}%`}
                    onFocus={() => setEditingWeightIndex(index)}
                    onChange={(event) => updateItem(index, "weight", event.target.value.replace(/%+$/, ""))}
                    onBlur={() => setEditingWeightIndex(null)}
                  />
                </td>
              ) : null}
              <td className="col-score">
                <input
                  className={`input mono ${itemTone} ${speculationMode && speculativeEditedScoreIndexes.has(index) ? "speculative-grade" : ""}`.trim()}
                  placeholder={scorePlaceholder}
                  value={compositeScoreDisplay(item.score, mode, editingScoreIndex === index)}
                  onFocus={() => setEditingScoreIndex(index)}
                  onChange={(event) => updateItem(index, "score", event.target.value)}
                  onBlur={() => setEditingScoreIndex(null)}
                />
              </td>
              <td className="col-actions">
                {index < items.length - 1 || item.name.trim() || item.score.trim() ? (
                  <button
                    className="btn small danger"
                    type="button"
                    aria-label={`Remove composite item ${index + 1}`}
                    onClick={() => updateDraft({
                      items: draftRef.current.items.filter((_, itemIndex) => itemIndex !== index),
                    })}
                  >
                    ×
                  </button>
                ) : null}
              </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CategoryCard({
  cat,
  course,
  scale,
  colorAssignmentGrades,
  flags = [],
  colorFlaggedAssignments = false,
  readableTextBackground = true,
  weightsLocked = false,
  hideWeights = false,
  pointsMode = false,
  dragging = false,
  onChange,
  open,
  onToggle,
  onEdit,
  onRename,
  onDragStart,
  onDragMove,
  onDragEnd,
  speculationMode = false,
  speculativeScores = {},
  onSpeculativeScoreChange,
  onSpeculativeCompositeChange,
}) {
  const [scoreDrafts, setScoreDrafts] = useState({});
  const [scoreErrors, setScoreErrors] = useState({});
  const [focusedScoreId, setFocusedScoreId] = useState(null);
  const [commentEditorId, setCommentEditorId] = useState(null);
  const [activeAnnotationKey, setActiveAnnotationKey] = useState(null);
  const [newAssignmentName, setNewAssignmentName] = useState("");
  const [newAssignmentScore, setNewAssignmentScore] = useState("");
  const [categoryNameDraft, setCategoryNameDraft] = useState(String(cat?.name || ""));
  const [categoryNameBusy, setCategoryNameBusy] = useState(false);
  const newAssignmentDraft = useRef({ name: "", score: "" });
  const [openCompositeIds, setOpenCompositeIds] = useState(new Set());
  const creatingAssignment = useRef(false);
  const saveTimers = useRef({});
  const droppedIds = useMemo(
    () => droppedAssignmentIds(cat, course, pointsMode),
    [cat, course, pointsMode]
  );
  const replacementScores = useMemo(
    () => replacementAssignmentScores(cat, course, droppedIds),
    [cat, course, droppedIds]
  );
  const isBonusCategory = Boolean(cat.is_bonus_category);
  const meaningfulAssignmentCount = (cat.assignments || []).filter((assignment) => (
    String(assignment.name || "").trim()
    || String(assignment.score_input || assignment.display || "").trim()
  )).length;
  const bonusPoints = isBonusCategory && pointsMode && cat.aggregation === "points_ratio";
  const weightedPointsCategory = !isBonusCategory && !pointsMode && cat.aggregation === "points_ratio";
  const requiresPoints = bonusPoints || weightedPointsCategory || (!isBonusCategory && pointsMode);
  const scorePlaceholder = bonusPoints
    ? "1/0"
    : weightedPointsCategory
      ? "19/20"
      : requiresPoints
        ? "19/20"
        : isBonusCategory ? "1% or =1/100" : "95 or =19/20";

  useEffect(() => {
    setCategoryNameDraft(String(cat?.name || ""));
  }, [cat?.id, cat?.name]);

  async function saveCategoryName() {
    const nextName = String(categoryNameDraft || "").trim();
    if (!nextName) {
      setCategoryNameDraft(String(cat?.name || ""));
      return;
    }
    if (nextName === String(cat?.name || "").trim() || !onRename || categoryNameBusy) return;
    setCategoryNameBusy(true);
    try {
      await onRename(cat.id, nextName);
    } catch (err) {
      setCategoryNameDraft(String(cat?.name || ""));
      console.error(err);
    } finally {
      setCategoryNameBusy(false);
    }
  }
  function validScoreEntry(raw) {
    const text = String(raw || "").trim();
    if (text.startsWith("=")) {
      const expression = parseScoreExpression(text);
      return Boolean(
        expression
        && (
          !requiresPoints
          || expression.possible !== 0
          || pointsMode
          || weightedPointsCategory
          || bonusPoints
        )
      );
    }
    if (!requiresPoints || !text) return true;
    if (isPointsScore(text, pointsMode || weightedPointsCategory || bonusPoints, bonusPoints)) return true;
    if (!pointsMode && !weightedPointsCategory && text.startsWith("=")) {
      return isPointsScore(text.slice(1).trim(), false, false);
    }
    return false;
  }
  const bonusUsesPoints = isBonusCategory && pointsMode && (
    cat.aggregation === "points_ratio"
    || (cat.assignments || []).some((assignment) => Number(assignment.possible) === 0)
  );
  const displayPercent = pointsMode && !isBonusCategory ? pointsCategoryPercent(cat, course) : cat.percent;
  const hasSpeculativeEdit = speculationMode && (cat.assignments || []).some((assignment) => (
    Object.prototype.hasOwnProperty.call(speculativeScores, assignment.id)
  ));

  useEffect(() => {
    if (!speculationMode) {
      setScoreDrafts({});
      setScoreErrors({});
      setFocusedScoreId(null);
    }
  }, [speculationMode]);

  useEffect(() => {
    return () => {
      Object.values(saveTimers.current).forEach(clearTimeout);
    };
  }, []);

  function queueScoreSave(assignmentId, raw) {
    setScoreDrafts((d) => ({ ...d, [assignmentId]: raw }));
    if (speculationMode) {
      onSpeculativeScoreChange?.(assignmentId, raw);
    }
  }

  async function flushScoreSave(assignmentId, raw) {
    if (speculationMode) return;
    clearTimeout(saveTimers.current[assignmentId]);
    if (!validScoreEntry(raw)) {
      setScoreErrors((errors) => ({ ...errors, [assignmentId]: "Enter points as numerator/denominator, such as 3/5." }));
      return;
    }
    const next = await api.patchAssignment(assignmentId, {
      score: raw,
      clear_score: raw.trim() === "",
    });
    setScoreDrafts((d) => {
      const copy = { ...d };
      delete copy[assignmentId];
      return copy;
    });
    onChange(next);
  }

  async function createDraftAssignment() {
    const name = newAssignmentDraft.current.name.trim();
    const score = newAssignmentDraft.current.score.trim();
    if ((!name && !score) || creatingAssignment.current) return;
    if (!validScoreEntry(score)) return;
    creatingAssignment.current = true;
    newAssignmentDraft.current = { name: "", score: "" };
    setNewAssignmentName("");
    setNewAssignmentScore("");
    try {
      const next = await api.createAssignment({
        category_id: cat.id,
        name: name || defaultAssignmentName(cat),
        score: score || null,
        is_bonus: isBonusCategory,
      });
      onChange(next);
    } catch (err) {
      console.error(err);
    } finally {
      creatingAssignment.current = false;
    }
  }

  async function saveComposite(assignmentId, composite) {
    try {
      const next = await api.patchAssignment(assignmentId, { composite });
      setOpenCompositeIds((current) => new Set(current).add(assignmentId));
      onChange(next);
    } catch (err) {
      console.error(err);
    }
  }

  async function convertToComposite(assignmentId) {
    setOpenCompositeIds((current) => new Set(current).add(assignmentId));
    await saveComposite(assignmentId, defaultComposite());
  }

  async function makeNormalGrade(assignmentId) {
    try {
      const next = await api.patchAssignment(assignmentId, { clear_composite: true });
      setOpenCompositeIds((current) => {
        const nextIds = new Set(current);
        nextIds.delete(assignmentId);
        return nextIds;
      });
      onChange(next);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <section
      className={`cat-card ${open ? "is-open" : "is-collapsed"}${dragging ? " is-dragging" : ""}`}
      data-cat-id={cat.id}
    >
      <div
        className="cat-head"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="row cat-head-left">
          <button
            type="button"
            className="cat-toggle"
            aria-expanded={open}
            aria-label={open ? "Collapse category" : "Expand category"}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <span className={`term-accordion-chevron ${open ? "open" : ""}`}>▸</span>
          </button>
          <input
            className="input cat-name"
            size={Math.min(Math.max(categoryNameDraft.length, 1), 24)}
            value={categoryNameDraft}
            aria-label={`Category name: ${cat.name}`}
            disabled={categoryNameBusy}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setCategoryNameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.stopPropagation();
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                event.preventDefault();
                setCategoryNameDraft(String(cat?.name || ""));
                event.currentTarget.blur();
              }
            }}
            onBlur={saveCategoryName}
          />
          <button
            type="button"
            className="cat-drag-handle"
            aria-label="Reorder category"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            onLostPointerCapture={onDragEnd}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M2.5 4h11v1.5h-11zm0 3.25h11v1.5h-11zm0 3.25h11V12h-11z"
              />
            </svg>
          </button>
        </div>
        <div className="row cat-head-meta">
          <span className={`mono ${hasSpeculativeEdit ? "speculative-grade" : ""}`.trim()}>
            {isBonusCategory
              ? bonusUsesPoints
                ? `Bonus: +${cat.percent == null ? "0" : formatGradeNumber(cat.percent)} pt`
                : `${cat.name} +${cat.percent == null ? "0" : fmtPct(cat.percent)}%`
              : `Section: ${displayPercent == null ? "—" : `${fmtPct(displayPercent)}%`}`}
          </span>
          {isBonusCategory || hideWeights ? null : (
            <span className="muted mono">Weight: {fmtWeightPct(cat.effective_weight)}%</span>
          )}
          <button
            type="button"
            className="cat-gear"
            aria-label="Category settings"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.49.49 0 0 0-.48-.41h-3.84a.49.49 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22l-1.92 3.32a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"
              />
            </svg>
          </button>
        </div>
      </div>
      {open ? (
      <>
      <table className="cat-scores">
        <thead>
          <tr>
            <th className="col-name">Name</th>
            <th className="col-score">Grade</th>
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
          {cat.assignments.map((a) => {
            const savedDisplay = isBonusCategory && pointsMode && Number(a.possible) === 0
              ? `${formatGradeNumber(a.earned)}/0`
              : !pointsMode && !isBonusCategory && cat.aggregation !== "points_ratio" && a.possible != null && Number(a.possible) !== 0 && Number(a.possible) !== 100
                  ? formatGradeNumber(assignmentPercent({
                      display: a.display,
                      earned: a.earned,
                      possible: a.possible,
                      isBonus: a.is_bonus,
                    }))
                : a.display;
            const savedInput = !pointsMode
              && !isBonusCategory
              && cat.aggregation !== "points_ratio"
              && a.possible != null
              && Number(a.possible) !== 0
              && Number(a.possible) !== 100
              && !(a.score_input || a.display).trim().startsWith("=")
              ? `=${a.score_input || a.display}`
              : (a.score_input || savedDisplay);
            const displayValue = savedDisplay;
            const isSpeculativeEdit = speculationMode && Object.prototype.hasOwnProperty.call(speculativeScores, a.id);
            const draft = scoreDrafts[a.id] ?? (focusedScoreId === a.id ? (a.score_input || savedDisplay) : displayValue);
            const isDropped = droppedIds.has(a.id);
            const replacementScore = replacementScores.get(a.id);
            const isReplaced = replacementScore != null;
            const isZeroDenominator = a.earned != null && Number(a.possible) === 0;
            const scoreLetter = isBonusCategory || a.is_bonus
              ? "A+"
              : colorAssignmentGrades
                ? isZeroDenominator
                  ? "A+"
                  : !isDropped
                    ? letterFromPercent(
                        assignmentPercent({
                          display: draft,
                          earned: a.earned,
                          possible: a.possible,
                          isBonus: a.is_bonus,
                        }),
                        scale
                      )
                    : null
                : null;
            const scoreTone = isDropped || isReplaced ? "" : letterClass(scoreLetter);
            const replacementTone = colorAssignmentGrades
              ? letterClass(letterFromPercent(replacementScore?.percent, scale))
              : "";
            const isComposite = Boolean(a.composite);
            const compositeOpen = openCompositeIds.has(a.id);
            const bonusPrefix = a.is_bonus && !isBonusCategory
              ? (a.bonus_type === "category" ? "++" : "+")
              : "";
            const assignmentFlags = flagsForAssignment(a, flags);
            const rowFlag = assignmentFlags[0];
            const rowClassName = [
              isDropped ? "cat-score-dropped" : "",
              assignmentFlags.length ? "assignment-row-flagged" : "",
              assignmentFlags.length && colorFlaggedAssignments ? "assignment-row-colored" : "",
              assignmentFlags.length && colorFlaggedAssignments && readableTextBackground ? "assignment-row-readable" : "",
            ].filter(Boolean).join(" ");
            return (
            <Fragment key={a.id}>
            <tr
              className={rowClassName || undefined}
              data-assignment-id={a.id}
              style={rowFlag && colorFlaggedAssignments ? { "--assignment-flag-color": rowFlag.color } : undefined}
            >
              <td className="col-name">
                <div className="assignment-name-cell">
                  <div className="assignment-name-pill">
                  {isComposite ? (
                    <button
                      type="button"
                      className={`composite-toggle ${compositeOpen ? "open" : ""}`}
                      aria-label={compositeOpen ? "Collapse composite grade" : "Expand composite grade"}
                      aria-expanded={compositeOpen}
                      onClick={() => setOpenCompositeIds((current) => {
                        const next = new Set(current);
                        if (next.has(a.id)) next.delete(a.id);
                        else next.add(a.id);
                        return next;
                      })}
                    >
                      ▸
                    </button>
                  ) : <span className="composite-toggle-spacer" aria-hidden="true" />}
                  <input
                    className="input"
                    defaultValue={a.name}
                    readOnly={speculationMode}
                    size={Math.max(1, String(a.name || "").length)}
                    onInput={(e) => {
                      e.currentTarget.size = Math.max(1, e.currentTarget.value.length);
                    }}
                    onBlur={async (e) => onChange(await api.patchAssignment(a.id, { name: e.target.value }))}
                  />
                  </div>
                  {assignmentFlags.length || a.comment || commentEditorId === a.id ? (
                    <div className="assignment-annotation-pill">
                      {assignmentFlags.map((flag) => (
                        <AssignmentFlag
                          key={flag.id}
                          flag={flag}
                          activeAnnotationKey={activeAnnotationKey}
                          activeKey={`${a.id}:${flag.id}`}
                          onActiveChange={setActiveAnnotationKey}
                          onDelete={async () => {
                            const nextIds = (a.flag_ids || []).map(String).filter((flagId) => flagId !== String(flag.id));
                            onChange(await api.patchAssignment(a.id, { flag_ids: nextIds }));
                          }}
                        />
                      ))}
                      <AssignmentComment
                        assignmentId={a.id}
                        comment={a.comment}
                        autoEdit={commentEditorId === a.id}
                        activeAnnotationKey={activeAnnotationKey}
                        activeKey={`${a.id}:comment`}
                        onActiveChange={setActiveAnnotationKey}
                        onChange={onChange}
                        onEditComplete={() => setCommentEditorId(null)}
                      />
                    </div>
                  ) : null}
                </div>
              </td>
              <td className="col-score">
                <div className={`assignment-score-cell assignment-score-pill ${bonusPrefix ? "has-bonus" : ""} ${isReplaced ? "is-replaced" : ""}`.trim()}>
                  {bonusPrefix ? (
                    <span className="assignment-bonus-prefix" aria-label={`${bonusPrefix} bonus`}>
                      {bonusPrefix}
                    </span>
                  ) : null}
                  <input
                    className={`input ${scoreTone} ${isReplaced ? "assignment-score-original-replaced" : ""} ${isSpeculativeEdit ? "speculative-grade" : ""}`.trim()}
                    placeholder={scorePlaceholder}
                    value={draft}
                    style={assignmentFlags.length && colorFlaggedAssignments
                      ? { width: `${Math.max(6, Math.min(19, String(draft ?? "").length))}ch` }
                      : undefined}
                    aria-invalid={Boolean(scoreErrors[a.id])}
                    title={scoreErrors[a.id] || undefined}
                    readOnly={isComposite}
                    onFocus={() => {
                      setFocusedScoreId(a.id);
                      setScoreDrafts((d) => ({ ...d, [a.id]: isSpeculativeEdit ? displayValue : savedInput }));
                    }}
                    onChange={(e) => queueScoreSave(a.id, e.target.value)}
                    onBlur={async (e) => {
                      setFocusedScoreId(null);
                      const raw = e.target.value;
                      if (speculationMode) return;
                      if (!validScoreEntry(e.target.value)) {
                        setScoreDrafts((drafts) => ({ ...drafts, [a.id]: displayValue }));
                        setScoreErrors((errors) => ({
                          ...errors,
                          [a.id]: "Enter points as numerator/denominator, such as 3/5.",
                        }));
                        return;
                      }
                      try {
                        await flushScoreSave(a.id, raw);
                      } catch (err) {
                        console.error(err);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                  {isReplaced ? (
                    <span
                      className={`assignment-replacement-score ${replacementTone}`.trim()}
                      aria-label={`Replacement score ${replacementScore.display}`}
                      title="Replacement category score"
                    >
                      {replacementScore.display}
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="col-actions">
                <div className="assignment-actions-pill">
                  <button className="btn small danger" onClick={async () => onChange(await api.deleteAssignment(a.id))}>
                    ×
                  </button>
                  <AssignmentActionMenu
                    composite={isComposite}
                    flags={flags}
                    assignedFlagIds={(a.flag_ids || []).map(String)}
                    onToggleFlag={async (flagId) => {
                      const currentIds = (a.flag_ids || []).map(String);
                      const nextIds = currentIds.includes(String(flagId))
                        ? currentIds.filter((flagIdValue) => flagIdValue !== String(flagId))
                        : [...currentIds, String(flagId)];
                      onChange(await api.patchAssignment(a.id, { flag_ids: nextIds }));
                    }}
                    hasComment={Boolean(String(a.comment || "").trim())}
                    averageCategory={
                      !isBonusCategory
                      && cat.aggregation === "average"
                      && meaningfulAssignmentCount > 1
                    }
                    isBonus={Boolean(a.is_bonus)}
                    bonusType={a.bonus_type}
                    onToggleBonus={async (type) => onChange(await api.patchAssignment(a.id, {
                      is_bonus: type != null,
                      bonus_type: type,
                    }))}
                    onConvert={() => convertToComposite(a.id)}
                    onNormal={() => makeNormalGrade(a.id)}
                    onAddComment={() => setCommentEditorId(a.id)}
                    onDeleteComment={async () => onChange(await api.patchAssignment(a.id, { comment: null }))}
                  />
                </div>
              </td>
            </tr>
            {isComposite && compositeOpen ? (
              <tr className="composite-detail-row" key={`${a.id}-composite`}>
                <td colSpan={3}>
                  <CompositeEditor
                    assignment={a}
                    categoryAggregation={cat.aggregation}
                    colorAssignmentGrades={colorAssignmentGrades}
                    scale={scale}
                    onSave={(composite) => saveComposite(a.id, composite)}
                    speculationMode={speculationMode}
                    onSpeculativeChange={(composite) => onSpeculativeCompositeChange?.(a.id, composite)}
                  />
                </td>
              </tr>
            ) : null}
            </Fragment>
            );
          })}
          <tr
            className="cat-score-new-row"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) createDraftAssignment();
            }}
          >
            <td className="col-name">
              <div className="assignment-name-cell">
                <span className="composite-toggle-spacer" aria-hidden="true" />
                <input
                  className="input"
                  placeholder="Name"
                  value={newAssignmentName}
                  readOnly={speculationMode}
                  onChange={(e) => {
                    newAssignmentDraft.current.name = e.target.value;
                    setNewAssignmentName(e.target.value);
                  }}
                  onBlur={(e) => {
                    setTimeout(() => {
                      createDraftAssignment();
                    }, 0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      createDraftAssignment();
                    }
                  }}
                />
              </div>
            </td>
            <td className="col-score">
              <input
                className="input"
                placeholder={scorePlaceholder}
                value={newAssignmentScore}
                readOnly={speculationMode}
                onChange={(e) => {
                  newAssignmentDraft.current.score = e.target.value;
                  setNewAssignmentScore(e.target.value);
                }}
                onBlur={(e) => {
                  if (!validScoreEntry(e.target.value)) {
                    setNewAssignmentScore("");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createDraftAssignment();
                  }
                }}
              />
            </td>
            <td className="col-actions" />
          </tr>
        </tbody>
      </table>
      </>
      ) : null}
    </section>
  );
}
