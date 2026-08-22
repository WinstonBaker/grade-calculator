const headers = { "Content-Type": "application/json" };

async function req(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  meta: () => req("/api/meta"),
  semesters: () => req("/api/semesters"),
  createSemester: (body) => req("/api/semesters", { method: "POST", headers, body: JSON.stringify(body) }),
  patchSemester: (id, body) => req(`/api/semesters/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
  deleteSemester: (id) => req(`/api/semesters/${id}`, { method: "DELETE" }),
  courses: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") q.set(k, v);
    });
    const suffix = q.toString() ? `?${q}` : "";
    return req(`/api/courses${suffix}`);
  },
  createCourse: (body) => req("/api/courses", { method: "POST", headers, body: JSON.stringify(body) }),
  course: (id) => req(`/api/courses/${id}`),
  patchCourse: (id, body) => req(`/api/courses/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
  deleteCourse: (id) => req(`/api/courses/${id}`, { method: "DELETE" }),
  updateScale: (id, rows) =>
    req(`/api/courses/${id}/scale`, { method: "PUT", headers, body: JSON.stringify({ rows }) }),
  resetScale: (id, profileId) =>
    req(`/api/courses/${id}/scale/default`, {
      method: "POST",
      headers,
      body: JSON.stringify(profileId ? { scale_profile_id: profileId } : {}),
    }),
  scaleProfiles: () => req("/api/scale-profiles"),
  createScaleProfile: (body = {}) =>
    req("/api/scale-profiles", { method: "POST", headers, body: JSON.stringify(body) }),
  patchScaleProfile: (id, body) =>
    req(`/api/scale-profiles/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
  deleteScaleProfile: (id) => req(`/api/scale-profiles/${id}`, { method: "DELETE" }),
  createCategory: (body) => req("/api/categories", { method: "POST", headers, body: JSON.stringify(body) }),
  patchCategory: (id, body) => req(`/api/categories/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
  reorderCategories: (courseId, categoryIds) =>
    req(`/api/courses/${courseId}/categories/order`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ category_ids: categoryIds }),
    }),
  deleteCategory: (id) => req(`/api/categories/${id}`, { method: "DELETE" }),
  createAssignment: (body) => req("/api/assignments", { method: "POST", headers, body: JSON.stringify(body) }),
  patchAssignment: (id, body) => req(`/api/assignments/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
  deleteAssignment: (id) => req(`/api/assignments/${id}`, { method: "DELETE" }),
  gpa: () => req("/api/gpa"),
  appearance: () => req("/api/appearance"),
  putAppearance: (body) => req("/api/appearance", { method: "PUT", headers, body: JSON.stringify(body) }),
  semesterSnapshots: (id) => req(`/api/semesters/${id}/snapshots`),
  recordSemesterSnapshot: (id) => req(`/api/semesters/${id}/snapshots`, { method: "POST" }),
  patchSemesterSnapshot: (semesterId, snapshotId, body) =>
    req(`/api/semesters/${semesterId}/snapshots/${snapshotId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    }),
  deleteSemesterSnapshots: (id, body) =>
    req(`/api/semesters/${id}/snapshots`, { method: "DELETE", headers, body: JSON.stringify(body) }),
  recordAllSnapshots: () => req("/api/snapshots/record-all", { method: "POST" }),
  gradePrompt: () => req("/api/grade-prompt"),
  snoozeGradePrompt: () => req("/api/grade-prompt/snooze", { method: "POST" }),
  updates: () => req("/api/updates"),
  applyUpdate: () => req("/api/updates/apply", { method: "POST" }),
  downloadUpdate: () => req("/api/updates/apply", { method: "POST" }),
  dismissUpdate: (body) => req("/api/updates/dismiss", { method: "POST", headers, body: JSON.stringify(body) }),
  patchSettings: (body) => req("/api/settings", { method: "PATCH", headers, body: JSON.stringify(body) }),
  createFumble: (body) => req("/api/fumbles", { method: "POST", headers, body: JSON.stringify(body) }),
  deleteFumble: (id) => req(`/api/fumbles/${id}`, { method: "DELETE" }),
};

export function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

export function fmtGpa(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(3);
}

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

/** Letter → quality-point options for a course GP override dropdown. */
export function gpOptions(course) {
  if (course?.scale?.length) {
    return course.scale.map((row) => [row.letter, row.quality_points]);
  }
  return FALLBACK_GP_OPTIONS;
}

export function gpSelectValue(gp, options) {
  if (gp === null || gp === undefined) return "";
  const match = options.find(([, v]) => Math.abs(v - Number(gp)) < 1e-6);
  return match ? String(match[1]) : String(gp);
}

export function fmtScore(n) {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  return v > 0 ? `+${v}` : String(v);
}

/** Term score: round((GPA − target) × credits × 3). */
export function termScore(qualityPoints, credits, targetGp = 4.0) {
  if (qualityPoints == null || credits == null || Number.isNaN(Number(qualityPoints))) return null;
  return Math.round((Number(qualityPoints) - Number(targetGp)) * Number(credits) * 3);
}

