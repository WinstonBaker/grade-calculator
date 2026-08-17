import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, fmtGpa, fmtPct, fmtScore, letterClass, scoreClass } from "./api";
import { useCreditTerms, useShowScore } from "./creditLabel.jsx";
import ExamImpactTable, { ExamImpactStats } from "./ExamImpact.jsx";
import { SEASONS } from "./seasons.js";

const SORTS = [
  ["code", "Class"],
  ["percent", "Percent"],
  ["letter", "Letter"],
  ["gpa", "GPA"],
  ["credits", "Credits"],
  ["score", "Score"],
];

const FALLBACK_GP_OPTIONS = [
  ["A+", 4.333],
  ["A", 4.0],
  ["A-", 3.667],
  ["B+", 3.333],
  ["B", 3.0],
  ["B-", 2.667],
  ["C+", 2.333],
  ["C", 2.0],
  ["C-", 1.667],
  ["D+", 1.333],
  ["D", 1.0],
  ["D-", 0.667],
  ["F", 0.0],
];

function gpOptions(course) {
  if (course?.scale?.length) {
    return course.scale.map((row) => [row.letter, row.quality_points]);
  }
  return FALLBACK_GP_OPTIONS;
}

function gpSelectValue(gp, options) {
  if (gp === null || gp === undefined) return "";
  const match = options.find(([, v]) => Math.abs(v - Number(gp)) < 1e-6);
  return match ? String(match[1]) : String(gp);
}

