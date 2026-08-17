import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtGpa, fmtPct, fmtScore, letterClass, scoreClass } from "./api";

const LETTERS = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];
const CREDITS = [1, 2, 3, 4];

function gradeFill(letter) {
  const cls = letterClass(letter) || "grade-f";
  return `var(--${cls})`;
}

function polar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function annularPath(cx, cy, outerR, innerR, startAngle, endAngle) {
  const sweep = endAngle - startAngle;
  if (sweep >= 359.999) {
    return [
      `M ${cx} ${cy - outerR}`,
      `A ${outerR} ${outerR} 0 1 1 ${cx} ${cy + outerR}`,
      `A ${outerR} ${outerR} 0 1 1 ${cx} ${cy - outerR}`,
      `M ${cx} ${cy - innerR}`,
      `A ${innerR} ${innerR} 0 1 0 ${cx} ${cy + innerR}`,
      `A ${innerR} ${innerR} 0 1 0 ${cx} ${cy - innerR}`,
      "Z",
    ].join(" ");
  }
  const [ox1, oy1] = polar(cx, cy, outerR, startAngle);
  const [ox2, oy2] = polar(cx, cy, outerR, endAngle);
  const [ix2, iy2] = polar(cx, cy, innerR, endAngle);
  const [ix1, iy1] = polar(cx, cy, innerR, startAngle);
  const large = sweep > 180 ? 1 : 0;
  return [
    `M ${ox1} ${oy1}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${ox2} ${oy2}`,
    `L ${ix2} ${iy2}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${ix1} ${iy1}`,
    "Z",
  ].join(" ");
}

function buildSlices(rows, valueKey) {
  const active = rows.filter((d) => d[valueKey] > 0);
  const total = active.reduce((sum, d) => sum + d[valueKey], 0);
  if (!total) return { slices: [], total: 0 };
  let angle = 0;
  const slices = active.map((d) => {
    const sweep = (d[valueKey] / total) * 360;
    const start = angle;
    angle += sweep;
    return {
      letter: d.letter,
      value: d[valueKey],
      pct: d[valueKey] / total,
      credits: d.credit_hours,
      creditPct: d.credit_pct,
      courses: d.courses,
      coursePct: d.course_pct,
      start,
      end: angle,
      color: gradeFill(d.letter),
    };
  });
  return { slices, total };
}

/** Keep letters through the lowest grade that still has credits; drop everything below. */
function truncateDistribution(distribution) {
  let last = -1;
  for (let i = 0; i < distribution.length; i += 1) {
    if (distribution[i].credit_hours > 0) last = i;
  }
  if (last < 0) return [];
  return distribution.slice(0, last + 1);
}

