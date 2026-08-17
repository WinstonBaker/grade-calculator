import { useEffect, useState } from "react";
import { api, fmtGpa, fmtScore, letterClass, scoreClass } from "./api";
import { ScaleRowsEditor, scalesMatch } from "./ScaleEditor.jsx";
import {
  DEFAULT_COLORS,
  DEFAULT_CUSTOM_GRADE_COLORS,
  GRADE_SCALES,
} from "./theme";

const TARGETS = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];

const COLOR_FIELDS = [
  ["primary", "Primary", "Buttons, active nav, and accent highlights"],
  ["secondary", "Secondary", "Page and sidebar background"],
  ["tertiary", "Tertiary", "Secondary accent and ambient glow"],
];

const PREVIEW_LETTERS = [
  ["A+", "ap"],
  ["A", "a"],
  ["A-", "am"],
  ["B+", "bp"],
  ["B", "b"],
  ["C", "c"],
];

const CUSTOM_LETTERS = [
  ["A+", "ap"],
  ["A", "a"],
  ["A−", "am"],
  ["B+", "bp"],
  ["B", "b"],
  ["B−", "bm"],
  ["C+", "cp"],
  ["C", "c"],
  ["C−", "cm"],
  ["D+", "dp"],
  ["D", "d"],
  ["D−", "dm"],
  ["F", "f"],
];

