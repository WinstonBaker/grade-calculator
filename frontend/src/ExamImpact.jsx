import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { courseGradeClass, fmtDelta, fmtPct, scoreClass } from "./api";

const CHANGE_LABEL = { up: "Up", down: "Down", same: "Same" };

export function ExamImpactStats({ summary }) {
  if (!summary) return null;
  return (
    <div className="grid-stats exam-impact-stats">
      <div className="stat">
        <div className="label">Avg exam vs tests</div>
        <div className={`value ${scoreClass(summary.avg_delta)}`}>{fmtDelta(summary.avg_delta)}</div>
      </div>
      <div className="stat">
        <div className="label">Letters up</div>
        <div className="value pos">{summary.letter_up || 0}</div>
      </div>
      <div className="stat">
        <div className="label">Letters down</div>
        <div className="value neg">{summary.letter_down || 0}</div>
      </div>
      <div className="stat">
        <div className="label">Unchanged</div>
        <div className="value">{summary.letter_same || 0}</div>
      </div>
    </div>
  );
}

function testCategoryIds(course) {
  if (course?.test_category_ids_configured === true) {
    return Array.isArray(course.test_category_ids) ? course.test_category_ids.map(Number) : [];
  }
  if (Array.isArray(course?.test_category_ids) && course.test_category_ids.length) {
    return course.test_category_ids.map(Number);
  }
  return inferredCategoryIds(course, /^(test|tests|midterm|midterms)$/i);
}

function inferredCategoryIds(course, pattern) {
  return (course?.categories || [])
    .filter((category) => !category.is_bonus_category && pattern.test(String(category.name || "").trim()))
    .map((category) => Number(category.id));
}

function examCategoryId(course) {
  if (course?.exam_category_id === -1) return "";
  if (course?.exam_category_id != null) return Number(course.exam_category_id);
  return inferredCategoryIds(course, /^(exam|exams|final|finals)$/i)[0] || "";
}

function TestCategoryMultiSelect({ course, value, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const categories = (course.categories || []).filter((cat) => !cat.is_bonus_category);
  const selected = new Set(value.map(Number));

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = categories
    .filter((cat) => selected.has(cat.id))
    .map((cat) => cat.name)
    .join(", ");

  function toggle(id) {
    const next = selected.has(id)
      ? value.filter((item) => Number(item) !== Number(id))
      : [...value, Number(id)];
    onChange(next);
  }

  return (
    <div className="exam-multi-select" ref={rootRef}>
      <button
        type="button"
        className="select exam-multi-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={label ? "" : "muted"}>{label || "Select"}</span>
      </button>
      {open ? (
        <div className="exam-multi-menu" role="listbox" aria-multiselectable="true">
          {categories.length === 0 ? (
            <div className="muted exam-multi-empty">No categories</div>
          ) : (
            categories.map((cat) => (
              <label key={cat.id} className="exam-multi-option">
                <input
                  type="checkbox"
                  checked={selected.has(cat.id)}
                  onChange={() => toggle(cat.id)}
                />
                <span>{cat.name}</span>
              </label>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function ExamImpactTable({ courses, onPatch, gradebookId = null, empty = "Pick test and exam categories to compare." }) {
  const editable = typeof onPatch === "function";
  const initializedDefaults = useRef(new Set());
  useEffect(() => {
    if (!editable) return;
    for (const course of courses) {
      const tests = testCategoryIds(course);
      const exam = examCategoryId(course);
      const hasSavedTests = course.test_category_ids_configured === true
        || (Array.isArray(course.test_category_ids) && course.test_category_ids.length);
      const key = String(course.id);
      if (!initializedDefaults.current.has(key)) {
        initializedDefaults.current.add(key);
        const patch = {};
        if (!hasSavedTests && tests.length) patch.test_category_ids = tests;
        if (course.exam_category_id == null && exam !== "") patch.exam_category_id = Number(exam);
        if (Object.keys(patch).length) Promise.resolve(onPatch(course.id, patch)).catch(() => {});
      }
    }
  }, [courses, editable, onPatch]);

  if (!courses?.length) return <div className="empty">{empty}</div>;

  return (
    <div className="table-wrap exam-impact-table-wrap">
      <table className="exam-impact-table">
        <thead>
          <tr>
            <th>Class</th>
            <th>Tests</th>
            <th>Exam</th>
            <th>Test %</th>
            <th>Exam %</th>
            <th>Δ</th>
            <th>Before</th>
            <th>After</th>
            <th>Letter</th>
          </tr>
        </thead>
        <tbody>
          {courses.map((course) => {
            const impact = course.exam_impact;
            const change = impact?.letter_change;
            const courseHref = gradebookId
              ? `/courses/${course.id}?gradebook=${encodeURIComponent(gradebookId)}`
              : `/courses/${course.id}`;
            const selectedTests = testCategoryIds(course);
            const hasBothPercents =
              impact?.test_percent != null &&
              !Number.isNaN(Number(impact.test_percent)) &&
              impact?.exam_percent != null &&
              !Number.isNaN(Number(impact.exam_percent));
            const afterIsOverridden = course.gp_override != null || course.pass_fail_override != null;
            const afterLetter = afterIsOverridden
              ? course.letter || course.pass_fail_override
              : impact?.letter_after;
            const afterClass = afterIsOverridden
              ? (course.gp_override === -1 ? "letter-neutral" : courseGradeClass(course))
              : courseGradeClass({ ...course, pass_fail_override: null, percent: impact?.percent_after, letter: impact?.letter_after });
            return (
              <tr key={course.id}>
                <td>
                  <Link to={courseHref}>{course.display_code || course.code}</Link>
                </td>
                <td>
                  {editable ? (
                    <TestCategoryMultiSelect
                      course={course}
                      value={selectedTests}
                      onChange={(ids) => onPatch(course.id, { test_category_ids: ids })}
                    />
                  ) : (
                    impact?.test_name
                    || selectedTests
                      .map((id) => (course.categories || []).find((c) => c.id === id)?.name)
                      .filter(Boolean)
                      .join(", ")
                    || "—"
                  )}
                </td>
                <td>
                  {editable ? (
                    <select
                      className="select"
                      value={examCategoryId(course)}
                      onChange={(e) =>
                        onPatch(course.id, { exam_category_id: e.target.value ? Number(e.target.value) : -1 })
                      }
                    >
                      <option value="">Select</option>
                      {(course.categories || []).filter((cat) => !cat.is_bonus_category).map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    impact?.exam_name
                    || (course.categories || []).find((c) => c.id === course.exam_category_id)?.name
                    || "—"
                  )}
                </td>
                <td className="mono">{fmtPct(impact?.test_percent)}</td>
                <td className="mono">{fmtPct(impact?.exam_percent)}</td>
                <td className={`mono ${scoreClass(impact?.delta)}`}>{fmtDelta(impact?.delta)}</td>
                <td>
                  {hasBothPercents ? (
                    <span className={`letter ${courseGradeClass({ ...course, pass_fail_override: null, percent: impact?.percent_before, letter: impact?.letter_before })}`}>
                      {impact?.letter_before || "—"}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {hasBothPercents ? (
                    <span className="course-letter-display">
                      <span className={`letter ${afterClass}`}>
                        {afterLetter || "—"}
                      </span>
                      {afterIsOverridden ? <span className="grade-override-marker" aria-label="Grade overridden">*</span> : null}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={hasBothPercents ? (change === "up" ? "pos" : change === "down" ? "neg" : "muted") : "muted"}>
                  {hasBothPercents ? CHANGE_LABEL[change] || "—" : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
