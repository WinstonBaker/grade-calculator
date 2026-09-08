import { DEFAULT_FLAGS, normalizeFlags } from "./flags.jsx";

export const DEFAULT_COLORS = {
  primary: "#e4b86d",
  secondary: "#12131a",
  tertiary: "#8bb4e8",
  text: "#e8e4d9",
};

export const DEFAULT_GRADE_SCALE = "classic";
export const DEFAULT_CREDIT_LABEL = "credits";

const DEFAULT_SEMESTER_TITLES = [
  { id: "winter", name: "Winter" },
  { id: "spring", name: "Spring" },
  { id: "summer", name: "Summer" },
  { id: "fall", name: "Fall" },
];

function normalizeSemesterTitles(value) {
  if (!Array.isArray(value)) return DEFAULT_SEMESTER_TITLES.map((item) => ({ ...item }));
  if (!value.length) return [];
  return value;
}

export const CREDIT_LABEL_OPTIONS = [
  { id: "classes", name: "Classes", singular: "class", plural: "classes", short: "class" },
  { id: "credits", name: "Credits", singular: "credit", plural: "credits", short: "cr" },
  { id: "units", name: "Units", singular: "unit", plural: "units", short: "u" },
  { id: "hours", name: "Hours", singular: "hour", plural: "hours", short: "hr" },
  {
    id: "credit_hours",
    name: "Credit hours",
    singular: "credit hour",
    plural: "credit hours",
    short: "CH",
  },
  {
    id: "semester_hours",
    name: "Semester hours",
    singular: "semester hour",
    plural: "semester hours",
    short: "SH",
  },
  { id: "other", name: "Other" },
];

export const TERM_LABEL_OPTIONS = [
  { id: "semester", name: "Semester" },
  { id: "quarter", name: "Quarter" },
  { id: "trimester", name: "Trimester" },
  { id: "term", name: "Term" },
  { id: "custom", name: "Custom" },
];

export function resolveTermLabel(appearance = {}) {
  if (appearance.termLabelId === "custom") return String(appearance.termLabelCustom || "").trim() || "Term";
  return TERM_LABEL_OPTIONS.find((item) => item.id === appearance.termLabelId)?.name || "Semester";
}

function titleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function singularFromPlural(plural) {
  const text = String(plural || "").trim();
  if (!text) return "credit";
  if (/ies$/i.test(text)) return text.replace(/ies$/i, "y");
  if (/ses$/i.test(text) || /xes$/i.test(text) || /zes$/i.test(text) || /ches$/i.test(text) || /shes$/i.test(text)) {
    return text.replace(/es$/i, "");
  }
  if (/s$/i.test(text) && !/ss$/i.test(text)) return text.slice(0, -1);
  return text;
}

export function resolveCreditTerms(appearance = {}) {
  const id = appearance.creditLabelId || DEFAULT_CREDIT_LABEL;
  if (id === "other") {
    const plural = String(appearance.creditLabelCustom || "").trim() || "credits";
    const singular = singularFromPlural(plural);
    return {
      id: "other",
      singular,
      plural,
      short: plural.slice(0, 2).toLowerCase() || "cr",
      label: titleCase(plural),
      singularLabel: titleCase(singular),
    };
  }
  const option = CREDIT_LABEL_OPTIONS.find((item) => item.id === id) || CREDIT_LABEL_OPTIONS[0];
  return {
    id: option.id,
    singular: option.singular,
    plural: option.plural,
    short: option.short,
    label: titleCase(option.plural),
    singularLabel: titleCase(option.singular),
  };
}

/** Letter keys used by grade color styles. */
export const GRADE_LETTER_KEYS = ["ap", "a", "am", "bp", "b", "bm", "cp", "c", "cm", "dp", "d", "dm", "f"];

