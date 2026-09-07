export const SEASONS = [
  ["winter", "Winter"],
  ["spring", "Spring"],
  ["summer", "Summer"],
  ["fall", "Fall"],
];

export const TERM_SEQUENCE = {
  winter: 0,
  spring: 1,
  summer: 2,
  fall: 3,
};

function configuredSeasonRanks(semesterTitles) {
  const titles = Array.isArray(semesterTitles) && semesterTitles.length
    ? semesterTitles
    : SEASONS.map(([id, name]) => ({ id, name }));
  return new Map(
    titles
      .map((term, index) => [String(term?.id || "").trim().toLowerCase(), index])
      .filter(([id]) => id),
  );
}

export function semesterSortValue(semester, semesterTitles) {
  const season = String(semester?.season || "").trim().toLowerCase();
  const ranks = configuredSeasonRanks(semesterTitles);
  const rank = ranks.get(season) ?? TERM_SEQUENCE[season] ?? -1;
  return (Number(semester?.year) || 0) * 1000 + rank;
}

export function sortSemesters(semesters = [], semesterTitles, descending = true) {
  return [...(semesters || [])].sort((a, b) => {
    const value = semesterSortValue(a, semesterTitles) - semesterSortValue(b, semesterTitles);
    if (value) return descending ? -value : value;
    const idValue = (Number(a?.id) || 0) - (Number(b?.id) || 0);
    return descending ? -idValue : idValue;
  });
}
