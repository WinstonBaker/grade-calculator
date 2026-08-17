import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  assignmentPercent,
  fmtGpa,
  fmtPct,
  fmtScore,
  letterClass,
  letterFromPercent,
  scoreClass,
} from "./api";

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

  async function load() {
    const [c, s] = await Promise.all([api.course(id), api.semesters()]);
    setCourse(c);
    setSemesters(s);
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

  const whatIfGroups = useMemo(() => {
    if (!course) return [];
    const map = new Map();
    for (const row of course.what_if || []) {
      if (!map.has(row.category_name)) map.set(row.category_name, []);
      map.get(row.category_name).push(row);
    }
    return [...map.entries()];
  }, [course]);

  if (!course) return <p className="muted">{error || "Loading…"}</p>;

  return (
    <>
      <div className="topbar">
        <div>
          <p className="muted">
            <Link to="/">Courses</Link> / {course.code}
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
            navigate("/");
          }}
        >
          Delete class
        </button>
      </div>

      {showScale ? (
        <ScaleEditor course={course} onSave={async (rows) => setCourse(await api.updateScale(course.id, rows))} />
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
        <div className="panel">
          <h2>What-if remaining</h2>
          <p className="muted">Score needed on incomplete categories to hit each cutoff.</p>
          {whatIfGroups.length === 0 ? (
            <p className="muted">Enter weights and leave a category empty to see targets.</p>
          ) : (
            whatIfGroups.map(([name, rows]) => (
              <div key={name} style={{ marginTop: 14 }}>
                <strong>{name}</strong>
                <table>
                  <thead>
                    <tr>
                      <th>Letter</th>
                      <th>Needed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows
                      .filter((r) => ["A+", "A", "A-", "B+", "B", "B-"].includes(r.letter))
                      .map((r) => (
                        <tr key={r.letter}>
                          <td>
                            <span className={`letter ${letterClass(r.letter)}`}>{r.letter}</span>
                          </td>
                          <td className={`mono ${r.needed > 100 ? "neg" : r.needed < 0 ? "pos" : ""}`}>
                            {fmtPct(r.needed)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function ScaleEditor({ course, onSave }) {
  const [rows, setRows] = useState(course.scale.map((r) => ({ ...r })));
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2>Grade cutoffs</h2>
      <div className="scale-grid muted" style={{ marginBottom: 8 }}>
        <span>Letter</span>
        <span>Min %</span>
        <span>GP</span>
      </div>
      {rows.map((row, i) => (
        <div className="scale-grid" key={row.letter} style={{ marginBottom: 6 }}>
          <span className="mono">{row.letter}</span>
          <input
            className="input"
            value={row.min_percent}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...row, min_percent: Number(e.target.value) };
              setRows(next);
            }}
          />
          <input
            className="input"
            value={Number(row.quality_points).toFixed(3)}
            step="0.001"
            onChange={(e) => {
              const next = [...rows];
              const n = Number(e.target.value);
              next[i] = { ...row, quality_points: Number.isNaN(n) ? 0 : Number(n.toFixed(3)) };
              setRows(next);
            }}
          />
        </div>
      ))}
      <button className="btn primary" style={{ marginTop: 10 }} onClick={() => onSave(rows)}>
        Save cutoffs
      </button>
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
