import { Link } from "react-router-dom";
import { fmtDelta, fmtPct, letterClass, scoreClass } from "./api";

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

export default function ExamImpactTable({ courses, onPatch, empty = "Pick test and exam categories to compare." }) {
  if (!courses?.length) return <div className="empty">{empty}</div>;
  const editable = typeof onPatch === "function";

  return (
    <div className="table-wrap">
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
            return (
              <tr key={course.id}>
                <td>
                  <Link to={`/courses/${course.id}`}>{course.code}</Link>
                </td>
                <td>
                  {editable ? (
                    <select
                      className="select"
                      value={course.test_category_id || ""}
                      onChange={(e) =>
                        onPatch(course.id, { test_category_id: e.target.value ? Number(e.target.value) : null })
                      }
                    >
                      <option value="">Select</option>
                      {(course.categories || []).map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    impact?.test_name
                    || (course.categories || []).find((c) => c.id === course.test_category_id)?.name
                    || "—"
                  )}
                </td>
                <td>
                  {editable ? (
                    <select
                      className="select"
                      value={course.exam_category_id || ""}
                      onChange={(e) =>
                        onPatch(course.id, { exam_category_id: e.target.value ? Number(e.target.value) : null })
                      }
                    >
                      <option value="">Select</option>
                      {(course.categories || []).map((cat) => (
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
                  <span className={`letter ${letterClass(impact?.letter_before)}`}>
                    {impact?.letter_before || "—"}
                  </span>
                </td>
                <td>
                  <span className={`letter ${letterClass(impact?.letter_after)}`}>
                    {impact?.letter_after || "—"}
                  </span>
                </td>
                <td className={change === "up" ? "pos" : change === "down" ? "neg" : "muted"}>
                  {CHANGE_LABEL[change] || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