export const DEFAULT_CUSTOM_GRADE_COLORS = {
  ap: "#a7f3d0",
  a: "#6ee7b7",
  am: "#fde68a",
  bp: "#fdba74",
  b: "#fb923c",
  bm: "#f87171",
  cp: "#ef4444",
  c: "#dc2626",
  cm: "#b91c1c",
  dp: "#991b1b",
  d: "#7f1d1d",
  dm: "#6b1620",
  f: "#450a0a",
};

export const GRADE_SCALES = [
  {
    id: "classic",
    name: "Classic",
    description: "Bright A+ green, A green, A- orange, then deepening reds",
    colors: {
      ap: "#3ee87a",
      a: "#7dce9a",
      am: "#e8a04a",
      bp: "#e88888",
      b: "#e06a6a",
      bm: "#d44f4f",
      cp: "#c43b3b",
      c: "#b12e2e",
      cm: "#9a2424",
      dp: "#7a1818",
      d: "#7a1818",
      dm: "#7a1818",
      f: "#671313",
    },
  },
  {
    id: "spectrum",
    name: "Spectrum",
    description: "Blue through teal, green, yellow, and red",
    colors: {
      ap: "#4cc9f0",
      a: "#52b788",
      am: "#95d5b2",
      bp: "#ffd166",
      b: "#f4a261",
      bm: "#e76f51",
      cp: "#e63946",
      c: "#d62828",
      cm: "#b91c1c",
      dp: "#991b1b",
      d: "#7f1d1d",
      dm: "#6b1620",
      f: "#5c1f2b",
    },
  },
  {
    id: "cool",
    name: "Cool",
    description: "Teal and blue highs with muted slate lows",
    colors: {
      ap: "#5eead4",
      a: "#2dd4bf",
      am: "#67e8f9",
      bp: "#7dd3fc",
      b: "#60a5fa",
      bm: "#818cf8",
      cp: "#a78bfa",
      c: "#c084fc",
      cm: "#eaa1ee",
      dp: "#b8a6d6",
      d: "#9ca3af",
      dm: "#7f8ba3",
      f: "#64748b",
    },
  },
  {
    id: "warm",
    name: "Warm",
    description: "Gold and amber highs fading into rust and brown",
    colors: {
      ap: "#fbbf24",
      a: "#f59e0b",
      am: "#fb923c",
      bp: "#f97316",
      b: "#ea580c",
      bm: "#dc2626",
      cp: "#b91c1c",
      c: "#991b1b",
      cm: "#b45309",
      dp: "#9a3412",
      d: "#7c2d12",
      dm: "#6b2a1a",
      f: "#4b2a20",
    },
  },
  {
    id: "forest",
    name: "Forest",
    description: "Emerald highs flowing through moss, amber, and earth",
    colors: {
      ap: "#86efac",
      a: "#4ade80",
      am: "#a3e635",
      bp: "#d9f99d",
      b: "#facc15",
      bm: "#eab308",
      cp: "#ca8a04",
      c: "#a16207",
      cm: "#b7791f",
      dp: "#975a16",
      d: "#7f5b24",
      dm: "#6b4f2a",
      f: "#5a4630",
    },
  },
];

export const DEFAULT_THEME_SCALE = "classic";
export const MAX_CUSTOM_PRESETS = 5;

export const THEME_PRESETS = [
  {
    id: "classic",
    name: "Classic",
    description: "Gold accents on a near-black canvas",
    primary: "#e4b86d",
    secondary: "#12131a",
    tertiary: "#8bb4e8",
  },
  {
    id: "light",
    name: "Light",
    description: "Warm paper background with amber and blue",
    primary: "#a87526",
    secondary: "#f4f1e9",
    tertiary: "#356da8",
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep navy with cool silver highlights",
    primary: "#c9d4e8",
    secondary: "#0b1020",
    tertiary: "#6ea8ff",
  },
  {
    id: "ocean",
    name: "Ocean",
    description: "Teal primary over a dark sea-green base",
    primary: "#3dd6c6",
    secondary: "#0e1a1c",
    tertiary: "#7eb6d9",
  },
  {
    id: "ember",
    name: "Ember",
    description: "Copper and rust on a charcoal ground",
    primary: "#e08a4a",
    secondary: "#16120f",
    tertiary: "#d4a574",
  },
];

