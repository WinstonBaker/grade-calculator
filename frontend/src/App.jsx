import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { api, fmtGpa, fmtScore, scoreClass } from "./api";
import CourseList from "./CourseList.jsx";
import Gradebook from "./Gradebook.jsx";
import GpaDashboard from "./GpaDashboard.jsx";
import Settings from "./Settings.jsx";
import { applyThemeColors, loadAppearance, saveAppearance } from "./theme";

const SEASONS = [
  ["spring", "Spring"],
  ["summer", "Summer"],
  ["fall", "Fall"],
];

export default function App() {
  const [semesters, setSemesters] = useState([]);
  const [error, setError] = useState("");
  const [year, setYear] = useState("2025");
  const [season, setSeason] = useState("fall");
  const [appearance, setAppearance] = useState(() => loadAppearance());
  const navigate = useNavigate();
  const location = useLocation();
  const selectedSemester = new URLSearchParams(location.search).get("semester");

  async function refresh() {
    try {
      setSemesters(await api.semesters());
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    applyThemeColors(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  async function addSemester(e) {
    e.preventDefault();
    try {
      const created = await api.createSemester({
        year: Number(year),
        season,
        included: true,
      });
      await refresh();
      navigate(`/courses?semester=${created.id}`);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Grade Calculator</h1>
          <p>Weighted courses, GPA, and what-ifs</p>
        </div>
        <nav className="nav-block">
          <h2>Views</h2>
          <NavLink
            to="/courses"
            end
            className={() => `nav-link ${location.pathname === "/courses" && !selectedSemester ? "active" : ""}`}
          >
            All courses
          </NavLink>
          <NavLink to="/gpa" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            GPA dashboard
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            Settings
          </NavLink>
        </nav>
        <nav className="nav-block">
          <h2>Semesters</h2>
          <div className="nav-list">
            {semesters.map((sem) => (
              <NavLink
                key={sem.id}
                to={`/courses?semester=${sem.id}`}
                className={() => `nav-link ${selectedSemester === String(sem.id) ? "active" : ""}`}
              >
                <span>{sem.name}</span>
                {sem.term_gpa != null || sem.term_score != null ? (
                  <span className="meta">
                    {sem.term_gpa != null ? <span>{fmtGpa(sem.term_gpa)}</span> : null}
                    {sem.term_score != null ? (
                      <span className={scoreClass(sem.term_score)}>{fmtScore(sem.term_score)}</span>
                    ) : null}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </div>
          <form className="semester-add" onSubmit={addSemester}>
            <label className="muted">
              Year
              <input
                className="input"
                type="number"
                min="2000"
                max="2100"
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />
            </label>
            <label className="muted">
              Term
              <select className="select" value={season} onChange={(e) => setSeason(e.target.value)}>
                {SEASONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn small primary" type="submit">
              Add semester
            </button>
          </form>
        </nav>
      </aside>
      <main className="main">
        {error ? <p className="error">{error}</p> : null}
        <Routes>
          <Route path="/" element={<Navigate to="/gpa" replace />} />
          <Route path="/courses" element={<CourseList semesters={semesters} onChange={refresh} />} />
          <Route
            path="/courses/:id"
            element={<Gradebook onChange={refresh} colorAssignmentGrades={appearance.gradeColors} />}
          />
          <Route path="/gpa" element={<GpaDashboard />} />
          <Route
            path="/settings"
            element={
              <Settings appearance={appearance} onAppearanceChange={setAppearance} />
            }
          />
        </Routes>
      </main>
    </div>
  );
}
