import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtGpa, fmtScore, gradeFromPercent, roundPercentForCalculation, scoreClass } from "./api";
import { CreditLabelProvider, Tooltip } from "./creditLabel.jsx";
import FeedbackBubble from "./FeedbackBubble.jsx";
import { useToasts } from "./notifications.jsx";
import { SEASONS, TERM_SEQUENCE } from "./seasons.js";

import { applyThemeColors, loadAppearance, parseAppearance, resolveTermLabel, saveAppearance } from "./theme";
import CrystalBall from "./CrystalBall.svg";

const CourseList = lazy(() => import("./CourseList.jsx"));
const Gradebook = lazy(() => import("./Gradebook.jsx"));
const GpaDashboard = lazy(() => import("./GpaDashboard.jsx"));
const Settings = lazy(() => import("./Settings.jsx"));

const APPEARANCE_SAVE_MS = 350;
const GRADE_PROMPT_TOAST_ID = "grade-record-prompt";
const UPDATE_TOAST_ID = "app-update";
const UPDATE_STATUS_TOAST_ID = "app-update-status";
const UPDATE_CHECK_MS = 7 * 24 * 60 * 60 * 1000;
// v1 is the clean-install local-storage baseline. Keep these keys stable for
// future releases, but do not read the pre-v1 keys.
const GRADEBOOKS_KEY = "grade-calculator-gradebooks-v1";
const GRADEBOOK_MEMBERS_KEY = "grade-calculator-gradebook-members-v1";
const GRADEBOOK_APPEARANCE_KEY = "grade-calculator-gradebook-appearance-v1";
const SPECULATION_TOOLTIP = 'Speculation Mode: Edit only the grade values of multiple items at once, allowing you to see how your grade would change when speculating a bulk number of grades. "Changes" are not saved when exited.';
const SPECULATION_MODE_TOAST_ID = "speculation-mode-status";
const GLOBAL_APPEARANCE_KEYS = new Set([
  "gradeColors",
  "tooltips",
  "gradeScale",
  "customGradeColors",
  "gradeScalePresets",
  "primary",
  "secondary",
  "tertiary",
  "themeScale",
  "themePresets",
  "autoContrastText",
  "textColor",
]);
const DEFAULT_HIGH_SCHOOL_TERMS = [
  { id: "fall", name: "Fall", season: "fall" },
  { id: "spring", name: "Spring", season: "spring" },
];

function CrystalBallIcon() {
  return <span className="speculation-icon" style={{ "--speculation-icon-url": `url("${CrystalBall}")` }} aria-hidden="true" />;
}

function SpeculationToggle({ enabled, onToggle }) {
  return (
    <Tooltip text={SPECULATION_TOOLTIP}>
      <button
        className={`speculation-toggle ${enabled ? "active" : ""}`}
        type="button"
        aria-label={enabled ? "Exit speculation mode" : "Enter speculation mode"}
        aria-pressed={enabled}
        onClick={onToggle}
      >
        <CrystalBallIcon />
      </button>
    </Tooltip>
  );
}

function SpeculationSummary({ summary }) {
  if (!summary) return null;
  return (
    <div className="speculation-summary" aria-label={`Current grade ${summary.letter}, ${summary.percentText}%`}>
      <span className={`speculation-percent mono ${summary.speculative ? "speculative-grade" : ""}`.trim()}>
        {summary.percentText}%
      </span>
      <span className={`letter letter-hero-circle ${summary.tone} ${summary.speculative ? "speculative-grade" : ""}`.trim()}>
        {summary.letter}
      </span>
    </div>
  );
}

function applyStatusToast(info) {
  const status = info?.apply_status;
  if (!status || !status.status) return null;
  const code = status.status;
  if (code === "failed_launched_staged") {
    return {
      tone: "warning",
      title: "Update partially applied",
        message:
        status.message ||
        "Couldn’t replace the installed copy, so the new build was launched from the download folder. Use that window going forward, or point your shortcut at the file under AppData\\Grade Calculator\\updates.",
    };
  }
  if (code === "failed") {
    return {
      tone: "warning",
      title: "Update failed",
      message: status.message || "The update could not be installed. Try again from Settings, or download from GitHub Releases.",
    };
  }
  return null;
}

function semesterKey(year, season) {
  return [Number(year) || 0, TERM_SEQUENCE[season] || 0];
}

function pluralizeTermLabel(label) {
  const text = String(label || "Term").trim();
  if (/s$/i.test(text)) return text;
  if (/y$/i.test(text)) return `${text.slice(0, -1)}ies`;
  return `${text}s`;
}

function fmtSidebarScore(value) {
  if (value === null || value === undefined) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  const rounded = Number(numeric.toFixed(2));
  const formatted = rounded > 0 ? `+${rounded}` : String(rounded);
  return formatted.replace(/^([+-]?)0\./, "$1.");
}