export default function Settings({ appearance, onAppearanceChange }) {
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateError, setUpdateError] = useState("");
  const [updateMessage, setUpdateMessage] = useState("");
  const [profileDrafts, setProfileDrafts] = useState({});

  function applyGpa(next) {
    setData(next);
    setProfileDrafts(
      Object.fromEntries(
        (next.scale_profiles || []).map((profile) => [
          profile.id,
          {
            name: profile.name,
            preset_id: profile.preset_id || "",
            rows: profile.rows.map((row) => ({ ...row })),
          },
        ])
      )
    );
  }

  useEffect(() => {
    api.gpa().then(applyGpa).catch((err) => setError(err.message));
    api.meta().then(setMeta).catch(() => {});
  }, []);

  async function runUpdate() {
    setUpdateBusy(true);
    setUpdateError("");
    setUpdateMessage("");
    try {
      const info = await api.updates();
      setUpdateInfo(info);
      if (!info.update_available) {
        setUpdateMessage(
          info.notes === "No GitHub release has been published yet."
            ? "No desktop release has been published yet."
            : "You're on the latest version."
        );
        return;
      }
      try {
        const result = await api.downloadUpdate();
        setUpdateMessage(
          `Downloaded version ${result.version}. Quit this app and open the new file in Downloads to finish updating.`
        );
      } catch (err) {
        const fallback = info.download_url || meta?.release_url;
        if (fallback) {
          window.open(fallback, "_blank", "noopener,noreferrer");
          setUpdateMessage(`Version ${info.latest_version} is available. Opened the download in your browser.`);
        } else {
          setUpdateError(err.message);
        }
      }
    } catch (err) {
      setUpdateError(err.message);
    } finally {
      setUpdateBusy(false);
    }
  }

  async function updateSettings(patch) {
    try {
      const next = await api.patchSettings(patch);
      applyGpa(next);
      setMessage("Saved");
      setError("");
      window.setTimeout(() => setMessage(""), 1400);
    } catch (err) {
      setError(err.message);
    }
  }

  async function refreshProfiles(okMessage = "Saved") {
    try {
      applyGpa(await api.gpa());
      setMessage(okMessage);
      setError("");
      window.setTimeout(() => setMessage(""), 1400);
    } catch (err) {
      setError(err.message);
    }
  }

  function updateProfileDraft(id, patch) {
    setProfileDrafts((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
  }

  async function saveProfile(id) {
    const draft = profileDrafts[id];
    if (!draft) return;
    try {
      await api.patchScaleProfile(id, {
        name: draft.name,
        rows: draft.rows,
        preset_id: draft.preset_id || null,
      });
      await refreshProfiles();
    } catch (err) {
      setError(err.message);
    }
  }

  async function applyPresetToProfile(id, preset) {
    try {
      await api.patchScaleProfile(id, { rows: preset.rows, preset_id: preset.id });
      await refreshProfiles();
    } catch (err) {
      setError(err.message);
    }
  }

  async function makeAnotherDefault() {
    try {
      await api.createScaleProfile();
      await refreshProfiles("Added default");
    } catch (err) {
      setError(err.message);
    }
  }

  async function makePrimary(id) {
    try {
      await api.patchScaleProfile(id, { is_primary: true });
      await refreshProfiles();
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeProfile(id) {
    try {
      await api.deleteScaleProfile(id);
      await refreshProfiles("Removed default");
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) return <p className="muted">Loading settings…</p>;

  const presets = data.scale_presets || meta?.scale_presets || [];
  const profiles = data.scale_profiles || [];
  const targetLetters = (data.default_scale || [])
    .filter((row) => row.letter !== "F")
    .map((row) => row.letter);
  const targets = targetLetters.length ? [...targetLetters] : [...TARGETS];
  if (data.target_letter && !targets.includes(data.target_letter)) {
    targets.unshift(data.target_letter);
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Settings</h1>
          <p>Configure GPA calculations and appearance.</p>
        </div>
        {message ? <span className="pos mono">{message}</span> : null}
      </div>

      {error ? <p className="error">{error}</p> : null}

      <section className="panel update-panel">
        <h2>Updates</h2>
        <p className="muted settings-note" style={{ marginTop: 0 }}>
          Current version <span className="mono">{meta?.version || "…"}</span>
        </p>
        <div className="update-actions">
          <button className="btn primary" type="button" disabled={updateBusy} onClick={runUpdate}>
            {updateBusy ? "Updating…" : "Update"}
          </button>
          {meta?.release_url ? (
            <a className="btn" href={meta.release_url} target="_blank" rel="noreferrer">
              View releases
            </a>
          ) : null}
        </div>
        {updateMessage ? <p className="pos">{updateMessage}</p> : null}
        {updateError ? <p className="error">{updateError}</p> : null}
        {updateInfo?.update_available && updateInfo.notes ? (
          <pre className="update-notes">{updateInfo.notes}</pre>
        ) : null}
      </section>

      <div className="settings-grid">
        <section className="panel">
          <h2>GPA calculation</h2>
          <div className="settings-fields">
            <label className="muted">
              Target letter
              <select
                className={`select letter-select ${letterClass(data.target_letter)}`}
                value={data.target_letter}
                onChange={(e) => updateSettings({ target_letter: e.target.value })}
              >
                {targets.map((letter) => (
                  <option key={letter} className={letterClass(letter)}>
                    {letter}
                  </option>
                ))}
              </select>
            </label>
            <label className="muted">
              Semesters remaining
              <input
                className="input"
                type="number"
                min="0"
                step="0.5"
                defaultValue={data.semesters_remaining}
                onBlur={(e) => updateSettings({ semesters_remaining: Number(e.target.value) })}
              />
            </label>
          </div>
          <p className="muted settings-note">
            Score measures performance relative to the selected target. Semesters remaining controls the pace shown
            on the GPA dashboard.
          </p>
        </section>

        <section className="panel">
          <h2>Current totals</h2>
          <div className="settings-summary">
            <div>
              <span className="muted">GPA</span>
              <strong className="mono">{fmtGpa(data.overall_gpa)}</strong>
            </div>
            <div>
              <span className="muted">Score</span>
              <strong className={`mono ${scoreClass(data.overall_score)}`}>{fmtScore(data.overall_score)}</strong>
            </div>
            <div>
              <span className="muted">Credits</span>
              <strong className="mono">{data.total_credits}</strong>
            </div>
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2>Default grade scales</h2>
        <p className="muted settings-note" style={{ marginTop: 0 }}>
          New classes copy the primary scale. Existing classes keep their own cutoffs unless you apply a
          default in the gradebook. GPA decimals matter: 3, 3.3, 3.33, and 3.333 are not the same.
        </p>
        {profiles.map((profile) => {
          const draft = profileDrafts[profile.id] || {
            name: profile.name,
            preset_id: profile.preset_id || "",
            rows: profile.rows.map((row) => ({ ...row })),
          };
          const selectedPresetId = draft.preset_id || "";
          return (
            <div className="scale-profile-card" key={profile.id}>
              <div className="scale-profile-head">
                <label className="muted">
                  Name
                  <input
                    className="input"
                    style={{ display: "block", marginTop: 6, minWidth: 180 }}
                    value={draft.name}
                    onChange={(event) => updateProfileDraft(profile.id, { name: event.target.value })}
                    onBlur={() => {
                      const name = draft.name.trim();
                      if (name && name !== profile.name) {
                        api.patchScaleProfile(profile.id, { name }).then(() => refreshProfiles()).catch((err) => setError(err.message));
                      }
                    }}
                  />
                </label>
                <div className="scale-profile-actions">
                  {profile.is_primary ? (
                    <span className="muted">Primary — used for new classes</span>
                  ) : (
                    <button className="btn small" type="button" onClick={() => makePrimary(profile.id)}>
                      Make primary
                    </button>
                  )}
                  {profiles.length > 1 ? (
                    <button className="btn small danger" type="button" onClick={() => removeProfile(profile.id)}>
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
              <label className="muted" style={{ display: "block", marginTop: 12 }}>
                School grade scale
                <select
                  className="select"
                  style={{ display: "block", width: "min(100%, 360px)", marginTop: 6 }}
                  value={selectedPresetId || "other"}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "other") {
                      updateProfileDraft(profile.id, { preset_id: "" });
                      api
                        .patchScaleProfile(profile.id, { preset_id: null })
                        .then(() => refreshProfiles())
                        .catch((err) => setError(err.message));
                      return;
                    }
                    const preset = presets.find((item) => item.id === value);
                    if (preset) applyPresetToProfile(profile.id, preset);
                  }}
                >
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                  <option value="other">Other</option>
                </select>
              </label>
              <div className="default-scale-editor">
                <ScaleRowsEditor
                  rows={draft.rows}
                  onChange={(rows) => {
                    const preset = presets.find((item) => item.id === draft.preset_id);
                    const stillMatches = preset ? scalesMatch(rows, preset.rows) : false;
                    updateProfileDraft(profile.id, {
                      rows,
                      preset_id: stillMatches ? draft.preset_id : "",
                    });
                  }}
                />
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn primary" type="button" onClick={() => saveProfile(profile.id)}>
                    Save {draft.name || "default"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        <button className="btn" type="button" style={{ marginTop: 12 }} onClick={makeAnotherDefault}>
          Make another default
        </button>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2>Appearance</h2>
        <div className="appearance-settings">
          <label className="appearance-toggle">
            <span>
              <strong>Color grades by letter</strong>
              <small>Color individual assignment scores in each class using the A+ through F key.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={appearance.gradeColors}
              onChange={(e) =>
                onAppearanceChange((current) => ({ ...current, gradeColors: e.target.checked }))
              }
            />
          </label>
        </div>
        <div className="grade-scale-picker">
          <p className="muted settings-note" style={{ marginTop: 14, marginBottom: 10 }}>
            Grade color scale
          </p>
          <div className="grade-scale-options">
            {GRADE_SCALES.map((scale) => {
              const selected = appearance.gradeScale === scale.id;
              return (
                <button
                  key={scale.id}
                  type="button"
                  className={`grade-scale-option ${selected ? "active" : ""}`}
                  onClick={() => onAppearanceChange((current) => ({ ...current, gradeScale: scale.id }))}
                >
                  <span className="grade-scale-option-head">
                    <strong>{scale.name}</strong>
                    {scale.id === "classic" ? <span className="muted">Default</span> : null}
                  </span>
                  <small className="muted">{scale.description}</small>
                  <span className="grade-scale-swatches">
                    {PREVIEW_LETTERS.map(([letter, key]) => (
                      <span
                        key={letter}
                        className="grade-scale-swatch"
                        style={{ background: scale.colors[key] }}
                        title={letter}
                      />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
          <div className={`custom-grade-scale ${appearance.gradeScale === "custom" ? "active" : ""}`}>
            <div className="custom-grade-scale-head">
              <span>
                <strong>Custom palette</strong>
                <small>Choose an exact color for every letter grade.</small>
              </span>
              <div className="row">
                <button
                  className="btn small"
                  type="button"
                  onClick={() =>
                    onAppearanceChange((current) => ({
                      ...current,
                      customGradeColors: { ...DEFAULT_CUSTOM_GRADE_COLORS },
                    }))
                  }
                >
                  Reset
                </button>
                <button
                  className={`btn small ${appearance.gradeScale === "custom" ? "" : "primary"}`}
                  type="button"
                  onClick={() => onAppearanceChange((current) => ({ ...current, gradeScale: "custom" }))}
                >
                  {appearance.gradeScale === "custom" ? "In use" : "Use custom"}
                </button>
              </div>
            </div>
            <div className="custom-grade-colors">
              {CUSTOM_LETTERS.map(([letter, key]) => (
                <label className="custom-grade-color" key={key}>
                  <input
                    type="color"
                    value={appearance.customGradeColors?.[key] || DEFAULT_CUSTOM_GRADE_COLORS[key]}
                    onChange={(e) =>
                      onAppearanceChange((current) => ({
                        ...current,
                        gradeScale: "custom",
                        customGradeColors: {
                          ...DEFAULT_CUSTOM_GRADE_COLORS,
                          ...current.customGradeColors,
                          [key]: e.target.value,
                        },
                      }))
                    }
                    aria-label={`${letter} color`}
                  />
                  <span>{letter}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="theme-colors">
          {COLOR_FIELDS.map(([key, label, hint]) => (
            <label className="theme-color" key={key}>
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
              <span className="theme-color-controls">
                <input
                  type="color"
                  value={appearance[key]}
                  onChange={(e) => onAppearanceChange((current) => ({ ...current, [key]: e.target.value }))}
                  aria-label={label}
                />
                <input
                  className="input mono"
                  value={appearance[key]}
                  onChange={(e) => onAppearanceChange((current) => ({ ...current, [key]: e.target.value }))}
                  spellCheck={false}
                />
              </span>
            </label>
          ))}
        </div>
        <button
          className="btn"
          type="button"
          style={{ marginTop: 12 }}
          onClick={() =>
            onAppearanceChange((current) => ({
              ...current,
              primary: DEFAULT_COLORS.primary,
              secondary: DEFAULT_COLORS.secondary,
              tertiary: DEFAULT_COLORS.tertiary,
            }))
          }
        >
          Reset colors
        </button>
      </section>
    </>
  );
}
