"""Weighted course grades, letter conversion, and GPA math."""

from __future__ import annotations

from dataclasses import dataclass, field
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

SEASON_ORDER = {"spring": 1, "summer": 2, "fall": 3}

AGGREGATIONS = (
    "average",
    "drop_lowest",
    "points_ratio",
    "average_plus_bonus",
    "replace_min_with",
)


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
class CategoryInput:
    id: int | None = None
    name: str = ""
    weight: float = 0.0
    weight_per_item: float | None = None
    aggregation: str = "average"
    drop_count: int = 1
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


def avg_drop_x(values: list[float], drop: int) -> float | None:
    """AVGDROPX: average after dropping the lowest `drop` scores, keeping at least one."""
    numbered = [v for v in values if v is not None]
    n = len(numbered)
    if n == 0:
        return None
    keep = n - min(max(drop, 0), n - 1)
    ranked = sorted(numbered, reverse=True)
    kept = ranked[:keep]
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
    agg = category.aggregation
    regular = _regular_percents(category)
    bonuses = _bonus_values(category)

    if agg == "points_ratio":
        scored = [a for a in category.assignments if a.has_score() and not a.is_bonus]
        return points_ratio(scored)

    if agg == "drop_lowest":
        return avg_drop_x(regular, category.drop_count)

    if agg == "average_plus_bonus":
        if not regular:
            return None
        return (sum(regular) + sum(bonuses)) / len(regular)

    if agg == "replace_min_with":
        if not regular:
            return None
        replacement = None
        if categories and category.replace_with_category_id is not None:
            other = next(
                (c for c in categories if c.id == category.replace_with_category_id),
                None,
            )
            if other is not None:
                # Avoid recursion through replace_min_with loops: treat replacement as average.
                replacement = category_percent(
                    CategoryInput(
                        id=other.id,
                        aggregation="average" if other.aggregation == "replace_min_with" else other.aggregation,
                        drop_count=other.drop_count,
                        assignments=other.assignments,
                    )
                )
        if replacement is None:
            return sum(regular) / len(regular)
        scores = list(regular)
        lowest = min(scores)
        if replacement > lowest:
            scores.remove(lowest)
            scores.append(replacement)
        return sum(scores) / len(scores)

    if not regular:
        return None
    return sum(regular) / len(regular)


def effective_weight(category: CategoryInput) -> float:
    if category.weight_per_item is not None:
        return category.weight_per_item * _score_count(category)
    return category.weight


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


def course_grade(course: CourseInput, target_gp: float = 4.0) -> CourseResult:
    scale = course.scale or [ScaleRow(*row) for row in DEFAULT_SCALE]
    cat_results: list[CategoryResult] = []
    percents: dict[int | None, float | None] = {}

    for cat in course.categories:
        pct = category_percent(cat, course.categories)
        percents[cat.id] = pct
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

    letter, gp = letter_from_percent(percent, scale)
    if course.gp_override is not None and course.gp_override in VALID_QUALITY_POINTS:
        gp = course.gp_override
        letter = next((row.letter for row in scale if row.quality_points == gp), letter)
    elif course.gp_override is not None:
        # Invalid override is ignored, matching the spreadsheet MATCH check.
        pass

    score = term_score(gp, course.credits, target_gp) if gp is not None else None
    what_if = what_if_needed(course, cat_results, scale, percent)
    return CourseResult(
        percent=percent,
        letter=letter,
        quality_points=gp,
        score=score,
        categories=cat_results,
        what_if=what_if,
    )


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
            needed = ((cutoff - bonus) * total_w - other_weighted) / target_weight
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
