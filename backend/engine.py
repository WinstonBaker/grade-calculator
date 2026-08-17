"""Weighted course grades, letter conversion, and GPA math."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace
from typing import Iterable

DEFAULT_SCALE: list[tuple[str, float, float]] = [
    ("A+", 97.0, 4.333),
    ("A", 93.0, 4.0),
    ("A-", 90.0, 3.667),
    ("B+", 87.0, 3.333),
    ("B", 83.0, 3.0),
    ("B-", 80.0, 2.667),
    ("C+", 77.0, 2.333),
    ("C", 73.0, 2.0),
    ("C-", 70.0, 1.667),
    ("D+", 67.0, 1.333),
    ("D", 63.0, 1.0),
    ("D-", 60.0, 0.667),
    ("F", 0.0, 0.0),
]

VALID_QUALITY_POINTS = {qp for _, _, qp in DEFAULT_SCALE}

# School GPA tables. Percent cutoffs are typical 10-point plus/minus bands;
# instructors can still change them per class. Quality points follow each
# school's published undergraduate transcript scale.
SCALE_PRESETS: list[dict] = [
    {
        "id": "ncsu",
        "name": "NC State",
        "description": "A+ is 4.333; plus/minus in thirds",
        "rows": DEFAULT_SCALE,
    },
    {
        "id": "unc",
        "name": "UNC",
        "description": "No A+ or D-; plus/minus at 3.7 / 3.3",
        "rows": [
            ("A", 93.0, 4.0),
            ("A-", 90.0, 3.7),
            ("B+", 87.0, 3.3),
            ("B", 83.0, 3.0),
            ("B-", 80.0, 2.7),
            ("C+", 77.0, 2.3),
            ("C", 73.0, 2.0),
            ("C-", 70.0, 1.7),
            ("D+", 67.0, 1.3),
            ("D", 60.0, 1.0),
            ("F", 0.0, 0.0),
        ],
    },
    {
        "id": "clemson",
        "name": "Clemson",
        "description": "A–F only; no plus/minus",
        "rows": [
            ("A", 90.0, 4.0),
            ("B", 80.0, 3.0),
            ("C", 70.0, 2.0),
            ("D", 60.0, 1.0),
            ("F", 0.0, 0.0),
        ],
    },
    {
        "id": "ecu",
        "name": "ECU",
        "description": "No A+; plus/minus at 3.7 / 3.3",
        "rows": [
            ("A", 93.0, 4.0),
            ("A-", 90.0, 3.7),
            ("B+", 87.0, 3.3),
            ("B", 83.0, 3.0),
            ("B-", 80.0, 2.7),
            ("C+", 77.0, 2.3),
            ("C", 73.0, 2.0),
            ("C-", 70.0, 1.7),
            ("D+", 67.0, 1.3),
            ("D", 63.0, 1.0),
            ("D-", 60.0, 0.7),
            ("F", 0.0, 0.0),
        ],
    },
    {
        "id": "uncw",
        "name": "UNCW",
        "description": "No A+; plus/minus in thirds",
        "rows": [
            ("A", 93.0, 4.0),
            ("A-", 90.0, 3.67),
            ("B+", 87.0, 3.33),
            ("B", 83.0, 3.0),
            ("B-", 80.0, 2.67),
            ("C+", 77.0, 2.33),
            ("C", 73.0, 2.0),
            ("C-", 70.0, 1.67),
            ("D+", 67.0, 1.33),
            ("D", 63.0, 1.0),
            ("D-", 60.0, 0.67),
            ("F", 0.0, 0.0),
        ],
    },
    {
        "id": "uncc",
        "name": "UNCC",
        "description": "A–F only; no plus/minus",
        "rows": [
            ("A", 90.0, 4.0),
            ("B", 80.0, 3.0),
            ("C", 70.0, 2.0),
            ("D", 60.0, 1.0),
            ("F", 0.0, 0.0),
        ],
    },
    {
        "id": "duke",
        "name": "Duke",
        "description": "A+ same as A (4.0); plus/minus at 3.7 / 3.3",
        "rows": [
            ("A+", 97.0, 4.0),
            ("A", 93.0, 4.0),
            ("A-", 90.0, 3.7),
            ("B+", 87.0, 3.3),
            ("B", 83.0, 3.0),
            ("B-", 80.0, 2.7),
            ("C+", 77.0, 2.3),
            ("C", 73.0, 2.0),
            ("C-", 70.0, 1.7),
            ("D+", 67.0, 1.3),
            ("D", 63.0, 1.0),
            ("D-", 60.0, 1.0),
            ("F", 0.0, 0.0),
        ],
    },
    {
        "id": "cofc",
        "name": "College of Charleston",
        "description": "No A+; plus/minus at 3.7 / 3.3",
        "rows": [
            ("A", 93.0, 4.0),
            ("A-", 90.0, 3.7),
            ("B+", 87.0, 3.3),
            ("B", 83.0, 3.0),
            ("B-", 80.0, 2.7),
            ("C+", 77.0, 2.3),
            ("C", 73.0, 2.0),
            ("C-", 70.0, 1.7),
            ("D+", 67.0, 1.3),
            ("D", 63.0, 1.0),
            ("D-", 60.0, 0.7),
            ("F", 0.0, 0.0),
        ],
    },
]


def scale_as_dicts(rows: Iterable[tuple[str, float, float]]) -> list[dict]:
    return [{"letter": letter, "min_percent": minimum, "quality_points": qp} for letter, minimum, qp in rows]


def preset_payload() -> list[dict]:
    return [
        {
            "id": preset["id"],
            "name": preset["name"],
            "description": preset["description"],
            "rows": scale_as_dicts(preset["rows"]),
        }
        for preset in SCALE_PRESETS
    ]


def _row_parts(row) -> tuple[str, float, float]:
    if isinstance(row, dict):
        letter = row.get("letter", "")
        minimum = row.get("min_percent", 0)
        qp = row.get("quality_points", 0)
    elif hasattr(row, "letter"):
        letter = row.letter
        minimum = row.min_percent
        qp = row.quality_points
    else:
        letter, minimum, qp = row
    return str(letter), float(minimum), float(qp)


def normalize_scale(rows) -> list[tuple[str, float, float]]:
    """Validate and sort a grade scale high-to-low by cutoff."""
    parsed: list[tuple[str, float, float]] = []
    seen: set[str] = set()
    if not rows:
        raise ValueError("Grade scale must include at least one letter")
    for row in rows:
        letter, minimum, qp = _row_parts(row)
        letter = letter.strip()
        if not letter:
            raise ValueError("Each row needs a letter")
        key = letter.casefold()
        if key in seen:
            raise ValueError(f"Duplicate letter {letter}")
        seen.add(key)
        parsed.append((letter, minimum, round(qp, 3)))
    parsed.sort(key=lambda item: (-item[1], item[0]))
    return parsed


def scale_rows_from_tuples(rows: Iterable[tuple[str, float, float]]) -> list["ScaleRow"]:
    return [ScaleRow(*row) for row in rows]


def quality_points_set(scale: Iterable["ScaleRow"]) -> set[float]:
    return {row.quality_points for row in scale}


SEASON_ORDER = {"transfer": 0, "spring": 1, "summer": 2, "fall": 3}
SEASON_LABELS = {
    "transfer": "Transfer",
    "spring": "Spring",
    "summer": "Summer",
    "fall": "Fall",
}

SNAPSHOT_INTERVALS = {
    "off": None,
    "weekly": 7,
    "biweekly": 14,
    "monthly": 30,
}


def course_level_band(code: str) -> str:
    """100-style (`MAE 310` → `300`) or 1000-style (`MATH 2310` → `2000`)."""
    match = re.search(r"(\d+)", code or "")
    if not match:
        return "other"
    digits = match.group(1)
    n = int(digits)
    if len(digits) == 3:
        return str((n // 100) * 100)
    if len(digits) == 4:
        return str((n // 1000) * 1000)
    return "other"


def course_without_category_scores(course: CourseInput, category_id: int) -> CourseInput:
    cats: list[CategoryInput] = []
    for cat in course.categories:
        if cat.id != category_id:
            cats.append(cat)
            continue
        cats.append(
            replace(
                cat,
                assignments=[replace(item, earned=None, possible=None) for item in cat.assignments],
            )
        )
    return replace(course, categories=cats)


def exam_impact(
    course: CourseInput,
    test_category_id: int | None,
    exam_category_id: int | None,
    target_gp: float = 4.0,
) -> dict | None:
    """Post-exam vs tests: score delta and letter movement. Ignores GP override."""
    if not test_category_id or not exam_category_id:
        return None
    test = next((c for c in course.categories if c.id == test_category_id), None)
    exam = next((c for c in course.categories if c.id == exam_category_id), None)
    if test is None or exam is None:
        return None
    test_pct = category_percent(test, course.categories)
    exam_pct = category_percent(exam, course.categories)
    delta = (exam_pct - test_pct) if test_pct is not None and exam_pct is not None else None
    plain = replace(course, gp_override=None)
    after = evaluate_course(plain, target_gp)
    before = evaluate_course(course_without_category_scores(plain, exam_category_id), target_gp)
    letter_change = None
    if before.letter and after.letter and before.quality_points is not None and after.quality_points is not None:
        if after.quality_points > before.quality_points:
            letter_change = "up"
        elif after.quality_points < before.quality_points:
            letter_change = "down"
        else:
            letter_change = "same"
    return {
        "test_category_id": test_category_id,
        "exam_category_id": exam_category_id,
        "test_percent": test_pct,
        "exam_percent": exam_pct,
        "delta": delta,
        "letter_before": before.letter,
        "letter_after": after.letter,
        "letter_change": letter_change,
    }

AGGREGATIONS = (
    "average",
    "points_ratio",
)
LEGACY_AGGREGATIONS = (
    "drop_lowest",
    "average_plus_bonus",
    "replace_min_with",
)
ACCEPTED_AGGREGATIONS = AGGREGATIONS + LEGACY_AGGREGATIONS
AGGREGATION_LABELS = {
    "average": "Average",
    "points_ratio": "Points ratio",
}


@dataclass
class AssignmentInput:
    name: str = ""
    earned: float | None = None
    possible: float | None = None
    is_bonus: bool = False

    def has_score(self) -> bool:
        return self.earned is not None

    def percent(self) -> float | None:
        if self.earned is None:
            return None
        if self.possible and self.possible != 0:
            return 100.0 * self.earned / self.possible
        return self.earned


@dataclass
class CategoryPolicy:
    aggregation: str
    drop_count: int
    include_bonus: bool
    replace_with_category_id: int | None


@dataclass
class CategoryInput:
    id: int | None = None
    name: str = ""
    weight: float = 0.0
    weight_per_item: float | None = None
    aggregation: str = "average"
    drop_count: int = 0
    include_bonus: bool = False
    replace_with_category_id: int | None = None
    assignments: list[AssignmentInput] = field(default_factory=list)


@dataclass
class ScaleRow:
    letter: str
    min_percent: float
    quality_points: float


@dataclass
class CourseInput:
    id: int | None = None
    code: str = ""
    credits: float = 0.0
    bonus_points: float = 0.0
    gp_override: float | None = None
    grade_rounding: int | None = None
    categories: list[CategoryInput] = field(default_factory=list)
    scale: list[ScaleRow] = field(default_factory=list)


@dataclass
class CategoryResult:
    id: int | None
    name: str
    aggregation: str
    weight: float
    effective_weight: float
    percent: float | None
    weighted: float | None
    score_count: int


@dataclass
class WhatIfRow:
    category_id: int | None
    category_name: str
    letter: str
    cutoff_percent: float
    quality_points: float
    needed: float | None


@dataclass
class CourseResult:
    percent: float | None
    letter: str | None
    quality_points: float | None
    score: int | None
    categories: list[CategoryResult]
    what_if: list[WhatIfRow]


def parse_score(raw: str | None) -> tuple[float | None, float | None]:
    """Parse 95, 19/20, or 19,20 into (earned, possible)."""
    if raw is None:
        return None, None
    text = str(raw).strip()
    if text == "":
        return None, None
    for sep in ("/", ",", " "):
        if sep in text:
            parts = [p.strip() for p in text.replace("/", sep).split(sep) if p.strip()]
            if len(parts) >= 2:
                return float(parts[0]), float(parts[1])
    return float(text), 100.0


def resolve_category_policy(
    aggregation: str = "average",
    drop_count: int | None = 0,
    include_bonus: bool = False,
    replace_with_category_id: int | None = None,
) -> CategoryPolicy:
    """Map exclusive legacy modes onto base + drop + bonus + replace knobs."""
    drop = max(int(drop_count or 0), 0)
    bonus = bool(include_bonus)
    replace_id = replace_with_category_id
    if aggregation == "drop_lowest":
        return CategoryPolicy("average", drop if drop else 1, bonus, replace_id)
    if aggregation == "average_plus_bonus":
        return CategoryPolicy("average", drop, True, replace_id)
    if aggregation == "replace_min_with":
        return CategoryPolicy("average", drop, bonus, replace_id)
    if aggregation == "points_ratio":
        return CategoryPolicy("points_ratio", drop, bonus, replace_id)
    return CategoryPolicy("average", drop, bonus, replace_id)


def _kept_scores(values: list[float], drop: int) -> list[float]:
    numbered = [v for v in values if v is not None]
    n = len(numbered)
    if n == 0:
        return []
    keep = n - min(max(drop, 0), n - 1)
    ranked = sorted(numbered, reverse=True)
    return ranked[:keep]


def avg_drop_x(values: list[float], drop: int) -> float | None:
    """AVGDROPX: average after dropping the lowest `drop` scores, keeping at least one."""
    kept = _kept_scores(values, drop)
    if not kept:
        return None
    return sum(kept) / len(kept)


def points_ratio(assignments: Iterable[AssignmentInput]) -> float | None:
    """PNTSUMTOT: 100 * sum(earned) / sum(possible) for scored rows."""
    earned = 0.0
    possible = 0.0
    any_row = False
    for item in assignments:
        if item.earned is None:
            continue
        any_row = True
        earned += item.earned
        possible += item.possible if item.possible not in (None, 0) else 0.0
    if not any_row or possible == 0:
        return None
    return 100.0 * earned / possible


def _regular_percents(category: CategoryInput) -> list[float]:
    out: list[float] = []
    for item in category.assignments:
        if item.is_bonus or not item.has_score():
            continue
        pct = item.percent()
        if pct is not None:
            out.append(pct)
    return out


def _bonus_values(category: CategoryInput) -> list[float]:
    return [item.earned for item in category.assignments if item.is_bonus and item.earned is not None]


def _score_count(category: CategoryInput) -> int:
    return sum(1 for item in category.assignments if (not item.is_bonus) and item.has_score())


def category_percent(
    category: CategoryInput,
    categories: list[CategoryInput] | None = None,
) -> float | None:
    policy = resolve_category_policy(
        category.aggregation,
        category.drop_count,
        category.include_bonus,
        category.replace_with_category_id,
    )
    regular = _regular_percents(category)
    bonuses = _bonus_values(category) if policy.include_bonus else []

    if policy.aggregation == "points_ratio":
        scored = [a for a in category.assignments if a.has_score() and not a.is_bonus]
        pct = points_ratio(scored)
        if pct is None or not bonuses:
            return pct
        earned = sum(item.earned for item in scored if item.earned is not None)
        possible = sum(
            item.possible if item.possible not in (None, 0) else 0.0 for item in scored
        )
        if possible == 0:
            return None
        return 100.0 * (earned + sum(bonuses)) / possible

    if not regular:
        return None

    scores = list(regular)
    if policy.replace_with_category_id is not None and categories:
        other = next((c for c in categories if c.id == policy.replace_with_category_id), None)
        if other is not None:
            replacement = category_percent(replace(other, replace_with_category_id=None), None)
            if replacement is not None:
                lowest = min(scores)
                if replacement > lowest:
                    scores.remove(lowest)
                    scores.append(replacement)

    kept = _kept_scores(scores, policy.drop_count)
    if not kept:
        return None
    return (sum(kept) + sum(bonuses)) / len(kept)


def effective_weight(category: CategoryInput) -> float:
    if category.weight_per_item is not None:
        return category.weight_per_item * _score_count(category)
    return category.weight


def round_half_up(percent: float | None, decimals: int | None) -> float | None:
    """Percent as the professor would round it (92.5 → 93 at 0 decimals)."""
    if percent is None or decimals is None:
        return percent
    factor = 10.0 ** decimals
    return math.floor(percent * factor + 0.5) / factor


def cutoff_with_rounding(cutoff: float, decimals: int | None) -> float:
    """Lowest raw percent that still rounds up to `cutoff`."""
    if decimals is None:
        return cutoff
    return cutoff - 0.5 / (10.0 ** decimals)


def letter_from_percent(percent: float | None, scale: list[ScaleRow]) -> tuple[str | None, float | None]:
    if percent is None:
        return None, None
    rows = scale or [ScaleRow(*row) for row in DEFAULT_SCALE]
    eligible = [row for row in rows if row.min_percent <= percent]
    if not eligible:
        return None, None
    best = max(eligible, key=lambda row: row.min_percent)
    return best.letter, best.quality_points


def term_score(quality_points: float | None, credits: float, target_gp: float) -> int | None:
    if quality_points is None or credits is None:
        return None
    return int(round((quality_points - target_gp) * credits * 3.0))


def evaluate_course(course: CourseInput, target_gp: float = 4.0) -> CourseResult:
    """Grade the course without what-if rows."""
    scale = course.scale or [ScaleRow(*row) for row in DEFAULT_SCALE]
    cat_results: list[CategoryResult] = []

    for cat in course.categories:
        pct = category_percent(cat, course.categories)
        weight = effective_weight(cat)
        weighted = weight * pct if pct is not None and weight else None
        cat_results.append(
            CategoryResult(
                id=cat.id,
                name=cat.name,
                aggregation=cat.aggregation,
                weight=cat.weight,
                effective_weight=weight,
                percent=pct,
                weighted=weighted,
                score_count=_score_count(cat),
            )
        )

    used = [(c.effective_weight, c.percent) for c in cat_results if c.percent is not None and c.effective_weight]
    if used:
        raw = sum(w * p for w, p in used) / sum(w for w, _ in used)
        percent = raw + (course.bonus_points or 0.0)
    else:
        percent = None

    letter, gp = letter_from_percent(round_half_up(percent, course.grade_rounding), scale)
    valid_qp = quality_points_set(scale) or VALID_QUALITY_POINTS
    if course.gp_override is not None and course.gp_override in valid_qp:
        gp = course.gp_override
        letter = next((row.letter for row in scale if row.quality_points == gp), letter)
    elif course.gp_override is not None:
        # Invalid override is ignored, matching the spreadsheet MATCH check.
        pass

    score = term_score(gp, course.credits, target_gp) if gp is not None else None
    return CourseResult(
        percent=percent,
        letter=letter,
        quality_points=gp,
        score=score,
        categories=cat_results,
        what_if=[],
    )


def course_grade(course: CourseInput, target_gp: float = 4.0) -> CourseResult:
    scale = course.scale or [ScaleRow(*row) for row in DEFAULT_SCALE]
    result = evaluate_course(course, target_gp)
    return replace(result, what_if=what_if_needed(course, result.categories, scale, result.percent))


def course_with_exam_score(
    course: CourseInput,
    category_id: int,
    exam_percent: float,
) -> CourseInput:
    """Copy of the course with one category forced to `exam_percent`."""
    cats: list[CategoryInput] = []
    for cat in course.categories:
        if cat.id != category_id:
            cats.append(cat)
            continue
        n = max(_score_count(cat), 1)
        cats.append(
            replace(
                cat,
                aggregation="average",
                drop_count=0,
                include_bonus=False,
                replace_with_category_id=None,
                assignments=[
                    AssignmentInput(name="Exam", earned=exam_percent, possible=100.0)
                    for _ in range(n)
                ],
            )
        )
    return replace(course, categories=cats)


def project_from_exam(
    course: CourseInput,
    category_id: int,
    exam_percent: float,
    target_gp: float = 4.0,
) -> CourseResult:
    """Overall grade if the chosen category (usually the final) scores `exam_percent`."""
    forced = course_with_exam_score(course, category_id, exam_percent)
    forced = replace(forced, gp_override=None)
    return evaluate_course(forced, target_gp)


def exam_score_needed(
    course: CourseInput,
    category_id: int,
    cutoff: float,
    target_gp: float = 4.0,
) -> float | None:
    """Exam percent that makes the overall course grade equal `cutoff`."""

    def overall(exam: float) -> float | None:
        return project_from_exam(course, category_id, exam, target_gp).percent

    p0 = overall(0.0)
    p100 = overall(100.0)
    if p0 is None or p100 is None:
        return None
    slope = (p100 - p0) / 100.0
    p50 = overall(50.0)
    linear_mid = p0 + 0.5 * (p100 - p0)
    if p50 is not None and abs(p50 - linear_mid) < 1e-6:
        if abs(slope) < 1e-15:
            return None
        return (cutoff - p0) / slope

    lo, hi = -100.0, 300.0
    p_lo, p_hi = overall(lo), overall(hi)
    if p_lo is None or p_hi is None:
        return None
    if abs(p_hi - p_lo) < 1e-15:
        return None
    if p_hi < cutoff or p_lo >= cutoff:
        return lo + (cutoff - p_lo) * (hi - lo) / (p_hi - p_lo)
    for _ in range(48):
        mid = (lo + hi) / 2.0
        got = overall(mid)
        if got is None:
            return None
        if got >= cutoff:
            hi = mid
        else:
            lo = mid
    return hi


def what_if_needed(
    course: CourseInput,
    cat_results: list[CategoryResult],
    scale: list[ScaleRow],
    _current_percent: float | None,
) -> list[WhatIfRow]:
    """Score needed on incomplete (or final) categories to hit each letter cutoff."""
    remaining = [c for c in cat_results if c.percent is None and c.effective_weight]
    if not remaining:
        remaining = [c for c in cat_results if "final" in c.name.lower()]
    if not remaining and cat_results:
        remaining = [cat_results[-1]]

    bonus = course.bonus_points or 0.0
    rows: list[WhatIfRow] = []
    for target in remaining:
        others = [c for c in cat_results if c.id != target.id and c.percent is not None and c.effective_weight]
        other_weighted = sum((c.effective_weight * c.percent) for c in others)
        other_weight = sum(c.effective_weight for c in others)
        # If the target already has a stored weight of 0 (no scores yet) but has a fixed weight, use it.
        src = next((c for c in course.categories if c.id == target.id), None)
        target_weight = target.effective_weight
        if (not target_weight) and src is not None:
            target_weight = src.weight if src.weight_per_item is None else src.weight_per_item
        if not target_weight:
            continue
        total_w = other_weight + target_weight
        for letter, cutoff, qp in [(r.letter, r.min_percent, r.quality_points) for r in scale]:
            if letter == "F":
                continue
            # Want (other_weighted + w * needed) / total_w + bonus = cutoff
            effective = cutoff_with_rounding(cutoff, course.grade_rounding)
            needed = ((effective - bonus) * total_w - other_weighted) / target_weight
            rows.append(
                WhatIfRow(
                    category_id=target.id,
                    category_name=target.name,
                    letter=letter,
                    cutoff_percent=cutoff,
                    quality_points=qp,
                    needed=needed,
                )
            )
    return rows


def weighted_gpa(pairs: Iterable[tuple[float, float]]) -> float | None:
    """pairs of (credits, quality_points). Only positive GP counts, matching SUMIF(gp>0)."""
    cred = 0.0
    points = 0.0
    any_row = False
    for credits, gp in pairs:
        if gp and gp > 0 and credits:
            any_row = True
            cred += credits
            points += credits * gp
    if not any_row or cred == 0:
        return None
    return points / cred


def overall_gpa_from_score(score: float, credits: float, target_gp: float) -> float | None:
    if not credits:
        return None
    return (score / 3.0 + target_gp * credits) / credits


def future_guess_delta(
    counts_by_credits: dict[int, dict[str, int]],
    scale: list[ScaleRow],
    target_gp: float,
) -> tuple[int | None, float, int | None]:
    """Return (delta_score, extra_credits, None placeholder)."""
    letter_to_gp = {row.letter: row.quality_points for row in scale}
    extra_credits = 0.0
    raw = 0.0
    any_count = False
    for credits, letters in counts_by_credits.items():
        ch = int(credits)
        for letter, count in letters.items():
            n = int(count or 0)
            if n <= 0:
                continue
            gp = letter_to_gp.get(letter)
            if gp is None:
                continue
            any_count = True
            extra_credits += n * ch
            raw += ch * n * (gp - target_gp)
    if not any_count:
        return None, extra_credits, None
    # Spreadsheet: round(sum(credits * count * (gp-target)) / 0.333)
    delta = int(round(raw / 0.333))
    return delta, extra_credits, None


def fumble_delta(did_gp: float, should_gp: float, credits: float, target_gp: float) -> int:
    did = term_score(did_gp, credits, target_gp) or 0
    should = term_score(should_gp, credits, target_gp) or 0
    return should - did
