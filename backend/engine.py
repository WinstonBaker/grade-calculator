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

DEFAULT_PASS_FAIL = {
    "rows": [{"label": "S", "min_percent": 70.0}, {"label": "U", "min_percent": 0.0}],
}

PRESET_PASS_FAIL = {
    "ncsu": {"rows": [{"label": "S", "min_percent": 70.0}, {"label": "U", "min_percent": 0.0}]},
    "unc": {"rows": [{"label": "PS", "min_percent": 73.0, "is_passing": False}, {"label": "LP", "min_percent": 60.0, "is_passing": True}, {"label": "F", "min_percent": 0.0, "is_passing": False}], "fail_affects_gpa": True},
    "clemson": {"rows": [{"label": "P", "min_percent": 60.0}, {"label": "NP", "min_percent": 0.0}]},
    "ecu": {"rows": [{"label": "P", "min_percent": 60.0}, {"label": "F", "min_percent": 0.0}]},
    "uncw": {"rows": [{"label": "P", "min_percent": 60.0}, {"label": "F", "min_percent": 0.0}]},
    "uncc": {"rows": [{"label": "P", "min_percent": 60.0}, {"label": "N", "min_percent": 0.0}]},
    "duke": {"rows": [{"label": "S", "min_percent": 70.0}, {"label": "U", "min_percent": 0.0}]},
    "cofc": {"rows": [{"label": "P", "min_percent": 73.0}, {"label": "NP", "min_percent": 0.0}]},
}

PRESET_MINIMUM_PASSING = {
    "ncsu": "C-", "unc": "C", "clemson": "D", "ecu": "D-",
    "uncw": "D-", "uncc": "D", "duke": "C-", "cofc": "C",
}

VALID_QUALITY_POINTS = {qp for _, _, qp in DEFAULT_SCALE}

