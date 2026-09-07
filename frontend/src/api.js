const headers = { "Content-Type": "application/json" };
const responseCache = new Map();
const inFlightGets = new Map();
let cacheGeneration = 0;
const MAX_CACHED_RESPONSES = 48;

function cloneResponse(value) {
  if (value === null || value === undefined) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isCacheableGet(path) {
  const pathname = path.split("?", 1)[0];
  return /^\/api\/(meta|semesters|courses|gpa|academic-years)(?:\/|$)/.test(pathname);
}

function clearResponseCache() {
  cacheGeneration += 1;
  responseCache.clear();
  inFlightGets.clear();
}

function rememberResponse(path, value) {
  responseCache.delete(path);
  responseCache.set(path, value);
  while (responseCache.size > MAX_CACHED_RESPONSES) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

function scopedPath(path) {
  if (typeof window === "undefined" || !path.startsWith("/api/")) return path;
  const gradebookId = new URLSearchParams(window.location.search).get("gradebook");
  if (!gradebookId) return path;
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  if (!params.has("gradebook_id")) params.set("gradebook_id", gradebookId);
  return `${pathname}?${params.toString()}`;
}

async function req(path, options = {}, scopeGradebook = true) {
  const resolvedPath = scopeGradebook ? scopedPath(path) : path;
  const method = String(options.method || "GET").toUpperCase();
  const cacheable = method === "GET" && isCacheableGet(resolvedPath);

  if (!cacheable) {
    if (method !== "GET") clearResponseCache();
    const res = await fetch(resolvedPath, options);
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

  if (responseCache.has(resolvedPath)) return cloneResponse(responseCache.get(resolvedPath));
  if (inFlightGets.has(resolvedPath)) return cloneResponse(await inFlightGets.get(resolvedPath));

  const generation = cacheGeneration;
  const request = (async () => {
    const res = await fetch(resolvedPath, options);
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
    return res.status === 204 ? null : res.json();
  })();
  inFlightGets.set(resolvedPath, request);
  try {
    const value = await request;
    if (generation === cacheGeneration) rememberResponse(resolvedPath, value);
    return cloneResponse(value);
  } finally {
    if (inFlightGets.get(resolvedPath) === request) inFlightGets.delete(resolvedPath);
  }
}

export const api = {
  meta: () => req("/api/meta"),
  gradebookSetupInventory: (gradebooks) =>
    req("/api/gradebook-setups/inventory", { method: "POST", headers, body: JSON.stringify({ gradebooks }) }, false),
  exportGradebookSetups: (gradebooks, includeEnteredAssignments = false) =>
    req("/api/gradebook-setups/export", {
      method: "POST",
      headers,
      body: JSON.stringify({ gradebooks, include_entered_assignments: includeEnteredAssignments }),
    }, false),
  importGradebookSetups: (payload, plan) =>
    req("/api/gradebook-setups/import", { method: "POST", headers, body: JSON.stringify({ payload, plan }) }, false),
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
  updateScale: (id, rows, pass_fail = null, minimum_passing_letter = null) =>
    req(`/api/courses/${id}/scale`, { method: "PUT", headers, body: JSON.stringify({ rows, pass_fail, minimum_passing_letter }) }),
  resetScale: (id, selection = {}) =>
    req(`/api/courses/${id}/scale/default`, {
      method: "POST",
      headers,
      body: JSON.stringify(typeof selection === "number" ? { scale_profile_id: selection } : selection),
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
  gpa: (params = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") q.set(k, Array.isArray(v) ? (v.join(",") || "__none__") : v);
    });
    return req(`/api/gpa${q.toString() ? `?${q}` : ""}`);
  },
  appearance: () => req("/api/appearance", {}, false),
  putAppearance: (body) => req("/api/appearance", { method: "PUT", headers, body: JSON.stringify(body) }, false),
  semesterSnapshots: (id) => req(`/api/semesters/${id}/snapshots`),
  recordSemesterSnapshot: (id, gradebookId = null) => {
    const suffix = gradebookId ? `?gradebook_id=${encodeURIComponent(gradebookId)}` : "";
    return req(`/api/semesters/${id}/snapshots${suffix}`, { method: "POST" }, !gradebookId);
  },
  patchSemesterSnapshot: (semesterId, snapshotId, body) =>
    req(`/api/semesters/${semesterId}/snapshots/${snapshotId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    }),
  deleteSemesterSnapshots: (id, body) =>
    req(`/api/semesters/${id}/snapshots`, { method: "DELETE", headers, body: JSON.stringify(body) }),
  recordAllSnapshots: () => req("/api/snapshots/record-all", { method: "POST" }),
  appState: () => req("/api/app-state", {}, false),
  putAppState: (body) => req("/api/app-state", { method: "PUT", headers, body: JSON.stringify(body) }, false),
  gradePrompt: () => req("/api/grade-prompt", {}, false),
  snoozeGradePrompt: () => req("/api/grade-prompt/snooze", { method: "POST" }, false),
  updates: () => req("/api/updates"),
  applyUpdate: () => req("/api/updates/apply", { method: "POST" }),
  downloadUpdate: () => req("/api/updates/apply", { method: "POST" }),
  dismissUpdate: (body) => req("/api/updates/dismiss", { method: "POST", headers, body: JSON.stringify(body) }),
  setUpdateNotifications: (disabled) => req("/api/updates/notifications", { method: "POST", headers, body: JSON.stringify({ disabled }) }),
  uninstall: () => req("/api/uninstall", { method: "POST", headers, body: JSON.stringify({ confirmed: true }) }),
  ackUpdateStatus: () => req("/api/updates/status/ack", { method: "POST" }),
  academicYears: () => req("/api/academic-years"),
  createAcademicYear: (body) => req("/api/academic-years", { method: "POST", headers, body: JSON.stringify(body) }),
  patchAcademicYear: (id, body) => req(`/api/academic-years/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
  deleteAcademicYear: (id) => req(`/api/academic-years/${id}`, { method: "DELETE" }),
  patchSettings: (body, gradebookId = null) => {
    const suffix = gradebookId ? `?gradebook_id=${encodeURIComponent(gradebookId)}` : "";
    return req(`/api/settings${suffix}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  },
  createFumble: (body) => req("/api/fumbles", { method: "POST", headers, body: JSON.stringify(body) }),
  patchFumble: (id, body) => req(`/api/fumbles/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
  deleteFumble: (id) => req(`/api/fumbles/${id}`, { method: "DELETE" }),
  deleteGradebookData: (gradebookId = null) => {
    const suffix = gradebookId ? `?gradebook_id=${encodeURIComponent(gradebookId)}` : "";
    return req(`/api/gradebook-data${suffix}`, { method: "DELETE" });
  },
};

class ScoreExpressionParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  skipSpace() {
    while (/\s/.test(this.text[this.index] || "")) this.index += 1;
  }

  parse() {
    const value = this.expression();
    this.skipSpace();
    if (this.index !== this.text.length || !Number.isFinite(value)) throw new Error("Invalid score expression");
    return value;
  }

  expression() {
    let value = this.term();
    while (true) {
      this.skipSpace();
      const operator = this.text[this.index];
      if (operator !== "+" && operator !== "-") return value;
      this.index += 1;
      const right = this.term();
      value = operator === "+" ? value + right : value - right;
    }
  }

  term() {
    let value = this.factor();
    while (true) {
      this.skipSpace();
      const operator = this.text[this.index];
      if (operator !== "*" && operator !== "/") return value;
      this.index += 1;
      const right = this.factor();
      if (operator === "/" && right === 0) throw new Error("Invalid score expression");
      value = operator === "*" ? value * right : value / right;
    }
  }

  factor() {
    this.skipSpace();
    let sign = 1;
    if (this.text[this.index] === "+" || this.text[this.index] === "-") {
      if (this.text[this.index] === "-") sign = -1;
      this.index += 1;
    }
    this.skipSpace();
    if (this.text[this.index] === "(") {
      this.index += 1;
      const value = this.expression();
      this.skipSpace();
      if (this.text[this.index] !== ")") throw new Error("Invalid score expression");
      this.index += 1;
      return sign * value;
    }
    const match = this.text.slice(this.index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (!match) throw new Error("Invalid score expression");
    this.index += match[0].length;
    return sign * Number(match[0]);
  }
}

export function parseScoreExpression(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("=")) return null;
  const body = text.slice(1).trim();
  if (!body) return null;
  let depth = 0;
  let slashIndex = null;
  let multipleTopLevelSlashes = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (char === "/" && depth === 0) {
      if (slashIndex != null) {
        multipleTopLevelSlashes = true;
        continue;
      }
      slashIndex = index;
    }
  }
  if (depth !== 0) return null;
  try {
    if (slashIndex == null || multipleTopLevelSlashes) {
      return { earned: new ScoreExpressionParser(body).parse(), possible: 100 };
    }
    return {
      earned: new ScoreExpressionParser(body.slice(0, slashIndex)).parse(),
      possible: new ScoreExpressionParser(body.slice(slashIndex + 1)).parse(),
    };
  } catch {
    return null;
  }
}

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
  if (Number(gp) === -1) return "na";
  const match = options.find(([, v]) => Math.abs(v - Number(gp)) < 1e-6);
  return match ? String(match[1]) : String(gp);
}

export function fmtScore(n) {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  if (Number.isNaN(v)) return "—";
  const rounded = Number(v.toFixed(3));
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

/** Apply the optional whole-percent rounding used by high-school overall grades. */
export function roundPercentForCalculation(value, shouldRound) {
  if (value == null || !Number.isFinite(Number(value))) return value;
  return shouldRound ? Math.round(Number(value)) : Number(value);
}

/** Term score: round((GPA − target) × credits × 3). */
export function termScore(qualityPoints, credits, targetGp = 4.0) {
  if (qualityPoints == null || credits == null || Number.isNaN(Number(qualityPoints))) return null;
  return Math.round((Number(qualityPoints) - Number(targetGp)) * Number(credits) * 3);
}

/** Letter/GPA/score from the course percent, ignoring GP override. */
export function trueGradeFromCourse(course, targetGp = 4.0) {
  if (course?.credit_mode === "pass_fail") {
    const config = course.pass_fail || {};
    const rows = (config.rows?.length ? config.rows : [{ label: config.pass_label || "S", min_percent: config.min_percent ?? 70 }, { label: config.fail_label || "U", min_percent: 0 }]).slice().sort((a, b) => Number(b.min_percent) - Number(a.min_percent));
    const automatic = course?.percent == null ? null : (rows.find((row) => Number(course.percent) >= Number(row.min_percent)) || rows.at(-1))?.label || null;
    return {
      letter: course.pass_fail_override || automatic,
      qualityPoints: null,
      score: null,
    };
  }
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
    S: "grade-ap",
    F: "grade-f",
    U: "grade-f",
  };
  return map[letter] || "grade-f";
}

export function passFailToneClass(percent, config = {}, scale = []) {
  if (percent == null || Number.isNaN(Number(percent))) return "";
  const rows = (config.rows?.length ? config.rows : [{ label: config.pass_label || "S", min_percent: config.min_percent ?? 70 }, { label: config.fail_label || "U", min_percent: 0 }]).slice().sort((a, b) => Number(b.min_percent) - Number(a.min_percent));
  const value = Number(percent);
  const passingFloor = Number(rows.at(-2)?.min_percent ?? rows[0]?.min_percent ?? 70);
  if (value < passingFloor) return "grade-f";
  const underlying = gradeFromPercent(value, scale);
  return letterClass(underlying.letter) || "grade-f";
}

export function passFailGradeIsFailing(course, letter = course?.letter) {
  if (course?.credit_mode !== "pass_fail" || !letter) return false;
  const config = course.pass_fail || {};
  const rows = (config.rows?.length ? config.rows : [
    { label: config.pass_label || "S", min_percent: config.min_percent ?? 70 },
    { label: config.fail_label || "U", min_percent: 0 },
  ]).slice().sort((a, b) => Number(b.min_percent) - Number(a.min_percent));
  const row = rows.find((item) => item.label === letter);
  if (row) return row.is_passing === false || row === rows.at(-1);
  return letter === (config.fail_label || "U") || letter === "U";
}

export function passFailGradeAffectsGpa(course, letter = course?.letter) {
  return course?.pass_fail?.fail_affects_gpa === true && passFailGradeIsFailing(course, letter);
}

function passFailCourseGradeClass(course, dashboard = false) {
  if (course?.credit_mode === "pass_fail") {
    const config = course.pass_fail || {};
    const rows = (config.rows?.length ? config.rows : [{ label: config.pass_label || "S", min_percent: config.min_percent ?? 70 }, { label: config.fail_label || "U", min_percent: 0 }]).slice().sort((a, b) => Number(b.min_percent) - Number(a.min_percent));
    const automaticLabel = course.percent == null
      ? null
      : (rows.find((row) => Number(course.percent) >= Number(row.min_percent)) || rows.at(-1))?.label;
    const resolvedLabel = course.pass_fail_override ?? automaticLabel ?? course.letter;
    const passingLabel = rows[0]?.label || "S";
    const failingLabel = rows.at(-1)?.label || "U";
    if (resolvedLabel === passingLabel || resolvedLabel === "S") {
      if (dashboard || course.pass_fail_override != null) return "grade-ap";
      return passFailToneClass(course.percent, config, course.scale) || "grade-ap";
    }
    if (resolvedLabel === failingLabel || resolvedLabel === "U") return "grade-f";
    const resolvedRow = rows.find((row) => row.label === resolvedLabel);
    if (resolvedRow) return passFailToneClass(Number(resolvedRow.min_percent), config, course.scale);
    return passFailToneClass(course.percent, config, course.scale);
  }
  return letterClass(course?.letter);
}

/** Course/class view grade color: natural pass/fail grades use attained percent cutoffs. */
export function courseGradeClass(course) {
  return passFailCourseGradeClass(course, false);
}

/** GPA dashboard grade color: pass/fail passes always use the A+ color. */
export function dashboardCourseGradeClass(course) {
  return passFailCourseGradeClass(course, true);
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
  const keep = regular.length - Math.min(Math.max(Number(cat.drop_count) || 0, 0), regular.length - 1);
  const scores = [...regular].sort((a, b) => b - a).slice(0, keep);
  const exam = Number(replacement);
  const replacements = Math.min(
    Math.max(Number(cat.replace_count ?? 0) || 0, 0),
    scores.length,
  );
  for (let index = 0; index < replacements; index += 1) {
    const lowest = Math.min(...scores);
    scores.splice(scores.indexOf(lowest), 1, exam);
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
export function projectPercentFromExam(course, examCategoryId, examPercent, weightByCatId = null) {
  if (course == null || examCategoryId == null || examPercent == null || Number.isNaN(Number(examPercent))) {
    return null;
  }
  if ((course.grading_mode || "weighted") === "points") {
    return projectPointsPercentFromExam(course, examCategoryId, examPercent);
  }
  const examPct = Number(examPercent);
  const used = [];
  const weightFor = (cat) => {
    if (weightByCatId) {
      return Number(weightByCatId[String(cat.id)] ?? weightByCatId[cat.id] ?? 0);
    }
    return Number(cat.effective_weight || examCategoryWeight(cat)) || 0;
  };
  for (const cat of course.categories || []) {
    let pct = null;
    let weight = 0;
    if (cat.id === examCategoryId) {
      pct = examPct;
      weight = weightFor(cat);
    } else if (cat.aggregation !== "points_ratio" && cat.replace_with_category_id === examCategoryId) {
      pct = replaceMinWithPercent(cat, examPct);
      weight = weightFor(cat);
    } else if (cat.percent != null && weightFor(cat)) {
      pct = cat.percent;
      weight = weightFor(cat);
    }
    if (pct != null && weight) used.push([weight, pct]);
  }
  if (!used.length) return null;
  const wsum = used.reduce((sum, [w]) => sum + w, 0);
  if (!wsum) return null;
  return used.reduce((sum, [w, p]) => sum + w * p, 0) / wsum + (Number(course.bonus_points) || 0);
}

/** Exam percent that makes the overall course grade equal `cutoff`. */
export function examNeededForCutoff(course, examCategoryId, cutoff, weightByCatId = null) {
  const overall = (exam) => projectPercentFromExam(course, examCategoryId, exam, weightByCatId);
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
  const options = course?.dynamic_weighting_enabled
    ? (course.dynamic_weighting?.options || []).map((option) => option.weights || {})
    : [];
  const weightSchemes = options.length ? options : [null];
  return scale
    .filter((row) => row.letter !== "F")
    .map((row) => {
      const needs = weightSchemes
        .map((weights) => examNeededForCutoff(
          course,
          examCategoryId,
          cutoffWithRounding(row.min_percent, course?.grade_rounding ?? null),
          weights
        ))
        .filter((value) => value != null && Number.isFinite(value));
      return {
        letter: row.letter,
        cutoff_percent: row.min_percent,
        quality_points: row.quality_points,
        needed: needs.length ? Math.min(...needs) : null,
      };
    });
}

export function pointsExamNeededRows(course, examPossible) {
  const denominator = Number(examPossible);
  if (!Number.isFinite(denominator) || denominator <= 0) return [];
  let earned = 0;
  let possible = 0;
  let bonusPercent = 0;
  for (const category of course?.categories || []) {
    if (category.is_bonus_category) {
      if (!(category.assignments || []).some((item) => Number(item.possible) === 0)) {
        bonusPercent += Number(category.percent) || 0;
      }
      for (const item of category.assignments || []) {
        if (item.earned != null && Number(item.possible) === 0) earned += Number(item.earned);
      }
      continue;
    }
    for (const item of category.assignments || []) {
      if (item.earned == null) continue;
      if (item.is_bonus) {
        if (category.include_bonus) earned += Number(item.earned);
        continue;
      }
      earned += Number(item.earned);
      const itemPossible = Number(item.possible);
      possible += Number.isFinite(itemPossible) && itemPossible > 0 ? itemPossible : 100;
    }
  }
  if (possible <= 0) return [];
  return (course?.scale || [])
    .filter((row) => row.letter !== "F")
    .map((row) => {
      const cutoff = cutoffWithRounding(row.min_percent, course?.grade_rounding ?? null);
      const neededPoints = ((cutoff - bonusPercent) / 100) * (possible + denominator) - earned;
      return {
        letter: row.letter,
        cutoff_percent: row.min_percent,
        quality_points: row.quality_points,
        needed_points: neededPoints,
        needed_percent: (100 * neededPoints) / denominator,
      };
    });
}

export function pointsPercentFromExam(course, examPossible, examEarned) {
  const denominator = Number(examPossible);
  const earnedExam = Number(examEarned);
  if (!Number.isFinite(denominator) || denominator <= 0 || !Number.isFinite(earnedExam)) return null;
  let earned = earnedExam;
  let possible = denominator;
  let bonusPercent = 0;
  for (const category of course?.categories || []) {
    if (category.is_bonus_category) {
      if (!(category.assignments || []).some((item) => Number(item.possible) === 0)) {
        bonusPercent += Number(category.percent) || 0;
      }
      for (const item of category.assignments || []) {
        if (item.earned != null && Number(item.possible) === 0) earned += Number(item.earned);
      }
      continue;
    }
    for (const item of category.assignments || []) {
      if (item.earned == null) continue;
      if (item.is_bonus) {
        if (category.include_bonus) earned += Number(item.earned);
        continue;
      }
      earned += Number(item.earned);
      const itemPossible = Number(item.possible);
      possible += Number.isFinite(itemPossible) && itemPossible > 0 ? itemPossible : 100;
    }
  }
  return (100 * earned) / possible + bonusPercent;
}

export function defaultExamCategoryId(categories) {
  const eligible = (categories || []).filter((cat) => !cat.is_bonus_category);
  if (!eligible.length) return null;
  const finalNamed = eligible.find((cat) => /final/i.test(cat.name || ""));
  if (finalNamed) return finalNamed.id;
  const examNamed = eligible.find((cat) => /exam/i.test(cat.name || ""));
  if (examNamed) return examNamed.id;
  const empty = eligible.find(
    (cat) => cat.percent == null && (cat.weight || cat.weight_per_item)
  );
  if (empty) return empty.id;
  const unscored = eligible.find((cat) => cat.percent == null);
  if (unscored) return unscored.id;
  return eligible[eligible.length - 1].id;
}

/**
 * Percent for an assignment score string or earned/possible pair.
 * Returns null for empty/invalid values, or bonus points without a possible max.
 */
export function assignmentPercent({ display, earned, possible, isBonus }) {
  if (isBonus && (possible == null || possible === 0)) return null;

  if (display !== undefined && display !== null) {
    const rawDisplay = String(display).trim();
    if (rawDisplay.startsWith("=")) {
      const expression = parseScoreExpression(rawDisplay);
      if (expression && Number.isFinite(expression.earned) && Number.isFinite(expression.possible) && expression.possible !== 0) {
        return (100 * expression.earned) / expression.possible;
      }
    }
    const raw = rawDisplay.replace(/^=/, "").trim();
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
