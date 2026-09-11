import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api, courseGradeClass, fmtGpa, fmtPct, fmtScore, gradeFromPercent, gpOptions, gpSelectValue, letterClass, roundPercentForCalculation, scoreClass } from "./api";
import { Tooltip, useCreditTerms, useShowScore } from "./creditLabel.jsx";
import ExamImpactTable, { ExamImpactStats } from "./ExamImpact.jsx";
import { useToasts } from "./notifications.jsx";
import SemesterProgressChart from "./SemesterProgressChart.jsx";
import { SEASONS } from "./seasons.js";
import { buildCourseDisplayCodes } from "./courseNames.js";
import { FlagSummaryButton, flaggedAssignmentsForSemester } from "./flags.jsx";

const DEFAULT_HIGH_SCHOOL_TERMS = [
  { id: "fall", name: "Fall", season: "fall" },
  { id: "spring", name: "Spring", season: "spring" },
];

const SORTS = [
  ["code", "Class"],
  ["percent", "Percent"],
  ["credits", "Credits"],
  ["letter", "Letter"],
  ["gpa", "GP"],
  ["score", "Score"],
];

const GRADE_SORT_KEYS = new Set(["letter", "gpa"]);

function apiSortKey(sort) {
  return GRADE_SORT_KEYS.has(sort) ? "gpa" : sort;
}

function isGradeSort(sort) {
  return GRADE_SORT_KEYS.has(sort);
}

function overrideGradeClass(value, options) {
  if (value === "" || value === "na" || value == null) return "";
  const match = options.find(([, gp]) => String(gp) === String(value));
  return match ? letterClass(match[0]) : "";
}