export function parseAppearance(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const themePresets = normalizeThemePresets(parsed.themePresets);
  const gradeScalePresets = normalizeGradeScalePresets(parsed.gradeScalePresets);
  const primary = normalizeHex(parsed.primary) || DEFAULT_COLORS.primary;
  const secondary = normalizeHex(parsed.secondary) || DEFAULT_COLORS.secondary;
  const tertiary = normalizeHex(parsed.tertiary) || DEFAULT_COLORS.tertiary;
  const classLabels = Array.isArray(parsed.classLabels)
    ? parsed.classLabels
      .map((label) => ({ id: String(label?.id || ""), name: String(label?.name || "").trim() }))
      .filter((label) => label.id && label.name)
    : [];
  const courseLabels = parsed.courseLabels && typeof parsed.courseLabels === "object"
    ? Object.fromEntries(
      Object.entries(parsed.courseLabels).map(([courseId, labelIds]) => [
        String(courseId),
        Array.isArray(labelIds) ? labelIds.map(String).filter((labelId) => classLabels.some((label) => label.id === labelId)) : [],
      ]).filter(([, labelIds]) => labelIds.length)
    )
    : {};
  return {
    gradeColors: parsed.gradeColors !== false,
    showScore: parsed.showScore !== false,
    tooltips: parsed.tooltips !== false,
    gradeScale: resolveGradeScaleId(parsed.gradeScale, gradeScalePresets),
    customGradeColors: normalizeGradeColors(parsed.customGradeColors),
    gradeScalePresets,
    creditLabelId: CREDIT_LABEL_OPTIONS.some((item) => item.id === parsed.creditLabelId)
      ? parsed.creditLabelId
      : DEFAULT_CREDIT_LABEL,
    creditLabelCustom: String(parsed.creditLabelCustom || "").trim(),
    classType: parsed.classType === "named" ? "named" : "alphanumeric",
    weightedGpa: parsed.weightedGpa === true,
    wgpaInSidebar: parsed.wgpaInSidebar === true,
    semesterTitles: normalizeSemesterTitles(parsed.semesterTitles),
    termLabelId: TERM_LABEL_OPTIONS.some((item) => item.id === parsed.termLabelId) ? parsed.termLabelId : "semester",
    termLabelCustom: String(parsed.termLabelCustom || "").trim(),
    primary,
    secondary,
    tertiary,
    themeScale: resolveThemeScaleId(parsed.themeScale, { primary, secondary, tertiary }, themePresets),
    themePresets,
    autoContrastText: parsed.autoContrastText !== false,
    textColor: normalizeHex(parsed.textColor) || DEFAULT_COLORS.text,
    flags: normalizeFlags(parsed.flags),
    colorFlaggedAssignments: parsed.colorFlaggedAssignments === true,
    readableTextBackground: parsed.readableTextBackground !== false,
    classLabels,
    courseLabels,
  };
}

function defaultAppearance() {
  return {
    gradeColors: true,
    showScore: true,
    tooltips: true,
    gradeScale: DEFAULT_GRADE_SCALE,
    customGradeColors: { ...DEFAULT_CUSTOM_GRADE_COLORS },
    gradeScalePresets: [],
    creditLabelId: DEFAULT_CREDIT_LABEL,
    creditLabelCustom: "",
    classType: "alphanumeric",
    weightedGpa: false,
    wgpaInSidebar: false,
    semesterTitles: DEFAULT_SEMESTER_TITLES.map((item) => ({ ...item })),
    termLabelId: "semester",
    termLabelCustom: "",
    primary: DEFAULT_COLORS.primary,
    secondary: DEFAULT_COLORS.secondary,
    tertiary: DEFAULT_COLORS.tertiary,
    themeScale: DEFAULT_THEME_SCALE,
    themePresets: [],
    autoContrastText: true,
    textColor: DEFAULT_COLORS.text,
    flags: DEFAULT_FLAGS.map((flag) => ({ ...flag })),
    colorFlaggedAssignments: false,
    readableTextBackground: true,
    classLabels: [],
    courseLabels: {},
  };
}

