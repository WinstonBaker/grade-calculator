import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api, fmtGpa, fmtPct, fmtScore, gpOptions, gpSelectValue, letterClass, scoreClass } from "./api";
import { useCreditTerms, useShowScore } from "./creditLabel.jsx";
import ExamImpactTable, { ExamImpactStats } from "./ExamImpact.jsx";
import { useToasts } from "./notifications.jsx";
import SemesterProgressChart from "./SemesterProgressChart.jsx";
import { SEASONS } from "./seasons.js";

const SORTS = [
  ["code", "Class"],
  ["percent", "Percent"],
  ["credits", "Credits"],
  ["letter", "Letter"],
  ["gpa", "GPA"],
  ["score", "Score"],
];

const GRADE_SORT_KEYS = new Set(["letter", "gpa", "score"]);

function apiSortKey(sort) {
  return GRADE_SORT_KEYS.has(sort) ? "gpa" : sort;
}

function isGradeSort(sort) {
  return GRADE_SORT_KEYS.has(sort);
}

export default function CourseList({ semesters, onChange }) {
  const creditTerms = useCreditTerms();
  const showScore = useShowScore();
  const { warning } = useToasts();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const semesterId = params.get("semester");
  const [courses, setCourses] = useState([]);
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

  const [year, setYear] = useState("");
  const [season, setSeason] = useState("fall");
  const [saveError, setSaveError] = useState("");
  const [semesterSettingsOpen, setSemesterSettingsOpen] = useState(false);

  const current = useMemo(
    () => semesters.find((s) => String(s.id) === String(semesterId)),
    [semesters, semesterId]
  );

  useEffect(() => {
    if (current) {
      setYear(String(current.year));
      setSeason(current.season);
      setSaveError("");
    }
  }, [current]);

  async function load() {
    const data = await api.courses({
      semester_id: semesterId || undefined,
      sort: apiSortKey(sort),
      desc,
    });
    setCourses(data);
  }

  useEffect(() => {
    if (!semesterId) return;
    load().catch(console.error);
  }, [semesterId, sort, desc]);

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
    if (!semesterId || !code.trim()) return;
    await api.createCourse({ semester_id: Number(semesterId), code: code.trim(), credits: Number(credits) });
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
      setSemesterSettingsOpen(false);
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

  if (!semesterId) return <Navigate to="/gpa" replace />;
  if (semesters.length && !current) return <Navigate to="/gpa" replace />;
  if (!current) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="gradebook-title-row">
            <h1>{current.name}</h1>
            <button
              type="button"
              className="cat-gear"
              aria-label="Semester settings"
              onClick={() => {
                setSaveError("");
                setSemesterSettingsOpen(true);
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
        <div className="row">
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
              navigate("/gpa");
            }}
          >
            Delete semester
          </button>
        </div>
      </div>

      <div className="grid-stats semester-stats">
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

      <div className="panel table-wrap">
        {courses.length === 0 ? (
          <div className="empty">No classes yet. Add one below.</div>
        ) : (
          <table>
            <thead>
              <tr>
                {sortCols.map(([key, label]) => (
                  <th key={key}>
                    <button className={sortHeaderClass(key)} onClick={() => toggleSort(key)}>
                      {label}
                      {sortHeaderArrow(key)}
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
                  <td className="mono">{c.credits}</td>
                  <td>
                    <span className={`letter ${letterClass(c.letter)}`}>{c.letter || "—"}</span>
                  </td>
                  <td className="mono">{fmtGpa(c.quality_points)}</td>
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
        <form className="row course-add-form" onSubmit={addCourse}>
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
      </div>

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
      />
    </>
  );
}

function averageDelta(courses) {
  const deltas = (courses || []).map((c) => c.exam_impact?.delta).filter((n) => n != null && !Number.isNaN(n));
  if (!deltas.length) return null;
  return deltas.reduce((sum, n) => sum + n, 0) / deltas.length;
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

function CourseMoveMenu({ course, semesters, onMove, onDelete }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0, ready: false });
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const others = semesters.filter((s) => s.id !== course.semester_id);

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
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
