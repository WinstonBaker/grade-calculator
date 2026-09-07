import { semesterSortValue } from "./seasons.js";

export function buildCourseDisplayCodes(semesters = [], courses = null, semesterTitles = null) {
  const terms = semesters.map((term, index) => ({
    id: term.id,
    order: semesterSortValue(term, semesterTitles) + index / 1000,
  }));
  const termOrder = new Map(terms.map((term) => [String(term.id), term.order]));
  const rows = courses
    ? courses.map((course) => ({ course, order: termOrder.get(String(course.semester_id)) ?? 0 }))
    : semesters.flatMap((term) =>
        (term.courses || []).map((course) => ({ course, order: termOrder.get(String(term.id)) ?? 0 }))
      );
  const countsByTerm = new Map();
  rows.forEach(({ course }) => {
    const key = String(course.code || "").trim().toLowerCase();
    const termKey = String(course.semester_id);
    const termCounts = countsByTerm.get(termKey) || new Map();
    termCounts.set(key, (termCounts.get(key) || 0) + 1);
    countsByTerm.set(termKey, termCounts);
  });
  const maxPerTerm = new Map();
  countsByTerm.forEach((termCounts) => {
    termCounts.forEach((count, key) => {
      maxPerTerm.set(key, Math.max(maxPerTerm.get(key) || 0, count));
    });
  });
  const seenByTerm = new Map();
  const labels = new Map();
  [...rows]
    .sort((a, b) => a.order - b.order || Number(a.course.id) - Number(b.course.id))
    .forEach(({ course }) => {
      const key = String(course.code || "").trim().toLowerCase();
      const termKey = String(course.semester_id);
      const termSeen = seenByTerm.get(termKey) || new Map();
      const index = (termSeen.get(key) || 0) + 1;
      termSeen.set(key, index);
      seenByTerm.set(termKey, termSeen);
      labels.set(course.id, maxPerTerm.get(key) > 1 ? `${course.code} (${index})` : course.code);
    });
  return labels;
}