export function appearancePayload(appearance) {
  return {
    gradeColors: appearance.gradeColors,
    showScore: appearance.showScore !== false,
    tooltips: appearance.tooltips !== false,
    gradeScale: resolveGradeScaleId(appearance.gradeScale, appearance.gradeScalePresets),
    customGradeColors: normalizeGradeColors(appearance.customGradeColors),
    gradeScalePresets: normalizeGradeScalePresets(appearance.gradeScalePresets),
    creditLabelId: appearance.creditLabelId || DEFAULT_CREDIT_LABEL,
    creditLabelCustom: String(appearance.creditLabelCustom || "").trim(),
    semesterTitles: normalizeSemesterTitles(appearance.semesterTitles),
    termLabelId: appearance.termLabelId || "semester",
    termLabelCustom: String(appearance.termLabelCustom || "").trim(),
    primary: appearance.primary,
    secondary: appearance.secondary,
    tertiary: appearance.tertiary,
    themeScale: appearance.themeScale || DEFAULT_THEME_SCALE,
    themePresets: normalizeThemePresets(appearance.themePresets),
    autoContrastText: appearance.autoContrastText !== false,
    textColor: normalizeHex(appearance.textColor) || DEFAULT_COLORS.text,
    flags: normalizeFlags(appearance.flags),
    colorFlaggedAssignments: appearance.colorFlaggedAssignments === true,
    readableTextBackground: appearance.readableTextBackground !== false,
    classLabels: Array.isArray(appearance.classLabels) ? appearance.classLabels : [],
    courseLabels: appearance.courseLabels && typeof appearance.courseLabels === "object" ? appearance.courseLabels : {},
  };
}

export function loadAppearance() {
  return defaultAppearance();
}

export function saveAppearance(appearance) {
  return appearancePayload(appearance);
}

export function getGradeScale(id, userPresets = []) {
  return (
    GRADE_SCALES.find((scale) => scale.id === id) ||
    normalizeGradeScalePresets(userPresets).find((scale) => scale.id === id) ||
    GRADE_SCALES[0]
  );
}

export function getActiveGradeColors(appearance = {}) {
  const userPresets = normalizeGradeScalePresets(appearance.gradeScalePresets);
  const scaleId = resolveGradeScaleId(appearance.gradeScale, userPresets);
  if (scaleId === "custom") return normalizeGradeColors(appearance.customGradeColors);
  return { ...getGradeScale(scaleId, userPresets).colors };
}

export function getThemePreset(id, userPresets = []) {
  return (
    THEME_PRESETS.find((preset) => preset.id === id) ||
    normalizeThemePresets(userPresets).find((preset) => preset.id === id) ||
    THEME_PRESETS[0]
  );
}

export function themePresetFromAppearance(appearance, id, name) {
  const preset = {
    id,
    name,
    primary: appearance.primary,
    secondary: appearance.secondary,
    tertiary: appearance.tertiary,
  };
  if (appearance.autoContrastText === false) {
    preset.autoContrastText = false;
    const textColor = normalizeHex(appearance.textColor);
    if (textColor) preset.textColor = textColor;
  }
  return preset;
}

export function appearanceFromThemePreset(preset) {
  const next = {
    themeScale: preset.id,
    primary: preset.primary,
    secondary: preset.secondary,
    tertiary: preset.tertiary,
    autoContrastText: true,
    textColor: DEFAULT_COLORS.text,
  };
  if (preset.autoContrastText === false) {
    next.autoContrastText = false;
    next.textColor = normalizeHex(preset.textColor) || DEFAULT_COLORS.text;
  }
  return next;
}