function normalizedName(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function isNeutralWeightedGp(course, gpValue, wgpaValue) {
  const gp = gpValue ?? course?.base_quality_points ?? course?.natural_quality_points ?? course?.quality_points;
  const wgpa = wgpaValue ?? course?.quality_points;
  return String(course?.gpa_weight_tag || "unweighted") === "unweighted"
    && course?.gp_override !== -1
    && Number.isFinite(Number(gp))
    && Number.isFinite(Number(wgpa))
    && Math.abs(Number(gp) - Number(wgpa)) < 1e-9;
}

function weightedQualityPoints(course, highSchool = false) {
  if (course?.quality_points == null) return null;
  const qualityPoints = Number(course.quality_points);
  if (!Number.isFinite(qualityPoints)) return null;
  return highSchool ? qualityPoints : qualityPoints + (Number(course.gpa_weight_boost) || 0);
}

const RESERVED_TERM_NAMES = new Set(["settings", "overall"]);

function hsAcademicYearKey(semester) {
  const year = Number(semester?.year) || new Date().getFullYear();
  return ["spring", "summer"].includes(String(semester?.season || "").toLowerCase()) ? year - 1 : year;
}

function normalizeHighSchoolTerms(value, semesters = []) {
  const hasConfiguredTerms = Array.isArray(value) && value.length;
  const source = hasConfiguredTerms ? value : DEFAULT_HIGH_SCHOOL_TERMS;
  const seen = new Set();
  const normalized = source.map((term, index) => {
    const season = String(term?.season || term?.id || "").toLowerCase();
    const id = String(term?.id || season || `term-${index}`).trim();
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const rawName = String(term?.name || season || "").trim();
    const name = /^term-\d+$/i.test(rawName) ? `Term ${index + 1}` : rawName || `Term ${index + 1}`;
    return { id, season, name };
  }).filter(Boolean);
  const existingSeasons = new Set(normalized.map((term) => term.season));
  for (const semester of (hasConfiguredTerms ? [] : semesters)) {
    const season = String(semester.season || "").toLowerCase();
    if (!existingSeasons.has(season)) {
      normalized.push({ id: season, season, name: season.charAt(0).toUpperCase() + season.slice(1) });
      existingSeasons.add(season);
    }
  }
  return normalized.length ? normalized : DEFAULT_HIGH_SCHOOL_TERMS;
}

function HighSchoolEditModeToggle({ value, onChange, weightedGpa, ariaLabel = "Edit mode" }) {
  return (
    <div className="view-toggle" role="group" aria-label={ariaLabel}>
      <button className={`btn small ${value === "classes" ? "primary" : ""}`} type="button" aria-pressed={value === "classes"} onClick={() => onChange("classes")}>Edit Classes</button>
      <button className={`btn small ${value === "termWeights" ? "primary" : ""}`} type="button" aria-pressed={value === "termWeights"} onClick={() => onChange("termWeights")}>Edit Term Weights</button>
      {weightedGpa ? <button className={`btn small ${value === "classWeights" ? "primary" : ""}`} type="button" aria-pressed={value === "classWeights"} onClick={() => onChange("classWeights")}>Edit Class Weight</button> : null}
    </div>
  );
}

export default function CourseList({ semesters, academicPeriods = [], onChange, flags = [], classLabels = [], courseLabels = {}, onAppearanceChange, onAcademicPeriodDelete, classType = "alphanumeric", gradebookType = "college", semesterTitles = [], highSchoolTerms: configuredHighSchoolTerms, highSchoolTermWeights = {}, highSchoolOverallRoundingByPeriod = {}, weightedGpa = false, termLabel = "Semester", termNames = {}, academicYearKey, academicPeriodName, onAcademicPeriodChange, onSemesterCreated, dataLoaded = true, gradebookId = null }) {
  const creditTerms = useCreditTerms();
  const showScore = useShowScore();
  const periodLabel = String(termLabel || "Term").trim() || "Term";
  const { warning, push } = useToasts();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const semesterId = params.get("term") || params.get("semester");
  const [courses, setCourses] = useState([]);
  const [allCourses, setAllCourses] = useState([]);
  const [sort, setSort] = useState("code");
  const [desc, setDesc] = useState(false);
  const [department, setDepartment] = useState("");
  const [courseNumber, setCourseNumber] = useState("");
  const [courseName, setCourseName] = useState("");
  const [credits, setCredits] = useState("");
  const [gpaSettings, setGpaSettings] = useState({ gradebook_type: "college", gpa_weight_tags: [] });
  const loadSequence = useRef(0);
  const canAddCourse = classType === "named"
    ? courseName.trim().length > 0
    : department.trim().length > 0
      && courseNumber.trim().length > 0
      && (gpaSettings.gpa_basis === "classes"
        || (credits.trim().length > 0 && Number.isFinite(Number(credits)) && Number(credits) > 0));

  const sortCols = useMemo(
    () =>
      SORTS.filter(([key]) => (showScore || key !== "score") && (gpaSettings.gpa_basis !== "classes" || key !== "credits")).map(([key, label]) => [
        key,
        key === "credits" ? creditTerms.label : label,
      ]),
    [creditTerms.label, showScore, gpaSettings.gpa_basis]
  );

  const [year, setYear] = useState("");
  const [season, setSeason] = useState("fall");
  const [saveError, setSaveError] = useState("");
  const [semesterSettingsOpen, setSemesterSettingsOpen] = useState(false);
  const [termSettingsOpen, setTermSettingsOpen] = useState(false);
  const [highSchoolEditMode, setHighSchoolEditMode] = useState("classes");
  const [overallEditMode, setOverallEditMode] = useState("classes");
  const [academicPeriodNameOpen, setAcademicPeriodNameOpen] = useState(false);
  const [highSchoolTerms, setHighSchoolTerms] = useState(() => normalizeHighSchoolTerms(configuredHighSchoolTerms, semesters));
  const isHighSchool = gradebookType === "high_school";
  const overallView = isHighSchool && semesterId === "overall";
  const gradebookQuery = new URLSearchParams(window.location.search).get("gradebook") || "default";

  const current = useMemo(
    () => semesters.find((s) => String(s.id) === String(semesterId)),
    [semesters, semesterId]
  );
  const currentAcademicYearKey = academicYearKey || (current ? String(hsAcademicYearKey(current)) : "");
  const currentAcademicPeriodParam = encodeURIComponent(academicPeriodName || currentAcademicYearKey);
  const academicYearSemesters = useMemo(
    () => semesters.filter((semester) => String(hsAcademicYearKey(semester)) === String(currentAcademicYearKey)),
    [semesters, currentAcademicYearKey]
  );
  const availableTerms = useMemo(() => {
    const base = normalizeHighSchoolTerms(highSchoolTerms, academicYearSemesters);
    // Once a period has an explicit term configuration, respect it exactly.
    // Re-adding every backend semester here made removed terms immediately
    // reappear, so the term-order controls appeared not to work.
    if (Array.isArray(highSchoolTerms) && highSchoolTerms.length) return base;
    const mappedIds = new Set(base.map((term) => {
      const match = academicYearSemesters.find((semester) => semester.season === term.season);
      return match?.id == null ? null : String(match.id);
    }).filter(Boolean));
    const extras = academicYearSemesters
      .filter((semester) => !mappedIds.has(String(semester.id)))
      .map((semester, index) => {
        const fallback = `Term ${base.length + index + 1}`;
        const rawName = String(semester.name || "").replace(/^\d{4}\s+/, "").trim();
        return {
          id: `semester-${semester.id}`,
          season: String(semester.season || "").toLowerCase(),
          name: /^term-\d+$/i.test(rawName) ? fallback : rawName || fallback,
        };
      });
    return [...base, ...extras];
  }, [highSchoolTerms, academicYearSemesters]);
  const academicPeriodOptions = useMemo(() => academicPeriods.length ? academicPeriods : [...new Set(semesters.map((semester) => String(hsAcademicYearKey(semester))))].map((key) => ({ key, label: key })), [academicPeriods, semesters]);
  const displayTermSemester = (term) => academicYearSemesters.find((item) => item.season === term.season);
  const displaySemesterName = (semester) => (
    !isHighSchool && termNames[String(semester?.id)]
      ? `${semester.year} ${termNames[String(semester.id)]}`
      : semester?.name || "Semester"
  );
  const relatedHighSchoolCourses = (course) => {
    if (!isHighSchool) return [course];
    const semesterById = new Map(semesters.map((semester) => [String(semester.id), semester]));
    const coursePeriod = String(currentAcademicYearKey || hsAcademicYearKey(semesterById.get(String(course?.semester_id))));
    const code = String(course?.code || "").trim().toLowerCase();
    return allCourses.filter((item) => (
      String(item.code || "").trim().toLowerCase() === code
      && String(hsAcademicYearKey(semesterById.get(String(item.semester_id)))) === coursePeriod
    ));
  };
  const selectedCourseLabels = (course) => {
    const labels = new Set();
    relatedHighSchoolCourses(course).forEach((item) => {
      (courseLabels?.[String(item.id)] || []).forEach((labelId) => labels.add(labelId));
    });
    return [...labels];
  };
  const updateCourseLabels = (course, labelIds) => onAppearanceChange?.((appearance) => ({
    ...appearance,
    courseLabels: {
      ...(appearance.courseLabels || {}),
      ...Object.fromEntries(relatedHighSchoolCourses(course).map((item) => [String(item.id), labelIds])),
    },
  }));
  const gradedCourses = useMemo(
    () => courses.filter((course) => course.quality_points != null && course.gp_override !== -1),
    [courses]
  );
  const termUnitBreakdown = useMemo(() => {
    if (!isHighSchool) return [];
    const counts = new Map();
    const termUnit = 1 / Math.max(availableTerms.length, 1);
    gradedCourses.forEach((course) => {
      // In a multi-term gradebook, catalog credits are not the class's
      // academic-period unit share. Each occurrence contributes one equal
      // share of the configured terms in the period.
      const units = termUnit;
      if (!Number.isFinite(units) || units <= 0) return;
      const key = Number(units.toFixed(3)).toString();
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([units, count]) => ({ units, count }))
      .sort((a, b) => Number(b.units) - Number(a.units));
  }, [availableTerms.length, gradedCourses, isHighSchool]);

  const termUnitTotal = useMemo(
    () => termUnitBreakdown.reduce((sum, row) => sum + Number(row.units) * row.count, 0),
    [termUnitBreakdown]
  );

  useEffect(() => {
    setHighSchoolTerms(normalizeHighSchoolTerms(configuredHighSchoolTerms, semesters));
  }, [configuredHighSchoolTerms, semesters]);

  useEffect(() => {
    if (current) {
      setYear(String(current.year));
      setSeason(current.season);
      setSaveError("");
    }
  }, [current]);

  async function load() {
    const sequence = ++loadSequence.current;
    const [data, allCourses, gpa] = await Promise.all([api.courses({
      semester_id: overallView ? undefined : (semesterId || undefined),
      sort: apiSortKey(sort),
      desc,
    }), api.courses(), api.gpa()]);
    if (sequence !== loadSequence.current) return;
    setGpaSettings(gpa);
    const displayCodes = buildCourseDisplayCodes(semesters, allCourses, semesterTitles);
    setAllCourses(allCourses);
    setCourses(data.map((course) => ({ ...course, display_code: displayCodes.get(course.id) || course.display_code })));
  }

  useEffect(() => {
    if (!semesterId) return;
    setCourses([]);
    setAllCourses([]);
    load().catch(console.error);
  }, [semesterId, sort, desc, overallView, gradebookQuery, semesterTitles, semesters]);

  useEffect(() => {
    if (!showScore && sort === "score") {
      setSort("gpa");
      setDesc(true);
    }
  }, [showScore, sort]);

  function toggleSort(next) {
    if (GRADE_SORT_KEYS.has(next)) {
      if (isGradeSort(sort)) setDesc((d) => !d);
      else {
        setSort("gpa");
        setDesc(true);
      }
      return;
    }
    if (sort === next) setDesc((d) => !d);
    else {
      setSort(next);
      setDesc(next !== "code");
    }
  }

  function sortHeaderClass(key) {
    return key === sort || (GRADE_SORT_KEYS.has(key) && isGradeSort(sort)) ? "active" : "";
  }

  function sortHeaderArrow(key) {
    if (key === sort || (GRADE_SORT_KEYS.has(key) && isGradeSort(sort))) {
      return desc ? " ↓" : " ↑";
    }
    return "";
  }

  async function addCourse(e) {
    e.preventDefault();
    const nextCode = classType === "named"
      ? courseName.trim()
      : `${department.trim()} ${courseNumber.trim()}`.toLowerCase();
    if (!semesterId || !nextCode || !canAddCourse) return;
    if (!isHighSchool && courses.some((course) => String(course.code || "").trim().toLowerCase() === nextCode)) {
      warning(`Course Already Exists in ${displaySemesterName(current)}`);
      return;
    }
    try {
      await api.createCourse({
        semester_id: Number(semesterId),
        code: nextCode.toUpperCase(),
        credits: Number(credits) || 3,
        bonus_mode: "none",
      });
      setDepartment("");
      setCourseNumber("");
      setCourseName("");
      await load();
      onChange?.();
    } catch (err) {
      if (err.message.includes("already exists")) {
        warning(`Course Already Exists in ${displaySemesterName(current)}`);
        return;
      }
      warning(err.message);
    }
  }

  async function saveSemester(e) {
    e.preventDefault();
    if (!current) return;
    try {
      await api.patchSemester(current.id, { year: Number(year), season });
      setSaveError("");
      setSemesterSettingsOpen(false);
      onChange?.();
    } catch (err) {
      setSaveError(err.message);
    }
  }

  function removeCourse(course) {
    const removeFromTerm = isHighSchool;
    push({
      id: `delete-course-${course.id}`,
      type: "persistent",
      title: removeFromTerm ? "Remove class from term?" : "Delete class?",
      message: removeFromTerm
        ? `Remove ${course.code} from this term? This removes its grades from this term but keeps classes in other terms.`
        : `Delete ${course.code}? This permanently removes the class and its grades.`,
      confirmLabel: removeFromTerm ? "Remove from term" : "Delete class",
      onConfirm: async () => {
        try {
                              await api.deleteCourse(course.id);
                              await load();
                              onChange?.();
                              window.dispatchEvent(new Event("grade-snapshots-updated"));
        } catch (err) {
          warning(err.message);
        }
      },
    });
  }

  async function setOverride(courseId, raw) {
    try {
      const course = courses.find((item) => item.id === courseId);
      if (course?.credit_mode === "pass_fail") {
        await api.patchCourse(courseId, { pass_fail_override: raw || null });
      } else {
        await api.patchCourse(courseId, {
          gp_override: raw === "na" ? -1 : raw === "" ? null : Number(raw),
        });
      }
      await load();
      onChange?.();
    } catch (err) {
      warning(err.message);
    }
  }

  async function moveCourse(courseId, semesterId) {
    const course = courses.find((item) => item.id === courseId);
    const target = semesters.find((semester) => String(semester.id) === String(semesterId));
    const duplicate = !isHighSchool && target?.courses?.some(
      (item) => item.id !== courseId && String(item.code || "").trim().toLowerCase() === String(course?.code || "").trim().toLowerCase()
    );
    if (duplicate) {
      warning(`Course Already Exists in ${target?.name || "selected semester"}`);
      return;
    }
    try {
      await api.patchCourse(courseId, { semester_id: Number(semesterId) });
      await load();
      onChange?.();
    } catch (err) {
      if (err.message.includes("already exists")) {
        warning(`Course Already Exists in ${target?.name || "selected semester"}`);
        return;
      }
      warning(err.message);
    }
  }

  async function moveCourseToAcademicPeriod(courseId, periodKey) {
    const course = courses.find((item) => item.id === courseId);
    const source = semesters.find((semester) => String(semester.id) === String(course?.semester_id));
    const targetSemesters = semesters.filter((semester) => String(hsAcademicYearKey(semester)) === String(periodKey));
    const related = relatedHighSchoolCourses(course);
    await Promise.all(related.map((item) => {
      const itemSemester = semesters.find((semester) => String(semester.id) === String(item.semester_id));
      const target = targetSemesters.find((semester) => semester.season === itemSemester?.season) || targetSemesters[0];
      return target ? api.patchCourse(item.id, { semester_id: Number(target.id) }) : null;
    }));
    await load();
    onChange?.();
  }

  async function patchExamCats(courseId, patch) {
    await api.patchCourse(courseId, patch);
    await load();
    onChange?.();
  }

  async function setGpaWeight(courseId, gpa_weight_tag) {
    // The term editor lists all classes in the academic period, while
    // `courses` contains only the currently selected term. Resolve from the
    // complete list first so classes introduced in another term still update.
    const course = allCourses.find((item) => item.id === courseId)
      || courses.find((item) => item.id === courseId);
    await Promise.all(relatedHighSchoolCourses(course).map((item) => api.patchCourse(item.id, { gpa_weight_tag })));
    await load();
    onChange?.();
  }

  async function selectHighSchoolTerm(value) {
    const existing = academicYearSemesters.find((semester) => String(semester.id) === String(value));
    if (existing) {
      navigate(`/courses?gradebook=${new URLSearchParams(window.location.search).get("gradebook") || "default"}&academicPeriod=${currentAcademicPeriodParam}&term=${existing.id}`);
      return;
    }
    const term = availableTerms.find((item) => `new:${item.id}` === value);
    if (!term) return;
    try {
      const start = Number(currentAcademicYearKey) || new Date().getFullYear();
      const created = await api.createSemester({ year: ["spring", "summer"].includes(term.season) ? start + 1 : start, season: term.season, included: true });
      await onSemesterCreated?.(created);
      await onChange?.();
      navigate(`/courses?gradebook=${new URLSearchParams(window.location.search).get("gradebook") || "default"}&academicPeriod=${currentAcademicPeriodParam}&term=${created.id}`);
    } catch (err) {
      warning(err.message);
    }
  }

  function requestDeletePeriod() {
    const periodName = academicPeriodName || `${currentAcademicYearKey}–${String(Number(currentAcademicYearKey) + 1).slice(-2)}`;
    push({
      id: `delete-period-${currentAcademicYearKey}`,
      type: "persistent",
      title: "Delete period?",
      message: `Delete ${periodName} and its terms and classes? This can not be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await onAcademicPeriodDelete?.(currentAcademicYearKey);
          onAppearanceChange?.((appearance) => {
            const next = { ...appearance };
            if (next.highSchoolAcademicPeriods) {
              const periods = { ...next.highSchoolAcademicPeriods };
              delete periods[String(currentAcademicYearKey)];
              next.highSchoolAcademicPeriods = periods;
            }
            if (next.highSchoolTermWeights) {
              const weights = { ...next.highSchoolTermWeights };
              delete weights[String(currentAcademicYearKey)];
              next.highSchoolTermWeights = weights;
            }
            if (next.highSchoolOverallRoundingByPeriod) {
              const rounding = { ...next.highSchoolOverallRoundingByPeriod };
              delete rounding[String(currentAcademicYearKey)];
              next.highSchoolOverallRoundingByPeriod = rounding;
            }
            return next;
          });
          onChange?.();
          navigate(`/gpa?gradebook=${encodeURIComponent(gradebookQuery)}`);
        } catch (err) {
          warning(err.message);
        }
      },
    });
  }

  async function saveTermWeights(weights) {
    try {
      const result = await api.patchSettings(
        { high_school_term_weights_by_period: { [String(currentAcademicYearKey)]: weights } },
        gradebookQuery,
      );
      if (result) setGpaSettings(result);
      onAppearanceChange?.((appearance) => ({
        ...appearance,
        highSchoolTermWeights: {
          ...(appearance.highSchoolTermWeights || {}),
          [String(currentAcademicYearKey)]: weights,
        },
      }));
    } catch (err) {
      warning(err.message);
    }
  }

  if (!semesterId) return <Navigate to={`/gpa?gradebook=${encodeURIComponent(gradebookQuery)}`} replace />;
  if (!dataLoaded) return <p className="muted">Loading…</p>;
  if (!current && !overallView) return <Navigate to={`/gpa?gradebook=${encodeURIComponent(gradebookQuery)}`} replace />;
  if (overallView) {
    return <><HighSchoolOverallView
      academicPeriodName={academicPeriodName || `${currentAcademicYearKey}–${String(Number(currentAcademicYearKey) + 1).slice(-2)}`}
      academicYearKey={currentAcademicYearKey}
      terms={availableTerms}
      semesters={academicYearSemesters}
      termSemesters={availableTerms.map((term, index) => displayTermSemester(term, index))}
      courses={allCourses}
      termWeights={highSchoolTermWeights[currentAcademicYearKey] || {}}
      overallRounding={highSchoolOverallRoundingByPeriod[String(currentAcademicYearKey)] || highSchoolOverallRoundingByPeriod.__default__ || {}}
      overallClasses={gpaSettings.overall_classes || []}
      termLabel={termLabel}
      weightedGpa={weightedGpa}
      gpaSettings={gpaSettings}
      onEditPeriodName={() => setAcademicPeriodNameOpen(true)}
      onSelectTerm={selectHighSchoolTerm}
      onDeletePeriod={requestDeletePeriod}
      onChange={async () => { await Promise.all([load(), onChange?.()]); }}
    />
    {academicPeriodNameOpen ? <AcademicPeriodNameModal
      name={academicPeriodName || `${currentAcademicYearKey}–${String(Number(currentAcademicYearKey) + 1).slice(-2)}`}
      onClose={() => setAcademicPeriodNameOpen(false)}
      onSave={(name) => {
        if (academicPeriodOptions.some((period) => String(period.key) !== String(currentAcademicYearKey) && normalizedName(period.label) === normalizedName(name))) {
          warning("Academic period names must be unique.");
          return;
        }
        onAcademicPeriodChange?.(name, currentAcademicYearKey);
        setAcademicPeriodNameOpen(false);
      }}
    /> : null}
    {overallEditMode ? <HighSchoolTermsModal
      page
      showModeToggle={false}
      modeToggle={<div className="overall-edit-toggle-row"><HighSchoolEditModeToggle value={overallEditMode} onChange={setOverallEditMode} weightedGpa={weightedGpa} ariaLabel="Overall edit mode" /></div>}
      academicPeriods={academicPeriodOptions}
      terms={availableTerms}
       semesters={academicYearSemesters}
       courses={allCourses}
       classLabels={classLabels}
       courseLabels={courseLabels}
       onClassLabelsChange={(course, labelIds) => updateCourseLabels(course, labelIds)}
       currentSemesterId={academicYearSemesters[0]?.id}
      academicYearKey={currentAcademicYearKey}
      periodName={academicPeriodName || `${currentAcademicYearKey}–${String(Number(currentAcademicYearKey) + 1).slice(-2)}`}
      classType={classType}
      matrixMode={overallEditMode === "termWeights" ? "weights" : overallEditMode === "classWeights" ? "classWeights" : "terms"}
      weightedGpa={weightedGpa}
      gpaWeightTags={gpaSettings.gpa_weight_tags || []}
      onGpaWeightChange={(courseId, tag) => setGpaWeight(courseId, tag)}
      termWeights={highSchoolTermWeights[currentAcademicYearKey] || {}}
      onTermWeightsChange={saveTermWeights}
      onPeriodNameChange={(name) => onAcademicPeriodChange?.(name, currentAcademicYearKey)}
      onSemesterCreated={onSemesterCreated}
      onTermsChange={(next) => {
        setHighSchoolTerms(next);
        onAppearanceChange?.((appearance) => ({ ...appearance, highSchoolTermsByPeriod: { ...(appearance.highSchoolTermsByPeriod || {}), [String(currentAcademicYearKey)]: next } }));
      }}
      onChange={async () => { await load(); onChange?.(); }}
      onClose={() => setOverallEditMode(null)}
    /> : null}
    </>;
  }
  const flaggedSemesterItems = flaggedAssignmentsForSemester({ ...current, courses }, flags);
  const periodName = isHighSchool
    ? (availableTerms.find((term) => term.season === current.season)?.name || current.name)
    : current.name;
  const termGpa = (() => {
    const graded = gradedCourses;
    const units = (course) => gpaSettings.gpa_basis === "classes" ? 1 : Number(course.credits) || 0;
    const totalUnits = graded.reduce((sum, course) => sum + units(course), 0);
    if (!totalUnits) return current.term_gpa;
    // `quality_points` is the effective value for college terms, including a
    // GP override. High-school terms expose the corresponding unweighted
    // effective value as `base_quality_points`.
    return graded.reduce((sum, course) => sum + Number(course.base_quality_points ?? course.quality_points) * units(course), 0) / totalUnits;
  })();
  const termWgpa = weightedGpa ? (() => {
    const graded = gradedCourses;
    if (!graded.length) return null;
    const units = (course) => gpaSettings.gpa_basis === "classes" ? 1 : Number(course.credits) || 0;
    const totalUnits = graded.reduce((sum, course) => sum + units(course), 0);
    if (!totalUnits) return null;
    return graded.reduce((sum, course) => sum + Number(weightedQualityPoints(course, isHighSchool)) * units(course), 0) / totalUnits;
  })() : null;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="gradebook-title-row">
            <h1>{isHighSchool ? (academicPeriodName || `${currentAcademicYearKey}–${String(Number(currentAcademicYearKey) + 1).slice(-2)}`) : displaySemesterName(current)}</h1>
            {isHighSchool ? <button type="button" className="cat-gear" aria-label={`Edit ${(academicPeriodName || `${currentAcademicYearKey}–${String(Number(currentAcademicYearKey) + 1).slice(-2)}`)} name`} onClick={() => setAcademicPeriodNameOpen(true)}><span className="pencil-icon" aria-hidden="true">✎</span></button> : null}
            {isHighSchool ? <div className="semester-term-picker header-semester-term-picker title-semester-term-picker" aria-label="Term to display">
              <div className="view-toggle semester-term-toggle" role="group" aria-label="Term to display">
                {availableTerms.map((term, index) => { const semester = displayTermSemester(term, index); return <button key={term.id} className={`btn small ${current.id === semester?.id ? "primary" : ""}`} type="button" aria-pressed={current.id === semester?.id} onClick={() => selectHighSchoolTerm(semester?.id || `new:${term.id}`)}>{term.name}</button>; })}
                <span className="term-toggle-divider" aria-hidden="true" />
                <button className="btn small" type="button" onClick={() => navigate(`/courses?gradebook=${new URLSearchParams(window.location.search).get("gradebook") || "default"}&academicPeriod=${currentAcademicPeriodParam}&term=overall`)}>Overall</button>
              </div>
            </div> : null}
          </div>
        </div>
        <div className="row topbar-actions">
          {isHighSchool ? (
            <div className="semester-term-picker header-semester-term-picker" aria-label="Term to display">
              <div className="view-toggle semester-term-toggle" role="group" aria-label="Term to display">
                {availableTerms.map((term, index) => {
                  const semester = displayTermSemester(term, index);
                  return <button key={term.id} className={`btn small ${current.id === semester?.id ? "primary" : ""}`} type="button" aria-pressed={current.id === semester?.id} onClick={() => selectHighSchoolTerm(semester?.id || `new:${term.id}`)}>{term.name}</button>;
                })}
                <span className="term-toggle-divider" aria-hidden="true" />
                <button className="btn small" type="button" onClick={() => navigate(`/courses?gradebook=${new URLSearchParams(window.location.search).get("gradebook") || "default"}&academicPeriod=${currentAcademicPeriodParam}&term=overall`)}>Overall</button>
              </div>
            </div>
          ) : null}
          {isHighSchool ? <button className="btn danger" type="button" onClick={requestDeletePeriod}>
            Delete Period
          </button> : <button
            className="btn danger"
            onClick={() => {
              const semester = current;
              push({
                id: `delete-semester-${semester.id}`,
                type: "persistent",
                title: "Delete semester?",
                message: `Delete ${semester.name} and its classes? This can not be undone.`,
                confirmLabel: "Delete",
                onConfirm: async () => {
                  try {
                    await api.deleteSemester(semester.id);
                    onChange?.();
                    navigate(`/gpa?gradebook=${encodeURIComponent(gradebookQuery)}`);
                  } catch (err) {
                    warning(err.message);
                  }
                },
              });
            }}
          >
            Delete semester
          </button>}
        </div>
      </div>

      <div className={`grid-stats semester-stats ${isHighSchool ? "high-school-semester-stats" : ""}`}>
        <div className="stat">
          <div className="label">{periodLabel} GPA</div>
          <div className="value">{fmtGpa(termGpa)}</div>
        </div>
        {weightedGpa ? (
          <div className="stat">
            <div className="label">{periodLabel} WGPA</div>
            <div className="value">{fmtGpa(termWgpa)}</div>
          </div>
        ) : null}
        {showScore ? (
          <div className="stat">
            <div className="label">{periodLabel} Score</div>
            <div className={`value ${current.included ? scoreClass(current.term_score) : ""}`}>
              {fmtScore(current.term_score)}
            </div>
          </div>
        ) : null}
        {isHighSchool ? (
          <div className="stat stat-info-hover" tabIndex={0} aria-describedby={`semester-classes-info-${current.id}`}>
            <div className="label">{periodLabel} Classes</div>
            <div className="value mono">{gradedCourses.length}</div>
            <p className="stat-info-hover-bubble" id={`semester-classes-info-${current.id}`} role="note">
              <span>Total units: {Number(termUnitTotal.toFixed(3)).toString()}</span>
              {termUnitBreakdown.length ? termUnitBreakdown.map((row) => (
                <span key={row.units}>{row.units}-unit classes: {row.count}</span>
              )) : <span>No units yet</span>}
            </p>
          </div>
        ) : (
          <div className="stat stat-info-hover" tabIndex={0} aria-describedby={`semester-credits-info-${current.id}`}>
            <div className="label">{periodLabel} {creditTerms.plural}</div>
            <div className="value mono">{current.term_credits ?? 0}</div>
            <p className="stat-info-hover-bubble" id={`semester-credits-info-${current.id}`} role="note">
              <span>Affects GPA: {current.term_affects_gpa_credits ?? current.term_gpa_credits ?? 0} {creditTerms.plural}</span>
              <span>Credit Only: {current.term_credit_only_credits ?? Math.max(0, (current.term_credits ?? 0) - (current.term_gpa_credits ?? 0))} {creditTerms.plural}</span>
              <br />
              {(current.term_passed_credits ?? 0) > 0 ? <span>Passing: {current.term_passed_credits} {creditTerms.plural}</span> : null}
              {(current.term_unpassed_credits ?? 0) > 0 ? <span>Failing: {current.term_unpassed_credits} {creditTerms.plural}</span> : null}
            </p>
          </div>
        )}
        {flaggedSemesterItems.length ? (
          <div className="semester-flag-summary">
            <FlagSummaryButton items={flaggedSemesterItems} flags={flags} semester gradebookId={gradebookQuery} />
          </div>
        ) : null}
        {false && isHighSchool ? (
          <div className="semester-term-picker" aria-label="Term to display">
            <div className="view-toggle semester-term-toggle" role="group" aria-label="Term to display">
              {availableTerms.map((term, index) => {
                const semester = displayTermSemester(term, index);
                return <button key={term.id} className={`btn small ${current.id === semester?.id ? "primary" : ""}`} type="button" aria-pressed={current.id === semester?.id} onClick={() => selectHighSchoolTerm(semester?.id || `new:${term.id}`)}>{term.name}</button>;
              })}
              <button className="btn small" type="button" onClick={() => navigate(`/courses?gradebook=${new URLSearchParams(window.location.search).get("gradebook") || "default"}&academicPeriod=${currentAcademicPeriodParam}&term=overall`)}>Overall</button>
            </div>
          </div>
        ) : null}
      </div>

      {semesterSettingsOpen ? (
        <SemesterSettingsModal
          year={year}
          season={season}
          error={saveError}
          onYear={setYear}
          onSeason={setSeason}
          onClose={() => {
            setSemesterSettingsOpen(false);
            setSaveError("");
            if (current) {
              setYear(String(current.year));
              setSeason(current.season);
            }
          }}
          onSubmit={saveSemester}
        />
      ) : null}

      {isHighSchool && academicPeriodNameOpen ? <AcademicPeriodNameModal
        name={academicPeriodName || `${currentAcademicYearKey}–${String(Number(currentAcademicYearKey) + 1).slice(-2)}`}
        onClose={() => setAcademicPeriodNameOpen(false)}
        onSave={(name) => {
          if (academicPeriodOptions.some((period) => String(period.key) !== String(currentAcademicYearKey) && normalizedName(period.label) === normalizedName(name))) {
            warning("Academic period names must be unique.");
            return;
          }
          onAcademicPeriodChange?.(name, currentAcademicYearKey);
          setAcademicPeriodNameOpen(false);
        }}
      /> : null}

      <div className="panel table-wrap">
        {isHighSchool ? <div className="row class-list-header"><div aria-hidden="true" /><div className="view-toggle" role="group" aria-label="Class list mode"><button className={`btn small ${!termSettingsOpen ? "primary" : ""}`} type="button" aria-pressed={!termSettingsOpen} onClick={() => { setHighSchoolEditMode("classes"); setTermSettingsOpen(false); }}>Class List</button><button className={`btn small ${termSettingsOpen && highSchoolEditMode === "classes" ? "primary" : ""}`} type="button" aria-pressed={termSettingsOpen && highSchoolEditMode === "classes"} onClick={() => { setHighSchoolEditMode("classes"); setTermSettingsOpen(true); }}>Edit Classes</button><button className={`btn small ${termSettingsOpen && highSchoolEditMode === "termWeights" ? "primary" : ""}`} type="button" aria-pressed={termSettingsOpen && highSchoolEditMode === "termWeights"} onClick={() => { setHighSchoolEditMode("termWeights"); setTermSettingsOpen(true); }}>Edit Term Weights</button>{weightedGpa ? <button className={`btn small ${termSettingsOpen && highSchoolEditMode === "classWeights" ? "primary" : ""}`} type="button" aria-pressed={termSettingsOpen && highSchoolEditMode === "classWeights"} onClick={() => { setHighSchoolEditMode("classWeights"); setTermSettingsOpen(true); }}>Edit Class Weight</button> : null}</div></div> : null}
        {termSettingsOpen && isHighSchool ? <HighSchoolTermsModal
          page
          showModeToggle={false}
          academicPeriods={academicPeriodOptions}
          terms={availableTerms}
           semesters={academicYearSemesters}
           courses={allCourses}
           classLabels={classLabels}
           courseLabels={courseLabels}
           onClassLabelsChange={(course, labelIds) => updateCourseLabels(course, labelIds)}
           currentSemesterId={current.id}
          academicYearKey={currentAcademicYearKey}
          periodName={academicPeriodName || `${currentAcademicYearKey}–${String(Number(currentAcademicYearKey) + 1).slice(-2)}`}
          classType={classType}
          matrixMode={highSchoolEditMode === "termWeights" ? "weights" : highSchoolEditMode === "classWeights" ? "classWeights" : "terms"}
          weightedGpa={weightedGpa}
          gpaWeightTags={gpaSettings.gpa_weight_tags || []}
          onGpaWeightChange={(courseId, tag) => setGpaWeight(courseId, tag)}
          termWeights={highSchoolTermWeights[currentAcademicYearKey] || {}}
          onTermWeightsChange={saveTermWeights}
          onPeriodNameChange={(name) => onAcademicPeriodChange?.(name, currentAcademicYearKey)}
          onSemesterCreated={onSemesterCreated}
          onTermsChange={(next) => {
            setHighSchoolTerms(next);
            onAppearanceChange?.((appearance) => ({ ...appearance, highSchoolTermsByPeriod: { ...(appearance.highSchoolTermsByPeriod || {}), [String(currentAcademicYearKey)]: next } }));
          }}
          onChange={async () => { await load(); onChange?.(); }}
          onClose={() => setTermSettingsOpen(false)}
        /> : courses.length === 0 ? (
          <div className={`empty ${isHighSchool ? "empty-with-action" : ""}`}>
            <span>No classes yet.</span>
            {isHighSchool ? <button className="btn small" type="button" onClick={() => setTermSettingsOpen(true)}>Add Class</button> : <span>Add one below.</span>}
          </div>
        ) : (
          <table className="course-list-table">
            <thead>
              <tr>
                {sortCols.filter(([key]) => key !== "score").map(([key, label]) => (
                  <th key={key}>
                    <button className={sortHeaderClass(key)} onClick={() => toggleSort(key)}>
                      {label}
                      {sortHeaderArrow(key)}
                    </button>
                  </th>
                ))}
                {weightedGpa ? <th>WGP</th> : null}
                {sortCols.filter(([key]) => key === "score").map(([key, label]) => (
                  <th key={key}>
                    <button className={sortHeaderClass(key)} onClick={() => toggleSort(key)}>
                      {label}
                      {sortHeaderArrow(key)}
                    </button>
                  </th>
                ))}
                {!isHighSchool ? <th>Override</th> : null}
                <th />
              </tr>
            </thead>
            <tbody>
              {courses.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={isHighSchool
                      ? `/courses/${c.id}?gradebook=${encodeURIComponent(gradebookQuery)}&academicPeriod=${currentAcademicPeriodParam}&term=${current.id}`
                      : `/courses/${c.id}?gradebook=${encodeURIComponent(gradebookQuery)}`}
                    >{c.display_code || c.code}</Link>
                  </td>
                  <td className={`mono ${c.gp_override === -1 ? "letter-neutral" : courseGradeClass(c)}`}>{fmtPct(c.percent)}</td>
                  {gpaSettings.gpa_basis !== "classes" ? <td className="mono">{c.gp_override === -1 ? "—" : c.credits}</td> : null}
                  <td>
                    <span className="course-letter-display">
                      <span className={`letter ${c.gp_override === -1 ? "letter-neutral" : courseGradeClass(c)}`}>
                        {c.letter || "—"}
                      </span>
                      {c.gp_override != null || c.pass_fail_override != null ? <span className="grade-override-marker" aria-label="Grade overridden">*</span> : null}
                    </span>
                  </td>
                  <td className={`mono ${c.gp_override != null || c.pass_fail_override != null ? "course-overridden-value" : ""}`.trim()}>{fmtGpa(c.gp_override === -1 ? null : c.gp_override ?? c.base_quality_points ?? c.natural_quality_points ?? c.quality_points)}</td>
                  {weightedGpa ? <td className={`mono ${isNeutralWeightedGp(c, c.base_quality_points ?? c.natural_quality_points ?? c.quality_points, weightedQualityPoints(c, isHighSchool)) ? "weighted-gp-neutral" : ""}`}>{fmtGpa(c.gp_override === -1 ? null : weightedQualityPoints(c, isHighSchool))}</td> : null}
                  {showScore ? (
                    <td className={`mono ${scoreClass(c.score)} ${c.gp_override != null || c.pass_fail_override != null ? "course-overridden-value" : ""}`.trim()}>{fmtScore(c.score)}</td>
                  ) : null}
                  {!isHighSchool ? <td>
                    {(() => {
                      const overrideValue = c.credit_mode === "pass_fail"
                        ? (c.pass_fail_override || "")
                        : gpSelectValue(c.gp_override, gpOptions(c));
                      return <select
                      className={`select override-select ${overrideValue === "" ? "is-none" : ""} ${overrideGradeClass(overrideValue, gpOptions(c))}`}
                      style={{ width: 118 }}
                      value={overrideValue}
                      onChange={(e) => setOverride(c.id, e.target.value)}
                      title={c.credit_mode === "pass_fail" ? "Pass/fail override — None uses the configured minimum percentages" : "GPA override — None uses percent cutoffs; N/A excludes the course"}
                    >
                      <option value="">None</option>
                      {c.credit_mode === "pass_fail" ? (
                        <>{(c.pass_fail?.rows || [{ label: c.pass_fail?.pass_label || "S" }, { label: c.pass_fail?.fail_label || "U" }]).map((row) => <option key={row.label} value={row.label}>{row.label}</option>)}</>
                      ) : (
                        <>
                          <option value="na">N/A</option>
                          {gpOptions(c).map(([letter, gp]) => (
                            <option key={letter} value={gp} className={letterClass(letter)}>
                              {letter} ({fmtGpa(gp)})
                            </option>
                          ))}
                        </>
                      )}
                      </select>;
                    })()}
                  </td> : null}
                  <td>
                      <CourseMoveMenu
                        course={c}
                        semesters={semesters}
                        isHighSchool={isHighSchool}
                        academicPeriodOptions={academicPeriodOptions}
                      classLabels={classLabels}
                      selectedLabels={selectedCourseLabels(c)}
                      onLabelsChange={(labelIds) => updateCourseLabels(c, labelIds)}
                        onMove={(semesterId) => moveCourse(c.id, semesterId)}
                        onMoveAcademicPeriod={(periodKey) => moveCourseToAcademicPeriod(c.id, periodKey)}
                      onTermOverride={(raw) => setOverride(c.id, raw)}
                      gpaWeightTags={weightedGpa ? gpaSettings.gpa_weight_tags || [] : []}
                      onGpaWeightChange={(tag) => setGpaWeight(c.id, tag)}
                      onDelete={() => removeCourse(c)}
                    />
                  </td>
                </tr>
              ))}
        </tbody>
      </table>
        )}
        {!isHighSchool ? <form className="row course-add-form" onSubmit={addCourse}>
          {classType === "named" ? <label className="course-name-field">
            <span className="muted">Course</span>
            <input className="input" placeholder="Course name" value={courseName} aria-label="Course name" onChange={(e) => setCourseName(e.target.value)} />
          </label> : <div className="course-code-box">
            <label>
              <span className="muted">Course</span>
              <input
                className="input"
                placeholder="MAE"
                value={department}
                style={{ width: `${Math.max(60, department.length * 10 + 20)}px` }}
                onChange={(e) => setDepartment(e.target.value)}
              />
            </label>
            <label>
              <span className="muted">Code</span>
              <input
                className="input"
                type="text"
                inputMode="numeric"
                placeholder="310"
                value={courseNumber}
                onChange={(e) => setCourseNumber(e.target.value.replace(/\D/g, ""))}
              />
            </label>
          </div>}
          {gpaSettings.gpa_basis !== "classes" ? <label className="course-credits-field">
            <span className="muted">Credits</span>
            <input
              className="input"
              value={credits}
              placeholder="3"
              aria-label={creditTerms.label}
              onChange={(e) => setCredits(e.target.value)}
            />
          </label> : null}
          <button className={`btn ${canAddCourse ? "primary" : ""}`.trim()} type="submit" disabled={!canAddCourse}>
            Add class
          </button>
        </form> : null}
      </div>

      <SemesterProgressChart
        semesterId={current.id}
        locked={Boolean(current.progression_locked)}
        onLock={async (nextLocked) => {
          try {
            await api.patchSemester(current.id, { progression_locked: nextLocked });
            onChange?.();
          } catch (err) {
            warning(err.message);
          }
        }}
        onToast={(message) => warning(message)}
        weightedGpa={weightedGpa}
        currentGpa={termGpa}
        currentWgpa={termWgpa}
        hasGpaOverrides={courses.some((course) => course.gp_override != null || course.pass_fail_override != null)}
      />

      <section id="exam-impact" className="panel" style={{ marginTop: 16 }}>
        <div className="tooltip-heading">
          <h2>Exam vs tests</h2>
          <Tooltip text="Pick the test and exam categories for each class. Δ is exam percent minus the test average; letter compares the course with and without the exam counting." />
        </div>
        <ExamImpactStats
          summary={{
            avg_delta: averageDelta(courses),
            letter_up: courses.filter((c) => c.exam_impact?.letter_change === "up").length,
            letter_down: courses.filter((c) => c.exam_impact?.letter_change === "down").length,
            letter_same: courses.filter((c) => c.exam_impact?.letter_change === "same").length,
          }}
        />
        <ExamImpactTable courses={courses} onPatch={patchExamCats} gradebookId={gradebookId} />
      </section>
    </>
  );
}

function averageDelta(courses) {
  const deltas = (courses || []).map((c) => c.exam_impact?.delta).filter((n) => n != null && !Number.isNaN(n));
  if (!deltas.length) return null;
  return deltas.reduce((sum, n) => sum + n, 0) / deltas.length;
}

function HighSchoolOverallView({ academicPeriodName, academicYearKey, terms, semesters, termSemesters = [], courses, termWeights = {}, overallRounding = {}, overallClasses = [], termLabel = "Semester", weightedGpa = false, gpaSettings = {}, onSelectTerm, onEditPeriodName, onDeletePeriod, onChange }) {
  const [overrides, setOverrides] = useState(() => ({}));
  const [overrideBusy, setOverrideBusy] = useState(false);
  const roundTermPercents = overallRounding.roundTermPercents === true;
  const roundOverallPercent = overallRounding.roundOverallPercent === true;
  const rows = useMemo(() => {
    const groups = new Map();
    for (const semester of semesters) {
      const seen = new Map();
      for (const course of courses.filter((item) => String(item.semester_id) === String(semester.id))) {
        const code = String(course.code || "").trim();
        const key = code.toLowerCase();
        if (!key) continue;
        const count = (seen.get(key) || 0) + 1;
        seen.set(key, count);
        const group = groups.get(key) || { code, count: 0, representative: course };
        group.count = Math.max(group.count, count);
        groups.set(key, group);
      }
    }
    return [...groups.values()]
      .flatMap((group) => Array.from({ length: group.count }, (_, occurrence) => ({
        key: `${group.code.toLowerCase()}-${occurrence}`,
        code: group.code,
        occurrence,
        label: occurrence === 0 && group.count === 1 ? group.code : `${group.code} (${occurrence + 1})`,
      })))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
  }, [courses, semesters]);
  // Use the same explicit term-to-semester mapping as the term switch. Falling
  // back to a season or array index can associate a custom term with the wrong
  // semester, which makes unchecked cells appear in the Overall table.
  const semesterForTerm = (term, index) => termSemesters[index] || semesters.find((semester) => semester.season === term.season);
  const courseFor = (row, term, index) => {
    const semester = semesterForTerm(term, index);
    const found = courses
      .filter((course) => String(course.semester_id) === String(semester?.id) && String(course.code || "").trim().toLowerCase() === row.code.toLowerCase())
      .sort((a, b) => Number(a.id) - Number(b.id))[row.occurrence];
    if (!semester?.courses?.length) return found;
    const embedded = semester.courses
      .filter((course) => String(course.code || "").trim().toLowerCase() === row.code.toLowerCase())
      .sort((a, b) => Number(a.id) - Number(b.id))[row.occurrence];
    return embedded?.percent != null || embedded?.categories?.length ? embedded : found;
  };
  const displayPercent = (value) => {
    if (value == null || Number.isNaN(Number(value))) return "—";
    const n = Number(value);
    return `${Number.isInteger(n) ? n : Number(n.toFixed(2))}%`;
  };
  const displayRatio = (value) => {
    if (value == null || Number.isNaN(Number(value))) return "—";
    return String(Number(Number(value).toFixed(3)));
  };
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
  const weightFor = (row, term, index) => {
    const existing = courseFor(row, term, index);
    if (!existing) return null;
    const included = terms.reduce((count, candidate, candidateIndex) => count + (courseFor(row, candidate, candidateIndex) ? 1 : 0), 0) || 1;
    const saved = termWeights[`${row.key}:${term.id}`];
    return saved == null ? 100 / included : Number(saved);
  };
  const rollups = rows.map((row) => {
    const termEntries = terms.map((term, index) => {
      const course = courseFor(row, term, index);
      const weight = weightFor(row, term, index);
      return course ? { course, weight } : null;
    });
    const entries = termEntries.filter(Boolean);
    const gradedEntries = entries.filter((entry) => coursePercent(entry.course) != null);
    const gradedWeight = gradedEntries.reduce((sum, entry) => sum + Number(entry.weight || 0), 0);
    const aggregatePercent = gradedWeight > 0
      ? gradedEntries.reduce((sum, entry) => sum + Number(roundPercentForCalculation(coursePercent(entry.course), roundTermPercents)) * Number(entry.weight || 0), 0) / gradedWeight
      : null;
    const calculatedPercent = aggregatePercent == null
      ? null
      : roundPercentForCalculation(aggregatePercent, roundOverallPercent);
    const representative = entries[0]?.course;
    const backendClass = overallClasses.find((item) => (
      String(item.period) === String(academicYearKey)
      && String(item.code || "").trim().toLowerCase() === row.code.toLowerCase()
      && Number(item.occurrence) === Number(row.occurrence)
    ));
    const backendGrade = backendClass?.letter
      ? { letter: backendClass.letter, quality_points: backendClass.quality_points }
      : null;
    // A high-school class's unit share is based on the terms defined for the
    // academic period, not on how many of those terms already have grades.
    // That keeps a three-term class at one full unit even when its third grade
    // has not been entered yet.
    const classCredit = terms.length ? entries.length / terms.length : null;
    // A locally selected null means the user intentionally cleared the final
    // override. Do not fall back to the stale server value in that case.
    const hasLocalOverride = Object.prototype.hasOwnProperty.call(overrides, row.key);
    const override = hasLocalOverride ? overrides[row.key] : representative?.final_gp_override ?? null;
    const overriddenGrade = override != null && override !== -1
      ? representative?.scale?.find((entry) => Number(entry.quality_points) === Number(override))
      : null;
    const grade = overriddenGrade || backendGrade || (calculatedPercent == null ? { letter: null, quality_points: null } : gradeFromPercent(calculatedPercent, representative?.scale, representative?.grade_rounding ?? null));
    const unweightedGp = override === -1 ? null : (overriddenGrade?.quality_points ?? backendClass?.quality_points ?? grade.quality_points ?? representative?.natural_quality_points ?? representative?.quality_points ?? null);
    const periodWeightBoost = Math.max(
      0,
      ...termEntries.map((entry) => Number(entry?.course?.gpa_weight_boost) || 0),
    );
    const weightedGp = unweightedGp == null ? null : (backendClass?.weighted_quality_points ?? Number(unweightedGp) + periodWeightBoost);
    const overallScore = unweightedGp == null
      ? null
      : Math.round((Number(unweightedGp) - Number(gpaSettings.target_gp ?? 4)) * 3) * Number(classCredit || 0);
    return { row, entries: termEntries, aggregatePercent: backendClass?.percent ?? backendClass?.overall_percent ?? aggregatePercent, calculatedPercent, representative, grade, unweightedGp, weightedGp, overallScore, classCredit, override };
  });
  const graded = rollups.filter((item) => item.unweightedGp != null);
  const semesterGpa = graded.length ? graded.reduce((sum, item) => sum + Number(item.unweightedGp), 0) / graded.length : null;
  const semesterWgpa = weightedGpa && graded.length ? graded.reduce((sum, item) => sum + Number(item.weightedGp), 0) / graded.length : null;
  const targetGp = Number(gpaSettings.target_gp ?? 4);
  const unweightedScore = graded.length
    ? graded.reduce((sum, item) => sum + Math.round((Number(item.unweightedGp) - targetGp) * 3) * Number(item.classCredit || 0), 0)
    : null;
  const unitBreakdown = useMemo(() => {
    const counts = new Map();
    graded.forEach((item) => {
      const units = Number(item.classCredit);
      if (!Number.isFinite(units) || units <= 0) return;
      const key = Number(units.toFixed(3)).toString();
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([units, count]) => ({ units, count }))
      .sort((a, b) => Number(b.units) - Number(a.units));
  }, [graded]);
  const unitTotal = useMemo(
    () => unitBreakdown.reduce((sum, row) => sum + Number(row.units) * row.count, 0),
    [unitBreakdown]
  );
  const gradeClass = (item) => courseGradeClass({ ...(item.representative || {}), letter: item.grade.letter || item.representative?.letter, percent: item.calculatedPercent, gp_override: null });
  async function updateOverride(item, raw) {
    setOverrideBusy(true);
    const value = raw === "na" ? -1 : raw === "" ? null : Number(raw);
    try {
      await Promise.all(item.entries.filter(Boolean).map((entry) => api.patchCourse(entry.course.id, { final_gp_override: value })));
      setOverrides((current) => ({ ...current, [item.row.key]: value }));
      await onChange?.();
    } finally {
      setOverrideBusy(false);
    }
  }

  return <>
    <div className="topbar">
      <div className="gradebook-title-row"><h1>{academicPeriodName}</h1><button type="button" className="cat-gear" aria-label={`Edit ${academicPeriodName} name`} onClick={onEditPeriodName}><span className="pencil-icon" aria-hidden="true">✎</span></button><div className="semester-term-picker header-semester-term-picker title-semester-term-picker" aria-label="Term to display"><div className="view-toggle semester-term-toggle" role="group" aria-label="Term to display">
        {terms.map((term, index) => { const semester = termSemesters[index] || semesters.find((item) => item.season === term.season); return <button key={term.id} className="btn small" type="button" onClick={() => onSelectTerm(semester?.id || `new:${term.id}`)}>{term.name}</button>; })}
        <span className="term-toggle-divider" aria-hidden="true" />
        <button className="btn small primary" type="button" aria-pressed="true">Overall</button>
      </div></div></div>
      <div className="row topbar-actions"><button className="btn danger" type="button" onClick={onDeletePeriod}>Delete Period</button></div>
    </div>
    <div className="grid-stats semester-stats high-school-semester-stats high-school-overall-stats">
      <div className="stat"><div className="label">{termLabel} GPA</div><div className="value">{fmtGpa(semesterGpa)}</div></div>
      {weightedGpa ? <div className="stat"><div className="label">{termLabel} WGPA</div><div className="value">{fmtGpa(semesterWgpa)}</div></div> : null}
      <div className="stat stat-info-hover" tabIndex={0} aria-describedby={`overall-classes-info-${academicYearKey}`}>
        <div className="label">{termLabel} Classes</div>
        <div className="value mono">{graded.length}</div>
        <p className="stat-info-hover-bubble" id={`overall-classes-info-${academicYearKey}`} role="note">
          <span>Total units: {Number(unitTotal.toFixed(3)).toString()}</span>
          {unitBreakdown.length ? unitBreakdown.map((row) => (
            <span key={row.units}>{row.units}-unit classes: {row.count}</span>
          )) : <span>No units yet</span>}
        </p>
      </div>
      <div className="stat"><div className="label">Unweighted Score</div><div className={`value ${unweightedScore == null ? "" : scoreClass(unweightedScore)}`}>{fmtScore(unweightedScore)}</div></div>
    </div>
    <section className="panel table-wrap high-school-overall-wrap">
      <table className="high-school-overall-table">
        <thead><tr><th>Class</th>{terms.map((term) => <th key={term.id}>{term.name}</th>)}<th>Overall</th><th>Final Override</th></tr></thead>
        <tbody>{rollups.map((item) => <tr key={item.row.key}>
          <th>{item.row.label}<div className="overall-class-length">{displayRatio(item.classCredit)} Units</div></th>
          {terms.map((term, index) => { const entry = item.entries[index]; return <td key={term.id}>{entry ? <><div className={`overall-cell-grade ${entry.course.gp_override === -1 ? "letter-neutral" : courseGradeClass(entry.course)}`}>{displayPercent(coursePercent(entry.course))}</div><div className="overall-cell-weight">({displayPercent(entry.weight)})</div></> : null}</td>; })}
          <td className="overall-class-summary">{item.representative ? <><div className={`overall-cell-score ${item.overallScore == null ? "muted" : scoreClass(item.overallScore)}`}>Score: {fmtScore(item.overallScore)}</div><div className={`overall-class-grade ${gradeClass(item)} ${item.override != null ? "overall-overridden-value" : ""}`}><span>{item.grade.letter || "—"}</span> <span className="mono overall-class-unweighted-gp">{fmtGpa(item.unweightedGp)}</span></div>{weightedGpa ? <div className={`overall-weighted-gp ${isNeutralWeightedGp(item.representative, item.unweightedGp, item.weightedGp) ? "weighted-gp-neutral" : ""} ${item.override != null ? "overall-overridden-value" : ""}`}>WGP: {fmtGpa(item.weightedGp)}</div> : null}</> : null}</td>
          <td className="overall-class-override">{item.representative ? <select className={`select override-select ${item.override == null ? "is-none" : ""} ${overrideGradeClass(item.override == null ? "" : item.override === -1 ? "na" : String(item.override), gpOptions(item.representative))}`} value={item.override == null ? "" : item.override === -1 ? "na" : String(item.override)} aria-label={`${item.row.label} final override`} onChange={(event) => updateOverride(item, event.target.value)}><option value="">None</option><option value="na">N/A</option>{gpOptions(item.representative).map(([letter, gp]) => <option key={letter} value={gp} className={letterClass(letter)}>{letter} ({fmtGpa(gp)})</option>)}</select> : null}</td>
         </tr>)}{!rollups.length ? <tr><td colSpan={terms.length + 3} className="muted">No classes in this academic period yet.</td></tr> : null}</tbody>
      </table>
    </section>
  </>;
}

function AcademicPeriodNameModal({ name, onClose, onSave }) {
  const [draft, setDraft] = useState(name || "");

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <form className="modal-panel" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); const next = draft.trim(); if (next) onSave(next); }} role="dialog" aria-modal="true" aria-labelledby="academic-period-name-title">
        <h2 id="academic-period-name-title">Edit academic period name</h2>
        <label className="muted">Name<input className="input" value={draft} autoFocus onChange={(event) => setDraft(event.target.value)} /></label>
        <div className="modal-actions"><span /><div className="row"><button className="btn" type="button" onClick={onClose}>Cancel</button><button className="btn primary" type="submit">Save name</button></div></div>
      </form>
    </div>,
    document.body,
  );
}

function InlineClassNameInput({ row, disabled = false, onSave }) {
  const [draft, setDraft] = useState(row.code || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(row.code || "");
  }, [row.key, row.code]);

  async function commit() {
    const next = draft.trim();
    const current = String(row.code || "").trim();
    if (!next || next === current || saving) {
      setDraft(current);
      return;
    }
    setSaving(true);
    try {
      const saved = await onSave?.(row, next);
      setDraft(saved === false ? current : next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      className="high-school-class-name-input"
      value={draft}
      disabled={disabled || saving}
      aria-label={`Class name for ${row.label}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft((current) => String(row.code || current));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function HighSchoolTermsModal({ academicPeriods = [], terms, semesters, courses, classLabels = [], courseLabels = {}, onClassLabelsChange, currentSemesterId, academicYearKey, periodName, classType = "alphanumeric", matrixMode: requestedMatrixMode = "terms", weightedGpa = false, gpaWeightTags = [], onGpaWeightChange, termWeights = {}, onTermWeightsChange, onPeriodNameChange, onTermsChange, onChange, onClose, onSemesterCreated, modeToggle = null, page = false, showModeToggle = true }) {
  const { push, warning } = useToasts();
  const [newClass, setNewClass] = useState("");
  const [newClassDepartment, setNewClassDepartment] = useState("");
  const [newClassNumber, setNewClassNumber] = useState("");
  const [periodDraft, setPeriodDraft] = useState(periodName || "");
  const [busy, setBusy] = useState(false);
  const [matrixMode, setMatrixMode] = useState(requestedMatrixMode);
  const [editClasses, setEditClasses] = useState(!page || !showModeToggle);
  const [weights, setWeights] = useState(termWeights);
  const [termNameDrafts, setTermNameDrafts] = useState(() => Object.fromEntries(terms.map((term) => [term.id, term.name])));
  const termNameBeforeEdit = useRef({});
  useEffect(() => {
    setMatrixMode(requestedMatrixMode);
  }, [requestedMatrixMode]);
  useEffect(() => {
    setTermNameDrafts((current) => {
      const next = {};
      terms.forEach((term) => {
        next[term.id] = Object.prototype.hasOwnProperty.call(current, term.id) ? current[term.id] : term.name;
      });
      return next;
    });
  }, [terms]);
  const termForSemester = (semester) => terms.find((term) => term.season === semester.season);
  const semesterForTerm = (term) => semesters.find((semester) => semester.season === term.season);
  const rows = useMemo(() => {
    const groups = new Map();
    for (const semester of semesters) {
      const seenInTerm = new Map();
      for (const course of courses.filter((item) => item.semester_id === semester.id)) {
        const key = String(course.code || "").trim().toLowerCase();
        const current = groups.get(key) || { code: String(course.code || "").trim(), count: 0, representative: course };
        const termCount = (seenInTerm.get(key) || 0) + 1;
        seenInTerm.set(key, termCount);
        current.count = Math.max(current.count, termCount);
        current.representative = current.representative || course;
        groups.set(key, current);
      }
    }
    return [...groups.values()]
      .flatMap((group) => Array.from({ length: group.count }, (_, index) => ({
        key: `${group.code.toLowerCase()}-${index}`,
        code: group.code,
        occurrence: index,
        label: index === 0 && group.count === 1 ? group.code : `${group.code} (${index + 1})`,
      })))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
  }, [courses, semesters]);
  const classColumnChars = useMemo(
    () => Math.min(30, Math.max(5, ...rows.map((row) => String(row.label || "").length))),
    [rows]
  );

  const coursesForRow = (row) => semesters.flatMap((semester) => {
    const matches = courses
      .filter((course) => course.semester_id === semester.id && String(course.code || "").trim().toLowerCase() === row.code.toLowerCase())
      .sort((a, b) => Number(a.id) - Number(b.id));
    return matches[row.occurrence] ? [matches[row.occurrence]] : [];
  });

  function classWeightValue(row) {
    const boostByTag = new Map(gpaWeightTags.map((tag) => [String(tag.id), Number(tag.boost) || 0]));
    return coursesForRow(row)
      .sort((a, b) => (
        (boostByTag.get(String(b.gpa_weight_tag || "unweighted")) || 0)
        - (boostByTag.get(String(a.gpa_weight_tag || "unweighted")) || 0)
      ))
      .map((course) => course.gpa_weight_tag || "unweighted")[0] || "unweighted";
  }

  function classLabelIds(row) {
    return [...new Set(coursesForRow(row).flatMap((course) => courseLabels?.[String(course.id)] || []))];
  }

  async function renameClass(row, name) {
    const course = coursesForRow(row)[0];
    if (!course) return false;
    setBusy(true);
    try {
      await api.patchCourse(course.id, { code: name });
      await onChange?.();
      return true;
    } catch (err) {
      warning(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function updateClassWeight(row, value) {
    const course = coursesForRow(row)[0];
    if (!course || !onGpaWeightChange) return;
    setBusy(true);
    try {
      await onGpaWeightChange(course.id, value);
    } catch (err) {
      warning(err.message);
    } finally {
      setBusy(false);
    }
  }

  function moveTerm(index, direction) {
    const next = [...terms];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    applyTermChange(next);
  }

  function reorderTerm(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= terms.length || toIndex >= terms.length) return;
    const next = [...terms];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    applyTermChange(next);
  }

  function addTerm() {
    const id = `term-${Date.now()}`;
    const usedNames = new Set(terms.map((term) => normalizedName(term.name)));
    let nextNumber = terms.length + 1;
    while (usedNames.has(`term ${nextNumber}`)) nextNumber += 1;
    applyTermChange([...terms, { id, season: id, name: `Term ${nextNumber}` }]);
  }

  function requestDeleteTerm(term) {
    const semester = semesterForTerm(term);
    push({
      id: `delete-term-${academicYearKey}-${term.id}`,
      type: "persistent",
      title: "Delete term?",
      message: `Delete ${term.name} and its classes? This can not be undone.`,
      confirmLabel: "Delete term",
      onConfirm: async () => {
        setBusy(true);
        try {
          if (semester) await api.deleteSemester(semester.id);
          onTermsChange(terms.filter((item) => item.id !== term.id));
          await onChange();
        } catch (err) {
          warning(err.message);
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function applyTermChange(next) {
    const seen = new Set();
    const reserved = next.some((term) => RESERVED_TERM_NAMES.has(normalizedName(term.name)));
    if (reserved) {
      warning("Term names can not be Settings or Overall.");
      return;
    }
    const duplicate = next.find((term) => {
      const name = normalizedName(term.name);
      if (!name) return false;
      if (seen.has(name)) return true;
      seen.add(name);
      return false;
    });
    if (duplicate) {
      warning("Term names must be unique within an academic period.");
      return;
    }
    onTermsChange(next);
  }

  function editTermName(term, name) {
    setTermNameDrafts((current) => ({ ...current, [term.id]: name }));
  }

  function finishTermNameEdit(term, name) {
    const previous = termNameBeforeEdit.current[term.id] || term.name || "Term";
    const trimmed = name.trim();
    if (!trimmed || RESERVED_TERM_NAMES.has(normalizedName(trimmed)) || terms.some((item) => item.id !== term.id && normalizedName(item.name) === normalizedName(trimmed))) {
      if (RESERVED_TERM_NAMES.has(normalizedName(trimmed)) || terms.some((item) => item.id !== term.id && normalizedName(item.name) === normalizedName(trimmed))) warning("Term names must be unique and can not be Settings or Overall.");
      setTermNameDrafts((current) => ({ ...current, [term.id]: previous }));
      return;
    }
    setTermNameDrafts((current) => ({ ...current, [term.id]: trimmed }));
    if (trimmed !== term.name) onTermsChange(terms.map((item) => item.id === term.id ? { ...item, name: trimmed } : item));
  }

  function savePeriodName() {
    const fallback = `${academicYearKey}–${String(Number(academicYearKey) + 1).slice(-2)}`;
    const next = periodDraft.trim() || fallback;
    const duplicate = academicPeriods.some((period) => String(period.key) !== String(academicYearKey) && normalizedName(period.label) === normalizedName(next));
    if (duplicate) {
      warning("Academic period names must be unique.");
      setPeriodDraft(periodName || fallback);
      return;
    }
    setPeriodDraft(next);
    onPeriodNameChange?.(next);
  }

  async function ensureSemester(term) {
    const existing = semesterForTerm(term);
    if (existing) return existing;
    const start = Number(academicYearKey) || new Date().getFullYear();
    const year = ["spring", "summer"].includes(term.season) ? start + 1 : start;
    const created = await api.createSemester({ year, season: term.season, included: true });
    await onSemesterCreated?.(created);
    return created;
  }

  async function toggleCourse(term, row, checked) {
    setBusy(true);
    try {
      let semester = await ensureSemester(term);
      if (!semester) return;
      const matching = courses.filter((course) => course.semester_id === semester.id && String(course.code || "").trim().toLowerCase() === row.code.toLowerCase());
      const existing = matching[row.occurrence];
      if (checked && !existing) {
        await api.createCourse({ semester_id: semester.id, code: row.code, credits: 3, bonus_mode: "none" });
      } else if (!checked && existing) {
        await api.deleteCourse(existing.id);
      }
      await onChange();
    } catch (err) {
      warning(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addClass(event) {
    event.preventDefault();
    const code = classType === "alphanumeric"
      ? [newClassDepartment.trim(), newClassNumber.trim()].filter(Boolean).join(" ")
      : newClass.trim();
    if (!code) return;
    setBusy(true);
    try {
      const targetTerm = terms[0];
      const semester = targetTerm ? await ensureSemester(targetTerm) : semesters.find((item) => String(item.id) === String(currentSemesterId));
      if (!semester) return;
      await api.createCourse({ semester_id: semester.id, code, credits: 3, bonus_mode: "none" });
      setNewClass("");
      setNewClassDepartment("");
      setNewClassNumber("");
      await onChange();
    } catch (err) {
      warning(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeClassRow(row) {
    push({
      id: `delete-class-${academicYearKey}-${row.key}`,
      type: "persistent",
      title: "Remove class?",
      message: `Remove ${row.label} from this academic period? This removes the class and its grades from every term where it is present.`,
      confirmLabel: "Remove class",
      onConfirm: async () => {
        setBusy(true);
        try {
          const matches = semesters.flatMap((semester) => courses
            .filter((course) => course.semester_id === semester.id && String(course.code || "").trim().toLowerCase() === row.code.toLowerCase())
            .sort((a, b) => Number(a.id) - Number(b.id))
          );
          const targets = semesters.flatMap((semester) => courses
            .filter((course) => course.semester_id === semester.id && String(course.code || "").trim().toLowerCase() === row.code.toLowerCase())
            .sort((a, b) => Number(a.id) - Number(b.id))
            .slice(row.occurrence, row.occurrence + 1)
          );
          if (matches.length && targets.length) await Promise.all(targets.map((course) => api.deleteCourse(course.id)));
          await onChange();
          window.dispatchEvent(new Event("grade-snapshots-updated"));
        } catch (err) {
          warning(err.message);
        } finally {
          setBusy(false);
        }
      },
    });
  }

  const classWeightTable = (
    <div className="high-school-class-weight-editor">
      {gpaWeightTags.length ? (
        <table className="high-school-class-weight-matrix">
          <thead><tr><th>Class</th><th>Class Labels</th><th>WGPA Weight</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const course = coursesForRow(row)[0];
              return <tr key={row.key}>
                <th><InlineClassNameInput row={row} disabled={busy} onSave={renameClass} /></th>
                <td>
                  {course ? <ClassLabelPicker
                    course={course}
                    classLabels={classLabels}
                    selectedLabels={classLabelIds(row)}
                    onLabelsChange={(labelIds) => onClassLabelsChange?.(course, labelIds)}
                  /> : null}
                </td>
                <td>
                  <select
                    className="select"
                    value={classWeightValue(row)}
                    disabled={busy || !course}
                    aria-label={`WGPA Weight for ${row.label}`}
                    onChange={(event) => updateClassWeight(row, event.target.value)}
                  >
                    {gpaWeightTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}{Number(tag.boost) ? ` (+${tag.boost})` : ""}</option>)}
                  </select>
                </td>
              </tr>;
            })}
            {!rows.length ? <tr><td colSpan={3} className="muted">No classes in this academic year yet.</td></tr> : null}
          </tbody>
        </table>
      ) : <p className="muted">No WGPA weights are configured.</p>}
    </div>
  );

  const content = (
        <div className={page ? "panel high-school-terms-page" : "modal-panel high-school-terms-modal"} onClick={(event) => event.stopPropagation()} role={page ? undefined : "dialog"} aria-modal={page ? undefined : "true"} aria-label="Term settings">
        {!page ? <div className="row modal-heading-row modal-heading-actions"><span /><button className="btn small" type="button" onClick={onClose}>Done</button></div> : null}
        {modeToggle}
        <div className="high-school-class-matrix-wrap">
           <div className="row modal-heading-row"><div>{!showModeToggle ? <p className="muted">{matrixMode === "classWeights" ? "Assign the WGPA weight used for each class." : "Checked cells indicate that the class was taken in that term. Leftmost columns occur first in the academic year. Adjust the weight of a class&apos;s grade for each term, affecting how the final grade is calculated."}</p> : null}</div>{showModeToggle ? <div className="view-toggle" role="group" aria-label="Class list mode"><button className={`btn small ${!editClasses ? "primary" : ""}`} type="button" onClick={() => setEditClasses(false)}>Class List</button><button className={`btn small ${editClasses ? "primary" : ""}`} type="button" onClick={() => setEditClasses(true)}>Edit Classes</button></div> : null}</div>
           {matrixMode === "classWeights" ? classWeightTable : showModeToggle && !editClasses ? <div className="high-school-class-list">{rows.length ? rows.map((row) => <div className="high-school-class-list-row" key={row.key}>{row.label}</div>) : <p className="muted">No classes in this academic period yet.</p>}</div> : <>
           {showModeToggle ? <div className="high-school-class-matrix-heading"><h3>Classes by term</h3><p className="muted">Checked cells indicate that the class was taken in that term. Leftmost columns occur first in the academic year.</p></div> : null}
           <table className="high-school-class-matrix" style={{ "--term-count": terms.length, "--class-column-chars": classColumnChars }}>
            <thead><tr><th>Class</th>{terms.map((term, index) => { const draftName = termNameDrafts[term.id] ?? term.name; return <th key={term.id} className="high-school-term-header"><div className="high-school-term-header-content"><button className="high-school-term-delete" type="button" aria-label={`Delete ${term.name} term`} disabled={busy} onClick={() => requestDeleteTerm(term)}>×</button><input className="high-school-term-header-input" style={{ width: `${Math.max(3, String(draftName || "").length)}ch` }} value={draftName} aria-label={`${term.name} term name`} onFocus={() => { termNameBeforeEdit.current[term.id] = termNameDrafts[term.id] ?? term.name; }} onChange={(event) => editTermName(term, event.target.value)} onBlur={(event) => finishTermNameEdit(term, event.target.value)} /><button className="high-school-term-drag" type="button" aria-label={`Move ${term.name} right`} disabled={index === terms.length - 1} onClick={() => reorderTerm(index, index + 1)}>→</button></div></th>; })}<th className="high-school-term-add-header"><div className="high-school-term-add-control"><span className="high-school-term-add-label">Add Term</span><button className="btn small" type="button" aria-label="Add term" onClick={addTerm}>+</button></div></th></tr></thead>
            <tbody>
              {rows.map((row) => <tr key={row.key}>
                 <th><InlineClassNameInput row={row} disabled={busy} onSave={renameClass} /></th>
                {terms.map((term) => {
                  const semester = semesterForTerm(term);
                  const matching = courses.filter((course) => course.semester_id === semester?.id && String(course.code || "").trim().toLowerCase() === row.code.toLowerCase());
                  if (matrixMode === "weights") {
                    const includedTerms = terms.filter((candidate) => {
                      const candidateSemester = semesterForTerm(candidate);
                      return courses.filter((item) => item.semester_id === candidateSemester?.id && String(item.code || "").trim().toLowerCase() === row.code.toLowerCase()).length > row.occurrence;
                    }).length || 1;
                    const key = `${row.key}:${term.id}`;
                    const saved = weights[key];
                    const initial = saved != null ? Number(saved) : 100 / includedTerms;
                    const formatWeight = (value) => Number.isInteger(Number(value)) ? String(Number(value)) : Number(Number(value).toFixed(2)).toString();
                    return <td key={term.id}>{matching[row.occurrence] ? <input className="term-weight-input" inputMode="decimal" placeholder="%" defaultValue={`${formatWeight(initial)}%`} onFocus={(event) => { event.target.value = event.target.value.replace(/%$/, ""); }} onBlur={(event) => { const value = event.target.value.replace(/%$/, "").trim(); const next = { ...weights }; if (value && Number.isFinite(Number(value))) { const precise = Math.min(100, Math.max(0, Number(Number(value).toFixed(5)))); next[key] = precise; event.target.value = `${formatWeight(precise)}%`; } setWeights(next); onTermWeightsChange?.(next); }} aria-label={`${row.label} weight in ${term.name}`} /> : null}</td>;
                  }
                  return <td key={term.id}><input type="checkbox" checked={Boolean(matching[row.occurrence])} disabled={busy} aria-label={`${row.label} taken in ${term.name}`} onChange={(event) => toggleCourse(term, row, event.target.checked)} /></td>;
                })}
                <td><button className="btn small danger matrix-remove" type="button" disabled={busy} aria-label={`Remove ${row.label}`} onClick={() => removeClassRow(row)}>×</button></td>
              </tr>)}
              {!rows.length ? <tr><td colSpan={terms.length + 2} className="muted">No classes in this academic year yet.</td></tr> : null}
            </tbody>
          </table>
          <form className="high-school-class-add" onSubmit={addClass}>
            {classType === "alphanumeric" ? <div className="course-code-box">
              <label><span className="muted">Course</span><input className="input" value={newClassDepartment} placeholder="MAE" aria-label="Course" onChange={(event) => setNewClassDepartment(event.target.value)} /></label>
              <label><span className="muted">Code</span><input className="input" value={newClassNumber} placeholder="310" aria-label="Code" onChange={(event) => setNewClassNumber(event.target.value.replace(/\D/g, ""))} /></label>
            </div> : <input className="input" value={newClass} placeholder="Add a class (e.g. Algebra II)" aria-label="New class" onChange={(event) => setNewClass(event.target.value)} />}
            <button className="btn small" type="submit" disabled={busy || (classType === "alphanumeric" ? !newClassDepartment.trim() || !newClassNumber.trim() : !newClass.trim())}>Add class</button>
          </form>
          </>}
        </div>
      </div>
  );
  if (page) return content;
  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">{content}</div>,
    document.body,
  );
}

function SemesterSettingsModal({ year, season, error, onYear, onSeason, onClose, onSubmit }) {
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <form
        className="modal-panel"
        onClick={(event) => event.stopPropagation()}
        onSubmit={onSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="semester-settings-title"
      >
        <h2 id="semester-settings-title">Semester settings</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Change the year or term to rename this semester (for example 2025 Spring).
        </p>
        <div className="modal-fields">
          <label className="muted">
            Year
            <input
              className="input"
              type="number"
              min="2000"
              max="2100"
              value={year}
              onChange={(event) => onYear(event.target.value)}
              autoFocus
            />
          </label>
          <label className="muted">
            Term
            <select className="select" value={season} onChange={(event) => onSeason(event.target.value)}>
              {SEASONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="modal-actions">
          <span />
          <div className="row">
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" type="submit">
              Save name
            </button>
          </div>
        </div>
      </form>
    </div>,
    document.body
  );
}

function ClassLabelPicker({ course, classLabels, selectedLabels, onLabelsChange }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, ready: false });
  const pickerRef = useRef(null);
  const buttonRef = useRef(null);
  const popoverRef = useRef(null);
  const selected = new Set(selectedLabels.map(String));
  const selectedNames = classLabels.filter((label) => selected.has(String(label.id))).map((label) => label.name);

  useLayoutEffect(() => {
    if (!open) return undefined;
    function place() {
      const button = buttonRef.current;
      const popover = popoverRef.current;
      if (!button || !popover) return;
      const rect = button.getBoundingClientRect();
      const width = popover.offsetWidth;
      const height = popover.offsetHeight;
      const gap = 8;
      const pad = 8;
      const left = Math.min(
        Math.max(pad, rect.right - width),
        window.innerWidth - width - pad
      );
      const top = Math.min(rect.bottom + gap, window.innerHeight - height - pad);
      setCoords({ top, left: Math.max(pad, left), ready: true });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function closePicker(event) {
      if (pickerRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closePicker);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closePicker);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="kebab-label-picker">
      <span className="kebab-label-caption">Class Labels:</span>
      <button
        className="kebab-item kebab-label-trigger"
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Class Labels: ${selectedNames.length ? selectedNames.join(", ") : "None"}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <span className="kebab-label-value">{selectedNames.length ? selectedNames.join(", ") : "None"}</span>
        <span className="kebab-label-arrow" aria-hidden="true" />
      </button>
      {open ? (
        createPortal(
          <div
            className="kebab-label-popover"
            role="listbox"
            aria-label={`Class Labels for ${course.code}`}
            ref={popoverRef}
            style={{ top: coords.top, left: coords.left, visibility: coords.ready ? "visible" : "hidden" }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {classLabels.map((label) => (
              <label className="kebab-label-option" key={label.id}>
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
          </div>,
          document.body
        )
      ) : null}
    </div>
  );
}

function CourseMoveMenu({ course, semesters, isHighSchool = false, academicPeriodOptions = [], classLabels = [], selectedLabels = [], onLabelsChange, onMove, onMoveAcademicPeriod, onTermOverride, gpaWeightTags = [], onGpaWeightChange, onDelete }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, ready: false });
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const others = semesters.filter((s) => s.id !== course.semester_id);
  const currentPeriodKey = hsAcademicYearKey(semesters.find((item) => String(item.id) === String(course.semester_id)));

  useLayoutEffect(() => {
    if (!open) return;

    function place() {
      const btn = wrapRef.current?.querySelector("button");
      const menu = menuRef.current;
      if (!btn || !menu) return;
      const rect = btn.getBoundingClientRect();
      const menuWidth = menu.offsetWidth;
      const menuHeight = menu.offsetHeight;
      const gap = 4;
      const pad = 8;
      const openUp = rect.bottom + gap + menuHeight > window.innerHeight - pad && rect.top > menuHeight + gap + pad;
      const top = openUp
        ? Math.max(pad, rect.top - menuHeight - gap)
        : Math.min(window.innerHeight - menuHeight - pad, rect.bottom + gap);
      const left = Math.min(
        Math.max(pad, rect.right - menuWidth),
        window.innerWidth - menuWidth - pad
      );
      setCoords({ top, left, ready: true });
    }

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, others.length]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event) {
      if (wrapRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="kebab-wrap" ref={wrapRef}>
      <button
        className="btn small kebab-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setCoords({ top: 0, left: 0, ready: false });
          setOpen((v) => !v);
        }}
      >
        ⋮
      </button>
      {open
        ? createPortal(
            <div
              className="kebab-menu"
              role="menu"
              ref={menuRef}
              style={{ top: coords.top, left: coords.left, visibility: coords.ready ? "visible" : "hidden" }}
            >
              {isHighSchool ? (
                <label className="kebab-item kebab-move-control">
                  <span>Move to:</span>
                  <select
                    className="select kebab-select"
                    defaultValue=""
                    aria-label="Move course to academic period"
                    onChange={(event) => {
                      const periodKey = event.target.value;
                      if (!periodKey) return;
                      setOpen(false);
                      onMoveAcademicPeriod?.(periodKey);
                    }}
                  >
                    <option value="" disabled>Select Period</option>
                    {academicPeriodOptions.filter((period) => String(period.key) !== String(currentPeriodKey)).map((period) => (
                      <option key={period.key} value={period.key}>{period.label}</option>
                    ))}
                  </select>
                </label>
              ) : others.length ? (
                <label className="kebab-item kebab-move-control">
                  <span>Move to:</span>
                  <select
                    className="select kebab-select"
                    defaultValue=""
                    aria-label="Move course to semester"
                    onChange={(event) => {
                      const semesterId = event.target.value;
                      if (!semesterId) return;
                      setOpen(false);
                      onMove(semesterId);
                    }}
                  >
                    <option value="" disabled>Select semester</option>
                    {others.map((sem) => (
                      <option key={sem.id} value={sem.id}>{sem.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="kebab-item muted">No other semesters</div>
              )}
              {isHighSchool ? (
                <label className="kebab-item kebab-move-control">
                  <span>Term Override:</span>
                  <select
                    className={`select kebab-select override-select ${course.credit_mode === "pass_fail" ? "" : gpSelectValue(course.gp_override, gpOptions(course)) === "" ? "is-none" : ""}`}
                    value={course.credit_mode === "pass_fail" ? (course.pass_fail_override || "") : gpSelectValue(course.gp_override, gpOptions(course))}
                    aria-label={`Term override for ${course.code || "class"}`}
                    onChange={(event) => {
                      setOpen(false);
                      onTermOverride?.(event.target.value);
                    }}
                  >
                    <option value="">None</option>
                    {course.credit_mode === "pass_fail" ? (
                      (course.pass_fail?.rows || [{ label: course.pass_fail?.pass_label || "S" }, { label: course.pass_fail?.fail_label || "U" }]).map((row) => <option key={row.label} value={row.label}>{row.label}</option>)
                    ) : (
                      <>
                        <option value="na">N/A</option>
                        {gpOptions(course).map(([letter, gp]) => <option key={letter} value={gp} className={letterClass(letter)}>{letter} ({fmtGpa(gp)})</option>)}
                      </>
                    )}
                  </select>
                </label>
              ) : null}
              {classLabels.length ? (
                <ClassLabelPicker
                  course={course}
                  classLabels={classLabels}
                  selectedLabels={selectedLabels}
                  onLabelsChange={onLabelsChange}
                />
              ) : null}
              {gpaWeightTags.length ? (
                <label className="kebab-item kebab-gpa-weight-control">
                  <span>GPA Weight:</span>
                  <select
                    className="select kebab-select"
                    value={course.gpa_weight_tag || "unweighted"}
                    aria-label={`GPA Weight for ${course.code || "class"}`}
                    onChange={(event) => {
                      setOpen(false);
                      onGpaWeightChange?.(event.target.value);
                    }}
                  >
                    {gpaWeightTags.map((tag) => (
                      <option key={tag.id} value={tag.id}>{tag.name}{Number(tag.boost) ? ` (+${tag.boost})` : ""}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button
                className="kebab-item danger"
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onDelete();
                }}
              >
                Remove from term
              </button>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
