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

export function ScaleRowsEditor({ rows, onChange }) {
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
        <span>GPA</span>
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
            step="0.1"
            value={row.min_percent}
            aria-label={`${row.letter || "Letter"} minimum percent`}
            onChange={(e) => update(i, { min_percent: Number(e.target.value) })}
          />
          <input
            className="input"
            type="number"
            step="0.001"
            value={row.quality_points}
            aria-label={`${row.letter || "Letter"} GPA`}
            onChange={(e) => {
              const n = Number(e.target.value);
              update(i, { quality_points: Number.isNaN(n) ? 0 : n });
            }}
          />
          <button
            className="btn small danger"
            type="button"
            onClick={() => remove(i)}
            disabled={rows.length <= 1}
            aria-label={`Remove ${row.letter || "letter"}`}
          >
            ×
          </button>
        </div>
      ))}
      <button className="btn small" type="button" style={{ marginTop: 8 }} onClick={add}>
        Add letter
      </button>
    </>
  );
}
