import { useEffect, useMemo, useRef, useState } from "react";
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
} from "./api";
import { ScaleRowsEditor } from "./ScaleEditor.jsx";

const AGG_LABELS = {
  average: "Average",
  drop_lowest: "Drop lowest",
  points_ratio: "Points ratio",
  average_plus_bonus: "Average + bonus",
  replace_min_with: "Replace lowest with",
};

function fmtWeightPct(weight) {
  if (weight == null || Number.isNaN(weight)) return "—";
  const pct = Number((weight * 100).toPrecision(12));
  if (Number.isInteger(pct)) return String(pct);
  return String(pct);
}

export default function Gradebook({ onChange, colorAssignmentGrades = true }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [course, setCourse] = useState(null);
  const [semesters, setSemesters] = useState([]);
  const [error, setError] = useState("");
  const [newCat, setNewCat] = useState("HW");
  const [showScale, setShowScale] = useState(false);
  const [openCats, setOpenCats] = useState({});
  const [profiles, setProfiles] = useState([]);

  async function load() {
    const [c, s, m] = await Promise.all([api.course(id), api.semesters(), api.meta()]);
    setCourse(c);
    setSemesters(s);
    setProfiles(m.scale_profiles || []);
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

  async function saveCourse(patch) {
    setCourse(await api.patchCourse(id, patch));
    onChange?.();
  }

  async function addCategory(e) {
    e.preventDefault();
    setCourse(
      await api.createCategory({
        course_id: Number(id),
        name: newCat,
        weight: 0.2,
        aggregation: "average",
      })
    );
  }

  function expandAllCategories() {
    if (!course) return;
    setOpenCats(Object.fromEntries(course.categories.map((c) => [c.id, true])));
  }

  function collapseAllCategories() {
    if (!course) return;
    setOpenCats(Object.fromEntries(course.categories.map((c) => [c.id, false])));
  }

  const [examCatId, setExamCatId] = useState(null);
  const [examScoreRaw, setExamScoreRaw] = useState("");

  useEffect(() => {
    setExamScoreRaw("");
    setExamCatId(null);
  }, [id]);

  useEffect(() => {
    if (!course?.categories) return;
    const ids = new Set(course.categories.map((c) => c.id));
    if (examCatId == null || !ids.has(examCatId)) {
      setExamCatId(defaultExamCategoryId(course.categories));
    }
  }, [course, examCatId]);

  if (!course) return <p className="muted">{error || "Loading…"}</p>;

  return (
    <>
      <div className="topbar">
        <div>
          <p className="muted">
            <Link to="/courses">Courses</Link> / {course.code}
          </p>
          <div className="gradebook-title-row">
            <h1>{course.code}</h1>
            <div className="row">
              <span className={`letter ${letterClass(course.letter)}`}>{course.letter || "—"}</span>
              <strong className={`mono ${letterClass(course.letter)}`}>{fmtPct(course.percent)}%</strong>
              <span className="mono">{fmtGpa(course.quality_points)}</span>
              <span className={`mono ${scoreClass(course.score)}`}>{fmtScore(course.score)}</span>
            </div>
          </div>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="panel row course-settings" style={{ marginBottom: 16 }}>
        <label className="muted">
          Code
          <input
            className="input"
            style={{ display: "block", marginTop: 4, width: 96 }}
            maxLength={8}
            defaultValue={course.code}
            onBlur={(e) => saveCourse({ code: e.target.value })}
          />
        </label>
        <label className="muted">
          Credits
          <input className="input" style={{ display: "block", marginTop: 4, width: 80 }} defaultValue={course.credits} onBlur={(e) => saveCourse({ credits: Number(e.target.value) })} />
        </label>
        <label className="muted">
          Overall Bonus
          <input className="input" style={{ display: "block", marginTop: 4, width: 80 }} defaultValue={course.bonus_points} onBlur={(e) => saveCourse({ bonus_points: Number(e.target.value) })} />
        </label>
        <label className="muted">
          GP override
          <input
            className="input"
            style={{ display: "block", marginTop: 4, width: 90 }}
            defaultValue={course.gp_override != null && course.gp_override !== "" ? Number(course.gp_override).toFixed(3) : ""}
            placeholder="none"
            onBlur={(e) => saveCourse({ gp_override: e.target.value === "" ? null : Number(Number(e.target.value).toFixed(3)) })}
          />
        </label>
        <label className="muted">
          Semester
          <select
            className="select"
            style={{ display: "block", marginTop: 4 }}
            value={course.semester_id}
            onChange={(e) => saveCourse({ semester_id: Number(e.target.value) })}
          >
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" type="button" onClick={() => setShowScale((v) => !v)}>
          Cutoffs
        </button>
        <button
          className="btn danger"
          type="button"
          onClick={async () => {
            if (!window.confirm("Delete this class?")) return;
            await api.deleteCourse(course.id);
            onChange?.();
            navigate("/courses");
          }}
        >
          Delete class
        </button>
      </div>

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
        />
      ) : null}

      <div className="split">
        <div className="cards">
          {course.categories.length > 0 ? (
            <div className="row" style={{ marginBottom: 4 }}>
              <button className="btn small" type="button" onClick={expandAllCategories}>
                Expand all
              </button>
              <button className="btn small" type="button" onClick={collapseAllCategories}>
                Collapse all
              </button>
            </div>
          ) : null}
          {course.categories.map((cat) => (
            <CategoryCard
              key={cat.id}
              cat={cat}
              categories={course.categories}
              scale={course.scale}
              colorAssignmentGrades={colorAssignmentGrades}
              open={!!openCats[cat.id]}
              onToggle={() => setOpenCats((prev) => ({ ...prev, [cat.id]: !prev[cat.id] }))}
              onChange={async (next) => {
                setCourse(next);
                onChange?.();
              }}
            />
          ))}
          <form className="panel row" onSubmit={addCategory}>
            <input className="input" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
            <button className="btn primary" type="submit">
              Add category
            </button>
          </form>
        </div>
        <ExamCalc
          course={course}
          examCatId={examCatId}
          examScoreRaw={examScoreRaw}
          onExamCatId={setExamCatId}
          onExamScoreRaw={setExamScoreRaw}
        />
      </div>
    </>
  );
}