# School GPA tables. Percent cutoffs are typical 10-point plus/minus bands;
# instructors can still change them per class. Quality points follow each
# school's published undergraduate transcript scale.
SCALE_PRESETS: list[dict] = [
    {
        "id": "ncsu",
        "name": "North Carolina State University",
        "description": "A+ is 4.333; plus/minus in thirds",
        "rows": DEFAULT_SCALE,
        "pass_fail": DEFAULT_PASS_FAIL,
    },
    {
        "id": "unc",
        "name": "UNC Chapel Hill",
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
        "name": "Clemson University",
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
        "name": "East Carolina University",
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
        "name": "UNC Wilmington",
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
        "name": "UNC Charlotte",
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
        "name": "Duke University",
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
            "pass_fail": dict(preset.get("pass_fail", PRESET_PASS_FAIL.get(preset["id"], DEFAULT_PASS_FAIL))),
            "minimum_passing_letter": preset.get("minimum_passing_letter", PRESET_MINIMUM_PASSING.get(preset["id"], "C-")),
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


SEASON_ORDER = {"transfer": 0, "winter": 1, "spring": 2, "summer": 3, "fall": 4}
SEASON_LABELS = {
    "transfer": "Transfer",
    "winter": "Winter",
    "spring": "Spring",
    "summer": "Summer",
    "fall": "Fall",
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


def _letter_change(course: CourseInput, before: CourseResult, after: CourseResult) -> str | None:
    """Compare the effective letter grades, including pass/fail scales."""
    if not before.letter or not after.letter:
        return None

    if before.quality_points is not None and after.quality_points is not None:
        if after.quality_points > before.quality_points:
            return "up"
        if after.quality_points < before.quality_points:
            return "down"
        return "same"

    if not is_pass_fail(course):
        return "same" if before.letter == after.letter else None

    rows = sorted(
        (course.pass_fail or PassFailScale()).rows or [],
        key=lambda row: float(row.get("min_percent", 0)),
        reverse=True,
    )
    rank = {row.get("label"): index for index, row in enumerate(rows)}
    before_rank = rank.get(before.letter)
    after_rank = rank.get(after.letter)
    if before_rank is None or after_rank is None:
        return "same" if before.letter == after.letter else None
    if after_rank < before_rank:
        return "up"
    if after_rank > before_rank:
        return "down"
    return "same"


def exam_impact(
    course: CourseInput,
    test_category_ids: list[int] | None,
    exam_category_id: int | None,
    target_gp: float = 4.0,
) -> dict | None:
    """Post-exam vs tests: score delta and effective letter movement."""
    test_ids = [int(item) for item in (test_category_ids or []) if item is not None]
    # Preserve order, drop duplicates.
    seen: set[int] = set()
    ordered_ids: list[int] = []
    for tid in test_ids:
        if tid in seen:
            continue
        seen.add(tid)
        ordered_ids.append(tid)
    if not ordered_ids or not exam_category_id:
        return None
    tests = [next((c for c in course.categories if c.id == tid), None) for tid in ordered_ids]
    if any(test is None for test in tests):
        return None
    exam = next((c for c in course.categories if c.id == exam_category_id), None)
    if exam is None:
        return None
    # Exam impact compares against the original test work, before any
    # drop-lowest or replacement policy changes the category result.
    test_percents = [
        category_percent(
            replace(test, drop_count=0, replace_count=0, replace_with_category_id=None),
            None,
        )
        for test in tests
    ]
    scored = [pct for pct in test_percents if pct is not None]
    test_pct = (sum(scored) / len(scored)) if scored else None
    exam_pct = category_percent(exam, course.categories)
    delta = (exam_pct - test_pct) if test_pct is not None and exam_pct is not None else None
    letter_before = None
    letter_after = None
    letter_change = None
    if test_pct is not None and exam_pct is not None:
        # The comparison baseline is always the tests-only grade.  The After
        # value must be the course's current effective grade, including any
        # manual GP or pass/fail override.
        plain = replace(course, gp_override=None, pass_fail_override=None)
        after = evaluate_course(course, target_gp)
        before = evaluate_course(course_without_category_scores(plain, exam_category_id), target_gp)
        letter_before = before.letter
        letter_after = after.letter
        letter_change = _letter_change(course, before, after)
    return {
        "test_category_ids": ordered_ids,
        "exam_category_id": exam_category_id,
        "test_percent": test_pct,
        "exam_percent": exam_pct,
        "delta": delta,
        "percent_before": before.percent if test_pct is not None and exam_pct is not None else None,
        "percent_after": after.percent if test_pct is not None and exam_pct is not None else None,
        "letter_before": letter_before,
        "letter_after": letter_after,
        "letter_change": letter_change,
    }

AGGREGATIONS = (
    "average",
    "points_ratio",
)
AGGREGATION_LABELS = {
    "average": "Average",
    "points_ratio": "Points",
}


@dataclass
class AssignmentInput:
    id: int = 0
    name: str = ""
    earned: float | None = None
    possible: float | None = None
    is_bonus: bool = False
    bonus_type: str | None = None

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
    replace_count: int = 0
    include_bonus: bool = False
    is_bonus_category: bool = False
    replace_with_category_id: int | None = None
    assignments: list[AssignmentInput] = field(default_factory=list)


@dataclass
class ScaleRow:
    letter: str
    min_percent: float
    quality_points: float


@dataclass
class PassFailScale:
    rows: list[dict] = field(default_factory=lambda: [{"label": "S", "min_percent": 70.0}, {"label": "U", "min_percent": 0.0}])
    fail_affects_gpa: bool = False


@dataclass
class CourseInput:
    id: int | None = None
    code: str = ""
    credits: float = 0.0
    bonus_points: float = 0.0
    bonus_mode: str = "none"
    gp_override: float | None = None
    grade_rounding: int | None = None
    categories: list[CategoryInput] = field(default_factory=list)
    scale: list[ScaleRow] = field(default_factory=list)
    grading_mode: str = "weighted"
    credit_mode: str = "for_credit"
    pass_fail: PassFailScale = field(default_factory=PassFailScale)
    pass_fail_override: str | None = None


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
    natural_letter: str | None = None
    natural_quality_points: float | None = None
    natural_score: int | None = None


class _ExpressionParser:
    def __init__(self, text: str):
        self.text = text
        self.index = 0

    def parse(self) -> float:
        value = self.expression()
        self.skip_space()
        if self.index != len(self.text) or not math.isfinite(value):
            raise ValueError("Invalid score expression")
        return value

    def skip_space(self) -> None:
        while self.index < len(self.text) and self.text[self.index].isspace():
            self.index += 1

    def expression(self) -> float:
        value = self.term()
        while True:
            self.skip_space()
            if self.index >= len(self.text) or self.text[self.index] not in "+-":
                return value
            operator = self.text[self.index]
            self.index += 1
            right = self.term()
            value = value + right if operator == "+" else value - right

    def term(self) -> float:
        value = self.factor()
        while True:
            self.skip_space()
            if self.index >= len(self.text) or self.text[self.index] not in "*/":
                return value
            operator = self.text[self.index]
            self.index += 1
            right = self.factor()
            if operator == "/" and right == 0:
                raise ValueError("Invalid score expression")
            value = value * right if operator == "*" else value / right

    def factor(self) -> float:
        self.skip_space()
        sign = 1.0
        if self.index < len(self.text) and self.text[self.index] in "+-":
            if self.text[self.index] == "-":
                sign = -1.0
            self.index += 1
            self.skip_space()
        if self.index < len(self.text) and self.text[self.index] == "(":
            self.index += 1
            value = self.expression()
            self.skip_space()
            if self.index >= len(self.text) or self.text[self.index] != ")":
                raise ValueError("Invalid score expression")
            self.index += 1
            return sign * value
        match = re.match(r"(?:\d+(?:\.\d*)?|\.\d+)", self.text[self.index:])
        if not match:
            raise ValueError("Invalid score expression")
        self.index += len(match.group(0))
        return sign * float(match.group(0))


def evaluate_score_expression(raw: str) -> tuple[float, float]:
    """Evaluate = expressions, treating one top-level slash as a score ratio."""
    text = str(raw or "").strip()
    if not text.startswith("="):
        raise ValueError("Score expressions must start with =")
    body = text[1:].strip()
    if not body:
        raise ValueError("Invalid score expression")
    depth = 0
    slash_index = None
    for index, char in enumerate(body):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth < 0:
                raise ValueError("Invalid score expression")
        elif char == "/" and depth == 0:
            if slash_index is not None:
                slash_index = -1
                break
            slash_index = index
    if depth != 0 or slash_index == -1:
        return _ExpressionParser(body).parse(), 100.0
    if slash_index is None:
        return _ExpressionParser(body).parse(), 100.0
    earned = _ExpressionParser(body[:slash_index]).parse()
    possible = _ExpressionParser(body[slash_index + 1:]).parse()
    return earned, possible


def parse_score(raw: str | None) -> tuple[float | None, float | None]:
    """Parse 95, 19/20, 19,20, or = arithmetic expressions."""
    if raw is None:
        return None, None
    text = str(raw).strip()
    if text == "":
        return None, None
    if text.startswith("="):
        return evaluate_score_expression(text)
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
    """Validate and normalize the current orthogonal category settings."""
    if aggregation not in AGGREGATIONS:
        raise ValueError(f"Unknown aggregation {aggregation}")
    return CategoryPolicy(
        aggregation,
        max(int(drop_count or 0), 0),
        bool(include_bonus),
        replace_with_category_id,
    )


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


def _points_possible(item: AssignmentInput) -> float:
    return float(item.possible) if item.possible not in (None, 0) else 100.0


def _ranked_points_subset(
    assignments: list[AssignmentInput], drop: int, ratio: float
) -> list[AssignmentInput]:
    fixed = [item for item in assignments if item.possible in (None, 0)]
    eligible = [item for item in assignments if item.possible not in (None, 0)]
    keep_count = len(eligible) - min(max(drop, 0), max(len(eligible) - 1, 0))
    return fixed + sorted(
        eligible,
        key=lambda item: item.earned - ratio * _points_possible(item),
        reverse=True,
    )[:keep_count]


def _best_points_subset(
    assignments: list[AssignmentInput],
    drop: int,
    base_earned: float = 0.0,
    base_possible: float = 0.0,
) -> list[AssignmentInput]:
    """Keep the fixed-size subset that maximizes the resulting points ratio.

    For a candidate ratio r, the best k-row subset is the k rows with the
    largest (earned - r * possible) contribution. Binary search over r finds
    the optimal ratio without enumerating every combination of rows.
    """
    if not assignments:
        return []
    keep_count = len(assignments) - min(max(drop, 0), len(assignments) - 1)
    if keep_count >= len(assignments):
        return assignments

    low = -1_000_000.0
    high = 1_000_000.0
    for _ in range(70):
        ratio = (low + high) / 2.0
        kept = _ranked_points_subset(assignments, drop, ratio)
        contribution = base_earned + sum(item.earned for item in kept if item.earned is not None)
        contribution -= ratio * (
            base_possible + sum(_points_possible(item) for item in kept)
        )
        if contribution >= 0:
            low = ratio
        else:
            high = ratio

    return _ranked_points_subset(assignments, drop, low)


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
    bonuses = _bonus_values(category)

    if category.is_bonus_category:
        return sum(bonuses)

    if policy.aggregation == "points_ratio":
        scored = [a for a in category.assignments if a.has_score() and not a.is_bonus]
        if policy.drop_count:
            scored = _best_points_subset(scored, policy.drop_count, 0)
        if policy.replace_with_category_id is not None and categories:
            other = next((c for c in categories if c.id == policy.replace_with_category_id), None)
            if other is not None:
                replacement = category_percent(replace(other, replace_with_category_id=None), None)
                replacements = min(max(int(category.replace_count or 0), 0), len(scored))
                candidates = [item for item in scored if item.possible not in (None, 0) and item.percent() is not None]
                for _ in range(replacements):
                    if not candidates:
                        break
                    lowest = min(candidates, key=lambda item: (item.percent(), item.name))
                    if replacement is None or replacement <= lowest.percent():
                        break
                    scored[scored.index(lowest)] = replace(
                        lowest,
                        earned=(replacement / 100.0) * float(lowest.possible),
                    )
                    candidates.remove(lowest)
        pct = points_ratio(scored)
        return pct

    if not regular:
        return None

    scores = _kept_scores(regular, policy.drop_count)
    if not scores:
        return None
    if policy.replace_with_category_id is not None and categories:
        other = next((c for c in categories if c.id == policy.replace_with_category_id), None)
        if other is not None:
            replacement = category_percent(replace(other, replace_with_category_id=None), None)
            if replacement is not None:
                replacements = min(
                    max(int(category.replace_count or 0), 0),
                    len(scores),
                )
                for _ in range(replacements):
                    lowest = min(scores)
                    if replacement <= lowest:
                        break
                    scores.remove(lowest)
                    scores.append(replacement)

    assignment_bonuses = [
        item.earned
        for item in category.assignments
        if item.is_bonus and item.bonus_type != "category" and item.earned is not None
    ]
    category_bonuses = [
        item.earned
        for item in category.assignments
        if item.is_bonus and item.bonus_type == "category" and item.earned is not None
    ]
    return (sum(scores) + sum(assignment_bonuses)) / len(scores) + sum(category_bonuses)


def effective_weight(category: CategoryInput) -> float:
    if category.weight_per_item is not None:
        return category.weight_per_item * _score_count(category)
    return category.weight


def _assignment_possible(item: AssignmentInput) -> float:
    if item.possible not in (None, 0):
        return float(item.possible)
    return 100.0


def course_points_percent(course: CourseInput) -> float | None:
    """Overall percent from total earned / possible, ignoring category weights."""
    scored_by_category: list[tuple[CategoryInput, list[AssignmentInput]]] = []
    earned = 0.0
    possible = 0.0
    bonus = 0.0
    fixed_earned = 0.0
    any_row = False
    for cat in course.categories:
        scored = [item for item in cat.assignments if not item.is_bonus and item.earned is not None]
        scored_by_category.append((cat, scored))
        any_row = any_row or bool(scored)
        for item in scored:
            earned += item.earned
            possible += _assignment_possible(item)
        for item in cat.assignments:
            if item.is_bonus:
                if (
                    cat.is_bonus_category
                    and cat.aggregation == "points_ratio"
                    and course.bonus_mode == "category"
                    and item.earned is not None
                ):
                    earned += item.earned
                    fixed_earned += item.earned
                    any_row = True
                elif cat.include_bonus and not cat.is_bonus_category and item.earned is not None:
                    bonus += item.earned

    if any(category.drop_count for category, _ in scored_by_category):
        low = -1_000_000.0
        high = 1_000_000.0
        for _ in range(70):
            ratio = (low + high) / 2.0
            candidate_earned = fixed_earned + bonus
            candidate_possible = 0.0
            for category, scored in scored_by_category:
                if not scored:
                    continue
                drop = resolve_category_policy(
                    "points_ratio", category.drop_count, False, None
                ).drop_count
                kept = _ranked_points_subset(scored, drop, ratio)
                candidate_earned += sum(item.earned for item in kept if item.earned is not None)
                candidate_possible += sum(_assignment_possible(item) for item in kept)
            if candidate_earned - ratio * candidate_possible >= 0:
                low = ratio
            else:
                high = ratio

        earned = fixed_earned
        possible = 0.0
        for category, scored in scored_by_category:
            if not scored:
                continue
            drop = resolve_category_policy(
                "points_ratio", category.drop_count, False, None
            ).drop_count
            kept = _ranked_points_subset(scored, drop, low)
            earned += sum(item.earned for item in kept if item.earned is not None)
            possible += sum(_assignment_possible(item) for item in kept)
    if not any_row or possible == 0:
        return None
    static_points = course.bonus_points if course.bonus_mode == "static_points" else 0.0
    return 100.0 * (earned + bonus + static_points) / possible


def is_points_based(course: CourseInput) -> bool:
    return (course.grading_mode or "weighted") == "points"


def is_pass_fail(course: CourseInput) -> bool:
    return (course.credit_mode or "for_credit") == "pass_fail"


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
        calculated_cat = (
            replace(cat, aggregation="points_ratio")
            if is_points_based(course) and not cat.is_bonus_category
            else cat
        )
        pct = category_percent(calculated_cat, course.categories)
        weight = effective_weight(calculated_cat)
        weighted = weight * pct if pct is not None and weight else None
        cat_results.append(
            CategoryResult(
                id=cat.id,
                name=cat.name,
                aggregation=calculated_cat.aggregation,
                weight=calculated_cat.weight,
                effective_weight=weight,
                percent=pct,
                weighted=weighted,
                score_count=_score_count(cat),
            )
        )

    used = [(c.effective_weight, c.percent) for c in cat_results if c.percent is not None and c.effective_weight]
    category_bonus = sum(
        result.percent or 0.0
        for result, category in zip(cat_results, course.categories)
        if category.is_bonus_category
        and category.aggregation != "points_ratio"
        and result.percent is not None
    )
    applied_bonus = (
        category_bonus
        if course.bonus_mode == "category"
        else 0.0
        if course.bonus_mode in {"none", "static_points"}
        else course.bonus_points or 0.0
    )
    if is_points_based(course):
        raw = course_points_percent(course)
        percent = (raw + applied_bonus) if raw is not None else None
    elif used:
        raw = sum(w * p for w, p in used) / sum(w for w, _ in used)
        percent = raw + applied_bonus
    else:
        percent = None

    letter, gp = letter_from_percent(round_half_up(percent, course.grade_rounding), scale)
    natural_letter, natural_gp = letter, gp
    if is_pass_fail(course):
        pf = course.pass_fail or PassFailScale()
        options = sorted(pf.rows or [], key=lambda row: float(row.get("min_percent", 0)), reverse=True)
        eligible = [row for row in options if percent is not None and percent >= float(row.get("min_percent", 0))]
        natural_row = max(eligible, key=lambda row: float(row.get("min_percent", 0))) if eligible else None
        natural_letter = natural_row.get("label") if natural_row else None
        natural_gp = None
        letter = course.pass_fail_override or natural_letter
        effective_row = next((row for row in options if row.get("label") == letter), natural_row)
        gp = 0.0 if pf.fail_affects_gpa and effective_row and not effective_row.get("is_passing", False) else None
    valid_qp = quality_points_set(scale) or VALID_QUALITY_POINTS
    if course.gp_override == -1 and not is_pass_fail(course):
        return CourseResult(
            percent=percent,
            letter="N/A",
            quality_points=None,
            score=None,
            natural_letter=natural_letter,
            natural_quality_points=natural_gp,
            natural_score=term_score(natural_gp, course.credits, target_gp) if natural_gp is not None else None,
            categories=cat_results,
            what_if=[],
        )
    if not is_pass_fail(course) and course.gp_override is not None and course.gp_override in valid_qp:
        gp = course.gp_override
        letter = next((row.letter for row in scale if row.quality_points == gp), letter)
    elif not is_pass_fail(course) and course.gp_override is not None:
        # Invalid override is ignored, matching the spreadsheet MATCH check.
        pass

    natural_score = term_score(natural_gp, course.credits, target_gp) if natural_gp is not None else None
    score = term_score(gp, course.credits, target_gp) if gp is not None else None
    return CourseResult(
        percent=percent,
        letter=letter,
        quality_points=gp,
        score=score,
        natural_letter=natural_letter,
        natural_quality_points=natural_gp,
        natural_score=natural_score,
        categories=cat_results,
        what_if=[],
    )


def course_grade(course: CourseInput, target_gp: float = 4.0) -> CourseResult:
    scale = course.scale or [ScaleRow(*row) for row in DEFAULT_SCALE]
    result = evaluate_course(course, target_gp)
    return replace(
        result,
        what_if=[] if course.gp_override == -1 or is_pass_fail(course) else what_if_needed(course, result.categories, scale, result.percent),
    )


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
    points_based = is_points_based(course)
    remaining = [c for c in cat_results if c.percent is None and (points_based or c.effective_weight)]
    if not remaining:
        remaining = [c for c in cat_results if "final" in c.name.lower()]
    if not remaining and cat_results:
        remaining = [cat_results[-1]]

    bonus = course.bonus_points or 0.0
    rows: list[WhatIfRow] = []
    for target in remaining:
        if points_based:
            if target.id is None:
                continue
            for letter, cutoff, qp in [(r.letter, r.min_percent, r.quality_points) for r in scale]:
                if letter == "F":
                    continue
                needed = exam_score_needed(course, target.id, cutoff_with_rounding(cutoff, course.grade_rounding))
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
            continue
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


def weighted_gpa(pairs: Iterable[tuple[float, float]], include_zero: bool = False) -> float | None:
    """Return the credit-weighted GPA, optionally including zero-GP courses."""
    cred = 0.0
    points = 0.0
    any_row = False
    for credits, gp in pairs:
        if credits and (gp > 0 or (include_zero and gp == 0)):
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
    counts_by_credits: dict[float, dict[str, float]],
    scale: list[ScaleRow],
    target_gp: float,
    unit_size: float | None = None,
) -> tuple[int | None, float, int | None]:
    """Return (delta_score, extra_units, None placeholder).

    ``counts_by_credits`` is still keyed by the user's planning grid, but a
    fixed-unit gradebook gives every entered class the same score/GPA unit.
    """
    letter_to_gp = {row.letter: row.quality_points for row in scale}
    extra_credits = 0.0
    raw = 0.0
    any_count = False
    for credits, letters in counts_by_credits.items():
        ch = float(unit_size) if unit_size is not None else float(credits)
        for letter, count in letters.items():
            n = float(count or 0)
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
    """Return the original single-term fumble score delta."""
    did = term_score(did_gp, credits, target_gp) or 0
    should = term_score(should_gp, credits, target_gp) or 0
    return should - did


def unit_weighted_fumble_delta(
    did_gp: float, should_gp: float, units: float, target_gp: float
) -> float:
    """Return a multi-term delta while preserving fractional class units.

    The grade-step change is rounded once, then multiplied by the class's
    academic-period unit share. This keeps a two-step change across one-third
    of a class at 0.667 instead of rounding it up to 1.
    """
    if should_gp is None or units is None:
        return 0.0
    if did_gp is None:
        return round((float(should_gp) - float(target_gp)) * 3.0) * float(units)
    grade_step_delta = round((float(should_gp) - float(did_gp)) * 3.0)
    return grade_step_delta * float(units)