/** Letter/GPA/score from the course percent, ignoring GP override. */
export function trueGradeFromCourse(course, targetGp = 4.0) {
  const grade = gradeFromPercent(course?.percent, course?.scale, course?.grade_rounding ?? null);
  const letter = grade.letter ?? course?.natural_letter ?? null;
  const qualityPoints = grade.quality_points ?? course?.natural_quality_points ?? null;
  const score =
    course?.natural_score != null && grade.letter != null
      ? course.natural_score
      : termScore(qualityPoints, course?.credits, targetGp);
  return { letter, qualityPoints, score };
}

export function fmtDelta(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  const text = v.toFixed(1);
  return v > 0 ? `+${text}` : text;
}

export function scoreClass(n) {
  if (n === null || n === undefined) return "";
  const v = Number(n);
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return "score-zero";
}

/** Exact letter → CSS class for the grade color scale. */
export function letterClass(letter) {
  if (!letter) return "";
  const map = {
    "A+": "grade-ap",
    A: "grade-a",
    "A-": "grade-am",
    "B+": "grade-bp",
    B: "grade-b",
    "B-": "grade-bm",
    "C+": "grade-cp",
    C: "grade-c",
    "C-": "grade-cm",
    "D+": "grade-dp",
    D: "grade-d",
    "D-": "grade-dm",
    F: "grade-f",
  };
  return map[letter] || "grade-f";
}

/** Map a percent to letter + quality points using the course scale (highest cutoff ≤ percent). */
/** Percent as the professor would round it (92.5 → 93 at 0 decimals). */
export function roundHalfUp(percent, decimals) {
  if (percent == null || decimals == null || Number.isNaN(Number(percent))) return percent;
  const factor = 10 ** Number(decimals);
  return Math.floor(Number(percent) * factor + 0.5) / factor;
}

/** Lowest raw percent that still rounds up to `cutoff`. */
export function cutoffWithRounding(cutoff, decimals) {
  if (decimals == null) return cutoff;
  return Number(cutoff) - 0.5 / 10 ** Number(decimals);
}

export function gradeFromPercent(percent, scale, rounding = null) {
  if (percent == null || Number.isNaN(Number(percent))) return { letter: null, quality_points: null };
  const value = roundHalfUp(percent, rounding);
  const rows = Array.isArray(scale) && scale.length ? scale : [];
  const eligible = rows.filter((row) => Number(row.min_percent) <= Number(value));
  if (!eligible.length) return { letter: null, quality_points: null };
  const best = eligible.reduce((a, row) =>
    Number(row.min_percent) > Number(a.min_percent) ? row : a
  );
  return { letter: best.letter, quality_points: best.quality_points };
}

/** Map a percent to a letter using the course scale (highest cutoff ≤ percent). */
export function letterFromPercent(percent, scale) {
  return gradeFromPercent(percent, scale).letter;
}

/** Weight to use when treating a category as the exam in a what-if. */
export function examCategoryWeight(cat) {
  if (!cat) return 0;
  if (cat.weight_per_item != null && cat.weight_per_item !== "") {
    const n = Number(cat.score_count) || 0;
    return Number(cat.weight_per_item) * Math.max(n, 1);
  }
  return Number(cat.weight) || 0;
}

function regularAssignmentPercents(cat) {
  const out = [];
  for (const item of cat.assignments || []) {
    if (item.is_bonus) continue;
    const pct = assignmentPercent({
      display: item.display,
      earned: item.earned,
      possible: item.possible,
      isBonus: false,
    });
    if (pct != null) out.push(pct);
  }
  return out;
}

export function replaceMinWithPercent(cat, replacement) {
  const regular = regularAssignmentPercents(cat);
  if (!regular.length) return null;
  if (replacement == null || Number.isNaN(Number(replacement))) {
    return regular.reduce((sum, n) => sum + n, 0) / regular.length;
  }
  const scores = [...regular];
  const lowest = Math.min(...scores);
  const exam = Number(replacement);
  if (exam > lowest) {
    scores.splice(scores.indexOf(lowest), 1);
    scores.push(exam);
  }
  return scores.reduce((sum, n) => sum + n, 0) / scores.length;
}

function assignmentPossible(item) {
  const possible = Number(item?.possible);
  if (Number.isFinite(possible) && possible !== 0) return possible;
  return 100;
}

/** Points-based overall if the exam category scores `examPercent` (out of 100). */
function projectPointsPercentFromExam(course, examCategoryId, examPercent) {
  const examPct = Number(examPercent);
  if (!Number.isFinite(examPct)) return null;
  let earned = 0;
  let possible = 0;
  let bonus = 0;
  let anyRow = false;
  for (const cat of course.categories || []) {
    if (cat.id === examCategoryId) {
      const scored = (cat.assignments || []).filter((item) => !item.is_bonus && item.earned != null);
      const n = Math.max(scored.length, 1);
      earned += examPct * n;
      possible += 100 * n;
      anyRow = true;
      continue;
    }
    for (const item of cat.assignments || []) {
      if (item.is_bonus) {
        if (cat.include_bonus && item.earned != null) bonus += Number(item.earned);
        continue;
      }
      if (item.earned == null || !Number.isFinite(Number(item.earned))) continue;
      anyRow = true;
      earned += Number(item.earned);
      possible += assignmentPossible(item);
    }
  }
  if (!anyRow || possible === 0) return null;
  return (100 * (earned + bonus)) / possible + (Number(course.bonus_points) || 0);
}