function normalizedName(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function isPlaceholderAcademicPeriodLabel(value) {
  const name = normalizedName(value);
  return !name || name === "academic period";
}

function hasOlderUnlocked(semesters, year, season) {
  const nextKey = semesterKey(year, season);
  return semesters.some((sem) => {
    if (sem.progression_locked) return false;
    const key = semesterKey(sem.year, sem.season);
    return key[0] < nextKey[0] || (key[0] === nextKey[0] && key[1] < nextKey[1]);
  });
}

function highSchoolAcademicYearKey(semester) {
  const year = Number(semester?.year) || new Date().getFullYear();
  return ["spring", "summer"].includes(String(semester?.season || "").toLowerCase()) ? year - 1 : year;
}

function highSchoolAcademicYearLabel(key) {
  const start = Number(key);
  return Number.isFinite(start)
    ? `${start}–${String(start + 1).slice(-2)}`
    : "Academic year";
}

function nextHighSchoolAcademicYear(semesters) {
  const currentYear = new Date().getFullYear();
  const periodKeys = (semesters || []).map((semester) => Number(highSchoolAcademicYearKey(semester))).filter(Number.isFinite);
  return (periodKeys.length ? Math.max(...periodKeys) + 1 : currentYear);
}

function highSchoolYearGroups(semesters, periodNames = {}, periodOrder = []) {
  const groups = new Map();
  for (const semester of semesters || []) {
    const key = String(highSchoolAcademicYearKey(semester));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(semester);
  }
  const orderRanks = new Map((Array.isArray(periodOrder) ? periodOrder : []).map((key, index) => [String(key), index]));
  return [...groups.entries()]
    .sort((a, b) => {
      const aRank = orderRanks.get(String(a[0]));
      const bRank = orderRanks.get(String(b[0]));
      if (aRank != null || bRank != null) {
        if (aRank == null) return 1;
        if (bRank == null) return -1;
        if (aRank !== bRank) return aRank - bRank;
      }
      return Number(b[0]) - Number(a[0]);
    })
    .map(([key, items]) => ({
      key,
      label: String(periodNames[key] || highSchoolAcademicYearLabel(key)),
      semesters: [...items].sort((a, b) => Number(a.year) - Number(b.year) || (TERM_SEQUENCE[a.season] || 0) - (TERM_SEQUENCE[b.season] || 0)),
    }));
}

function highSchoolPeriodScore(group, targetGp = 4, highSchoolTerms = [], highSchoolTermsByPeriod = {}, termWeights = {}, overallRounding = {}, backendPeriodScores = {}) {
  const semesters = group?.semesters || [];
  const backendScore = backendPeriodScores?.[String(group?.key)];
  if (backendScore != null && Number.isFinite(Number(backendScore))) return Number(backendScore);
  const roundTermPercents = overallRounding.roundTermPercents === true;
  const roundOverallPercent = overallRounding.roundOverallPercent === true;
  if (!semesters.length) return null;
  const configuredTerms = highSchoolTermsByPeriod?.[String(group.key)] || highSchoolTerms;
  const terms = Array.isArray(configuredTerms) && configuredTerms.length
    ? configuredTerms
    : semesters.map((semester) => ({ id: semester.season, season: semester.season }));
  const coursePercent = (course) => {
    if (course?.gp_override === -1) return null;
    if (course?.gp_override != null) {
      const overrideRow = (course.scale || []).find((entry) => Number(entry.quality_points) === Number(course.gp_override));
      if (overrideRow?.min_percent != null) return Number(overrideRow.min_percent);
    }
    if (course?.percent != null && Number.isFinite(Number(course.percent))) return Number(course.percent);
    const categories = (course?.categories || []).filter((category) => category.percent != null && category.effective_weight != null);
    const totalWeight = categories.reduce((sum, category) => sum + Number(category.effective_weight || 0), 0);
    return totalWeight ? categories.reduce((sum, category) => sum + Number(category.percent) * Number(category.effective_weight), 0) / totalWeight : null;
  };
  const semesterForTerm = (term, index) => semesters.find(
    (semester) => String(semester.season || "").toLowerCase() === String(term.season || term.id || "").toLowerCase(),
  ) || semesters[index];
  const rows = new Map();
  semesters.forEach((semester) => {
    const occurrences = new Map();
    (semester.courses || []).forEach((course) => {
      const code = String(course.code || "").trim();
      const key = code.toLowerCase();
      if (!key) return;
      const occurrence = occurrences.get(key) || 0;
      occurrences.set(key, occurrence + 1);
      const row = rows.get(key) || { code, count: 0 };
      row.count = Math.max(row.count, occurrence + 1);
      rows.set(key, row);
    });
  });

  const rollups = [];
  for (const [codeKey, row] of rows) {
    for (let occurrence = 0; occurrence < row.count; occurrence += 1) {
      const entries = terms.map((term, index) => {
        const semester = semesterForTerm(term, index);
        const matching = (semester?.courses || [])
          .filter((course) => String(course.code || "").trim().toLowerCase() === codeKey)
          .sort((a, b) => Number(a.id) - Number(b.id));
        return matching[occurrence] ? { course: matching[occurrence], term } : null;
      }).filter(Boolean);
      if (!entries.length) continue;
      const included = entries.length;
      const weightedEntries = entries.map((entry) => ({
        ...entry,
        weight: termWeights[`${codeKey}-${occurrence}:${entry.term.id}`] == null
          ? 100 / included
          : Number(termWeights[`${codeKey}-${occurrence}:${entry.term.id}`]),
      }));
      const gradedEntries = weightedEntries.filter((entry) => coursePercent(entry.course) != null);
      const gradedWeight = gradedEntries.reduce((sum, entry) => sum + Number(entry.weight || 0), 0);
      const aggregatePercent = gradedWeight > 0
        ? gradedEntries.reduce((sum, entry) => sum + Number(roundPercentForCalculation(coursePercent(entry.course), roundTermPercents)) * Number(entry.weight || 0), 0) / gradedWeight
        : null;
      const calculatedPercent = aggregatePercent == null
        ? null
        : roundPercentForCalculation(aggregatePercent, roundOverallPercent);
      const representative = entries[0]?.course;
      const override = representative?.final_gp_override;
      const overriddenGp = override != null && Number(override) !== -1 ? Number(override) : null;
      const grade = calculatedPercent == null
        ? { quality_points: null }
        : gradeFromPercent(calculatedPercent, representative?.scale, representative?.grade_rounding ?? null);
      const qualityPoints = Number(override) === -1
        ? null
        : overriddenGp ?? grade.quality_points ?? representative?.natural_quality_points ?? representative?.quality_points ?? null;
      if (qualityPoints == null) continue;
      rollups.push({ qualityPoints, units: included / Math.max(terms.length, 1) });
    }
  }
  if (!rollups.length) return null;
  return rollups.reduce(
    (sum, item) => sum + Math.round((Number(item.qualityPoints) - Number(targetGp)) * 3) * item.units,
    0,
  );
}

function highSchoolPeriodGpaValues(overallClasses = []) {
  const grouped = new Map();
  for (const item of overallClasses || []) {
    const period = String(item?.period ?? "");
    const gpa = Number(item?.quality_points);
    if (!period || !Number.isFinite(gpa)) continue;
    const current = grouped.get(period) || { gpa: [], wgpa: [] };
    current.gpa.push(gpa);
    const wgpa = Number(item?.weighted_quality_points ?? item?.quality_points);
    if (Number.isFinite(wgpa)) current.wgpa.push(wgpa);
    grouped.set(period, current);
  }
  return Object.fromEntries([...grouped.entries()].map(([period, values]) => [
    period,
    {
      gpa: values.gpa.length ? values.gpa.reduce((sum, value) => sum + value, 0) / values.gpa.length : null,
      wgpa: values.wgpa.length ? values.wgpa.reduce((sum, value) => sum + value, 0) / values.wgpa.length : null,
    },
  ]));
}

function academicYearRecordKey(record, semesters) {
  const keys = new Set((record?.semester_ids || []).map((id) => {
    const semester = semesters.find((item) => String(item.id) === String(id));
    return semester ? String(highSchoolAcademicYearKey(semester)) : null;
  }).filter(Boolean));
  return keys.size === 1 ? [...keys][0] : null;
}

function promptAcademicPeriodGroups(semesters = [], academicPeriods = []) {
  const byId = new Map((semesters || []).map((semester) => [String(semester.id), semester]));
  const assigned = new Set();
  const groups = [];

  for (const period of academicPeriods || []) {
    const periodSemesters = (period.semester_ids || [])
      .map((id) => byId.get(String(id)))
      .filter(Boolean)
      .sort((a, b) => Number(a.year) - Number(b.year) || (TERM_SEQUENCE[a.season] || 0) - (TERM_SEQUENCE[b.season] || 0));
    if (!periodSemesters.length) continue;
    const key = String(highSchoolAcademicYearKey(periodSemesters[0]));
    periodSemesters.forEach((semester) => assigned.add(String(semester.id)));
    groups.push({
      key,
      label: String(period.name || highSchoolAcademicYearLabel(key)),
      semesters: periodSemesters,
    });
  }

  const unassigned = new Map();
  for (const semester of semesters || []) {
    if (assigned.has(String(semester.id))) continue;
    const key = String(highSchoolAcademicYearKey(semester));
    if (!unassigned.has(key)) unassigned.set(key, []);
    unassigned.get(key).push(semester);
  }
  for (const [key, periodSemesters] of unassigned.entries()) {
    groups.push({
      key,
      label: highSchoolAcademicYearLabel(key),
      semesters: periodSemesters.sort((a, b) => Number(a.year) - Number(b.year) || (TERM_SEQUENCE[a.season] || 0) - (TERM_SEQUENCE[b.season] || 0)),
    });
  }
  return groups;
}

function GradePromptSelect({
  gradebooks = [],
  currentGradebookId = "",
  promptSemesters = [],
  promptAcademicPeriods = [],
  defaultId,
  selectedRef,
  currentSemesterId = "",
}) {
  const initialGradebookId = gradebooks.find((item) => String(item.id) === String(currentGradebookId))?.id || gradebooks[0]?.id || "";
  const allSemesters = promptSemesters || [];
  const initialSemesters = allSemesters.filter((semester) => (
    !semester.gradebook_id || String(semester.gradebook_id) === String(initialGradebookId)
  ));
  const initialSemester = initialSemesters.find((sem) => String(sem.id) === String(currentSemesterId))
    || initialSemesters.find((sem) => String(sem.id) === String(defaultId))
    || initialSemesters[0]
    || null;
  const [gradebookValue, setGradebookValue] = useState(String(initialGradebookId));
  const [value, setValue] = useState(String(initialSemester?.id ?? ""));
  const recordingSemesters = allSemesters.filter((semester) => (
    !semester.gradebook_id || String(semester.gradebook_id) === String(gradebookValue)
  ));
  const selectedSemester = recordingSemesters.find((sem) => String(sem.id) === String(value));
  const selectedBookIsHighSchool = selectedSemester?.gradebook_type
    ? selectedSemester.gradebook_type === "high_school"
    : false;
  const selectedBookAcademicPeriods = promptAcademicPeriods.filter((period) => (
    !period.gradebook_id || String(period.gradebook_id) === String(gradebookValue)
  ));
  const periodGroups = selectedBookIsHighSchool
    ? promptAcademicPeriodGroups(recordingSemesters, selectedBookAcademicPeriods)
    : [];
  const selectedPeriodKey = selectedBookIsHighSchool && selectedSemester
    ? String(highSchoolAcademicYearKey(selectedSemester))
    : String(periodGroups[0]?.key || "");
  const selectedPeriod = periodGroups.find((period) => String(period.key) === selectedPeriodKey);
  const currentPeriodSemesters = selectedPeriod?.semesters || [];
  const showPeriodSelector = selectedBookIsHighSchool && periodGroups.length > 0;
  const showTermSelector = selectedBookIsHighSchool && currentPeriodSemesters.length > 0;
  const showSemesterSelector = !selectedBookIsHighSchool && recordingSemesters.length > 0;

  useEffect(() => {
    const next = gradebooks.find((item) => String(item.id) === String(currentGradebookId))?.id || gradebooks[0]?.id || "";
    setGradebookValue(String(next));
  }, [currentGradebookId, gradebooks]);

  useEffect(() => {
    if (!recordingSemesters.some((sem) => String(sem.id) === String(value))) {
      setValue(String(recordingSemesters[0]?.id || ""));
    }
  }, [recordingSemesters, value]);

  useEffect(() => {
    selectedRef.current = { gradebookId: String(gradebookValue), semesterId: Number(value) };
  }, [selectedRef, gradebookValue, value]);

  return (
    <div className="toast-selects">
      {gradebooks.length ? <label className="toast-select-label">
        <span className="muted">Gradebook</span>
        <select
          className="select toast-select"
          aria-label="Gradebook to record"
          value={gradebookValue}
          onChange={(e) => {
            const next = e.target.value;
            setGradebookValue(next);
          }}
        >
          {gradebooks.map((gradebook) => (
            <option key={gradebook.id} value={gradebook.id}>{gradebook.name}</option>
          ))}
        </select>
      </label> : null}
      {showPeriodSelector ? <label className="toast-select-label">
        <span className="muted">Academic period</span>
        <select
          className="select toast-select"
          aria-label="Academic period to record"
          value={selectedPeriodKey}
          onChange={(e) => {
            const nextPeriod = periodGroups.find((period) => String(period.key) === String(e.target.value));
            const nextSemester = nextPeriod?.semesters?.[0];
            if (nextSemester) {
              setValue(String(nextSemester.id));
              selectedRef.current = { gradebookId: String(gradebookValue), semesterId: Number(nextSemester.id) };
            }
          }}
        >
          {periodGroups.map((period) => <option key={period.key} value={period.key}>{period.label}</option>)}
        </select>
      </label> : null}
      {showTermSelector ? <label className="toast-select-label">
        <span className="muted">Term</span>
        <select
          className="select toast-select"
          value={value}
          aria-label="Term to record"
          onChange={(e) => {
            const next = e.target.value;
            setValue(next);
            selectedRef.current = { gradebookId: String(gradebookValue), semesterId: Number(next) };
          }}
        >
          {currentPeriodSemesters.map((sem) => (
            <option key={sem.id} value={sem.id}>
              {String(sem.name || "Term").replace(/^\d{4}\s+/, "")}
              {sem.progression_locked ? " (locked)" : ""}
            </option>
          ))}
        </select>
      </label> : null}
      {showSemesterSelector ? <label className="toast-select-label">
        <span className="muted">Term</span>
        <select
          className="select toast-select"
          value={value}
          aria-label="Term to record"
          onChange={(e) => {
            const next = e.target.value;
            setValue(next);
            selectedRef.current = { gradebookId: String(gradebookValue), semesterId: Number(next) };
          }}
        >
          {recordingSemesters.map((sem) => (
            <option key={sem.id} value={sem.id}>
              {sem.name || `Term ${sem.id}`}
              {sem.progression_locked ? " (locked)" : ""}
            </option>
          ))}
        </select>
      </label> : null}
    </div>
  );
}

function loadGradebooks() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GRADEBOOKS_KEY) || "[]");
    if (Array.isArray(parsed) && parsed.length) {
      const seen = new Set();
      return parsed
        .filter((item) => item?.id)
        .map((item, index) => {
          const id = String(item.id).trim();
          if (seen.has(id)) return null;
          seen.add(id);
          return {
            id,
            name: String(item.name || `Gradebook ${index + 1}`).trim() || `Gradebook ${index + 1}`,
          };
        })
        .filter(Boolean);
    }
  } catch {
    /* use the default */
  }
  return [{ id: "gradebook-1", name: "Gradebook 1" }];
}

