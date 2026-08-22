import { useEffect, useState } from "react";
import { api, letterClass } from "./api";
import { ScaleRowsEditor, scalesMatch } from "./ScaleEditor.jsx";
import {
  CREDIT_LABEL_OPTIONS,
  DEFAULT_CUSTOM_GRADE_COLORS,
  DEFAULT_COLORS,
  GRADE_SCALES,
  MAX_CUSTOM_PRESETS,
  THEME_PRESETS,
  appearanceFromThemePreset,
  getActiveGradeColors,
  getGradeScale,
  themePresetFromAppearance,
} from "./theme";
import { useCreditTerms, useShowScore } from "./creditLabel.jsx";

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

export default function Settings({ appearance, onAppearanceChange, onChange }) {
  const creditTerms = useCreditTerms();
  const showScore = useShowScore();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateError, setUpdateError] = useState("");
  const [updateMessage, setUpdateMessage] = useState("");
  const [profileDrafts, setProfileDrafts] = useState({});
  const [themePresetName, setThemePresetName] = useState("");
  const [gradeScalePresetName, setGradeScalePresetName] = useState("");
  const savedThemePresets = appearance.themePresets || [];
  const savedGradeScalePresets = appearance.gradeScalePresets || [];
  const themePresetLimitReached = savedThemePresets.length >= MAX_CUSTOM_PRESETS;
  const gradeScalePresetLimitReached = savedGradeScalePresets.length >= MAX_CUSTOM_PRESETS;

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
    api.updates().then(setUpdateInfo).catch(() => {});
  }, []);

  async function refreshAll() {
    const [gpa, nextMeta] = await Promise.all([api.gpa(), api.meta().catch(() => null)]);
    applyGpa(gpa);
    if (nextMeta) setMeta(nextMeta);
    await onChange?.();
  }

  async function runUpdate() {
    setUpdateBusy(true);
    setUpdateError("");
    setUpdateMessage("");
    let restarting = false;
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
      const result = await api.applyUpdate();
      if (result.restarting) {
        restarting = true;
        setUpdateMessage("Installing over this app and restarting…");
        return;
      }
      const fallback = result.download_url || result.release_url || info.download_url || meta?.release_url;
      if (fallback) {
        window.open(fallback, "_blank", "noopener,noreferrer");
        setUpdateMessage(`Version ${info.latest_version} is available. Opened the download in your browser.`);
      }
    } catch (err) {
      setUpdateError(err.message);
    } finally {
      if (!restarting) setUpdateBusy(false);
      try {
        await refreshAll();
        const nextInfo = await api.updates().catch(() => null);
        if (nextInfo) setUpdateInfo(nextInfo);
      } catch (err) {
        setError(err.message);
      }
    }
  }

  async function updateSettings(patch) {
    try {
      applyGpa(await api.patchSettings(patch));
      await onChange?.();
      setMessage("Saved");
      setError("");
      window.setTimeout(() => setMessage(""), 1400);
    } catch (err) {
      setError(err.message);
    }
  }

  async function refreshProfiles(okMessage = "Saved") {
    try {
      await refreshAll();
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
          {meta?.frozen
            ? " — installs over this app and restarts."
            : " — this development build cannot replace itself; Update opens the GitHub release."}
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
        {updateInfo?.apply_status?.status === "failed_launched_staged" ||
        updateInfo?.apply_status?.status === "failed" ? (
          <p className="error">
            {updateInfo.apply_status.message ||
              "The last update could not replace the installed file. Check Settings after relaunching from the download folder."}
          </p>
        ) : null}
        {updateInfo?.update_available && updateInfo.notes ? (
          <pre className="update-notes">{updateInfo.notes}</pre>
        ) : null}
      </section>

      <section className="panel">
        <h2>Appearance</h2>
        <div className="appearance-settings">
          <label className="muted" style={{ display: "block" }}>
            Credit name
            <select
              className="select"
              style={{ display: "block", width: "min(100%, 280px)", marginTop: 6 }}
              value={appearance.creditLabelId || "credits"}
              onChange={(e) =>
                onAppearanceChange((current) => ({
                  ...current,
                  creditLabelId: e.target.value,
                }))
              }
            >
              {CREDIT_LABEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          {appearance.creditLabelId === "other" ? (
            <label className="muted" style={{ display: "block", marginTop: 10 }}>
              Custom name
              <input
                className="input"
                style={{ display: "block", width: "min(100%, 280px)", marginTop: 6 }}
                value={appearance.creditLabelCustom || ""}
                placeholder="e.g. Units"
                onChange={(e) =>
                  onAppearanceChange((current) => ({
                    ...current,
                    creditLabelCustom: e.target.value,
                  }))
                }
              />
            </label>
          ) : null}
          <label className="appearance-toggle">
            <span>
              <strong>Color grades by letter</strong>
              <small>Color individual assignment scores in each class using the A+ through F color key.</small>
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
            {savedGradeScalePresets.map((preset) => {
              const selected = appearance.gradeScale === preset.id;
              return (
                <div key={preset.id} className={`grade-scale-option saved-theme-option ${selected ? "active" : ""}`}>
                  <button
                    type="button"
                    className="saved-theme-select"
                    onClick={() =>
                      onAppearanceChange((current) => ({
                        ...current,
                        gradeScale: preset.id,
                      }))
                    }
                  >
                    <span className="grade-scale-option-head">
                      <strong>{preset.name}</strong>
                      <span className="muted">Saved</span>
                    </span>
                    <span className="grade-scale-swatches">
                      {PREVIEW_LETTERS.map(([letter, key]) => (
                        <span
                          key={letter}
                          className="grade-scale-swatch"
                          style={{ background: preset.colors[key] }}
                          title={letter}
                        />
                      ))}
                    </span>
                  </button>
                  <button
                    className="btn small danger saved-theme-delete"
                    type="button"
                    onClick={() =>
                      onAppearanceChange((current) => {
                        const gradeScalePresets = (current.gradeScalePresets || []).filter(
                          (item) => item.id !== preset.id
                        );
                        const selectedStill = current.gradeScale === preset.id;
                        return {
                          ...current,
                          gradeScalePresets,
                          gradeScale: selectedStill ? "custom" : current.gradeScale,
                        };
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              );
            })}
          </div>
          <div className={`custom-grade-scale ${appearance.gradeScale === "custom" ? "active" : ""}`}>
            <div className="custom-grade-scale-head">
              <span>
                <strong>{appearance.gradeScale === "custom" ? "Custom palette" : "Palette"}</strong>
                <small>
                  {appearance.gradeScale === "custom"
                    ? "Choose an exact color for every letter grade."
                    : `${getGradeScale(appearance.gradeScale, savedGradeScalePresets).name} colors. Use custom to edit this palette.`}
                </small>
              </span>
              <div className="row">
                {appearance.gradeScale === "custom" ? (
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
                ) : null}
                <button
                  className={`btn small ${appearance.gradeScale === "custom" ? "" : "primary"}`}
                  type="button"
                  onClick={() =>
                    onAppearanceChange((current) => ({
                      ...current,
                      gradeScale: "custom",
                      customGradeColors: getActiveGradeColors(current),
                    }))
                  }
                >
                  {appearance.gradeScale === "custom" ? "In use" : "Use custom"}
                </button>
              </div>
            </div>
            <div className="custom-grade-colors">
              {CUSTOM_LETTERS.map(([letter, key]) => {
                const custom = appearance.gradeScale === "custom";
                const colors = getActiveGradeColors(appearance);
                return (
                  <label className={`custom-grade-color ${custom ? "" : "locked"}`} key={key}>
                    <input
                      type="color"
                      value={colors[key]}
                      disabled={!custom}
                      onChange={(e) =>
                        onAppearanceChange((current) => ({
                          ...current,
                          customGradeColors: {
                            ...getActiveGradeColors(current),
                            [key]: e.target.value,
                          },
                        }))
                      }
                      aria-label={`${letter} color`}
                    />
                    <span>{letter}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="theme-preset-save">
            <input
              className="input"
              value={gradeScalePresetName}
              placeholder="Preset name"
              aria-label="Grade color preset name"
              onChange={(e) => setGradeScalePresetName(e.target.value)}
            />
            <button
              className="btn"
              type="button"
              disabled={gradeScalePresetLimitReached}
              title={gradeScalePresetLimitReached ? `Maximum ${MAX_CUSTOM_PRESETS} saved presets` : undefined}
              onClick={() => {
                if (gradeScalePresetLimitReached) return;
                const name = gradeScalePresetName.trim() || "My palette";
                const id = `grade-${Date.now()}`;
                onAppearanceChange((current) => ({
                  ...current,
                  gradeScale: id,
                  gradeScalePresets: [
                    ...(current.gradeScalePresets || []),
                    {
                      id,
                      name,
                      colors: getActiveGradeColors(current),
                    },
                  ],
                }));
                setGradeScalePresetName("");
              }}
            >
              Save preset
            </button>
            <button
              className="btn"
              type="button"
              onClick={() =>
                onAppearanceChange((current) => ({
                  ...current,
                  gradeScale: "classic",
                }))
              }
            >
              Reset scale
            </button>
          </div>
        </div>
        <p className="muted settings-note" style={{ marginTop: 18, marginBottom: 10 }}>
          App Colors
        </p>
        <div className="grade-scale-options">
          {THEME_PRESETS.map((preset) => {
            const selected = appearance.themeScale === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={`grade-scale-option ${selected ? "active" : ""}`}
                onClick={() =>
                  onAppearanceChange((current) => ({
                    ...current,
                    ...appearanceFromThemePreset(preset),
                  }))
                }
              >
                <span className="grade-scale-option-head">
                  <strong>{preset.name}</strong>
                  {preset.id === "classic" ? <span className="muted">Default</span> : null}
                </span>
                <small className="muted">{preset.description}</small>
                <span className="grade-scale-swatches">
                  {["primary", "secondary", "tertiary"].map((key) => (
                    <span
                      key={key}
                      className="grade-scale-swatch"
                      style={{ background: preset[key] }}
                      title={key}
                    />
                  ))}
                </span>
              </button>
            );
          })}
          {(appearance.themePresets || []).map((preset) => {
            const selected = appearance.themeScale === preset.id;
            return (
              <div key={preset.id} className={`grade-scale-option saved-theme-option ${selected ? "active" : ""}`}>
                <button
                  type="button"
                  className="saved-theme-select"
                  onClick={() =>
                    onAppearanceChange((current) => ({
                      ...current,
                      ...appearanceFromThemePreset(preset),
                    }))
                  }
                >
                  <span className="grade-scale-option-head">
                    <strong>{preset.name}</strong>
                    <span className="muted">Saved</span>
                  </span>
                  <span className="grade-scale-swatches">
                    {["primary", "secondary", "tertiary"].map((key) => (
                      <span
                        key={key}
                        className="grade-scale-swatch"
                        style={{ background: preset[key] }}
                        title={key}
                      />
                    ))}
                  </span>
                </button>
                <button
                  className="btn small danger saved-theme-delete"
                  type="button"
                  onClick={() =>
                    onAppearanceChange((current) => {
                      const themePresets = (current.themePresets || []).filter((item) => item.id !== preset.id);
                      const selectedStill = current.themeScale === preset.id;
                      return {
                        ...current,
                        themePresets,
                        themeScale: selectedStill ? "custom" : current.themeScale,
                      };
                    })
                  }
                >
                  Delete
                </button>
              </div>
            );
          })}
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
                  onChange={(e) =>
                    onAppearanceChange((current) => ({
                      ...current,
                      themeScale: "custom",
                      [key]: e.target.value,
                    }))
                  }
                  aria-label={label}
                />
                <input
                  className="input mono"
                  value={appearance[key]}
                  onChange={(e) =>
                    onAppearanceChange((current) => ({
                      ...current,
                      themeScale: "custom",
                      [key]: e.target.value,
                    }))
                  }
                  spellCheck={false}
                />
              </span>
            </label>
          ))}
        </div>
        <label className="appearance-toggle appearance-subtoggle">
          <span>
            <strong>Auto-contrast text</strong>
            <small>
              When the background is light, switch body text to dark. Turn off to pick a fixed text color
              instead.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={appearance.autoContrastText !== false}
            onChange={(e) =>
              onAppearanceChange((current) => ({
                ...current,
                autoContrastText: e.target.checked,
                textColor: current.textColor || DEFAULT_COLORS.text,
              }))
            }
          />
        </label>
        {appearance.autoContrastText === false ? (
          <label className="theme-color appearance-subtoggle">
            <span>
              <strong>Text</strong>
              <small>Body text color when auto-contrast is off.</small>
            </span>
            <span className="theme-color-controls">
              <input
                type="color"
                value={appearance.textColor || DEFAULT_COLORS.text}
                onChange={(e) =>
                  onAppearanceChange((current) => ({
                    ...current,
                    textColor: e.target.value,
                  }))
                }
                aria-label="Text color"
              />
              <input
                className="input mono"
                value={appearance.textColor || DEFAULT_COLORS.text}
                onChange={(e) =>
                  onAppearanceChange((current) => ({
                    ...current,
                    textColor: e.target.value,
                  }))
                }
                spellCheck={false}
              />
            </span>
          </label>
        ) : null}
        <div className="theme-preset-save">
          <input
            className="input"
            value={themePresetName}
            placeholder="Preset name"
            aria-label="Site color preset name"
            onChange={(e) => setThemePresetName(e.target.value)}
          />
          <button
            className="btn"
            type="button"
            disabled={themePresetLimitReached}
            title={themePresetLimitReached ? `Maximum ${MAX_CUSTOM_PRESETS} saved presets` : undefined}
            onClick={() => {
              if (themePresetLimitReached) return;
              const name = themePresetName.trim() || "My theme";
              const id = `theme-${Date.now()}`;
              onAppearanceChange((current) => ({
                ...current,
                themeScale: id,
                themePresets: [
                  ...(current.themePresets || []),
                  themePresetFromAppearance(current, id, name),
                ],
              }));
              setThemePresetName("");
            }}
          >
            Save preset
          </button>
          <button
            className="btn"
            type="button"
            onClick={() =>
              onAppearanceChange((current) => ({
                ...current,
                ...appearanceFromThemePreset(THEME_PRESETS[0]),
              }))
            }
          >
            Reset colors
          </button>
        </div>
      </section>

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
            {showScore
              ? "Score measures performance relative to the selected target. Semesters remaining controls the pace shown on the GPA dashboard."
              : "Target letter and remaining semesters are used when Score is turned on."}
          </p>
          <label className="appearance-toggle" style={{ marginTop: 12 }}>
            <span>
              <strong>Show Score</strong>
              <small>
                Target-relative Score on the GPA dashboard, course lists, and sidebar. Assignment scores stay
                visible.
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={appearance.showScore !== false}
              onChange={(e) =>
                onAppearanceChange((current) => ({ ...current, showScore: e.target.checked }))
              }
            />
          </label>
          <label className="appearance-toggle" style={{ marginTop: 12 }}>
            <span>
              <strong>Cap GPA at 4.000</strong>
              <small>
                Caps semester and cumulative GPA only.
                {showScore ? " A+ quality points still count toward Score." : ""}
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={data.gpa_cap === 4}
              onChange={(e) => updateSettings({ gpa_cap: e.target.checked ? 4 : null })}
            />
          </label>
          <label className="muted" style={{ display: "block", marginTop: 14 }}>
            Grade recording interval (days)
            <input
              className="input"
              style={{ display: "block", width: "min(100%, 160px)", marginTop: 6 }}
              type="number"
              min="1"
              step="1"
              defaultValue={data.recording_interval_days ?? 7}
              onBlur={(e) => {
                const value = Math.max(1, Math.floor(Number(e.target.value) || 7));
                e.target.value = String(value);
                updateSettings({ recording_interval_days: value });
              }}
            />
            <small className="settings-note" style={{ display: "block", marginTop: 6 }}>
              How often to ask you to record class percents and semester GPA for progression charts.
            </small>
          </label>
      </section>

    </>
  );
}
