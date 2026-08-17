const STORAGE_KEY = "grade-calculator-appearance";

export const DEFAULT_COLORS = {
  primary: "#e4b86d",
  secondary: "#12131a",
  tertiary: "#8bb4e8",
};

export const DEFAULT_GRADE_SCALE = "classic";

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
      f: "#7a1818",
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
      cm: "#9d0208",
      dp: "#6a040f",
      d: "#6a040f",
      dm: "#6a040f",
      f: "#370617",
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
      cm: "#e879f9",
      dp: "#94a3b8",
      d: "#64748b",
      dm: "#475569",
      f: "#334155",
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
      cm: "#7f1d1d",
      dp: "#78350f",
      d: "#78350f",
      dm: "#451a03",
      f: "#1c1917",
    },
  },
  {
    id: "mono",
    name: "Mono",
    description: "Neutral grayscale with subtle contrast by letter",
    colors: {
      ap: "#f8fafc",
      a: "#e2e8f0",
      am: "#cbd5e1",
      bp: "#94a3b8",
      b: "#64748b",
      bm: "#475569",
      cp: "#334155",
      c: "#1e293b",
      cm: "#0f172a",
      dp: "#0f172a",
      d: "#0f172a",
      dm: "#020617",
      f: "#020617",
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
      cm: "#854d0e",
      dp: "#713f12",
      d: "#5f3812",
      dm: "#422006",
      f: "#29200d",
    },
  },
  {
    id: "pastel",
    name: "Pastel",
    description: "Soft mint, sky, lilac, peach, and rose tones",
    colors: {
      ap: "#6ee7b7",
      a: "#93c5fd",
      am: "#a5b4fc",
      bp: "#c4b5fd",
      b: "#d8b4fe",
      bm: "#f0abfc",
      cp: "#f9a8d4",
      c: "#fda4af",
      cm: "#fca5a5",
      dp: "#fdba74",
      d: "#fb923c",
      dm: "#f97316",
      f: "#ea580c",
    },
  },
];

export function loadAppearance() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        gradeColors: parsed.gradeColors !== false,
        gradeScale: resolveGradeScaleId(parsed.gradeScale),
        customGradeColors: normalizeGradeColors(parsed.customGradeColors),
        primary: normalizeHex(parsed.primary) || DEFAULT_COLORS.primary,
        secondary: normalizeHex(parsed.secondary) || DEFAULT_COLORS.secondary,
        tertiary: normalizeHex(parsed.tertiary) || DEFAULT_COLORS.tertiary,
      };
    }
  } catch {
    /* ignore */
  }

  // Migrate older light-mode preference into a light secondary palette once.
  const legacyLight = window.localStorage.getItem("grade-calculator-light-mode") === "true";
  return {
    gradeColors: window.localStorage.getItem("grade-calculator-grade-colors") !== "false",
    gradeScale: DEFAULT_GRADE_SCALE,
    customGradeColors: { ...DEFAULT_CUSTOM_GRADE_COLORS },
    primary: legacyLight ? "#a87526" : DEFAULT_COLORS.primary,
    secondary: legacyLight ? "#f4f1e9" : DEFAULT_COLORS.secondary,
    tertiary: legacyLight ? "#356da8" : DEFAULT_COLORS.tertiary,
  };
}

export function saveAppearance(appearance) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      gradeColors: appearance.gradeColors,
      gradeScale: resolveGradeScaleId(appearance.gradeScale),
      customGradeColors: normalizeGradeColors(appearance.customGradeColors),
      primary: appearance.primary,
      secondary: appearance.secondary,
      tertiary: appearance.tertiary,
    })
  );
  window.localStorage.removeItem("grade-calculator-light-mode");
  window.localStorage.removeItem("grade-calculator-grade-colors");
}

export function getGradeScale(id) {
  return GRADE_SCALES.find((scale) => scale.id === id) || GRADE_SCALES[0];
}

export function applyThemeColors({ primary, secondary, tertiary, gradeScale, customGradeColors }) {
  const root = document.documentElement;
  const primaryHex = normalizeHex(primary) || DEFAULT_COLORS.primary;
  const secondaryHex = normalizeHex(secondary) || DEFAULT_COLORS.secondary;
  const tertiaryHex = normalizeHex(tertiary) || DEFAULT_COLORS.tertiary;
  const secondaryRgb = hexToRgb(secondaryHex);
  const primaryRgb = hexToRgb(primaryHex);
  const tertiaryRgb = hexToRgb(tertiaryHex);
  const isLight = luminance(secondaryRgb) > 0.48;
  const text = isLight ? "#29261f" : "#e8e4d9";
  const muted = isLight ? mixHex(secondaryHex, "#2a261f", 0.42) : mixHex(secondaryHex, "#e8e4d9", 0.55);
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

  applyGradeScale(resolveGradeScaleId(gradeScale), customGradeColors);
}

function applyGradeScale(scaleId, customGradeColors) {
  const root = document.documentElement;
  const colors =
    scaleId === "custom" ? normalizeGradeColors(customGradeColors) : getGradeScale(scaleId).colors;
  root.dataset.gradeScale = scaleId;
  for (const key of GRADE_LETTER_KEYS) {
    const hex = colors[key];
    const { r, g, b } = hexToRgb(hex);
    root.style.setProperty(`--grade-${key}`, hex);
    root.style.setProperty(`--grade-${key}-bg`, `rgba(${r}, ${g}, ${b}, 0.18)`);
  }
}

function resolveGradeScaleId(id) {
  return id === "custom" || GRADE_SCALES.some((scale) => scale.id === id) ? id : DEFAULT_GRADE_SCALE;
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