function ScaleEditor({ course, profiles, onSave, onApply }) {
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
  const resolvedId = examCatId ?? defaultExamCategoryId(course.categories);
  const examPct = assignmentPercent({ display: examScoreRaw, isBonus: false });
  const projected = useMemo(
    () => projectPercentFromExam(course, resolvedId, examPct),
    [course, resolvedId, examPct]
  );
  const grade = gradeFromPercent(projected, course.scale);
  const needed = useMemo(() => examNeededRows(course, resolvedId), [course, resolvedId]);
  const examCat = course.categories.find((c) => c.id === resolvedId);
  const hasWeight = examCat ? examCat.weight || examCat.weight_per_item || examCat.effective_weight : false;

  return (
    <div className="panel">
      <h2>Final from exam</h2>
      <p className="muted">Course grade if this exam scores a given percent, and what you need for each cutoff.</p>
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
                onChange={(e) => onExamCatId(Number(e.target.value))}
              >
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
          {examScoreRaw.trim() && projected != null ? (
            <div className="exam-preview">
              <span className={`letter ${letterClass(grade.letter)}`}>{grade.letter || "—"}</span>
              <strong className={`mono exam-pct ${letterClass(grade.letter)}`}>{fmtPct(projected)}%</strong>
              <span className="mono">{fmtGpa(grade.quality_points)}</span>
            </div>
          ) : examScoreRaw.trim() && projected == null ? (
            <p className="muted">Enter a valid score and give this category a weight.</p>
          ) : null}
          {!hasWeight ? (
            <p className="muted">This category has no weight, so it cannot change the course grade.</p>
          ) : needed.length === 0 ? (
            <p className="muted">Add grade cutoffs to see exam targets.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Letter</th>
                  <th>Exam %</th>
                </tr>
              </thead>
              <tbody>
                {needed.map((row) => (
                  <tr key={row.letter}>
                    <td>
                      <span className={`letter ${letterClass(row.letter)}`}>{row.letter}</span>
                    </td>
                    <td className={`mono ${row.needed > 100 ? "neg" : row.needed < 0 ? "pos" : ""}`}>
                      {fmtPct(row.needed)}
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

function CategoryCard({ cat, categories, scale, colorAssignmentGrades, onChange, open, onToggle }) {
  const [name, setName] = useState(cat.name);
  const [scoreDrafts, setScoreDrafts] = useState({});
  const saveTimers = useRef({});

  useEffect(() => {
    setName(cat.name);
  }, [cat.name]);

  useEffect(() => {
    return () => {
      Object.values(saveTimers.current).forEach(clearTimeout);
    };
  }, []);

  async function patch(body) {
    onChange(await api.patchCategory(cat.id, body));
  }

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
    <section className={`cat-card ${open ? "is-open" : "is-collapsed"}`}>
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
        <div className="row cat-head-left" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="cat-toggle"
            aria-expanded={open}
            aria-label={open ? "Collapse category" : "Expand category"}
            onClick={onToggle}
          >
            {open ? "▾" : "▸"}
          </button>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => patch({ name })} />
        </div>
        <div className="row">
          <span className="mono">
            Section: {cat.percent == null ? "—" : `${fmtPct(cat.percent)}%`}
          </span>
          <span className="muted mono">Weight: {fmtWeightPct(cat.effective_weight)}%</span>
          <button
            className="btn small danger"
            onClick={async (e) => {
              e.stopPropagation();
              onChange(await api.deleteCategory(cat.id));
            }}
          >
            Remove
          </button>
        </div>
      </div>
      {open ? (
      <>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="muted">
          Weight %
          <input
            className="input"
            style={{ display: "block", width: 90, marginTop: 4 }}
            key={`weight-${cat.id}-${cat.weight}`}
            defaultValue={Number((cat.weight * 100).toPrecision(12))}
            onBlur={(e) => patch({ weight: Number(e.target.value) / 100 })}
          />
        </label>
        <label className="muted">
          Per item %
          <input
            className="input"
            style={{ display: "block", width: 90, marginTop: 4 }}
            key={`wpi-${cat.id}-${cat.weight_per_item}`}
            defaultValue={
              cat.weight_per_item == null ? "" : Number((cat.weight_per_item * 100).toPrecision(12))
            }
            placeholder="off"
            onBlur={(e) =>
              patch({
                weight_per_item: e.target.value.trim() === "" ? null : Number(e.target.value) / 100,
              })
            }
          />
        </label>
        <label className="muted">
          Aggregation
          <select
            className="select"
            style={{ display: "block", marginTop: 4 }}
            value={cat.aggregation}
            onChange={(e) => patch({ aggregation: e.target.value })}
          >
            {Object.entries(AGG_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {cat.aggregation === "drop_lowest" ? (
          <label className="muted">
            Drop
            <input
              className="input"
              style={{ display: "block", width: 70, marginTop: 4 }}
              defaultValue={cat.drop_count}
              onBlur={(e) => patch({ drop_count: Number(e.target.value) })}
            />
          </label>
        ) : null}
        {cat.aggregation === "replace_min_with" ? (
          <label className="muted">
            Replace using
            <select
              className="select"
              style={{ display: "block", marginTop: 4 }}
              value={cat.replace_with_category_id || ""}
              onChange={(e) => patch({ replace_with_category_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Select</option>
              {categories
                .filter((c) => c.id !== cat.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </div>
      <table className="cat-scores">
        <thead>
          <tr>
            <th className="col-name">Name</th>
            <th className="col-score">Score</th>
            <th className="col-bonus">Bonus</th>
            <th className="col-actions" />
          </tr>
        </thead>
        <tbody>
          {cat.assignments.map((a) => {
            const draft = scoreDrafts[a.id] ?? a.display;
            const scoreLetter =
              colorAssignmentGrades
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
            const scoreTone = letterClass(scoreLetter);
            return (
            <tr key={a.id}>
              <td className="col-name">
                <input
                  className="input"
                  defaultValue={a.name}
                  onBlur={async (e) => onChange(await api.patchAssignment(a.id, { name: e.target.value }))}
                />
              </td>
              <td className="col-score">
                <input
                  className={`input ${scoreTone}`}
                  placeholder="95 or 19/20"
                  value={draft}
                  onChange={(e) => queueScoreSave(a.id, e.target.value)}
                  onBlur={(e) => flushScoreSave(a.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </td>
              <td className="col-bonus">
                <input
                  type="checkbox"
                  checked={a.is_bonus}
                  onChange={async (e) => onChange(await api.patchAssignment(a.id, { is_bonus: e.target.checked }))}
                />
              </td>
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
