import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export const DEFAULT_FLAGS = [
  { id: "important", name: "Important", color: "#e4b86d" },
  { id: "review", name: "Review", color: "#8bb4e8" },
  { id: "missing", name: "Missing", color: "#e07a7a" },
];

const FALLBACK_COLORS = ["#e4b86d", "#8bb4e8", "#7dce9a", "#e07a7a", "#c084fc"];

function validColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
}

export function normalizeFlags(flags) {
  if (!Array.isArray(flags)) return DEFAULT_FLAGS.map((flag) => ({ ...flag }));
  const seen = new Set();
  return flags
    .map((flag, index) => {
      const id = String(flag?.id || `flag-${index + 1}`);
      if (seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        name: String(flag?.name || "").trim() || `Flag ${index + 1}`,
        color: validColor(flag?.color, FALLBACK_COLORS[index % FALLBACK_COLORS.length]),
      };
    })
    .filter(Boolean);
}

export function flagsForAssignment(assignment, flags) {
  const ids = new Set((assignment?.flag_ids || []).map(String));
  return normalizeFlags(flags).filter((flag) => ids.has(String(flag.id)));
}

export function flaggedAssignmentsForCourse(course, flags) {
  const output = [];
  for (const category of course?.categories || []) {
    for (const assignment of category.assignments || []) {
      const assignmentFlags = flagsForAssignment(assignment, flags);
      if (!assignmentFlags.length) continue;
      output.push({
        courseId: course.id,
        categoryId: category.id,
        assignmentId: assignment.id,
        courseName: course.display_code || course.displayCode || course.code,
        sectionName: category.name,
        assignmentName: assignment.name || "Assignment",
        flags: assignmentFlags,
      });
    }
  }
  return output;
}

export function flaggedAssignmentsForSemester(semester, flags) {
  return (semester?.courses || []).flatMap((course) =>
    flaggedAssignmentsForCourse(course, flags).map((item) => ({ ...item, semesterName: semester.name }))
  );
}

export function FlagIcon({ color = "currentColor", size = 18, className = "" }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d="M4.35 4.71 9.55 21.21"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth="2.15"
      />
      <path
        d="M6.72 4.75c2.8-1.7 7.22-1.02 9.92.08 2.5 1.1 4.9 2 6.3.2-.8 3.5-3.1 5.5-6.2 6.8s-5.37 1.1-6.53 3.46c-.14-.3-2.32-7.02-3.49-10.54Z"
        fill={color}
      />
    </svg>
  );
}

export function FlagSummaryButton({ items, flags = [], semester = false }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function close(event) {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    }
    function escape(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!items?.length) return null;

  const knownFlags = normalizeFlags(flags);
  const groups = knownFlags
    .map((flag) => ({
      flag,
      items: items.filter((item) => item.flags?.some((itemFlag) => String(itemFlag.id) === String(flag.id))),
    }))
    .filter((group) => group.items.length);

  return (
    <span className="flag-summary" ref={wrapRef}>
      <button
        className="flag-summary-button"
        type="button"
        aria-label={semester ? "View flagged assignments in this semester" : "View flagged assignments"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <FlagIcon size={17} />
      </button>
        {open ? (
        <div className="flag-summary-popover" role="dialog">
            {groups.map((group) => (
              <section className="flag-summary-group" key={group.flag.id}>
                <strong className="flag-summary-group-heading">
                  <FlagIcon color={group.flag.color} size={16} />
                  {group.flag.name}
                </strong>
                <div className="flag-summary-list">
                  {group.items.map((item, index) => (
                    <div className="flag-summary-item" key={`${group.flag.id}-${item.courseId}-${item.sectionName}-${item.assignmentName}-${index}`}>
                      <Link
                        to={`/courses/${item.courseId}#assignment-${item.assignmentId}`}
                        onClick={() => setOpen(false)}
                      >
                        {semester ? `${item.courseName} / ${item.sectionName} / ${item.assignmentName}` : `${item.sectionName} / ${item.assignmentName}`}
                      </Link>
                    </div>
                  ))}
                </div>
              </section>
            ))}
        </div>
      ) : null}
    </span>
  );
}

export function newFlagId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `flag-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export { FALLBACK_COLORS };
