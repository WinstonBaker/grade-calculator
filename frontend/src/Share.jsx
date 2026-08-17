import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

export default function Share({ semesters, onChange }) {
  const [selected, setSelected] = useState(() => new Set());
  const [importSemester, setImportSemester] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    if (!importSemester && semesters[0]) setImportSemester(String(semesters[0].id));
  }, [semesters, importSemester]);

  const allIds = useMemo(
    () => semesters.flatMap((sem) => (sem.courses || []).map((course) => course.id)),
    [semesters]
  );

  function toggleCourse(id, on) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleSemester(sem, on) {
    const ids = (sem.courses || []).map((c) => c.id);
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  }

  async function exportSelected() {
    setError("");
    setMessage("");
    if (!selected.size) {
      setError("Select at least one class.");
      return;
    }
    try {
      const payload = await api.exportCourses([...selected]);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "grade-calculator-classes.json";
      link.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${payload.courses.length} class${payload.courses.length === 1 ? "" : "es"}.`);
    } catch (err) {
      setError(err.message);
    }
  }

  async function importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setMessage("");
    if (!importSemester) {
      setError("Pick a semester to import into.");
      return;
    }
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const courses = Array.isArray(payload?.courses) ? payload.courses : Array.isArray(payload) ? payload : null;
      if (!courses?.length) {
        setError("That file has no classes to import.");
        return;
      }
      const created = await api.importCourses({
        semester_id: Number(importSemester),
        courses,
      });
      setMessage(`Imported ${created.length} class${created.length === 1 ? "" : "es"}.`);
      onChange?.();
    } catch (err) {
      setError(err instanceof SyntaxError ? "That file is not valid JSON." : err.message);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Share classes</h1>
          <p>Export codes, credits, and category weights — not scores — then import them into another copy of the app.</p>
        </div>
        <div className="row">
          <button className="btn primary" type="button" onClick={exportSelected} disabled={!selected.size}>
            Export selected
          </button>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="pos">{message}</p> : null}

      <section className="panel" style={{ marginBottom: 16 }}>
        <h2>Export</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          A semester check is full when every class is selected, empty when none are, and a dash when only some are.
        </p>
        {semesters.length === 0 ? (
          <div className="empty">Add a semester first.</div>
        ) : (
          <div className="share-tree">
            {semesters.map((sem) => (
              <SemesterBranch
                key={sem.id}
                semester={sem}
                selected={selected}
                onToggleCourse={toggleCourse}
                onToggleSemester={toggleSemester}
              />
            ))}
            {allIds.length ? (
              <label className="checkbox share-all">
                <input
                  type="checkbox"
                  checked={allIds.length > 0 && allIds.every((id) => selected.has(id))}
                  ref={(el) => {
                    if (el) {
                      const count = allIds.filter((id) => selected.has(id)).length;
                      el.indeterminate = count > 0 && count < allIds.length;
                    }
                  }}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(allIds) : new Set())
                  }
                />
                All classes
              </label>
            ) : (
              <div className="empty">No classes to export yet.</div>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Import</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Adds the exported class templates to the semester you pick. Scores are not copied.
        </p>
        <div className="row">
          <label className="muted">
            Destination semester
            <select
              className="select"
              style={{ display: "block", marginTop: 4 }}
              value={importSemester}
              onChange={(e) => setImportSemester(e.target.value)}
            >
              {semesters.map((sem) => (
                <option key={sem.id} value={sem.id}>
                  {sem.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" onClick={() => fileRef.current?.click()}>
            Choose file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={importFile}
          />
        </div>
      </section>
    </>
  );
}

function SemesterBranch({ semester, selected, onToggleCourse, onToggleSemester }) {
  const courses = semester.courses || [];
  const ids = courses.map((c) => c.id);
  const count = ids.filter((id) => selected.has(id)).length;
  const checkboxRef = useRef(null);

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = count > 0 && count < ids.length;
    }
  }, [count, ids.length]);

  return (
    <details className="share-semester" open>
      <summary>
        <label className="checkbox" onClick={(e) => e.stopPropagation()}>
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={ids.length > 0 && count === ids.length}
            disabled={!ids.length}
            onChange={(e) => onToggleSemester(semester, e.target.checked)}
          />
          <span>{semester.name}</span>
          <span className="muted">
            {count}/{ids.length}
          </span>
        </label>
      </summary>
      <div className="share-classes">
        {courses.length === 0 ? (
          <p className="muted">No classes in this semester.</p>
        ) : (
          courses.map((course) => (
            <label key={course.id} className="checkbox">
              <input
                type="checkbox"
                checked={selected.has(course.id)}
                onChange={(e) => onToggleCourse(course.id, e.target.checked)}
              />
              <span>{course.code}</span>
              <span className="muted">{course.credits}</span>
            </label>
          ))
        )}
      </div>
    </details>
  );
}