/** Overall course percent if `examCategoryId` scores `examPercent`. */
export function projectPercentFromExam(course, examCategoryId, examPercent) {
  if (course == null || examCategoryId == null || examPercent == null || Number.isNaN(Number(examPercent))) {
    return null;
  }
  if ((course.grading_mode || "weighted") === "points") {
    return projectPointsPercentFromExam(course, examCategoryId, examPercent);
  }
  const examPct = Number(examPercent);
  const used = [];
  for (const cat of course.categories || []) {
    let pct = null;
    let weight = 0;
    if (cat.id === examCategoryId) {
      pct = examPct;
      weight = examCategoryWeight(cat);
    } else if (cat.aggregation !== "points_ratio" && cat.replace_with_category_id === examCategoryId) {
      pct = replaceMinWithPercent(cat, examPct);
      weight = cat.effective_weight || examCategoryWeight(cat);
    } else if (cat.percent != null && cat.effective_weight) {
      pct = cat.percent;
      weight = cat.effective_weight;
    }
    if (pct != null && weight) used.push([weight, pct]);
  }
  if (!used.length) return null;
  const wsum = used.reduce((sum, [w]) => sum + w, 0);
  if (!wsum) return null;
  return used.reduce((sum, [w, p]) => sum + w * p, 0) / wsum + (Number(course.bonus_points) || 0);
}

/** Exam percent that makes the overall course grade equal `cutoff`. */
export function examNeededForCutoff(course, examCategoryId, cutoff) {
  const overall = (exam) => projectPercentFromExam(course, examCategoryId, exam);
  const p0 = overall(0);
  const p100 = overall(100);
  if (p0 == null || p100 == null) return null;
  const p50 = overall(50);
  const linearMid = p0 + 0.5 * (p100 - p0);
  const slope = (p100 - p0) / 100;
  if (p50 != null && Math.abs(p50 - linearMid) < 1e-6) {
    if (Math.abs(slope) < 1e-15) return null;
    return (cutoff - p0) / slope;
  }
  let lo = -100;
  let hi = 300;
  const pLo = overall(lo);
  const pHi = overall(hi);
  if (pLo == null || pHi == null || Math.abs(pHi - pLo) < 1e-15) return null;
  if (pHi < cutoff || pLo >= cutoff) {
    return lo + ((cutoff - pLo) * (hi - lo)) / (pHi - pLo);
  }
  for (let i = 0; i < 48; i += 1) {
    const mid = (lo + hi) / 2;
    const got = overall(mid);
    if (got == null) return null;
    if (got >= cutoff) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function examNeededRows(course, examCategoryId) {
  const scale = course?.scale || [];
  return scale
    .filter((row) => row.letter !== "F")
    .map((row) => ({
      letter: row.letter,
      cutoff_percent: row.min_percent,
      quality_points: row.quality_points,
      needed: examNeededForCutoff(
        course,
        examCategoryId,
        cutoffWithRounding(row.min_percent, course?.grade_rounding ?? null)
      ),
    }));
}

export function defaultExamCategoryId(categories) {
  if (!categories?.length) return null;
  const finalNamed = categories.find((cat) => /final/i.test(cat.name || ""));
  if (finalNamed) return finalNamed.id;
  const examNamed = categories.find((cat) => /exam/i.test(cat.name || ""));
  if (examNamed) return examNamed.id;
  const empty = categories.find(
    (cat) => cat.percent == null && (cat.weight || cat.weight_per_item)
  );
  if (empty) return empty.id;
  const unscored = categories.find((cat) => cat.percent == null);
  if (unscored) return unscored.id;
  return categories[categories.length - 1].id;
}

/**
 * Percent for an assignment score string or earned/possible pair.
 * Returns null for empty/invalid values, or bonus points without a possible max.
 */
export function assignmentPercent({ display, earned, possible, isBonus }) {
  if (isBonus && (possible == null || possible === 0)) return null;

  if (display !== undefined && display !== null) {
    const raw = String(display).trim();
    if (!raw) return null;
    const ratio = raw.match(/^(-?\d+(?:\.\d+)?)\s*[/,]\s*(-?\d+(?:\.\d+)?)$/);
    if (ratio) {
      const e = Number(ratio[1]);
      const p = Number(ratio[2]);
      if (!Number.isFinite(e) || !Number.isFinite(p) || p === 0) return null;
      return (100 * e) / p;
    }
    const alone = Number(raw);
    if (!Number.isFinite(alone)) return null;
    return alone;
  }

  if (earned == null || !Number.isFinite(Number(earned))) return null;
  if (possible != null && Number(possible) !== 0) {
    return (100 * Number(earned)) / Number(possible);
  }
  return Number(earned);
}
