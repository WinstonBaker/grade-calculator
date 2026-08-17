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
  createCategory: (body) => req("/api/categories", { method: "POST", headers, body: JSON.stringify(body) }),
  patchCategory: (id, body) => req(`/api/categories/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
  deleteCategory: (id) => req(`/api/categories/${id}`, { method: "DELETE" }),
  createAssignment: (body) => req("/api/assignments", { method: "POST", headers, body: JSON.stringify(body) }),
  patchAssignment: (id, body) => req(`/api/assignments/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) }),
  deleteAssignment: (id) => req(`/api/assignments/${id}`, { method: "DELETE" }),
  gpa: () => req("/api/gpa"),
  updates: () => req("/api/updates"),
  downloadUpdate: () => req("/api/updates/download", { method: "POST" }),
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

export function fmtScore(n) {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  return v > 0 ? `+${v}` : String(v);
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

/** Map a percent to a letter using the course scale (highest cutoff ≤ percent). */
export function letterFromPercent(percent, scale) {
  if (percent == null || Number.isNaN(Number(percent))) return null;
  const rows = Array.isArray(scale) && scale.length ? scale : [];
  const eligible = rows.filter((row) => Number(row.min_percent) <= Number(percent));
  if (!eligible.length) return null;
  return eligible.reduce((best, row) =>
    Number(row.min_percent) > Number(best.min_percent) ? row : best
  ).letter;
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
