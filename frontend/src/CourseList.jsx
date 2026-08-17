import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, fmtGpa, fmtPct, fmtScore, letterClass, scoreClass } from "./api";

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
  const [params, setParams] = useSearchParams();
  const semesterId = params.get("semester");
  const [courses, setCourses] = useState([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("code");
  const [desc, setDesc] = useState(false);
  const [code, setCode] = useState("");
  const [credits, setCredits] = useState("3");

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
          <div className="stat">
            <div className="label">Semester score</div>
            <div className={`value ${scoreClass(current.term_score)}`}>{fmtScore(current.term_score)}</div>
          </div>
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
              <option value="spring">Spring</option>
              <option value="summer">Summer</option>
              <option value="fall">Fall</option>
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
        <input className="input" style={{ width: 90 }} value={credits} onChange={(e) => setCredits(e.target.value)} />
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
                {SORTS.map(([key, label]) => (
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
                  <td className={`mono ${scoreClass(c.score)}`}>{fmtScore(c.score)}</td>
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
                    <button className="btn small danger" onClick={() => removeCourse(c.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
