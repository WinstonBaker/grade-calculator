import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { api, fmtGpa, fmtScore, scoreClass } from "./api";
import CourseList from "./CourseList.jsx";
import { CreditLabelProvider } from "./creditLabel.jsx";
import FeedbackBubble from "./FeedbackBubble.jsx";
import Gradebook from "./Gradebook.jsx";
import GpaDashboard from "./GpaDashboard.jsx";
import { useToasts } from "./notifications.jsx";
import Settings from "./Settings.jsx";
import { SEASONS, TERM_SEQUENCE } from "./seasons.js";
import { applyThemeColors, loadAppearance, parseAppearance, saveAppearance } from "./theme";

const APPEARANCE_SAVE_MS = 350;
const GRADE_PROMPT_TOAST_ID = "grade-record-prompt";
const UPDATE_TOAST_ID = "app-update";
const UPDATE_STATUS_TOAST_ID = "app-update-status";
const UPDATE_CHECK_MS = 7 * 24 * 60 * 60 * 1000;

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

function hasOlderUnlocked(semesters, year, season) {
  const nextKey = semesterKey(year, season);
  return semesters.some((sem) => {
    if (sem.progression_locked) return false;
    const key = semesterKey(sem.year, sem.season);
    return key[0] < nextKey[0] || (key[0] === nextKey[0] && key[1] < nextKey[1]);
  });
}

function GradePromptSelect({ semesters, defaultId, selectedRef }) {
  const initial = semesters.some((sem) => sem.id === defaultId)
    ? defaultId
    : semesters[0]?.id ?? "";
  const [value, setValue] = useState(String(initial));

  useEffect(() => {
    selectedRef.current = Number(value);
  }, [selectedRef, value]);

  return (
    <label className="toast-select-label">
      <span className="muted">Semester</span>
      <select
        className="select toast-select"
        value={value}
        aria-label="Semester to record"
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          selectedRef.current = Number(next);
          api.patchSettings({ default_recording_semester_id: Number(next) }).catch(() => {});
        }}
      >
        {semesters.map((sem) => (
          <option key={sem.id} value={sem.id}>
            {sem.progression_locked ? `${sem.name} (locked)` : sem.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function App() {
  const { warning, push, dismiss } = useToasts();
  const [semesters, setSemesters] = useState([]);
  const [year, setYear] = useState("2025");
  const [season, setSeason] = useState("fall");
  const [appearance, setAppearance] = useState(() => loadAppearance());
  const appearanceSaveTimer = useRef(null);
  const appearanceReady = useRef(false);
  const gradePromptSemesterRef = useRef(null);
  const [githubRepo, setGithubRepo] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const selectedSemester = new URLSearchParams(location.search).get("semester");

  async function refresh() {
    try {
      const [nextSemesters, meta] = await Promise.all([
        api.semesters(),
        api.meta().catch(() => null),
      ]);
      setSemesters(nextSemesters);
      if (meta) setGithubRepo(meta.github_repo || "");
    } catch (err) {
      warning(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, [location.pathname]);

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
        gradePromptSemesterRef.current = status.default_semester_id;
        push({
          id: GRADE_PROMPT_TOAST_ID,
          type: "persistent",
          tone: "info",
          title: "Grade progression",
          message: "Record current grades for progression chart",
          body: (
            <GradePromptSelect
              semesters={status.semesters || []}
              defaultId={status.default_semester_id}
              selectedRef={gradePromptSemesterRef}
            />
          ),
          dismissOnConfirm: false,
          onConfirm: async () => {
            const semesterId = gradePromptSemesterRef.current;
            try {
              const latest = await api.gradePrompt();
              const selected = (latest.semesters || []).find((sem) => sem.id === semesterId);
              if (selected?.progression_locked) {
                warning("Progression is locked for this semester");
                return;
              }
              await api.recordSemesterSnapshot(semesterId);
              shown.current = false;
              dismiss(GRADE_PROMPT_TOAST_ID);
              await refresh();
              window.dispatchEvent(new CustomEvent("grade-snapshots-updated"));
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
    const nextYear = Number(year);
    let lockPrevious = false;
    if (hasOlderUnlocked(semesters, nextYear, season)) {
      lockPrevious = window.confirm("Lock previous semester's grade progression graphs?");
    }
    try {
      const created = await api.createSemester({
        year: nextYear,
        season,
        included: true,
        lock_previous: lockPrevious,
      });
      await refresh();
      navigate(`/courses?semester=${created.id}`);
    } catch (err) {
      warning(err.message);
    }
  }

  return (
    <CreditLabelProvider appearance={appearance}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <h1>Grade Calculator</h1>
          </div>
          <nav className="nav-block">
            <div className="nav-list nav-list-views">
              <NavLink to="/gpa" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
                GPA dashboard
              </NavLink>
              <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
                Settings
              </NavLink>
            </div>
            <h2>Semesters</h2>
            <div className="nav-list">
              {semesters.map((sem) => (
                <NavLink
                  key={sem.id}
                  to={`/courses?semester=${sem.id}`}
                  className={() => `nav-link ${selectedSemester === String(sem.id) ? "active" : ""}`}
                >
                  <span>{sem.name}</span>
                  {sem.term_gpa != null ? (
                    <span className={`meta ${sem.included ? "" : "meta-excluded"}`}>
                      <span className="meta-gpa">{fmtGpa(sem.term_gpa)}</span>
                      {appearance.showScore !== false && sem.term_score != null ? (
                        <span
                          className={`meta-score ${sem.included ? scoreClass(sem.term_score) : ""}`}
                        >
                          {fmtScore(sem.term_score)}
                        </span>
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
          <FeedbackBubble repo={githubRepo} />
        </aside>
        <main className="main" key={location.pathname}>
          <Routes>
            <Route path="/" element={<Navigate to="/gpa" replace />} />
            <Route path="/courses" element={<CourseList semesters={semesters} onChange={refresh} />} />
            <Route
              path="/courses/:id"
              element={<Gradebook onChange={refresh} colorAssignmentGrades={appearance.gradeColors} />}
            />
            <Route path="/gpa" element={<GpaDashboard onChange={refresh} />} />
            <Route
              path="/settings"
              element={
                <Settings appearance={appearance} onAppearanceChange={setAppearance} onChange={refresh} />
              }
            />
          </Routes>
        </main>
      </div>
    </CreditLabelProvider>
  );
}