function DistributionTable({ distribution }) {
  const rows = truncateDistribution(distribution);
  if (!rows.length) return null;
  return (
    <table style={{ marginTop: 16 }}>
      <thead>
        <tr>
          <th>Letter</th>
          <th>Credits</th>
          <th>% credits</th>
          <th>Courses</th>
          <th>% courses</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.letter}>
            <td>
              <span className={`letter ${letterClass(d.letter)}`}>{d.letter}</span>
            </td>
            <td className="mono">{d.credit_hours}</td>
            <td className="mono">{fmtPct(d.credit_pct * 100, 1)}%</td>
            <td className="mono">{d.courses}</td>
            <td className="mono">{fmtPct((d.course_pct ?? 0) * 100, 1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DonutChart({ title, slices, total, unit, emptyLabel }) {
  const [hover, setHover] = useState(null);
  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 86;
  const innerR = 52;

  if (!slices.length) {
    return (
      <div className="donut-card">
        <div className="donut-title">{title}</div>
        <p className="muted" style={{ margin: "48px 0" }}>
          {emptyLabel}
        </p>
      </div>
    );
  }

  const tip = hover || null;

  return (
    <div className="donut-card">
      <div className="donut-title">{title}</div>
      <div className="donut-figure">
        <svg
          className="pie-chart"
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          role="img"
          aria-label={`${title} grade distribution`}
          onMouseLeave={() => setHover(null)}
        >
          {slices.map((s) => (
            <path
              key={s.letter}
              d={annularPath(cx, cy, outerR, innerR, s.start, s.end)}
              fill={s.color}
              className={`donut-slice ${hover?.letter === s.letter ? "active" : ""}`}
              onMouseEnter={() => setHover(s)}
            >
              <title>
                {s.letter}: {s.value} {unit} ({fmtPct(s.pct * 100, 1)}%)
              </title>
            </path>
          ))}
        </svg>
        <div className="donut-center">
          {tip ? (
            <>
              <div className={`donut-center-letter letter ${letterClass(tip.letter)}`}>{tip.letter}</div>
              <div className="donut-center-value mono">{fmtPct(tip.pct * 100, 1)}%</div>
              <div className="donut-center-label">{tip.value} {unit}</div>
            </>
          ) : (
            <>
              <div className="donut-center-value mono">{total}</div>
              <div className="donut-center-label">{unit}</div>
            </>
          )}
        </div>
      </div>
      {tip ? (
        <div className="donut-tooltip">
          <span className={`letter ${letterClass(tip.letter)}`}>{tip.letter}</span>
          <span className="mono">
            {tip.credits} cr ({fmtPct((tip.creditPct ?? tip.pct) * 100, 1)}%)
          </span>
          <span className="mono">
            {tip.courses} courses ({fmtPct((tip.coursePct ?? tip.pct) * 100, 1)}%)
          </span>
        </div>
      ) : (
        <div className="donut-tooltip muted">Hover a slice for details</div>
      )}
    </div>
  );
}

function GradeDistributionCharts({ distribution }) {
  const byCredits = useMemo(() => buildSlices(distribution, "credit_hours"), [distribution]);
  const byCourses = useMemo(() => buildSlices(distribution, "courses"), [distribution]);

  return (
    <div className="dist-charts">
      <div className="dist-charts-row">
        <DonutChart
          title="By credits"
          slices={byCredits.slices}
          total={byCredits.total}
          unit="credits"
          emptyLabel="No graded credits yet."
        />
        <DonutChart
          title="By courses"
          slices={byCourses.slices}
          total={byCourses.total}
          unit="courses"
          emptyLabel="No graded courses yet."
        />
      </div>
    </div>
  );
}

function subjectPrefix(code) {
  const match = String(code || "")
    .trim()
    .match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : String(code || "?").toUpperCase();
}

const GRADE_ORDER = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"];

function distributionFromCourses(courses) {
  const graded = courses.filter((c) => c.letter && c.quality_points != null);
  const totalCredits = graded.reduce((sum, c) => sum + (Number(c.credits) || 0), 0);
  const totalCourses = graded.length;
  return GRADE_ORDER.filter((letter) => letter !== "F").map((letter) => {
    const matched = graded.filter((c) => c.letter === letter);
    const creditHours = matched.reduce((sum, c) => sum + (Number(c.credits) || 0), 0);
    return {
      letter,
      credit_hours: creditHours,
      courses: matched.length,
      credit_pct: totalCredits ? creditHours / totalCredits : 0,
      course_pct: totalCourses ? matched.length / totalCourses : 0,
    };
  });
}

function CourseCodeStats({ terms }) {
  const [minCredits, setMinCredits] = useState("6");
  const [sortKey, setSortKey] = useState("score");
  const [sortDesc, setSortDesc] = useState(true);
  const [openCode, setOpenCode] = useState(null);

  const min = Number(minCredits) || 0;

  const rows = useMemo(() => {
    const buckets = new Map();
    for (const term of terms.filter((t) => t.included)) {
      for (const course of term.courses) {
        if (course.quality_points == null) continue;
        const code = subjectPrefix(course.code);
        const cur = buckets.get(code) || {
          code,
          items: [],
          courses: 0,
          credits: 0,
          gpaCredits: 0,
          score: 0,
          qpCredits: 0,
        };
        const credits = Number(course.credits) || 0;
        cur.items.push(course);
        cur.courses += 1;
        cur.credits += credits;
        cur.score += course.score || 0;
        if (course.quality_points > 0) {
          cur.gpaCredits += credits;
          cur.qpCredits += course.quality_points * credits;
        }
        buckets.set(code, cur);
      }
    }
    return [...buckets.values()].map((row) => ({
      ...row,
      gpa: row.gpaCredits > 0 ? row.qpCredits / row.gpaCredits : null,
      distribution: distributionFromCourses(row.items),
    }));
  }, [terms]);

  const filtered = useMemo(() => {
    const list = rows.filter((r) => r.credits >= min);
    const key = {
      code: (r) => r.code,
      courses: (r) => r.courses,
      credits: (r) => r.credits,
      score: (r) => r.score,
      gpa: (r) => r.gpa ?? -1,
    }[sortKey];
    return [...list].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      if (av === bv) return a.code.localeCompare(b.code);
      const cmp = av > bv ? 1 : -1;
      return sortDesc ? -cmp : cmp;
    });
  }, [rows, min, sortKey, sortDesc]);

  const bestByScore = useMemo(
    () => [...rows].filter((r) => r.credits >= min).sort((a, b) => b.score - a.score || b.gpa - a.gpa).slice(0, 5),
    [rows, min]
  );
  const bestByGpa = useMemo(
    () =>
      [...rows]
        .filter((r) => r.credits >= min && r.gpa != null)
        .sort((a, b) => b.gpa - a.gpa || b.score - a.score)
        .slice(0, 5),
    [rows, min]
  );

  function toggleSort(next) {
    if (sortKey === next) setSortDesc((d) => !d);
    else {
      setSortKey(next);
      setSortDesc(next !== "code");
    }
  }

  function toggleCode(code) {
    setOpenCode((prev) => (prev === code ? null : code));
  }

  const cols = [
    ["code", "Code"],
    ["courses", "Courses"],
    ["credits", "Credits"],
    ["score", "Score"],
    ["gpa", "GPA"],
  ];

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="topbar" style={{ marginBottom: 12, paddingBottom: 0, border: 0 }}>
        <div>
          <h2 style={{ margin: 0 }}>Course codes</h2>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            Subject prefixes from included classes (MA, MAE, PY, …). Click a code for grade breakdown. Filter by
            minimum credits to rank the best.
          </p>
        </div>
        <label className="muted">
          Min credits
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            style={{ display: "block", marginTop: 4, width: 90 }}
            value={minCredits}
            onChange={(e) => setMinCredits(e.target.value)}
          />
        </label>
      </div>

      <div className="code-best-grid">
        <div className="code-best">
          <div className="donut-title">Best by score</div>
          {bestByScore.length === 0 ? (
            <p className="muted">No codes meet the minimum.</p>
          ) : (
            <ol className="code-best-list">
              {bestByScore.map((r, i) => (
                <li key={r.code}>
                  <span className="mono muted">{i + 1}.</span>
                  <strong>{r.code}</strong>
                  <span className={`mono ${scoreClass(r.score)}`}>{fmtScore(r.score)}</span>
                  <span className="mono muted">{r.credits} cr</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="code-best">
          <div className="donut-title">Best by GPA</div>
          {bestByGpa.length === 0 ? (
            <p className="muted">No codes meet the minimum.</p>
          ) : (
            <ol className="code-best-list">
              {bestByGpa.map((r, i) => (
                <li key={r.code}>
                  <span className="mono muted">{i + 1}.</span>
                  <strong>{r.code}</strong>
                  <span className="mono">{fmtGpa(r.gpa)}</span>
                  <span className="mono muted">{r.credits} cr</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">No subject codes with at least {min} credits.</div>
      ) : (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="code-stats-table">
            <thead>
              <tr>
                {cols.map(([key, label]) => (
                  <th key={key}>
                    <button className={sortKey === key ? "active" : ""} onClick={() => toggleSort(key)}>
                      {label}
                      {sortKey === key ? (sortDesc ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const open = openCode === r.code;
                return (
                  <Fragment key={r.code}>
                    <tr
                      className={`code-stats-row ${open ? "open" : ""}`}
                      onClick={() => toggleCode(r.code)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && toggleCode(r.code)}
                    >
                      <td>
                        <span className="term-accordion-chevron">{open ? "▾" : "▸"}</span>{" "}
                        <strong>{r.code}</strong>
                      </td>
                      <td className="mono">{r.courses}</td>
                      <td className="mono">{r.credits}</td>
                      <td className={`mono ${scoreClass(r.score)}`}>{fmtScore(r.score)}</td>
                      <td className="mono">{fmtGpa(r.gpa)}</td>
                    </tr>
                    {open ? (
                      <tr className="code-stats-detail">
                        <td colSpan={cols.length}>
                          <div className="code-detail-panel" onClick={(e) => e.stopPropagation()}>
                            <GradeDistributionCharts distribution={r.distribution} />
                            <DistributionTable distribution={r.distribution} />
                            <table style={{ marginTop: 12 }}>
                              <thead>
                                <tr>
                                  <th>Class</th>
                                  <th>Letter</th>
                                  <th>GPA</th>
                                  <th>Credits</th>
                                  <th>Score</th>
                                </tr>
                              </thead>
                              <tbody>
                                {[...r.items]
                                  .sort((a, b) => a.code.localeCompare(b.code))
                                  .map((c) => (
                                    <tr key={c.id}>
                                      <td>
                                        <Link to={`/courses/${c.id}`}>{c.code}</Link>
                                      </td>
                                      <td>
                                        <span className={`letter ${letterClass(c.letter)}`}>{c.letter || "—"}</span>
                                      </td>
                                      <td className="mono">{fmtGpa(c.quality_points)}</td>
                                      <td className="mono">{c.credits}</td>
                                      <td className={`mono ${scoreClass(c.score)}`}>{fmtScore(c.score)}</td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function GpaDashboard() {
  const [data, setData] = useState(null);
  const [view, setView] = useState("semester");
  const [sort, setSort] = useState("code");
  const [desc, setDesc] = useState(false);
  const [fumbleCourse, setFumbleCourse] = useState("");
  const [fumbleGp, setFumbleGp] = useState("4.333");
  const [guessDraft, setGuessDraft] = useState({});
  const [openTerms, setOpenTerms] = useState({});
  const [semestersSectionOpen, setSemestersSectionOpen] = useState(true);
  const [futureGuessOpen, setFutureGuessOpen] = useState(false);

  async function load() {
    setData(await api.gpa());
  }

  useEffect(() => {
    load().catch(console.error);
  }, []);

  useEffect(() => {
    if (data?.future_guess?.grid) setGuessDraft(data.future_guess.grid);
  }, [data]);

  useEffect(() => {
    if (!data?.terms) return;
    setOpenTerms((prev) => {
      const next = { ...prev };
      for (const term of data.terms) {
        if (next[term.id] === undefined) next[term.id] = term.course_count > 0;
      }
      return next;
    });
  }, [data]);

  const flatCourses = useMemo(() => {
    if (!data) return [];
    const rows = data.terms.flatMap((t) => t.courses.map((c) => ({ ...c, semester: t.name, included: t.included })));
    const key = {
      code: (c) => c.code.toLowerCase(),
      percent: (c) => c.percent ?? -1,
      letter: (c) => c.quality_points ?? -1,
      gpa: (c) => c.quality_points ?? -1,
      credits: (c) => c.credits ?? 0,
      score: (c) => c.score ?? -999,
      semester: (c) => c.semester || "",
    }[sort];
    return [...rows].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      if (av === bv) return 0;
      const cmp = av > bv ? 1 : -1;
      return desc ? -cmp : cmp;
    });
  }, [data, sort, desc]);

  function toggleSort(next) {
    if (sort === next) setDesc((d) => !d);
    else {
      setSort(next);
      setDesc(next !== "code" && next !== "semester");
    }
  }

  if (!data) return <p className="muted">Loading…</p>;

  async function commitGuess(ch, letter, value) {
    const next = { ...guessDraft };
    next[ch] = { ...(next[ch] || {}) };
    next[ch][letter] = Number(value) || 0;
    setGuessDraft(next);
    setData(await api.patchSettings({ future_guess: next }));
  }

  function toggleTerm(id) {
    setOpenTerms((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function expandAllTerms() {
    setOpenTerms(Object.fromEntries(data.terms.map((t) => [t.id, true])));
    setSemestersSectionOpen(true);
  }

  function collapseAllTerms() {
    setOpenTerms(Object.fromEntries(data.terms.map((t) => [t.id, false])));
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>GPA</h1>
        </div>
        <div className="row">
          <label className="muted">
            Target
            <select
              className="select"
              style={{ display: "block", marginTop: 4 }}
              value={data.target_letter}
              onChange={async (e) => setData(await api.patchSettings({ target_letter: e.target.value }))}
            >
              {LETTERS.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <label className="muted">
            Semesters remaining
            <input
              className="input"
              style={{ display: "block", marginTop: 4, width: 90 }}
              defaultValue={data.semesters_remaining}
              onBlur={async (e) => setData(await api.patchSettings({ semesters_remaining: Number(e.target.value) }))}
            />
          </label>
        </div>
      </div>

      <div className="grid-stats">
        <div className="stat">
          <div className="label">Overall GPA</div>
          <div className="value">{fmtGpa(data.overall_gpa)}</div>
        </div>
        <div className="stat">
          <div className="label">Overall score</div>
          <div className={`value ${scoreClass(data.overall_score)}`}>{fmtScore(data.overall_score)}</div>
        </div>
        <div className="stat">
          <div className="label">Credits</div>
          <div className="value">{data.total_credits}</div>
        </div>
        <div className="stat">
          <div className="label">Score / remaining sem</div>
          <div className="value">{fmtPct(data.score_per_semester, 1)}</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <button className={`btn ${view === "semester" ? "primary" : ""}`} onClick={() => setView("semester")}>
          Group by semester
        </button>
        <button className={`btn ${view === "class" ? "primary" : ""}`} onClick={() => setView("class")}>
          Sort by class
        </button>
      </div>

      {view === "semester" ? (
        <section className="panel term-accordion" style={{ marginBottom: 16 }}>
          <div
            className="term-accordion-head"
            onClick={() => setSemestersSectionOpen((v) => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && setSemestersSectionOpen((v) => !v)}
          >
            <div>
              <h2 className="term-accordion-title">
                <span className="term-accordion-chevron">{semestersSectionOpen ? "▾" : "▸"}</span>
                Semesters
              </h2>
              <p className="term-accordion-meta">
                {data.terms.length} terms · {data.total_credits} included credits · score{" "}
                <span className={`mono ${scoreClass(data.overall_score)}`}>{fmtScore(data.overall_score)}</span>
              </p>
            </div>
            <div className="term-accordion-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="btn small"
                type="button"
                onClick={() => {
                  setSemestersSectionOpen(true);
                  expandAllTerms();
                }}
              >
                Expand all
              </button>
              <button className="btn small" type="button" onClick={collapseAllTerms}>
                Collapse all
              </button>
            </div>
          </div>
          {semestersSectionOpen ? (
            <div className="term-accordion-body" style={{ paddingTop: 12 }}>
              {data.terms.map((term) => {
                const open = !!openTerms[term.id];
                return (
                  <section className="panel term-accordion" key={term.id} style={{ marginBottom: 10 }}>
                    <div
                      className="term-accordion-head"
                      onClick={() => toggleTerm(term.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && toggleTerm(term.id)}
                    >
                      <div>
                        <h2 className="term-accordion-title">
                          <span className="term-accordion-chevron">{open ? "▾" : "▸"}</span>
                          {term.name}
                        </h2>
                        <p className="term-accordion-meta">
                          GPA {fmtGpa(term.term_gpa)} · {term.term_credits} credits · score{" "}
                          <span className={`mono ${scoreClass(term.term_score)}`}>{fmtScore(term.term_score)}</span>
                        </p>
                      </div>
                      <div className="term-accordion-actions" onClick={(e) => e.stopPropagation()}>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={term.included}
                            onChange={async (e) => {
                              await api.patchSemester(term.id, { included: e.target.checked });
                              await load();
                            }}
                          />
                          Include
                        </label>
                      </div>
                    </div>
                    {open ? (
                      <div className="term-accordion-body">
                        <CourseTable courses={term.courses} />
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : (
        <div className="panel">
          <CourseTable
            courses={flatCourses}
            showSemester
            sort={sort}
            desc={desc}
            onSort={toggleSort}
          />
        </div>
      )}

      <div className="split" style={{ marginTop: 16 }}>
        <div className="panel">
          <h2>Grade distribution</h2>
          <GradeDistributionCharts distribution={data.distribution} />
          <DistributionTable distribution={data.distribution} />
        </div>
        <div className="panel">
          <h2>Fumbles</h2>
          <p className="muted">What if a class had been a higher letter.</p>
          <div className="row" style={{ marginBottom: 10 }}>
            <select className="select" value={fumbleCourse} onChange={(e) => setFumbleCourse(e.target.value)}>
              <option value="">Class</option>
              {data.terms.flatMap((t) =>
                t.courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}
                  </option>
                ))
              )}
            </select>
            <select className="select" value={fumbleGp} onChange={(e) => setFumbleGp(e.target.value)}>
              {data.default_scale
                .filter((s) => s.letter !== "F")
                .map((s) => (
                  <option key={s.letter} value={s.quality_points}>
                    {s.letter} ({fmtGpa(s.quality_points)})
                  </option>
                ))}
            </select>
            <button
              className="btn primary"
              onClick={async () => {
                if (!fumbleCourse) return;
                setData(
                  await api.createFumble({
                    course_id: Number(fumbleCourse),
                    should_have_been_gp: Number(fumbleGp),
                  })
                );
              }}
            >
              Add
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Class</th>
                <th>Did</th>
                <th>Should</th>
                <th>∆</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.fumbles.map((f) => (
                <tr key={f.id}>
                  <td>{f.code}</td>
                  <td className="mono">{fmtGpa(f.did_get)}</td>
                  <td className="mono">{fmtGpa(f.should_have_been_gp)}</td>
                  <td className={`mono ${scoreClass(f.delta)}`}>{fmtScore(f.delta)}</td>
                  <td>
                    <button className="btn small danger" onClick={async () => setData(await api.deleteFumble(f.id))}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 10 }}>
            Score with fumbles {fmtScore(data.score_with_fumbles)} → GPA {fmtGpa(data.gpa_with_fumbles)}
          </p>
        </div>
      </div>

      <CourseCodeStats terms={data.terms} />

      <section className="panel term-accordion" style={{ marginTop: 16 }}>
        <div
          className="term-accordion-head"
          onClick={() => setFutureGuessOpen((v) => !v)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && setFutureGuessOpen((v) => !v)}
        >
          <div>
            <h2 className="term-accordion-title">
              <span className="term-accordion-chevron">{futureGuessOpen ? "▾" : "▸"}</span>
              Future guess
            </h2>
            <p className="term-accordion-meta">
              {futureGuessOpen
                ? "How many remaining courses at each letter and credit load."
                : `∆ score ${data.future_guess.delta_score ?? "—"} · adjusted credits ${
                    data.future_guess.adjusted_credits ?? "—"
                  } · adjusted GPA ${fmtGpa(data.future_guess.adjusted_gpa)}`}
            </p>
          </div>
        </div>
        {futureGuessOpen ? (
          <>
            <div className="table-wrap">
              <table className="guess-grid">
                <thead>
                  <tr>
                    <th />
                    {CREDITS.map((ch) => (
                      <th key={ch}>{ch} CH</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {LETTERS.map((letter) => (
                    <tr key={letter}>
                      <td>
                        <span className={`letter ${letterClass(letter)}`}>{letter}</span>
                      </td>
                      {CREDITS.map((ch) => (
                        <td key={ch}>
                          <input
                            className="input"
                            value={guessDraft[ch]?.[letter] ?? guessDraft[String(ch)]?.[letter] ?? ""}
                            onChange={(e) => {
                              const next = {
                                ...guessDraft,
                                [ch]: { ...(guessDraft[ch] || guessDraft[String(ch)] || {}), [letter]: e.target.value },
                              };
                              setGuessDraft(next);
                            }}
                            onBlur={(e) => commitGuess(ch, letter, e.target.value)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ marginTop: 12 }}>
              ∆ score {data.future_guess.delta_score ?? "—"} · adjusted credits{" "}
              {data.future_guess.adjusted_credits ?? "—"} · adjusted GPA {fmtGpa(data.future_guess.adjusted_gpa)}
            </p>
          </>
        ) : null}
      </section>
    </>
  );
}

function CourseTable({ courses, showSemester = false, sort = null, desc = false, onSort = null }) {
  if (!courses.length) return <div className="empty">No classes in this view.</div>;

  const sortable = typeof onSort === "function";
  const cols = [
    showSemester ? ["semester", "Semester"] : null,
    ["code", "Class"],
    ["percent", "%"],
    ["letter", "Letter"],
    ["gpa", "GPA"],
    ["credits", "CH"],
    ["score", "Score"],
  ].filter(Boolean);

  return (
    <table>
      <thead>
        <tr>
          {cols.map(([key, label]) => (
            <th key={key}>
              {sortable ? (
                <button className={sort === key ? "active" : ""} onClick={() => onSort(key)}>
                  {label}
                  {sort === key ? (desc ? " ↓" : " ↑") : ""}
                </button>
              ) : (
                label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {courses.map((c) => (
          <tr key={c.id}>
            {showSemester ? <td className="muted">{c.semester}</td> : null}
            <td>
              <Link to={`/courses/${c.id}`}>{c.code}</Link>
            </td>
            <td className={`mono ${letterClass(c.letter)}`}>{fmtPct(c.percent)}</td>
            <td>
              <span className={`letter ${letterClass(c.letter)}`}>{c.letter || "—"}</span>
            </td>
            <td className="mono">{fmtGpa(c.quality_points)}</td>
            <td className="mono">{c.credits}</td>
            <td className={`mono ${scoreClass(c.score)}`}>{fmtScore(c.score)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