export function applyThemeColors({
  primary,
  secondary,
  tertiary,
  gradeScale,
  customGradeColors,
  gradeScalePresets,
  autoContrastText,
  textColor,
}) {
  const root = document.documentElement;
  const primaryHex = normalizeHex(primary) || DEFAULT_COLORS.primary;
  const secondaryHex = normalizeHex(secondary) || DEFAULT_COLORS.secondary;
  const tertiaryHex = normalizeHex(tertiary) || DEFAULT_COLORS.tertiary;
  const secondaryRgb = hexToRgb(secondaryHex);
  const primaryRgb = hexToRgb(primaryHex);
  const tertiaryRgb = hexToRgb(tertiaryHex);
  const lightBackground = luminance(secondaryRgb) > 0.48;
  const autoContrast = autoContrastText !== false;
  const isLight = autoContrast && lightBackground;
  const text = autoContrast
    ? isLight
      ? "#29261f"
      : DEFAULT_COLORS.text
    : normalizeHex(textColor) || DEFAULT_COLORS.text;
  const muted = isLight
    ? mixHex(secondaryHex, "#2a261f", 0.42)
    : mixHex(secondaryHex, text, 0.55);
  const raised = isLight ? mixHex(secondaryHex, "#ffffff", 0.72) : mixHex(secondaryHex, "#ffffff", 0.08);
  const hover = isLight ? mixHex(secondaryHex, "#2a261f", 0.1) : mixHex(secondaryHex, "#ffffff", 0.14);
  const lineAlpha = isLight ? 0.14 : 0.12;
  const textRgb = hexToRgb(text);

  root.style.setProperty("--bg", secondaryHex);
  root.style.setProperty("--bg-raised", raised);
  root.style.setProperty("--bg-hover", hover);
  root.style.setProperty("--line", `rgba(${textRgb.r}, ${textRgb.g}, ${textRgb.b}, ${lineAlpha})`);
  root.style.setProperty("--text", text);
  root.style.setProperty("--muted", muted);
  root.style.setProperty("--gold", primaryHex);
  root.style.setProperty("--gold-dim", `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.16)`);
  root.style.setProperty("--blue", tertiaryHex);
  root.style.setProperty(
    "--sidebar-bg",
    isLight
      ? `rgba(${secondaryRgb.r}, ${secondaryRgb.g}, ${secondaryRgb.b}, 0.94)`
      : `rgba(${secondaryRgb.r}, ${secondaryRgb.g}, ${secondaryRgb.b}, 0.92)`
  );
  root.style.setProperty(
    "--surface-soft",
    isLight ? `rgba(${textRgb.r}, ${textRgb.g}, ${textRgb.b}, 0.04)` : "rgba(255, 255, 255, 0.02)"
  );
  root.style.setProperty(
    "--detail-bg",
    isLight ? `rgba(${textRgb.r}, ${textRgb.g}, ${textRgb.b}, 0.05)` : "rgba(0, 0, 0, 0.18)"
  );
  root.style.setProperty("--shadow", isLight ? "0 16px 40px rgba(55, 46, 32, 0.11)" : "0 18px 50px rgba(0, 0, 0, 0.35)");
  root.style.setProperty(
    "--accent-glow",
    `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, ${isLight ? 0.14 : 0.1})`
  );
  root.style.setProperty(
    "--tertiary-glow",
    `rgba(${tertiaryRgb.r}, ${tertiaryRgb.g}, ${tertiaryRgb.b}, ${isLight ? 0.12 : 0.09})`
  );
  root.style.setProperty("--btn-on-primary", isLight ? "#1a1408" : contrastText(primaryRgb));
  root.dataset.tone = isLight ? "light" : "dark";

  applyGradeScale({ gradeScale, customGradeColors, gradeScalePresets });
}