export default function CourseList({ semesters, onChange }) {
  const creditTerms = useCreditTerms();
  const showScore = useShowScore();
  const [params, setParams] = useSearchParams();
  const semesterId = params.get("semester");
  const [courses, setCourses] = useState([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("code");
  const [desc, setDesc] = useState(false);
  const [code, setCode] = useState("");
  const [credits, setCredits] = useState("3");

  const sortCols = useMemo(
    () =>
      SORTS.filter(([key]) => showScore || key !== "score").map(([key, label]) => [
        key,
        key === "credits" ? creditTerms.label : label,
      ]),
    [creditTerms.label, showScore]
  );

  const [addTo, setAddTo] = useState("");
  const [year, setYear] = useState("");
  const [season, setSeason] = useState("fall");
  const [saveError, setSaveError] = useState("");

  const current = useMemo(
    () => semesters.find((s) => String(s.id) === String(semesterId)),
    [semesters, semesterId]
  );

  useEffect(() => {
    setAddTo(semesterId || (semesters[0] ? String(semesters[0].id) : ""));
    if (current) {
      setYear(String(current.year));
      setSeason(current.season);
      setSaveError("");
    }
  }, [semesterId, semesters, current]);

  async function load() {
    const data = await api.courses({
      semester_id: semesterId || undefined,
      q,
      sort,
      desc,
    });
    setCourses(data);
  }

  useEffect(() => {
    load().catch(console.error);
  }, [semesterId, q, sort, desc]);

  useEffect(() => {
    if (!showScore && sort === "score") {
      setSort("code");
      setDesc(false);
    }
  }, [showScore, sort]);

  function toggleSort(next) {
    if (sort === next) setDesc((d) => !d);
    else {
      setSort(next);
      setDesc(next !== "code");
    }
  }

  async function addCourse(e) {
    e.preventDefault();
    const sid = addTo || semesterId || semesters[0]?.id;
    if (!sid || !code.trim()) return;
    await api.createCourse({ semester_id: Number(sid), code: code.trim(), credits: Number(credits) });
    setCode("");
    await load();
    onChange?.();
  }

  async function saveSemester(e) {
    e.preventDefault();
    if (!current) return;
    try {
      await api.patchSemester(current.id, { year: Number(year), season });
      setSaveError("");
      onChange?.();
    } catch (err) {
      setSaveError(err.message);
    }
  }

  async function removeCourse(id) {
    if (!window.confirm("Delete this class?")) return;
    await api.deleteCourse(id);
    await load();
    onChange?.();
  }

  async function setOverride(courseId, raw) {
    await api.patchCourse(courseId, {
      gp_override: raw === "" ? null : Number(raw),
    });
    await load();
    onChange?.();
  }

  async function moveCourse(courseId, semesterId) {
    await api.patchCourse(courseId, { semester_id: Number(semesterId) });
    await load();
    onChange?.();
  }

  async function patchExamCats(courseId, patch) {
    await api.patchCourse(courseId, patch);
    await load();
    onChange?.();
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{current ? current.name : "All courses"}</h1>
          <p>
            {current
              ? "Change the year or term below to rename this semester (for example 2025 Spring)."
              : "Search and sort by semester or class. Click a row to open the gradebook."}
          </p>
          {saveError ? <p className="error">{saveError}</p> : null}
        </div>
        <div className="row">
          <input className="input" placeholder="Search class" value={q} onChange={(e) => setQ(e.target.value)} />
          {current ? (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={current.included}
                  onChange={async (e) => {
                    await api.patchSemester(current.id, { included: e.target.checked });
                    onChange?.();
                  }}
                />
                Include in GPA
              </label>
              <button
                className="btn danger"
                onClick={async () => {
                  if (!window.confirm(`Delete ${current.name} and its classes?`)) return;
                  await api.deleteSemester(current.id);
                  onChange?.();
                  setParams({});
                }}
              >
                Delete semester
              </button>
            </>
          ) : null}
        </div>
      </div>

      {current ? (
        <div className="grid-stats">
          <div className="stat">
            <div className="label">Semester GPA</div>
            <div className="value">{fmtGpa(current.term_gpa)}</div>
          </div>
          {showScore ? (
            <div className="stat">
              <div className="label">Semester score</div>
              <div className={`value ${scoreClass(current.term_score)}`}>{fmtScore(current.term_score)}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {current ? (
        <form className="panel row" onSubmit={saveSemester} style={{ marginBottom: 16 }}>
          <label className="muted">
            Year
            <input
              className="input"
              type="number"
              min="2000"
              max="2100"
              style={{ display: "block", marginTop: 4, width: 110 }}
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </label>
          <label className="muted">
            Term
            <select
              className="select"
              style={{ display: "block", marginTop: 4 }}
              value={season}
              onChange={(e) => setSeason(e.target.value)}
            >
              {SEASONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" type="submit" style={{ alignSelf: "flex-end" }}>
            Save name
          </button>
        </form>
      ) : null}

      <form className="panel row" onSubmit={addCourse} style={{ marginBottom: 16 }}>
        {!semesterId ? (
          <select className="select" value={addTo} onChange={(e) => setAddTo(e.target.value)}>
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
        <input className="input" placeholder="Class code (MAE 310)" value={code} onChange={(e) => setCode(e.target.value)} />
        <input
          className="input"
          style={{ width: 90 }}
          value={credits}
          placeholder={creditTerms.label}
          aria-label={creditTerms.label}
          onChange={(e) => setCredits(e.target.value)}
        />
        <button className="btn primary" type="submit">
          Add class
        </button>
      </form>

      <div className="panel table-wrap">
        {courses.length === 0 ? (
          <div className="empty">No classes yet. Add one above.</div>
        ) : (
          <table>
            <thead>
              <tr>
                {sortCols.map(([key, label]) => (
                  <th key={key}>
                    <button className={sort === key ? "active" : ""} onClick={() => toggleSort(key)}>
                      {label}
                      {sort === key ? (desc ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                ))}
                <th>Override</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {courses.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/courses/${c.id}`}>{c.code}</Link>
                  </td>
                  <td className={`mono ${letterClass(c.letter)}`}>{fmtPct(c.percent)}</td>
                  <td>
                    <span className={`letter ${letterClass(c.letter)}`}>{c.letter || "—"}</span>
                  </td>
                  <td className="mono">{fmtGpa(c.quality_points)}</td>
                  <td className="mono">{c.credits}</td>
                  {showScore ? (
                    <td className={`mono ${scoreClass(c.score)}`}>{fmtScore(c.score)}</td>
                  ) : null}
                  <td>
                    <select
                      className="select"
                      style={{ width: 118 }}
                      value={gpSelectValue(c.gp_override, gpOptions(c))}
                      onChange={(e) => setOverride(c.id, e.target.value)}
                      title="GPA override — leave Auto to use percent cutoffs"
                    >
                      <option value="">Auto</option>
                      {gpOptions(c).map(([letter, gp]) => (
                        <option key={letter} value={gp}>
                          {letter} ({fmtGpa(gp)})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <CourseMoveMenu
                      course={c}
                      semesters={semesters}
                      onMove={(semesterId) => moveCourse(c.id, semesterId)}
                      onDelete={() => removeCourse(c.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {current ? (
        <section className="panel" style={{ marginTop: 16 }}>
          <h2>Exam vs tests</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Pick the test and exam categories for each class. Δ is exam percent minus the test average; letter
            compares the course with and without the exam counting.
          </p>
          <ExamImpactStats
            summary={{
              avg_delta: averageDelta(courses),
              letter_up: courses.filter((c) => c.exam_impact?.letter_change === "up").length,
              letter_down: courses.filter((c) => c.exam_impact?.letter_change === "down").length,
              letter_same: courses.filter((c) => c.exam_impact?.letter_change === "same").length,
            }}
          />
          <ExamImpactTable courses={courses} onPatch={patchExamCats} />
        </section>
      ) : null}
    </>
  );
}

function averageDelta(courses) {
  const deltas = (courses || []).map((c) => c.exam_impact?.delta).filter((n) => n != null && !Number.isNaN(n));
  if (!deltas.length) return null;
  return deltas.reduce((sum, n) => sum + n, 0) / deltas.length;
}

function CourseMoveMenu({ course, semesters, onMove, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const others = semesters.filter((s) => s.id !== course.semester_id);

  useEffect(() => {
    function close(event) {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div className="kebab-wrap" ref={ref}>
      <button
        className="btn small kebab-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋮
      </button>
      {open ? (
        <div className="kebab-menu" role="menu">
          {others.length ? (
            others.map((sem) => (
              <button
                key={sem.id}
                className="kebab-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onMove(sem.id);
                }}
              >
                Move to {sem.name}
              </button>
            ))
          ) : (
            <div className="kebab-item muted">No other semesters</div>
          )}
          <button
            className="kebab-item danger"
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
