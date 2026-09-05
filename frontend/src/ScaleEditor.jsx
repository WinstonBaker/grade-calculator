import { useState } from "react";

const SUGGESTED_LETTERS = [
  "A+",
  "A",
  "A-",
  "B+",
  "B",
  "B-",
  "C+",
  "C",
  "C-",
  "D+",
  "D",
  "D-",
  "F",
];

export function scaleKey(rows) {
  return (rows || [])
    .map((row) => `${row.letter}:${Number(row.min_percent)}:${Number(row.quality_points)}`)
    .join("|");
}

export function scalesMatch(a, b) {
  return scaleKey(a) === scaleKey(b);
}

function unusedLetter(rows) {
  const used = new Set((rows || []).map((row) => String(row.letter).toLowerCase()));
  for (const letter of SUGGESTED_LETTERS) {
    if (!used.has(letter.toLowerCase())) return letter;
  }
  return "New";
}

export function ScaleRowsEditor({ rows, onChange, minimumPassingLetter = "C-", onMinimumPassingLetterChange, allowRemove = true }) {
  const [drafts, setDrafts] = useState({});

  function numericValue(index, field) {
    return drafts[`${index}-${field}`] ?? rows[index][field];
  }

  function updateNumber(index, field, value) {
    const key = `${index}-${field}`;
    const sanitized = value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
    setDrafts((current) => ({ ...current, [key]: sanitized }));
    if (sanitized !== "") {
      const number = Number(sanitized);
      if (!Number.isNaN(number)) update(index, { [field]: number });
    }
  }

  function finishNumber(index, field) {
    const key = `${index}-${field}`;
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function update(index, patch) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function remove(index) {
    if (rows.length <= 1) return;
    onChange(rows.filter((_, i) => i !== index));
  }

  function add() {
    onChange([...rows, { letter: unusedLetter(rows), min_percent: 0, quality_points: 0 }]);
  }

  return (
    <>
      <div className="scale-grid scale-grid-head muted">
        <span>Letter</span>
        <span>Min %</span>
        <span>Grade Point</span>
        <span>Minimum Passing Grade</span>
        <span />
      </div>
      {rows.map((row, i) => (
        <div className="scale-grid" key={`${row.letter}-${i}`}>
          <input
            className="input"
            value={row.letter}
            aria-label={`Letter ${i + 1}`}
            onChange={(e) => update(i, { letter: e.target.value })}
          />
          <input
            className="input"
            type="number"
            inputMode="decimal"
            step="0.1"
            value={numericValue(i, "min_percent")}
            aria-label={`${row.letter || "Letter"} minimum percent`}
            onChange={(e) => updateNumber(i, "min_percent", e.target.value)}
            onBlur={() => finishNumber(i, "min_percent")}
          />
          <input
            className="input"
            type="number"
            inputMode="decimal"
            step="0.001"
            value={numericValue(i, "quality_points")}
            aria-label={`${row.letter || "Letter"} grade point`}
            onChange={(e) => updateNumber(i, "quality_points", e.target.value)}
            onBlur={() => finishNumber(i, "quality_points")}
          />
          <label className="scale-passing-check" aria-label={`Minimum passing grade ${row.letter || "letter"}`}>
            <input type="checkbox" checked={row.letter === minimumPassingLetter} onChange={() => onMinimumPassingLetterChange?.(row.letter)} />
          </label>
          {allowRemove ? (
            <button
              className="btn small danger"
              type="button"
              onClick={() => remove(i)}
              disabled={rows.length <= 1}
              aria-label={`Remove ${row.letter || "letter"}`}
            >
              ×
            </button>
          ) : <span />}
        </div>
      ))}
      <button className="btn small" type="button" style={{ marginTop: 8 }} onClick={add}>
        Add letter
      </button>
    </>
  );
}

export function PassFailScaleEditor({ passFail = {}, onChange, allowRemove = true }) {
  const value = {
    rows: passFail.rows?.length
      ? passFail.rows
      : [
          { label: passFail.pass_label || "S", min_percent: passFail.min_percent ?? 70 },
          { label: passFail.fail_label || "U", min_percent: 0 },
        ],
  };

  function updateRow(index, patch) {
    onChange({ ...passFail, rows: value.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  }

  function add() {
    onChange({ ...passFail, rows: [...value.rows, { label: "", min_percent: 0 }] });
  }

  function remove(index) {
    if (value.rows.length <= 1) return;
    onChange({ ...passFail, rows: value.rows.filter((_, i) => i !== index) });
  }

  return (
    <div className="pass-fail-scale-editor">
      <h3>Pass/Fail Scale</h3>
      <div className="pass-fail-scale-table">
        <div className="pass-fail-scale-row pass-fail-scale-head muted"><span>Label</span><span>Minimum %</span><span>Minimum Passing Grade</span><span /></div>
        {value.rows.map((row, index) => (
          <div className="pass-fail-scale-row" key={index}>
            <input className="input" value={row.label} maxLength={8} aria-label={`Pass/fail label ${index + 1}`} onChange={(event) => updateRow(index, { label: event.target.value })} />
            <input className="input" type="number" min="0" max="100" step="0.1" value={row.min_percent} aria-label={`Minimum percent ${index + 1}`} onChange={(event) => updateRow(index, { min_percent: event.target.value === "" ? "" : Number(event.target.value) })} />
            <label className="scale-passing-check" aria-label={`Minimum passing grade ${row.label || "row"}`}>
              <input type="checkbox" checked={Boolean(row.is_passing ?? (index === 0))} onChange={() => onChange({ ...passFail, rows: value.rows.map((item, i) => ({ ...item, is_passing: i === index })) })} />
            </label>
            {allowRemove ? (
              <button className="btn small danger" type="button" onClick={() => remove(index)} disabled={value.rows.length <= 1} aria-label={`Remove pass/fail row ${index + 1}`}>×</button>
            ) : <span />}
          </div>
        ))}
        <button className="btn small" type="button" style={{ marginTop: 8 }} onClick={add}>Add letter</button>
      </div>
    </div>
  );
}