function applyGradeScale({ gradeScale, customGradeColors, gradeScalePresets }) {
  const userPresets = normalizeGradeScalePresets(gradeScalePresets);
  const scaleId = resolveGradeScaleId(gradeScale, userPresets);
  const colors = getActiveGradeColors({ gradeScale, customGradeColors, gradeScalePresets: userPresets });
  const root = document.documentElement;
  root.dataset.gradeScale = scaleId;
  for (const key of GRADE_LETTER_KEYS) {
    const hex = colors[key];
    const { r, g, b } = hexToRgb(hex);
    root.style.setProperty(`--grade-${key}`, hex);
    root.style.setProperty(`--grade-${key}-bg`, `rgba(${r}, ${g}, ${b}, 0.18)`);
  }
}

function resolveGradeScaleId(id, userPresets = []) {
  if (id === "custom") return "custom";
  if (GRADE_SCALES.some((scale) => scale.id === id)) return id;
  if (normalizeGradeScalePresets(userPresets).some((preset) => preset.id === id)) return id;
  return DEFAULT_GRADE_SCALE;
}

function themeColorsMatch(colors, preset) {
  return (
    normalizeHex(colors?.primary) === normalizeHex(preset.primary) &&
    normalizeHex(colors?.secondary) === normalizeHex(preset.secondary) &&
    normalizeHex(colors?.tertiary) === normalizeHex(preset.tertiary)
  );
}

function resolveThemeScaleId(id, colors, userPresets = []) {
  if (id === "custom") return "custom";
  if (THEME_PRESETS.some((preset) => preset.id === id)) return id;
  if (userPresets.some((preset) => preset.id === id)) return id;
  const builtin = THEME_PRESETS.find((preset) => themeColorsMatch(colors, preset));
  if (builtin) return builtin.id;
  const saved = userPresets.find((preset) => themeColorsMatch(colors, preset));
  if (saved) return saved.id;
  return colors && (colors.primary || colors.secondary || colors.tertiary) ? "custom" : DEFAULT_THEME_SCALE;
}

function normalizeThemePresets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw
    .map((item) => {
      const id = String(item?.id || "").trim();
      const name = String(item?.name || "").trim();
      const primary = normalizeHex(item?.primary);
      const secondary = normalizeHex(item?.secondary);
      const tertiary = normalizeHex(item?.tertiary);
      if (!id || !name || !primary || !secondary || !tertiary) return null;
      if (THEME_PRESETS.some((preset) => preset.id === id) || seen.has(id)) return null;
      seen.add(id);
      const preset = { id, name, primary, secondary, tertiary };
      if (item.autoContrastText === false) {
        preset.autoContrastText = false;
        const textColor = normalizeHex(item.textColor);
        if (textColor) preset.textColor = textColor;
      }
      return preset;
    })
    .filter(Boolean)
    .slice(0, MAX_CUSTOM_PRESETS);
}

function normalizeGradeScalePresets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw
    .map((item) => {
      const id = String(item?.id || "").trim();
      const name = String(item?.name || "").trim();
      const colors = normalizeGradeColors(item?.colors);
      if (!id || !name) return null;
      if (GRADE_SCALES.some((preset) => preset.id === id) || seen.has(id)) return null;
      seen.add(id);
      return { id, name, colors };
    })
    .filter(Boolean)
    .slice(0, MAX_CUSTOM_PRESETS);
}

function normalizeGradeColors(colors) {
  return Object.fromEntries(
    GRADE_LETTER_KEYS.map((key) => [
      key,
      normalizeHex(colors?.[key]) || DEFAULT_CUSTOM_GRADE_COLORS[key],
    ])
  );
}

function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return null;
}

function hexToRgb(hex) {
  const normalized = normalizeHex(hex) || "#000000";
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;
}

function mixHex(a, b, amount) {
  const left = hexToRgb(a);
  const right = hexToRgb(b);
  return rgbToHex({
    r: left.r + (right.r - left.r) * amount,
    g: left.g + (right.g - left.g) * amount,
    b: left.b + (right.b - left.b) * amount,
  });
}

function luminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastText(rgb) {
  return luminance(rgb) > 0.55 ? "#1a1408" : "#f7f2e8";
}
