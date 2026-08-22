import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  assignmentPercent,
  defaultExamCategoryId,
  examNeededRows,
  fmtGpa,
  fmtPct,
  fmtScore,
  gradeFromPercent,
  letterClass,
  letterFromPercent,
  projectPercentFromExam,
  scoreClass,
  trueGradeFromCourse,
} from "./api";
import { ScaleRowsEditor } from "./ScaleEditor.jsx";
import { useCreditTerms, useShowScore } from "./creditLabel.jsx";

const DEFAULT_AGG_OPTIONS = [
  ["average", "Average"],
  ["points_ratio", "Points ratio"],
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

function fmtWeightPct(weight) {
  if (weight == null || Number.isNaN(weight)) return "—";
  const pct = Number((weight * 100).toPrecision(12));
  if (Number.isInteger(pct)) return String(pct);
  return String(pct);
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
    includeBonus: !!cat?.include_bonus,
    replaceWithCategoryId: cat?.replace_with_category_id ? String(cat.replace_with_category_id) : "",
  };
}

function draftToPayload(draft) {
  const pct = Number(draft.weightPct);
  const weightValue = Number.isFinite(pct) ? pct / 100 : 0;
  const drop = Number(draft.dropCount);
  const perItem = draft.weightMode === "per_item";
  return {
    name: draft.name.trim(),
    weight: perItem ? 0 : weightValue,
    weight_per_item: perItem ? weightValue : null,
    aggregation: draft.aggregation,
    drop_count: Number.isFinite(drop) && drop >= 0 ? Math.floor(drop) : 0,
    include_bonus: !!draft.includeBonus,
    replace_with_category_id: draft.replaceWithCategoryId ? Number(draft.replaceWithCategoryId) : null,
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
  if (course?.gp_override == null) return false;
  return (
    valuesDiffer(course.letter, trueGrade.letter)
    || valuesDiffer(course.quality_points, trueGrade.qualityPoints)
    || valuesDiffer(course.score, trueGrade.score)
  );
}

function GradeHeroMeta({ letter, qualityPoints, score, showScore, struck = false, overrideLabel = false }) {
  return (
    <div className={`grade-hero-meta ${struck ? "is-struck" : ""}`}>
      <span className={`letter letter-hero-circle ${struck ? "is-struck-letter" : letterClass(letter)}`}>
        {letter || "—"}
      </span>
      <div className="grade-hero-gp-score">
        <span className="mono grade-hero-gpa">{fmtGpa(qualityPoints)}</span>
        {showScore ? (
          <span className={`grade-hero-score ${struck ? "" : scoreClass(score)}`}>
            Score: <span className="mono">{fmtScore(score)}</span>
          </span>
        ) : null}
        {overrideLabel ? <span className="grade-hero-override-label">Override</span> : null}
      </div>
    </div>
  );
}

export default function Gradebook({ onChange, colorAssignmentGrades = true }) {
  const creditTerms = useCreditTerms();
  const showScore = useShowScore();
  const { id } = useParams();
  const navigate = useNavigate();
  const [course, setCourse] = useState(null);
  const [semesters, setSemesters] = useState([]);
  const [error, setError] = useState("");
  const [showScale, setShowScale] = useState(false);
  const [showDynamic, setShowDynamic] = useState(false);
  const [showExamCalc, setShowExamCalc] = useState(false);
  const [openCats, setOpenCats] = useState({});
  const [profiles, setProfiles] = useState([]);
  const [aggOptions, setAggOptions] = useState(DEFAULT_AGG_OPTIONS);
  const [categoryModal, setCategoryModal] = useState(null);
  const [dragCatId, setDragCatId] = useState(null);
  const dragCatIdRef = useRef(null);
  const dragStartOrderRef = useRef(null);
  const categoriesRef = useRef([]);

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
    const [c, s, m] = await Promise.all([api.course(id), api.semesters(), api.meta()]);
    setCourse(c);
    setSemesters(s);
    setProfiles(m.scale_profiles || []);
    const ids = Array.isArray(m.aggregations) && m.aggregations.length ? m.aggregations : ["average", "points_ratio"];
    const labels = m.aggregation_labels || {};
    setAggOptions(ids.map((aggId) => [aggId, labels[aggId] || aggId]));
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [id]);

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
    setCourse(await api.patchCourse(id, patch));
    onChange?.();
  }

  async function saveCategorySettings(payload) {
    const next =
      categoryModal?.mode === "edit" && categoryModal.cat
        ? await api.patchCategory(categoryModal.cat.id, payload)
        : await api.createCategory({ course_id: Number(id), ...payload });
    setCourse(next);
    onChange?.();
    setCategoryModal(null);
  }

  async function deleteCategoryFromModal() {
    if (!categoryModal?.cat) return;
    const next = await api.deleteCategory(categoryModal.cat.id);
    setCourse(next);
    onChange?.();
    setCategoryModal(null);
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
    const ids = new Set(course.categories.map((c) => c.id));
    if (examCatId === undefined) {
      setExamCatId(defaultExamCategoryId(course.categories));
      return;
    }
    if (examCatId != null && !ids.has(examCatId)) {
      setExamCatId(null);
    }
  }, [course, examCatId]);

  if (!course) return <p className="muted">{error || "Loading…"}</p>;

  const trueGrade = trueGradeFromCourse(course);
  const hasOverride = courseHasOverride(course, trueGrade);
  const pctLetter = trueGrade.letter || course.letter;

  return (
    <>
      <div className="gradebook-header">
        <div className="gradebook-header-title">
          <p className="muted">
            <Link to={`/courses?semester=${course.semester_id}`}>
              {semesters.find((s) => s.id === course.semester_id)?.name || "Semester"}
            </Link>{" "}
            / {course.code}
          </p>
          <div className="gradebook-title-row">
            <h1>{course.code}</h1>
            <div className="grade-hero">
              {hasOverride ? (
                <>
                  <GradeHeroMeta
                    letter={trueGrade.letter}
                    qualityPoints={trueGrade.qualityPoints}
                    score={trueGrade.score}
                    showScore={showScore}
                    struck
                  />
                  <GradeHeroMeta
                    letter={course.letter}
                    qualityPoints={course.quality_points}
                    score={course.score}
                    showScore={showScore}
                    overrideLabel
                  />
                </>
              ) : (
                <GradeHeroMeta
                  letter={course.letter}
                  qualityPoints={course.quality_points}
                  score={course.score}
                  showScore={showScore}
                />
              )}
              <strong className={`mono grade-hero-pct ${letterClass(pctLetter)}`}>
                {fmtPct(course.percent)}%
              </strong>
            </div>
          </div>
        </div>

        <div className="gradebook-header-toolbar">
          <div className="panel row course-settings">
            <label className="muted course-settings-class">
              <span>Class</span>
              <span className="course-settings-class-sizer" aria-hidden="true">
                MMMMMMMMM
              </span>
              <input
                className="input"
                maxLength={8}
                defaultValue={course.code}
                onBlur={(e) => saveCourse({ code: e.target.value })}
              />
            </label>
            <label className="muted course-settings-credit">
              {creditTerms.singularLabel}
              <input
                className="input"
                defaultValue={course.credits}
                onBlur={(e) => saveCourse({ credits: Number(e.target.value) })}
              />
            </label>
            <label className="muted course-settings-bonus">
              Overall Bonus
              <input
                className="input"
                defaultValue={course.bonus_points}
                onBlur={(e) => saveCourse({ bonus_points: Number(e.target.value) })}
              />
            </label>
            <label className="muted course-settings-grading">
              <span>Grading</span>
              <span className="course-settings-class-sizer" aria-hidden="true">
                Weighted Categories
              </span>
              <select
                className="select"
                value={course.grading_mode === "points" ? "points" : "weighted"}
                onChange={(e) => {
                  const mode = e.target.value;
                  if (mode === "points") setShowDynamic(false);
                  saveCourse({ grading_mode: mode });
                }}
              >
                <option value="weighted">Weighted Categories</option>
                <option value="points">Points Based</option>
              </select>
            </label>
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
                Dynamic Weighting
              </button>
              )}
              <button
                className="btn danger course-settings-delete"
                type="button"
                onClick={async () => {
                  if (!window.confirm("Delete this class?")) return;
                  await api.deleteCourse(course.id);
                  onChange?.();
                  navigate(`/courses?semester=${course.semester_id}`);
                }}
              >
                Delete class
              </button>
            </div>
          </div>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {showScale ? (
        <ScaleEditor
          course={course}
          profiles={profiles}
          onSave={async (rows) => {
            try {
              setCourse(await api.updateScale(course.id, rows));
              setError("");
            } catch (err) {
              setError(err.message);
            }
          }}
          onApply={async (profileId) => {
            try {
              setCourse(await api.resetScale(course.id, profileId));
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
          {course.categories.map((cat) => (
            <CategoryCard
              key={cat.id}
              cat={cat}
              scale={course.scale}
              colorAssignmentGrades={colorAssignmentGrades}
              weightsLocked={!!course.dynamic_weighting_enabled}
              hideWeights={course.grading_mode === "points"}
              dragging={dragCatId === cat.id}
              open={!!openCats[cat.id]}
              onToggle={() => setOpenCats((prev) => ({ ...prev, [cat.id]: !prev[cat.id] }))}
              onEdit={() => setCategoryModal({ mode: "edit", cat })}
              onDragStart={(event) => onCategoryDragStart(event, cat.id)}
              onDragMove={onCategoryDragMove}
              onDragEnd={onCategoryDragEnd}
              onChange={async (next) => {
                setCourse(next);
                onChange?.();
              }}
            />
          ))}
          <button className="btn" type="button" onClick={() => setCategoryModal({ mode: "create" })}>
            Add category
          </button>
        </div>
        {showExamCalc ? (
          <ExamCalc
            course={course}
            examCatId={examCatId}
            examScoreRaw={examScoreRaw}
            onExamCatId={setExamCatId}
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
          onClose={() => setCategoryModal(null)}
          onSubmit={saveCategorySettings}
          onDelete={deleteCategoryFromModal}
        />
      ) : null}
    </>
  );
}

function newOptionId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `opt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function weightsFromCourse(categories) {
  return Object.fromEntries((categories || []).map((cat) => [String(cat.id), Number(cat.weight) || 0]));
}

function projectPercentWithWeights(course, weightByCatId) {
  const used = [];
  for (const cat of course.categories || []) {
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
      <h2>Dynamic weighting</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Compare alternate category weight schemes. When enabled, the scheme with the highest course grade is
        applied automatically, and category weight fields are locked.
      </p>
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
        Enable Dynamic Weighting
      </label>
      {enabled ? (
        categories.length === 0 ? (
          <p className="muted">Add categories before setting dynamic weights.</p>
        ) : (
          <div className="dynamic-weight-table-wrap">
            <table className="dynamic-weight-table">
              <thead>
                <tr>
                  <th>Category</th>
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
                {categories.map((cat) => (
                  <tr key={cat.id}>
                    <th scope="row">
                      {cat.name}
                      {cat.percent != null ? (
                        <span className="muted mono"> · {fmtPct(cat.percent)}%</span>
                      ) : null}
                    </th>
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

function ScaleEditor({ course, profiles, onSave, onApply, onRoundingChange }) {
  const [rows, setRows] = useState(course.scale.map((r) => ({ ...r })));
  const [saving, setSaving] = useState(false);
  const selectedProfileId = course.scale_profile_id == null ? "" : String(course.scale_profile_id);

  useEffect(() => {
    setRows(course.scale.map((r) => ({ ...r })));
  }, [course.scale]);

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2>Grade cutoffs</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        This class only. Pick a saved default to copy it here. Saving custom cutoffs stops following that default.
      </p>
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
      <label className="muted" style={{ display: "block", marginBottom: 12 }}>
        Default scale
        <select
          className="select"
          style={{ display: "block", marginTop: 6, width: "min(100%, 360px)" }}
          value={selectedProfileId}
          disabled={saving}
          onChange={async (event) => {
            const value = event.target.value;
            setSaving(true);
            try {
              if (!value) await onSave(rows);
              else await onApply(Number(value));
            } finally {
              setSaving(false);
            }
          }}
        >
          <option value="">Custom</option>
          {(profiles || []).map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
              {profile.is_primary ? " (primary)" : ""}
            </option>
          ))}
        </select>
      </label>
      <ScaleRowsEditor rows={rows} onChange={setRows} />
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="btn primary"
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(rows);
            } finally {
              setSaving(false);
            }
          }}
        >
          Save cutoffs
        </button>
      </div>
    </div>
  );
}

function ExamCalc({ course, examCatId, examScoreRaw, onExamCatId, onExamScoreRaw }) {
  const rounding = course.grade_rounding ?? null;
  const resolvedId = examCatId ?? null;
  const selected = resolvedId != null;
  const examPct = assignmentPercent({ display: examScoreRaw, isBonus: false });
  const projected = useMemo(
    () => (selected ? projectPercentFromExam(course, resolvedId, examPct) : null),
    [course, resolvedId, examPct, selected]
  );
  const grade = gradeFromPercent(projected, course.scale, rounding);
  const needed = useMemo(
    () => (selected ? examNeededRows(course, resolvedId) : []),
    [course, resolvedId, selected]
  );
  const blankRows = useMemo(
    () => (course.scale || []).filter((row) => row.letter !== "F").map((row) => ({ letter: row.letter })),
    [course.scale]
  );
  const examCat = course.categories.find((c) => c.id === resolvedId);
  const hasWeight =
    course.grading_mode === "points"
      ? Boolean(examCat)
      : Boolean(examCat && (examCat.weight || examCat.weight_per_item || examCat.effective_weight));
  const tableRows = selected ? needed : blankRows;

  return (
    <div className="panel">
      <h2>Exam grade needed table</h2>
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
            <label className="muted">
              Exam category
              <select
                className="select"
                style={{ display: "block", marginTop: 4, width: "100%" }}
                value={resolvedId ?? ""}
                onChange={(e) => onExamCatId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">None</option>
                {course.categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                    {cat.percent != null ? ` · ${fmtPct(cat.percent)}%` : " · no score yet"}
                  </option>
                ))}
              </select>
            </label>
            <label className="muted">
              Exam score
              <input
                className="input"
                style={{ display: "block", marginTop: 4, width: "100%" }}
                placeholder="90 or 18/20"
                value={examScoreRaw}
                onChange={(e) => onExamScoreRaw(e.target.value)}
              />
            </label>
          </div>
          {selected && examScoreRaw.trim() && projected != null ? (
            <div className="exam-preview">
              <span className={`letter ${letterClass(grade.letter)}`}>{grade.letter || "—"}</span>
              <strong className={`mono exam-pct ${letterClass(grade.letter)}`}>{fmtPct(projected)}%</strong>
              <span className="mono">{fmtGpa(grade.quality_points)}</span>
            </div>
          ) : selected && examScoreRaw.trim() && projected == null ? (
            <p className="muted">
              {course.grading_mode === "points"
                ? "Enter a valid score to preview the course grade."
                : "Enter a valid score and give this category a weight."}
            </p>
          ) : null}
          {selected && !hasWeight ? (
            <p className="muted">This category has no weight, so it cannot change the course grade.</p>
          ) : tableRows.length === 0 ? (
            <p className="muted">Add grade cutoffs to see exam targets.</p>
          ) : (
            <table className="exam-cutoff-table">
              <thead>
                <tr className="exam-cutoff-head-row">
                  <th className="exam-cutoff-exam-head">Exam %</th>
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
                      {row.needed == null ? "" : fmtPct(row.needed)}
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
  onClose,
  onSubmit,
  onDelete,
}) {
  const [draft, setDraft] = useState(() => categoryDraftFromCat(mode === "edit" ? cat : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pointsRatio = draft.aggregation === "points_ratio";
  const others = (categories || []).filter((item) => item.id !== cat?.id);

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
    if (!window.confirm("Delete this category?")) return;
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
          {hideWeights ? null : weightsLocked ? (
            <p className="muted modal-field-wide" style={{ margin: 0 }}>
              Weights are controlled by Dynamic Weighting.
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
          {hideWeights ? null : (
          <label className="muted modal-field-wide category-weight-field">
            Weight
            <div className="category-weight-row">
              <select
                className="select"
                value={draft.weightMode}
                disabled={weightsLocked}
                onChange={(event) => update({ weightMode: event.target.value })}
              >
                <option value="weight">Weight</option>
                <option value="per_item">Per item weight</option>
              </select>
              <input
                className="input"
                inputMode="decimal"
                value={draft.weightPct}
                disabled={weightsLocked}
                onChange={(event) => update({ weightPct: event.target.value })}
                aria-label={`${draft.weightMode === "per_item" ? "Per item weight" : "Weight"} %`}
              />
            </div>
          </label>
          )}
          <label className="muted">
            Aggregation
            <select
              className="select"
              value={draft.aggregation}
              onChange={(event) => update({ aggregation: event.target.value })}
            >
              {(aggOptions || DEFAULT_AGG_OPTIONS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {pointsRatio ? null : (
            <label className="muted">
              Drop X lowest grades
              <input
                className="input"
                type="number"
                min="0"
                step="1"
                value={draft.dropCount}
                onChange={(event) => update({ dropCount: event.target.value })}
              />
              <span className="muted category-drop-note">
                If X is at least the number of grades, all but the highest are dropped.
              </span>
            </label>
          )}
          <label className="muted">
            Include bonus
            <input
              type="checkbox"
              style={{ display: "block", marginTop: 8 }}
              checked={draft.includeBonus}
              onChange={(event) => update({ includeBonus: event.target.checked })}
            />
          </label>
          {pointsRatio ? null : (
            <label className="muted modal-field-wide">
              Replace using
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
            </label>
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

function droppedAssignmentIds(cat) {
  if (!cat?.drop_count || cat.aggregation === "points_ratio") return new Set();

  const scored = cat.assignments
    .filter((a) => !a.is_bonus)
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

  const sorted = [...scored].sort((a, b) => a.percent - b.percent || a.id - b.id);
  return new Set(sorted.slice(0, toDrop).map((a) => a.id));
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

function CategoryCard({
  cat,
  scale,
  colorAssignmentGrades,
  weightsLocked = false,
  hideWeights = false,
  dragging = false,
  onChange,
  open,
  onToggle,
  onEdit,
  onDragStart,
  onDragMove,
  onDragEnd,
}) {
  const [scoreDrafts, setScoreDrafts] = useState({});
  const saveTimers = useRef({});
  const droppedIds = useMemo(() => droppedAssignmentIds(cat), [cat]);

  useEffect(() => {
    return () => {
      Object.values(saveTimers.current).forEach(clearTimeout);
    };
  }, []);

  function queueScoreSave(assignmentId, raw) {
    setScoreDrafts((d) => ({ ...d, [assignmentId]: raw }));
    clearTimeout(saveTimers.current[assignmentId]);
    saveTimers.current[assignmentId] = setTimeout(async () => {
      try {
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
      } catch (err) {
        console.error(err);
      }
    }, 250);
  }

  async function flushScoreSave(assignmentId, raw) {
    clearTimeout(saveTimers.current[assignmentId]);
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
          <strong className="cat-name">{cat.name}</strong>
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
          <span className="mono">
            Section: {cat.percent == null ? "—" : `${fmtPct(cat.percent)}%`}
          </span>
          {hideWeights ? null : weightsLocked ? (
            <label className="muted cat-weight-box" onClick={(e) => e.stopPropagation()}>
              Weight
              <input
                className="input"
                value={`${fmtWeightPct(cat.effective_weight)}%`}
                readOnly
                disabled
                tabIndex={-1}
              />
            </label>
          ) : (
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
            {cat.include_bonus ? <th className="col-bonus">Bonus</th> : null}
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
          {cat.assignments.map((a) => {
            const draft = scoreDrafts[a.id] ?? a.display;
            const isDropped = droppedIds.has(a.id);
            const scoreLetter =
              !isDropped && colorAssignmentGrades
                ? letterFromPercent(
                    assignmentPercent({
                      display: draft,
                      earned: a.earned,
                      possible: a.possible,
                      isBonus: a.is_bonus,
                    }),
                    scale
                  )
                : null;
            const scoreTone = isDropped ? "" : letterClass(scoreLetter);
            return (
            <tr key={a.id} className={isDropped ? "cat-score-dropped" : undefined}>
              <td className="col-name">
                <input
                  className="input"
                  defaultValue={a.name}
                  onBlur={async (e) => onChange(await api.patchAssignment(a.id, { name: e.target.value }))}
                />
              </td>
              <td className="col-score">
                <input
                  className={`input ${scoreTone}`.trim()}
                  placeholder="95 or 19/20"
                  value={draft}
                  onChange={(e) => queueScoreSave(a.id, e.target.value)}
                  onBlur={(e) => flushScoreSave(a.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </td>
              {cat.include_bonus ? (
                <td className="col-bonus">
                  <input
                    type="checkbox"
                    checked={a.is_bonus}
                    onChange={async (e) => onChange(await api.patchAssignment(a.id, { is_bonus: e.target.checked }))}
                  />
                </td>
              ) : null}
              <td className="col-actions">
                <button className="btn small danger" onClick={async () => onChange(await api.deleteAssignment(a.id))}>
                  ×
                </button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      <button
        className="btn small"
        style={{ marginTop: 10 }}
        onClick={async () => onChange(await api.createAssignment({ category_id: cat.id, name: `${cat.name} ${cat.assignments.length + 1}` }))}
      >
        Add score
      </button>
      </>
      ) : null}
    </section>
  );
}