function loadGradebookMembers(gradebooks = []) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GRADEBOOK_MEMBERS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(gradebooks.map((gradebook) => {
      return [gradebook.id, parsed[gradebook.id]];
    }).filter(([, members]) => Array.isArray(members)));
  } catch {
    return {};
  }
}

function loadGradebookAppearance(gradebooks = []) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GRADEBOOK_APPEARANCE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(gradebooks.map((gradebook) => {
      const stored = parsed[gradebook.id];
      if (!stored || typeof stored !== "object") return [gradebook.id, stored];
      return [gradebook.id, stripGlobalAppearance(stored)];
    }).filter(([, value]) => value && typeof value === "object"));
  } catch {
    return {};
  }
}

function stripGlobalAppearance(value) {
  if (!value || typeof value !== "object") return {};
  const scoped = { ...value };
  GLOBAL_APPEARANCE_KEYS.forEach((key) => delete scoped[key]);
  return scoped;
}

function globalAppearanceValues(value) {
  return Object.fromEntries([...GLOBAL_APPEARANCE_KEYS].map((key) => [key, value?.[key]]));
}

export default function App() {
  const { warning, push, dismiss } = useToasts();
  const [semesters, setSemesters] = useState([]);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [academicYears, setAcademicYears] = useState([]);
  const [gradebookType, setGradebookType] = useState("college");
  const [gpaBasis, setGpaBasis] = useState("credits");
  const [targetGp, setTargetGp] = useState(4);
  const [highSchoolPeriodScores, setHighSchoolPeriodScores] = useState({});
  const [highSchoolPeriodGpas, setHighSchoolPeriodGpas] = useState({});
  const [year, setYear] = useState("");
  const [academicPeriodDraft, setAcademicPeriodDraft] = useState("");
  const [season, setSeason] = useState("fall");
  const [appearance, setAppearance] = useState(() => loadAppearance());
  const [gradebooks, setGradebooks] = useState(() => loadGradebooks());
  const [gradebookMembers, setGradebookMembers] = useState(() => loadGradebookMembers(gradebooks));
  const [gradebookAppearance, setGradebookAppearance] = useState(() => loadGradebookAppearance(gradebooks));
  const [gradebookMenuOpen, setGradebookMenuOpen] = useState(false);
  const [gradebookCreateOpen, setGradebookCreateOpen] = useState(false);
  const [gradebookNameDraft, setGradebookNameDraft] = useState("");
  const gradebookMenuRef = useRef(null);
  const [speculationMode, setSpeculationMode] = useState(false);
  const [speculationSummary, setSpeculationSummary] = useState(null);
  const appearanceSaveTimer = useRef(null);
  const refreshSequence = useRef(0);
  const appearanceReady = useRef(false);
  const gradePromptSemesterRef = useRef(null);
  const gradePromptViewRef = useRef({ gradebookId: "gradebook-1", semesterId: null });
  const [githubRepo, setGithubRepo] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const requestedGradebookId = query.get("gradebook");
  const selectedGradebook = gradebooks.find((item) => item.id === requestedGradebookId) || gradebooks[0];
  const selectedGradebookId = selectedGradebook?.id || "gradebook-1";
  const selectedSemester = query.get("term") || query.get("semester");
  gradePromptViewRef.current = {
    gradebookId: selectedGradebookId,
    semesterId: Number(selectedSemester) || null,
  };
  const selectedAcademicPeriod = query.get("academicPeriod");
  const selectedAcademicYear = query.get("academicYear");
  const isClassView = /^\/courses\/[^/]+$/.test(location.pathname);
  const activeAppearance = useMemo(
    () => ({
      ...appearance,
      ...stripGlobalAppearance(gradebookAppearance[selectedGradebookId]),
      // App-wide appearance preferences always win over legacy gradebook
      // snapshots and can only be changed from global Settings.
      ...globalAppearanceValues(appearance),
    }),
    [appearance, gradebookAppearance, selectedGradebookId]
  );
  const termLabel = resolveTermLabel(activeAppearance);
  const isHighSchool = gradebookType === "high_school";
  const academicPeriodNames = useMemo(
    () => activeAppearance.highSchoolAcademicPeriods || {},
    [activeAppearance.highSchoolAcademicPeriods]
  );
  const namedAcademicPeriodKeys = useMemo(() => {
    const keys = new Set();
    academicYears.forEach((record) => {
      const key = academicYearRecordKey(record, semesters);
      if (key) keys.add(key);
    });
    Object.entries(academicPeriodNames).forEach(([key, name]) => {
      if (key && !isPlaceholderAcademicPeriodLabel(name)) keys.add(String(key));
    });
    return keys;
  }, [academicPeriodNames, academicYears, semesters]);
  // The API scopes semesters to the active gradebook. In multi-term mode,
  // empty terms must be assigned to a named academic period before they are
  // navigable; terms with real classes remain visible with a date-based label
  // so data is never hidden by the cleanup guard.
  const visibleSemesters = useMemo(
    () => isHighSchool
      ? semesters.filter((semester) => (
        namedAcademicPeriodKeys.has(String(highSchoolAcademicYearKey(semester)))
        || (Array.isArray(semester.courses) && semester.courses.length > 0)
      ))
      : semesters,
    [isHighSchool, namedAcademicPeriodKeys, semesters]
  );
  const semesterSectionLabel = pluralizeTermLabel(termLabel);
  const selectedSemesterRecord = visibleSemesters.find((semester) => String(semester.id) === String(selectedSemester));
  const backendAcademicPeriodNames = useMemo(() => Object.fromEntries(
    academicYears
      .map((record) => [academicYearRecordKey(record, semesters), String(record.name || "").trim()])
      .filter(([key, name]) => key && name && !isPlaceholderAcademicPeriodLabel(name))
  ), [academicYears, semesters]);
  const localAcademicPeriodNames = useMemo(() => Object.fromEntries(
    Object.entries(academicPeriodNames)
      .map(([key, name]) => [String(key), String(name || "").trim()])
      .filter(([key, name]) => key && name && !isPlaceholderAcademicPeriodLabel(name))
  ), [academicPeriodNames]);
  const routeAcademicPeriodKey = isHighSchool && selectedSemesterRecord
    ? String(highSchoolAcademicYearKey(selectedSemesterRecord))
    : "";
  const routeAcademicPeriodName = String(selectedAcademicPeriod || "").trim();
  const resolvedAcademicPeriodNames = useMemo(
    () => ({
      ...backendAcademicPeriodNames,
      ...localAcademicPeriodNames,
      ...(routeAcademicPeriodKey && routeAcademicPeriodName && !isPlaceholderAcademicPeriodLabel(routeAcademicPeriodName)
        ? { [routeAcademicPeriodKey]: routeAcademicPeriodName }
        : {}),
    }),
    [backendAcademicPeriodNames, localAcademicPeriodNames, routeAcademicPeriodKey, routeAcademicPeriodName]
  );
  const academicPeriodOrder = useMemo(
    () => activeAppearance.highSchoolAcademicPeriodOrder || [],
    [activeAppearance.highSchoolAcademicPeriodOrder]
  );
  const visibleAcademicYears = useMemo(() => highSchoolYearGroups(visibleSemesters, resolvedAcademicPeriodNames, academicPeriodOrder), [visibleSemesters, resolvedAcademicPeriodNames, academicPeriodOrder]);
  const sidebarAcademicYears = useMemo(
    () => highSchoolYearGroups(visibleSemesters, resolvedAcademicPeriodNames, academicPeriodOrder.length ? [...academicPeriodOrder].reverse() : []),
    [visibleSemesters, resolvedAcademicPeriodNames, academicPeriodOrder]
  );
  const selectedBackendAcademicPeriod = academicYears.find((record) => String(record.name || "").trim().toLowerCase() === String(selectedAcademicPeriod || "").trim().toLowerCase());
  const selectedAcademicPeriodGroup = visibleAcademicYears.find((group) => String(group.label).trim().toLowerCase() === String(selectedAcademicPeriod || "").trim().toLowerCase());
  const selectedAcademicPeriodKey = academicYearRecordKey(selectedBackendAcademicPeriod, semesters) || selectedAcademicPeriodGroup?.key;
  const resolvedAcademicYear = selectedAcademicPeriodKey || selectedAcademicYear || (isHighSchool && selectedSemesterRecord ? String(highSchoolAcademicYearKey(selectedSemesterRecord)) : visibleAcademicYears[0]?.key || "");
  const resolvedAcademicPeriodName = isHighSchool
    ? (resolvedAcademicPeriodNames[resolvedAcademicYear] || (resolvedAcademicYear ? highSchoolAcademicYearLabel(resolvedAcademicYear) : ""))
    : "";
  const highSchoolTermsForPeriod = isHighSchool
    ? (activeAppearance.highSchoolTermsByPeriod?.[String(resolvedAcademicYear)] || activeAppearance.highSchoolTerms)
    : activeAppearance.highSchoolTerms;
  const configuredTermNames = useMemo(() => Object.fromEntries(visibleSemesters.map((semester) => {
    if (!isHighSchool) {
      const title = (activeAppearance.semesterTitles || []).find(
        (term) => String(term.id || "").toLowerCase() === String(semester.season || "").toLowerCase(),
      );
      return [String(semester.id), title?.name || String(semester.name || "").replace(/^\d{4}\s+/, "")];
    }
    const key = String(highSchoolAcademicYearKey(semester));
    const terms = activeAppearance.highSchoolTermsByPeriod?.[key] || activeAppearance.highSchoolTerms || [];
    const match = terms.find((term) => String(term.season || term.id).toLowerCase() === String(semester.season || "").toLowerCase());
    return [String(semester.id), match?.name || String(semester.name || "").replace(/^\d{4}\s+/, "")];
  })), [activeAppearance.highSchoolTerms, activeAppearance.highSchoolTermsByPeriod, activeAppearance.semesterTitles, isHighSchool, visibleSemesters]);
  const configuredPeriodNames = useMemo(() => {
    if (!isHighSchool) return {};
    return Object.fromEntries(visibleSemesters.map((semester) => {
      const key = String(highSchoolAcademicYearKey(semester));
      return [String(semester.id), resolvedAcademicPeriodNames[key] || highSchoolAcademicYearLabel(key)];
    }));
  }, [isHighSchool, resolvedAcademicPeriodNames, visibleSemesters]);

  useEffect(() => {
    if (!gradebookMenuOpen) return undefined;
    function closeMenu(event) {
      if (!gradebookMenuRef.current?.contains(event.target)) setGradebookMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [gradebookMenuOpen]);

  function toggleGradebookMenu() {
    setGradebookMenuOpen((current) => !current);
  }

  function handleGradebookTriggerKeyDown(event) {
    if (event.key === "Escape") setGradebookMenuOpen(false);
  }

  useEffect(() => {
    window.localStorage.setItem(GRADEBOOKS_KEY, JSON.stringify(gradebooks));
    window.localStorage.setItem(GRADEBOOK_MEMBERS_KEY, JSON.stringify(gradebookMembers));
    window.localStorage.setItem(GRADEBOOK_APPEARANCE_KEY, JSON.stringify(gradebookAppearance));
  }, [gradebooks, gradebookMembers, gradebookAppearance]);

  function updateGradebookAppearance(updater) {
    setGradebookAppearance((current) => {
      const base = { ...appearance, ...stripGlobalAppearance(current[selectedGradebookId]) };
      const next = typeof updater === "function" ? updater(base) : updater;
      return {
        ...current,
        [selectedGradebookId]: stripGlobalAppearance(next),
      };
    });
  }

  async function saveAcademicPeriodName(name, periodKey, semesterList = semesters) {
    const nextName = String(name || "").trim();
    const key = String(periodKey || "");
    const periodSemesters = semesterList.filter((semester) => String(highSchoolAcademicYearKey(semester)) === key);
    const semesterIds = periodSemesters.map((semester) => Number(semester.id)).filter(Number.isInteger);
    if (!nextName || !key || !semesterIds.length) return;
    if (isPlaceholderAcademicPeriodLabel(nextName)) {
      warning("Choose a name for the academic period.");
      return;
    }
    const duplicate = highSchoolYearGroups(semesterList, resolvedAcademicPeriodNames, academicPeriodOrder)
      .some((group) => String(group.key) !== key && normalizedName(group.label) === normalizedName(nextName));
    if (duplicate) {
      warning("Academic period names must be unique.");
      return;
    }
    const existing = academicYears.find((record) => academicYearRecordKey(record, semesterList) === key);
    try {
      const saved = existing
        ? await api.patchAcademicYear(existing.id, { name: nextName, semester_ids: semesterIds })
        : await api.createAcademicYear({ name: nextName, semester_ids: semesterIds });
      setAcademicYears((current) => existing
        ? current.map((record) => record.id === saved.id ? saved : record)
        : [...current, saved]);
    } catch (err) {
      warning(err.message);
    }
  }

  async function registerHighSchoolSemester(semester) {
    const semesterId = Number(semester?.id);
    if (!Number.isInteger(semesterId)) return;
    setGradebookMembers((current) => ({
      ...current,
      [selectedGradebookId]: [...new Set([...(current[selectedGradebookId] || []), String(semesterId)])],
    }));

    const combinedSemesters = [...semesters, semester];
    const periodKey = String(highSchoolAcademicYearKey(semester));
    const existing = academicYears.find((record) => academicYearRecordKey(record, combinedSemesters) === periodKey);
    if (!existing || (existing.semester_ids || []).some((id) => String(id) === String(semesterId))) return;
    try {
      const saved = await api.patchAcademicYear(existing.id, {
        semester_ids: [...existing.semester_ids, semesterId],
      });
      setAcademicYears((current) => current.map((record) => record.id === saved.id ? saved : record));
    } catch (err) {
      warning(err.message);
    }
  }

  useEffect(() => {
    if (requestedGradebookId === selectedGradebookId) return;
    const params = new URLSearchParams(location.search);
    params.set("gradebook", selectedGradebookId);
    navigate(`${location.pathname}?${params.toString()}${location.hash}`, { replace: true });
  }, [location.pathname, location.search, location.hash, navigate, requestedGradebookId, selectedGradebookId]);

  useEffect(() => {
    if (location.pathname !== "/courses") return;
    const params = new URLSearchParams(location.search);
    if (!params.has("semester") || params.has("term")) return;
    params.set("term", params.get("semester"));
    params.delete("semester");
    navigate(`${location.pathname}?${params.toString()}${location.hash}`, { replace: true });
  }, [location.pathname, location.search, location.hash, navigate]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setSpeculationMode(false);
    setSpeculationSummary(null);
    dismiss(SPECULATION_MODE_TOAST_ID);
  }, [location.pathname, location.search, location.hash, dismiss]);

  useEffect(() => {
    if (activeAppearance.tooltips === false) dismiss(SPECULATION_MODE_TOAST_ID);
  }, [activeAppearance.tooltips, dismiss]);

  useEffect(() => {
    function blurFocusedNumber(event) {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "number" && document.activeElement === target) {
        target.blur();
      }
    }

    document.addEventListener("wheel", blurFocusedNumber, { capture: true });
    return () => document.removeEventListener("wheel", blurFocusedNumber, { capture: true });
  }, []);

  async function refresh() {
    const sequence = ++refreshSequence.current;
    const requestGradebookId = selectedGradebookId;
    try {
      const gpaParams = { gradebook_id: requestGradebookId };
      const [nextSemesters, meta, gpa, nextAcademicYears] = await Promise.all([
        api.semesters(),
        api.meta().catch(() => null),
        api.gpa(gpaParams).catch(() => null),
        api.academicYears().catch(() => []),
      ]);
      if (sequence !== refreshSequence.current || requestGradebookId !== selectedGradebookId) return;
      setSemesters(nextSemesters);
      setAcademicYears(Array.isArray(nextAcademicYears) ? nextAcademicYears : []);
      if (gpa?.gradebook_type) setGradebookType(gpa.gradebook_type);
      if (gpa?.gpa_basis) setGpaBasis(gpa.gpa_basis);
      if (gpa?.target_gp != null) setTargetGp(Number(gpa.target_gp));
      setHighSchoolPeriodScores(gpa?.high_school_period_scores || {});
      setHighSchoolPeriodGpas(highSchoolPeriodGpaValues(gpa?.overall_classes || []));
      const storedAppearance = gradebookAppearance[requestGradebookId] || {};
      const backendRounding = gpa?.high_school_overall_rounding
        ? { __default__: gpa.high_school_overall_rounding }
        : gpa?.high_school_overall_rounding_by_period;
      const backendTermWeights = gpa?.high_school_term_weights_by_period;
      const localRounding = storedAppearance.highSchoolOverallRoundingByPeriod;
      const localTermWeights = storedAppearance.highSchoolTermWeights;
      if (backendRounding && Object.keys(backendRounding).length) {
        setGradebookAppearance((current) => ({
          ...current,
          [requestGradebookId]: {
            ...(current[requestGradebookId] || {}),
            highSchoolOverallRoundingByPeriod: backendRounding,
          },
        }));
      } else if (localRounding && Object.keys(localRounding).length) {
        api.patchSettings(
          { high_school_overall_rounding_by_period: localRounding },
          requestGradebookId,
        ).catch(() => {});
      }
      if (backendTermWeights && Object.keys(backendTermWeights).length) {
        setGradebookAppearance((current) => ({
          ...current,
          [requestGradebookId]: {
            ...(current[requestGradebookId] || {}),
            highSchoolTermWeights: backendTermWeights,
          },
        }));
      } else if (localTermWeights && Object.keys(localTermWeights).length) {
        api.patchSettings(
          { high_school_term_weights_by_period: localTermWeights },
          requestGradebookId,
        ).catch(() => {});
      }
      // Older installs did not persist semester membership for the default
      // gradebook, which made every newly-created semester appear everywhere.
      // Seed memberships once so each gradebook owns its own semester list.
      setGradebookMembers((current) => {
        const next = { ...current };
        let changed = false;
        for (const gradebook of gradebooks) {
          if (Object.prototype.hasOwnProperty.call(next, gradebook.id)) continue;
          next[gradebook.id] = gradebook.id === "gradebook-1"
            ? nextSemesters.map((semester) => String(semester.id))
            : [];
          changed = true;
        }
        return changed ? next : current;
      });
      if (meta) setGithubRepo(meta.github_repo || "");
    } catch (err) {
      if (sequence === refreshSequence.current) warning(err.message);
    } finally {
      if (sequence === refreshSequence.current) setDataLoaded(true);
    }
  }

  function toggleSpeculationMode() {
    const nextEnabled = !speculationMode;
    dismiss(SPECULATION_MODE_TOAST_ID);
    if (activeAppearance.tooltips !== false) {
      push({
        id: SPECULATION_MODE_TOAST_ID,
        type: "timed",
        tone: "info",
        message: nextEnabled ? "Speculation Mode Enabled" : "Speculation Mode Disabled",
        durationMs: 3000,
      });
    }
    setSpeculationMode(nextEnabled);
  }

  function openGradebookCreate() {
    const nextNumber = gradebooks.reduce((highest, gradebook) => {
      const match = String(gradebook.id).match(/^gradebook-(\d+)$/);
      return Math.max(highest, match ? Number(match[1]) : 0);
    }, 0) + 1;
    setGradebookNameDraft(`Gradebook ${nextNumber}`);
    setGradebookCreateOpen(true);
  }

  function createGradebook(event) {
    event?.preventDefault();
    const nextNumber = gradebooks.reduce((highest, gradebook) => {
      const match = String(gradebook.id).match(/^gradebook-(\d+)$/);
      return Math.max(highest, match ? Number(match[1]) : 0);
    }, 0) + 1;
    const name = gradebookNameDraft.trim();
    if (!name) return;
    const id = `gradebook-${nextNumber}`;
    setGradebooks((current) => [...current, { id, name }]);
    setGradebookMembers((current) => ({ ...current, [id]: [] }));
    setGradebookMenuOpen(false);
    setGradebookCreateOpen(false);
    setGradebookNameDraft("");
    navigate(`/gpa?gradebook=${id}`);
  }

  function renameGradebook(name) {
    const nextName = String(name || "").trim();
    if (!nextName) return;
    setGradebooks((current) => current.map((item) => item.id === selectedGradebookId ? { ...item, name: nextName } : item));
  }

  function reorderGradebooks(orderedIds) {
    const requestedOrder = Array.isArray(orderedIds) ? orderedIds.map((id) => String(id)) : [];
    setGradebooks((current) => {
      const byId = new Map(current.map((item) => [String(item.id), item]));
      const ordered = requestedOrder.map((id) => byId.get(id)).filter(Boolean);
      const included = new Set(ordered.map((item) => String(item.id)));
      current.forEach((item) => {
        if (!included.has(String(item.id))) ordered.push(item);
      });
      return ordered;
    });
  }

  async function registerImportedGradebookSetups(result) {
    const imported = Array.isArray(result?.gradebooks) ? result.gradebooks : [];
    if (!imported.length) return;
    setGradebooks((current) => {
      const known = new Set(current.map((item) => String(item.id)));
      const additions = imported
        .filter((item) => item?.created && item?.id && !known.has(String(item.id)))
        .map((item) => ({ id: String(item.id), name: String(item.name || "Imported gradebook") }));
      return additions.length ? [...current, ...additions] : current;
    });
    setGradebookMembers((current) => {
      const next = { ...current };
      imported.forEach((item) => {
        if (!item?.id) return;
        const id = String(item.id);
        next[id] = [...new Set([...(next[id] || []), ...((item.semester_ids || []).map(String))])];
      });
      return next;
    });
    setGradebookAppearance((current) => {
      const next = { ...current };
      imported.forEach((item) => {
        if (!item?.created || !item?.id || !item?.appearance || typeof item.appearance !== "object") return;
        const id = String(item.id);
        next[id] = { ...(next[id] || {}), ...stripGlobalAppearance(item.appearance) };
      });
      return next;
    });
  }

  function requestDeleteGradebook(targetId = selectedGradebookId) {
    const targetGradebookId = String(targetId || "");
    const targetGradebook = gradebooks.find((item) => String(item.id) === targetGradebookId);
    if (!targetGradebook) return;
    if (gradebooks.length <= 1) {
      warning("Keep at least one gradebook.");
      return;
    }
    push({
      id: `delete-gradebook-${targetGradebookId}`,
      type: "persistent",
      title: "Delete gradebook?",
      message: `Delete ${targetGradebook.name || "this gradebook"} and all of its data? This cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await api.deleteGradebookData(targetGradebookId);
          const remaining = gradebooks.filter((item) => String(item.id) !== targetGradebookId);
          setGradebooks(remaining);
          setGradebookMembers((current) => {
            const next = { ...current };
            delete next[targetGradebookId];
            return next;
          });
          setGradebookAppearance((current) => {
            const next = { ...current };
            delete next[targetGradebookId];
            return next;
          });
          if (String(selectedGradebookId) === targetGradebookId) {
            navigate(`/gpa?gradebook=${remaining[0].id}`);
          }
        } catch (err) {
          warning(err.message);
        }
      },
    });
  }

  function deleteGradebook() {
    requestDeleteGradebook(selectedGradebookId);
  }

  useEffect(() => {
    setDataLoaded(false);
    // Keep the last known periods visible while the selected gradebook loads.
    // Clearing these arrays makes the sidebar flash empty during a normal
    // gradebook or page transition.
    refresh();
  }, [selectedGradebookId]);

  useEffect(() => {
    let cancelled = false;

    async function syncAppearance() {
      try {
        const server = await api.appearance();
        if (cancelled) return;
        const serverAppearance = server ? parseAppearance(server) : null;
        if (serverAppearance) {
          appearanceReady.current = true;
          setAppearance(serverAppearance);
          saveAppearance(serverAppearance);
          return;
        }
        await api.putAppearance(saveAppearance(loadAppearance()));
      } catch {
        /* API offline */
      } finally {
        if (!cancelled) appearanceReady.current = true;
      }
    }

    syncAppearance();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyThemeColors(appearance);
  }, [appearance]);

  useEffect(() => {
    const payload = saveAppearance(appearance);
    if (!appearanceReady.current) return undefined;
    clearTimeout(appearanceSaveTimer.current);
    appearanceSaveTimer.current = window.setTimeout(() => {
      api.putAppearance(payload).catch(() => {});
    }, APPEARANCE_SAVE_MS);
    return () => clearTimeout(appearanceSaveTimer.current);
  }, [appearance]);

  useEffect(() => {
    let cancelled = false;
    const shown = { current: false };

    async function checkGradePrompt() {
      try {
        const status = await api.gradePrompt();
        if (cancelled) return;
        if (!status?.due) {
          shown.current = false;
          dismiss(GRADE_PROMPT_TOAST_ID);
          return;
        }
        if (shown.current) return;
        shown.current = true;
        const currentView = gradePromptViewRef.current;
        gradePromptSemesterRef.current = {
          gradebookId: currentView.gradebookId,
          semesterId: currentView.semesterId || Number(status.default_semester_id) || 0,
        };
        push({
          id: GRADE_PROMPT_TOAST_ID,
          type: "persistent",
          tone: "info",
          title: "Grade progression",
          message: "Record current grades for progression chart",
          dismissIcon: "zzz",
          dismissLabel: "Snooze",
          body: (
            <GradePromptSelect
              gradebooks={gradebooks}
              currentGradebookId={selectedGradebookId}
              promptSemesters={status.semesters || []}
              promptAcademicPeriods={status.academic_periods || []}
              defaultId={status.default_semester_id}
              selectedRef={gradePromptSemesterRef}
              currentSemesterId={selectedSemester}
            />
          ),
          dismissOnConfirm: false,
          onConfirm: async () => {
            const selection = gradePromptSemesterRef.current || {};
            const targetGradebookId = String(selection.gradebookId || gradePromptViewRef.current.gradebookId);
            const semesterId = Number(selection.semesterId || 0);
            try {
              const latest = await api.gradePrompt();
              const selected = (latest.semesters || []).find((sem) => (
                Number(sem.id) === semesterId && String(sem.gradebook_id) === targetGradebookId
              ));
              if (!selected) {
                warning("Select a term in a gradebook before recording grades.");
                return;
              }
              const selectedLabel = selected?.name || "the selected term";
              if (selected?.progression_locked) {
                warning(`Progression is locked for ${selectedLabel}`);
                return;
              }
              try {
                await api.recordSemesterSnapshot(semesterId, targetGradebookId);
                shown.current = false;
                dismiss(GRADE_PROMPT_TOAST_ID);
                await refresh();
                window.dispatchEvent(new CustomEvent("grade-snapshots-updated"));
              } catch (err) {
                if (err.message === "No class grades to record") {
                  shown.current = false;
                  dismiss(GRADE_PROMPT_TOAST_ID);
                  warning(`No grades to record yet for ${selectedLabel}`);
                  await refresh();
                  return;
                }
                throw err;
              }
            } catch (err) {
              warning(err.message);
            }
          },
          onDismissAction: async () => {
            shown.current = false;
            try {
              await api.snoozeGradePrompt();
            } catch (err) {
              warning(err.message);
            }
          },
        });
      } catch {
        /* ignore */
      }
    }

    checkGradePrompt();
    const timer = window.setInterval(checkGradePrompt, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      dismiss(GRADE_PROMPT_TOAST_ID);
    };
  // Keep this effect global. Gradebook selection/creation must not dismiss and
  // recreate the reminder; only the global timer, snooze, or recording action
  // may change its visible state.
  }, [push, dismiss, warning]);

  useEffect(() => {
    let cancelled = false;
    const shownVersion = { current: null };
    const shownApplyStatus = { current: null };

    function offerUpdateToast(info) {
      shownVersion.current = info.latest_version;
      push({
        id: UPDATE_TOAST_ID,
        type: "persistent",
        tone: "info",
        title: "Update available",
        message: `Version ${info.latest_version} is ready`,
        dismissIcon: "zzz",
        dismissLabel: "Snooze",
        dismissOnConfirm: false,
        onConfirm: () => applyFromToast(info),
        onDismissAction: async () => {
          shownVersion.current = null;
          try {
            await api.dismissUpdate({ version: info.latest_version });
          } catch (err) {
            warning(err.message);
          }
        },
      });
    }

    function offerApplyStatusToast(info) {
      const toast = applyStatusToast(info);
      if (!toast) {
        shownApplyStatus.current = null;
        dismiss(UPDATE_STATUS_TOAST_ID);
        return;
      }
      const key = `${info.apply_status.status}:${info.apply_status.version || ""}:${info.apply_status.at || ""}`;
      if (shownApplyStatus.current === key) return;
      shownApplyStatus.current = key;
      push({
        id: UPDATE_STATUS_TOAST_ID,
        type: "persistent",
        tone: toast.tone,
        title: toast.title,
        message: toast.message,
        onDismissAction: async () => {
          shownApplyStatus.current = null;
          try {
            await api.ackUpdateStatus();
          } catch {
            /* ignore */
          }
        },
      });
    }

    async function applyFromToast(info) {
      if (!info.can_apply) {
        const url = info.download_url || info.release_url;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        shownVersion.current = null;
        dismiss(UPDATE_TOAST_ID);
        return;
      }
      push({
        id: UPDATE_TOAST_ID,
        type: "persistent",
        tone: "info",
        title: "Installing update",
        message: "Downloading and replacing the app…",
      });
      try {
        const result = await api.applyUpdate();
        if (result.restarting) return;
        const url = result.download_url || result.release_url || info.download_url || info.release_url;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        shownVersion.current = null;
        dismiss(UPDATE_TOAST_ID);
      } catch (err) {
        warning(err.message);
        if (!cancelled) offerUpdateToast(info);
      }
    }

    async function checkForAppUpdate() {
      try {
        const info = await api.updates();
        if (cancelled) return;
        offerApplyStatusToast(info);
        if (!info.show_toast) {
          shownVersion.current = null;
          dismiss(UPDATE_TOAST_ID);
          return;
        }
        if (shownVersion.current === info.latest_version) return;
        offerUpdateToast(info);
      } catch {
        /* GitHub unreachable */
      }
    }

    checkForAppUpdate();
    const timer = window.setInterval(checkForAppUpdate, UPDATE_CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      dismiss(UPDATE_TOAST_ID);
      dismiss(UPDATE_STATUS_TOAST_ID);
    };
  }, [push, dismiss, warning]);

  async function addSemester(e) {
    e.preventDefault();
    const nextYear = isHighSchool ? nextHighSchoolAcademicYear(semesters) : Number(year) || 0;
    const nextSeason = isHighSchool ? "fall" : season;
    if (isHighSchool && isPlaceholderAcademicPeriodLabel(academicPeriodDraft)) {
      warning("Enter an academic period name.");
      return;
    }
    if (isHighSchool) {
      const duplicate = highSchoolYearGroups(semesters, resolvedAcademicPeriodNames, academicPeriodOrder)
        .some((group) => normalizedName(group.label) === normalizedName(academicPeriodDraft));
      if (duplicate) {
        warning("Academic period names must be unique.");
        return;
      }
    }
    if (!Number.isInteger(nextYear) || nextYear <= 0) {
      warning("Year must be a positive whole number.");
      return;
    }

    async function createSemester(lockPrevious) {
      try {
        const created = await api.createSemester({
          year: nextYear,
          season: nextSeason,
          included: true,
          lock_previous: lockPrevious,
        });
        await refresh();
        if (isHighSchool) {
          const periodKey = String(highSchoolAcademicYearKey(created));
          await saveAcademicPeriodName(academicPeriodDraft.trim(), periodKey, [...semesters, created]);
          setGradebookAppearance((current) => {
            const currentAppearance = current[selectedGradebookId] || {};
            return {
              ...current,
              [selectedGradebookId]: {
                ...currentAppearance,
                highSchoolTermsByPeriod: {
                  ...(currentAppearance.highSchoolTermsByPeriod || {}),
                  [periodKey]: DEFAULT_HIGH_SCHOOL_TERMS,
                },
              },
            };
          });
          setAcademicPeriodDraft("");
        }
        setGradebookMembers((current) => {
          const existing = current[selectedGradebookId]
            ?? (selectedGradebookId === "gradebook-1" ? semesters.map((semester) => String(semester.id)) : []);
          return {
            ...current,
            [selectedGradebookId]: [...new Set([...existing, String(created.id)])],
          };
        });
        navigate(isHighSchool
          ? `/courses?gradebook=${selectedGradebookId}&academicPeriod=${encodeURIComponent(academicPeriodDraft.trim())}&term=${created.id}`
          : `/courses?gradebook=${selectedGradebookId}&term=${created.id}`);
      } catch (err) {
        warning(err.message);
      }
    }

    if (visibleSemesters.length && hasOlderUnlocked(visibleSemesters, nextYear, nextSeason)) {
      push({
        id: "lock-previous-semester-graphs",
        type: "persistent",
        tone: "info",
        title: "Lock previous semester graphs?",
        message: "Lock previous semester's grade progression graphs when adding this semester?",
        confirmLabel: "Lock previous graphs",
        dismissLabel: "Leave graphs unlocked",
        onConfirm: () => createSemester(true),
        onDismissAction: () => createSemester(false),
      });
      return;
    }

    await createSemester(false);
  }

  async function addAcademicPeriod(name) {
    const nextName = String(name || "").trim();
    if (isPlaceholderAcademicPeriodLabel(nextName)) throw new Error("Enter an academic period name.");
    if (highSchoolYearGroups(semesters, resolvedAcademicPeriodNames, academicPeriodOrder).some((group) => normalizedName(group.label) === normalizedName(nextName))) {
      throw new Error("Academic period names must be unique.");
    }
    const created = await api.createSemester({ year: nextHighSchoolAcademicYear(semesters), season: "fall", included: true });
    await api.createAcademicYear({ name: nextName, semester_ids: [created.id] });
    const periodKey = String(highSchoolAcademicYearKey(created));
    setGradebookAppearance((current) => {
      const currentAppearance = current[selectedGradebookId] || {};
      const termsByPeriod = currentAppearance.highSchoolTermsByPeriod || {};
      return {
        ...current,
        [selectedGradebookId]: {
          ...currentAppearance,
          highSchoolTermsByPeriod: {
            ...termsByPeriod,
            [periodKey]: DEFAULT_HIGH_SCHOOL_TERMS,
          },
        },
      };
    });
    setGradebookMembers((current) => ({ ...current, [selectedGradebookId]: [...new Set([...(current[selectedGradebookId] || []), String(created.id)])] }));
    await refresh();
  }

  async function deleteAcademicPeriod(periodKey) {
    const key = String(periodKey);
    const [liveSemesters, liveAcademicYears] = await Promise.all([api.semesters(), api.academicYears()]);
    const targets = liveSemesters.filter((semester) => String(highSchoolAcademicYearKey(semester)) === key);
    const records = liveAcademicYears.filter((record) => academicYearRecordKey(record, liveSemesters) === key);
    for (const semester of targets) {
      try {
        await api.deleteSemester(semester.id);
      } catch (err) {
        if (!/not found/i.test(err.message || "")) throw err;
      }
    }
    for (const record of records) {
      try {
        await api.deleteAcademicYear(record.id);
      } catch (err) {
        if (!/not found/i.test(err.message || "")) throw err;
      }
    }
    updateGradebookAppearance((current) => {
      const next = { ...current };
      for (const field of ["highSchoolAcademicPeriods", "highSchoolTermWeights", "highSchoolTermsByPeriod", "highSchoolOverallRoundingByPeriod"]) {
        if (next[field]) { const values = { ...next[field] }; delete values[key]; next[field] = values; }
      }
      return next;
    });
    setGradebookMembers((current) => ({ ...current, [selectedGradebookId]: (current[selectedGradebookId] || []).filter((id) => !targets.some((semester) => String(semester.id) === String(id))) }));
    await refresh();
  }

  return (
    <CreditLabelProvider appearance={activeAppearance} gpaBasis={gpaBasis}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <h1>Grade Calculator</h1>
          </div>
          <nav className="nav-block">
          <div className="gradebook-switcher" ref={gradebookMenuRef}>
              <div className="gradebook-switcher-row">
                <button
                  className="gradebook-switcher-trigger"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={gradebookMenuOpen}
                  aria-controls="gradebook-menu"
                  onClick={toggleGradebookMenu}
                  onKeyDown={handleGradebookTriggerKeyDown}
                >
                  <span>{selectedGradebook?.name || "Gradebook"}</span>
                  <span className="gradebook-switcher-arrow" aria-hidden="true" />
                </button>
                {gradebookMenuOpen ? (
                  <div className="gradebook-dropdown" id="gradebook-menu" role="listbox" aria-label="Gradebooks">
                    {gradebooks.map((item) => (
                      <button
                        key={item.id}
                        className={`gradebook-dropdown-option ${item.id === selectedGradebookId ? "active" : ""}`}
                        type="button"
                        role="option"
                        aria-selected={item.id === selectedGradebookId}
                        onClick={() => {
                          setGradebookMenuOpen(false);
                          const params = new URLSearchParams(location.search);
                          params.set("gradebook", item.id);
                          navigate(`${location.pathname}?${params.toString()}${location.hash}`);
                        }}
                      >
                        {item.name}
                      </button>
                    ))}
                    <div className="gradebook-dropdown-footer">
                      <button className="btn small" type="button" onClick={() => {
                        setGradebookMenuOpen(false);
                        openGradebookCreate();
                      }}>New gradebook</button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="nav-list nav-list-views">
              <div className="nav-dashboard-settings-row">
                <NavLink to={`/gpa?gradebook=${selectedGradebookId}`} className={({ isActive }) => `nav-link nav-dashboard-link ${isActive ? "active" : ""}`}>
                  GPA Dashboard
                </NavLink>
                <NavLink
                  to={`/gradebook-settings?gradebook=${selectedGradebookId}`}
                  className={({ isActive }) => `nav-link nav-gradebook-settings-link ${isActive ? "active" : ""}`}
                  aria-label="Gradebook Settings"
                  title="Gradebook Settings"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.49.49 0 0 0-.48-.41h-3.84a.49.49 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22l-1.92 3.32a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" />
                  </svg>
                </NavLink>
              </div>
            </div>
            <h2>{isHighSchool ? "Academic Period" : semesterSectionLabel}</h2>
            <div className="semester-nav-section">
              <div className="nav-list">
                {isHighSchool ? (dataLoaded ? sidebarAcademicYears.map((group) => {
                  const first = group.semesters[0];
                  const active = location.pathname.startsWith("/courses") && resolvedAcademicYear === group.key;
                  const showSidebarWgpa = activeAppearance.weightedGpa === true && activeAppearance.wgpaInSidebar === true;
                  const periodGpas = highSchoolPeriodGpas[String(group.key)] || {};
                  const sidebarGpa = showSidebarWgpa ? periodGpas.wgpa : periodGpas.gpa;
                  const groupScore = highSchoolPeriodScore(
                    group,
                    targetGp,
                    activeAppearance.highSchoolTerms,
                    activeAppearance.highSchoolTermsByPeriod,
                    activeAppearance.highSchoolTermWeights?.[String(group.key)] || {},
                    activeAppearance.highSchoolOverallRoundingByPeriod?.[String(group.key)]
                      || activeAppearance.highSchoolOverallRoundingByPeriod?.__default__
                      || {},
                    highSchoolPeriodScores,
                  );
                  return (
                    <Link
                      key={group.key}
                      to={`/courses?gradebook=${selectedGradebookId}&academicPeriod=${encodeURIComponent(group.label)}&term=${first?.id || ""}`}
                      className={`nav-link semester-link ${active ? "active" : ""}`}
                    >
                      <span>{group.label}</span>
                      {sidebarGpa != null ? (
                        <span className="meta">
                          <span className="meta-gpa">{fmtGpa(sidebarGpa)}</span>
                          {activeAppearance.showScore !== false && groupScore != null ? (
                            <span className={`meta-score ${scoreClass(groupScore)}`}>{fmtSidebarScore(groupScore)}</span>
                          ) : null}
                        </span>
                      ) : null}
                    </Link>
                  );
                }) : null) : (dataLoaded ? visibleSemesters.map((sem) => (
                  <NavLink
                    key={sem.id}
                    to={`/courses?gradebook=${selectedGradebookId}&term=${sem.id}`}
                    className={() => `nav-link semester-link ${selectedSemester === String(sem.id) ? "active" : ""}`}
                  >
                    <span>{configuredTermNames[String(sem.id)] ? `${sem.year} ${configuredTermNames[String(sem.id)]}` : sem.name}</span>
                    {(activeAppearance.weightedGpa === true && activeAppearance.wgpaInSidebar === true ? sem.term_wgpa : sem.term_gpa) != null ? (
                      <span className={`meta ${sem.included ? "" : "meta-excluded"}`}>
                        <span className="meta-gpa">{fmtGpa(activeAppearance.weightedGpa === true && activeAppearance.wgpaInSidebar === true ? sem.term_wgpa : sem.term_gpa)}</span>
                        {activeAppearance.showScore !== false && sem.term_score != null ? (
                          <span className={`meta-score ${sem.included ? scoreClass(sem.term_score) : ""}`}>{fmtSidebarScore(sem.term_score)}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </NavLink>
                )) : null)}
              </div>
              <form className="semester-add" onSubmit={addSemester}>
                {isHighSchool ? <label className="semester-add-field muted">
                  <input className="semester-add-name" type="text" placeholder="Academic period" value={academicPeriodDraft} onChange={(e) => setAcademicPeriodDraft(e.target.value)} aria-label="Academic period name" />
                </label> : <>
                  <label className="semester-add-field muted">
                    <input className="semester-add-year" type="number" min="1" step="1" placeholder={String(new Date().getFullYear())} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year" />
                  </label>
                  <label className="semester-add-field muted">
                    <select className="semester-add-term" value={season} onChange={(e) => setSeason(e.target.value)} aria-label="Term">
                      {(activeAppearance.semesterTitles || SEASONS.map(([value, label]) => ({ id: value, name: label }))).map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}
                    </select>
                  </label>
                </>}
                <button className="btn small" type="submit">
                  Add
                </button>
              </form>
            </div>
          </nav>
          <div className={`sidebar-bottom-tools${isClassView ? " is-class-view" : ""}`}>
            {isClassView && speculationMode && speculationSummary ? (
              <div className="speculation-summary-center">
                <SpeculationSummary summary={speculationSummary} />
              </div>
            ) : (
              <FeedbackBubble repo={githubRepo} />
            )}
            <NavLink className="sidebar-settings-fab" to={`/settings?gradebook=${encodeURIComponent(selectedGradebookId)}`} aria-label="Settings">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.49.49 0 0 0-.48-.41h-3.84a.49.49 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22l-1.92 3.32a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" />
              </svg>
            </NavLink>
            {isClassView ? <SpeculationToggle enabled={speculationMode} onToggle={toggleSpeculationMode} /> : null}
          </div>
        </aside>
        <main className="main" key={location.pathname}>
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Routes>
            <Route path="/" element={<Navigate to="/gpa" replace />} />
            <Route
              path="/courses"
              element={
                <CourseList
                  semesters={visibleSemesters}
                  academicPeriods={visibleAcademicYears}
                  gradebookType={gradebookType}
                  academicYearKey={resolvedAcademicYear}
                  academicPeriodName={resolvedAcademicPeriodName}
                  onAcademicPeriodChange={saveAcademicPeriodName}
                  onAcademicPeriodDelete={deleteAcademicPeriod}
                  classType={activeAppearance.classType}
                  highSchoolTerms={highSchoolTermsForPeriod}
                  termNames={configuredTermNames}
                  termLabel={termLabel}
                  highSchoolTermWeights={activeAppearance.highSchoolTermWeights}
                  highSchoolOverallRoundingByPeriod={activeAppearance.highSchoolOverallRoundingByPeriod}
                  weightedGpa={activeAppearance.weightedGpa === true}
                  isHighSchool={isHighSchool}
                  onSemesterCreated={registerHighSchoolSemester}
                  onChange={refresh}
                  dataLoaded={dataLoaded}
                  flags={activeAppearance.flags}
                  classLabels={activeAppearance.classLabels}
                  courseLabels={activeAppearance.courseLabels}
                  onAppearanceChange={updateGradebookAppearance}
                  colorFlaggedAssignments={activeAppearance.colorFlaggedAssignments}
                  readableTextBackground={activeAppearance.readableTextBackground}
                  gradebookId={selectedGradebookId}
                />
              }
            />
            <Route
              path="/courses/:id"
              element={
                <Gradebook
                  onChange={refresh}
                  colorAssignmentGrades={activeAppearance.gradeColors}
                  flags={activeAppearance.flags}
                  classLabels={activeAppearance.classLabels}
                  courseLabels={activeAppearance.courseLabels}
                  onAppearanceChange={updateGradebookAppearance}
                  colorFlaggedAssignments={activeAppearance.colorFlaggedAssignments}
                  readableTextBackground={activeAppearance.readableTextBackground}
                  gradebookId={selectedGradebookId}
                  highSchoolMode={isHighSchool}
                  classType={activeAppearance.classType}
                  academicPeriodNames={resolvedAcademicPeriodNames}
                  highSchoolTerms={activeAppearance.highSchoolTerms}
                  highSchoolTermsByPeriod={activeAppearance.highSchoolTermsByPeriod}
                  onAcademicPeriodDelete={deleteAcademicPeriod}
                  weightedGpa={activeAppearance.weightedGpa === true}
                  speculationMode={speculationMode}
                  onSpeculationSummaryChange={setSpeculationSummary}
                />
              }
            />
            <Route path="/gpa" element={<GpaDashboard onChange={refresh} flags={activeAppearance.flags} classLabels={activeAppearance.classLabels} courseLabels={activeAppearance.courseLabels} semesterIds={visibleSemesters.map((sem) => sem.id)} termNames={configuredTermNames} periodNames={configuredPeriodNames} periodOrder={visibleAcademicYears.map((group) => group.label)} gradebookId={selectedGradebookId} highSchoolMode={isHighSchool} highSchoolTerms={activeAppearance.highSchoolTerms} highSchoolTermsByPeriod={activeAppearance.highSchoolTermsByPeriod} classType={activeAppearance.classType} weightedGpa={activeAppearance.weightedGpa === true} termLabel={termLabel} />} />
            <Route
              path="/settings"
              element={
                <Settings mode="global" gradebooks={gradebooks} gradebookAppearances={gradebookAppearance} appearance={appearance} onAppearanceChange={setAppearance} onGradebookOrderChange={reorderGradebooks} onAddGradebook={openGradebookCreate} onDeleteGradebook={requestDeleteGradebook} onChange={refresh} onImportedGradebookSetups={registerImportedGradebookSetups} />
              }
            />
            <Route
              path="/gradebook-settings"
              element={<Settings key={selectedGradebookId} mode="gradebook" gradebookId={selectedGradebookId} gradebooks={gradebooks} gradebookAppearances={gradebookAppearance} appearance={activeAppearance} gradebookName={selectedGradebook?.name || ""} onGradebookNameChange={renameGradebook} onDeleteGradebook={requestDeleteGradebook} onImportedGradebookSetups={registerImportedGradebookSetups} academicPeriods={visibleAcademicYears} semesters={semesters} onAddAcademicPeriod={addAcademicPeriod} onDeleteAcademicPeriod={deleteAcademicPeriod} onAcademicPeriodChange={saveAcademicPeriodName} onAppearanceChange={updateGradebookAppearance} onChange={refresh} />}
            />
            </Routes>
          </Suspense>
        </main>
      </div>
      {gradebookCreateOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form className="modal panel" role="dialog" aria-modal="true" aria-labelledby="new-gradebook-title" onSubmit={createGradebook}>
            <h2 id="new-gradebook-title">New gradebook</h2>
            <label className="muted">
              Gradebook name
              <input
                className="input"
                autoFocus
                value={gradebookNameDraft}
                onChange={(event) => setGradebookNameDraft(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button className="btn" type="button" onClick={() => setGradebookCreateOpen(false)}>Cancel</button>
              <button className="btn primary" type="submit" disabled={!gradebookNameDraft.trim()}>Create gradebook</button>
            </div>
          </form>
        </div>
      ) : null}
    </CreditLabelProvider>
  );
}
