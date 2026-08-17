from __future__ import annotations

import json
from datetime import date

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.engine import (
    AGGREGATIONS,
    DEFAULT_SCALE,
    SEASON_ORDER,
    AssignmentInput,
    CategoryInput,
    CourseInput,
    ScaleRow,
    course_grade,
    fumble_delta,
    future_guess_delta,
    overall_gpa_from_score,
    parse_score,
    weighted_gpa,
)
from backend.models import (
    Assignment,
    Category,
    Course,
    Fumble,
    GradeScale,
    Semester,
    Settings,
)


def seed_if_needed(db: Session) -> None:
    settings = db.get(Settings, 1)
    if settings is None:
        db.add(
            Settings(
                id=1,
                target_letter="A",
                semesters_remaining=8,
                future_guess_json="{}",
            )
        )
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    if db.query(Semester).count() == 0:
        today = date.today()
        if today.month >= 8:
            season = "fall"
        elif today.month <= 5:
            season = "spring"
        else:
            season = "summer"
        db.add(Semester(year=today.year, season=season, included=True))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()


def copy_default_scale(db: Session, course: Course) -> None:
    for letter, minimum, qp in DEFAULT_SCALE:
        db.add(
            GradeScale(
                course_id=course.id,
                letter=letter,
                min_percent=minimum,
                quality_points=qp,
            )
        )


def apply_score_fields(obj: Assignment, data, is_bonus: bool | None = None) -> None:
    bonus = obj.is_bonus if is_bonus is None else is_bonus
    if getattr(data, "clear_score", False):
        obj.earned = None
        obj.possible = None
        return
    if data.score is not None:
        text = str(data.score).strip()
        if text == "":
            obj.earned = None
            obj.possible = None
            return
        if bonus and "/" not in text and "," not in text:
            obj.earned = float(text)
            obj.possible = None
            return
        earned, possible = parse_score(text)
        obj.earned = earned
        obj.possible = possible
        return
    if data.earned is not None:
        obj.earned = data.earned
    if data.possible is not None:
        obj.possible = data.possible


def course_to_input(course: Course) -> CourseInput:
    cats = sorted(course.categories, key=lambda c: (c.sort_order, c.id))
    return CourseInput(
        id=course.id,
        code=course.code,
        credits=course.credits,
        bonus_points=course.bonus_points or 0.0,
        gp_override=course.gp_override,
        categories=[
            CategoryInput(
                id=cat.id,
                name=cat.name,
                weight=cat.weight,
                weight_per_item=cat.weight_per_item,
                aggregation=cat.aggregation,
                drop_count=cat.drop_count,
                replace_with_category_id=cat.replace_with_category_id,
                assignments=[
                    AssignmentInput(
                        name=a.name,
                        earned=a.earned,
                        possible=a.possible,
                        is_bonus=a.is_bonus,
                    )
                    for a in sorted(cat.assignments, key=lambda x: (x.sort_order, x.id))
                ],
            )
            for cat in cats
        ],
        scale=[
            ScaleRow(row.letter, row.min_percent, row.quality_points)
            for row in sorted(course.scale_rows, key=lambda r: -r.min_percent)
        ],
    )


def target_gp_from_settings(settings: Settings) -> tuple[str, float]:
    letter = settings.target_letter or "A"
    lookup = {row[0]: row[2] for row in DEFAULT_SCALE}
    return letter, lookup.get(letter, 4.0)


def serialize_assignment(a: Assignment) -> dict:
    pct = None
    if a.earned is not None:
        if a.possible:
            pct = 100.0 * a.earned / a.possible
        else:
            pct = a.earned
    display = ""
    if a.earned is not None:
        if a.possible and a.possible != 100:
            display = f"{a.earned:g}/{a.possible:g}"
        elif a.is_bonus and not a.possible:
            display = f"{a.earned:g}"
        else:
            display = f"{a.earned:g}"
    return {
        "id": a.id,
        "name": a.name,
        "earned": a.earned,
        "possible": a.possible,
        "is_bonus": a.is_bonus,
        "percent": pct,
        "display": display,
        "sort_order": a.sort_order,
    }


def serialize_course(course: Course, target_gp: float) -> dict:
    result = course_grade(course_to_input(course), target_gp)
    cats_by_id = {c.id: c for c in result.categories}
    categories = []
    for cat in sorted(course.categories, key=lambda c: (c.sort_order, c.id)):
        computed = cats_by_id.get(cat.id)
        categories.append(
            {
                "id": cat.id,
                "name": cat.name,
                "weight": cat.weight,
                "weight_per_item": cat.weight_per_item,
                "aggregation": cat.aggregation,
                "drop_count": cat.drop_count,
                "replace_with_category_id": cat.replace_with_category_id,
                "sort_order": cat.sort_order,
                "percent": computed.percent if computed else None,
                "effective_weight": computed.effective_weight if computed else cat.weight,
                "weighted": computed.weighted if computed else None,
                "score_count": computed.score_count if computed else 0,
                "assignments": [
                    serialize_assignment(a)
                    for a in sorted(cat.assignments, key=lambda x: (x.sort_order, x.id))
                ],
            }
        )
    return {
        "id": course.id,
        "semester_id": course.semester_id,
        "code": course.code,
        "credits": course.credits,
        "bonus_points": course.bonus_points,
        "gp_override": course.gp_override,
        "percent": result.percent,
        "letter": result.letter,
        "quality_points": result.quality_points,
        "score": result.score,
        "categories": categories,
        "scale": [
            {
                "id": row.id,
                "letter": row.letter,
                "min_percent": row.min_percent,
                "quality_points": row.quality_points,
            }
            for row in sorted(course.scale_rows, key=lambda r: -r.min_percent)
        ],
        "what_if": [
            {
                "category_id": w.category_id,
                "category_name": w.category_name,
                "letter": w.letter,
                "cutoff_percent": w.cutoff_percent,
                "quality_points": w.quality_points,
                "needed": w.needed,
            }
            for w in result.what_if
        ],
    }


def serialize_semester(sem: Semester, target_gp: float) -> dict:
    courses = [serialize_course(c, target_gp) for c in sem.courses]
    pairs = [
        (c["credits"], c["quality_points"])
        for c in courses
        if c["quality_points"] is not None
    ]
    gpa = weighted_gpa(pairs)
    credits = sum(c["credits"] for c in courses if c["quality_points"] is not None and c["quality_points"] > 0)
    score = sum(c["score"] or 0 for c in courses if c["quality_points"] is not None)
    return {
        "id": sem.id,
        "year": sem.year,
        "season": sem.season,
        "name": f"{sem.year} {sem.season.title()}",
        "included": sem.included,
        "term_gpa": gpa,
        "term_credits": credits,
        "term_score": score,
        "course_count": len(courses),
        "courses": courses,
    }


def sort_semesters(semesters: list[Semester]) -> list[Semester]:
    return sorted(
        semesters,
        key=lambda s: (s.year, SEASON_ORDER.get(s.season, 0)),
        reverse=True,
    )


def sort_courses(courses: list[dict], sort_by: str, descending: bool) -> list[dict]:
    key_map = {
        "code": lambda c: (c["code"] or "").lower(),
        "percent": lambda c: c["percent"] if c["percent"] is not None else -1,
        "letter": lambda c: c["quality_points"] if c["quality_points"] is not None else -1,
        "gpa": lambda c: c["quality_points"] if c["quality_points"] is not None else -1,
        "credits": lambda c: c["credits"] or 0,
        "score": lambda c: c["score"] if c["score"] is not None else -999,
    }
    key = key_map.get(sort_by, key_map["code"])
    return sorted(courses, key=key, reverse=descending)


def build_gpa(db: Session) -> dict:
    settings = db.get(Settings, 1)
    target_letter, target_gp = target_gp_from_settings(settings)
    semesters = sort_semesters(db.query(Semester).all())
    terms = [serialize_semester(s, target_gp) for s in semesters]

    included_terms = [t for t in terms if t["included"]]
    overall_score = sum(t["term_score"] for t in included_terms)
    total_credits = sum(t["term_credits"] for t in included_terms)
    overall = overall_gpa_from_score(overall_score, total_credits, target_gp) if total_credits else None

    all_credits = 0.0
    for term in terms:
        for course in term["courses"]:
            all_credits += course["credits"] or 0
    credits_remaining = all_credits - total_credits
    remaining_sems = settings.semesters_remaining or 0
    score_per_sem = (-overall_score / remaining_sems) if remaining_sems else None

    included_courses = [c for t in included_terms for c in t["courses"] if c["quality_points"]]
    dist = []
    for letter, minimum, qp in DEFAULT_SCALE:
        if letter == "F":
            continue
        matched = [c for c in included_courses if c["quality_points"] == qp]
        ch = sum(c["credits"] for c in matched)
        dist.append(
            {
                "letter": letter,
                "quality_points": qp,
                "credit_hours": ch,
                "credit_pct": (ch / total_credits) if total_credits else 0,
                "courses": len(matched),
                "course_pct": (len(matched) / len(included_courses)) if included_courses else 0,
            }
        )

    fumble_rows = []
    fumble_total = 0
    by_id = {c["id"]: c for t in terms for c in t["courses"]}
    for fumble in db.query(Fumble).all():
        course = by_id.get(fumble.course_id)
        if not course or course["quality_points"] is None:
            continue
        delta = fumble_delta(
            course["quality_points"],
            fumble.should_have_been_gp,
            course["credits"],
            target_gp,
        )
        fumble_total += delta
        fumble_rows.append(
            {
                "id": fumble.id,
                "course_id": course["id"],
                "code": course["code"],
                "did_get": course["quality_points"],
                "letter": course["letter"],
                "should_have_been_gp": fumble.should_have_been_gp,
                "credits": course["credits"],
                "delta": delta,
            }
        )

    score_with = overall_score + fumble_total
    gpa_with = overall_gpa_from_score(score_with, total_credits, target_gp) if total_credits else None

    try:
        guess_raw = json.loads(settings.future_guess_json or "{}")
    except json.JSONDecodeError:
        guess_raw = {}
    counts: dict[int, dict[str, int]] = {}
    for cred, letters in guess_raw.items():
        counts[int(cred)] = {str(k): int(v) for k, v in letters.items()}
    scale_rows = [ScaleRow(*row) for row in DEFAULT_SCALE]
    delta, extra, _ = future_guess_delta(counts, scale_rows, target_gp)
    adj_credits = total_credits + extra if extra else None
    adj_score = (overall_score + delta) if delta is not None else None
    adj_gpa = (
        overall_gpa_from_score(adj_score, adj_credits, target_gp)
        if adj_score is not None and adj_credits
        else None
    )

    return {
        "target_letter": target_letter,
        "target_gp": target_gp,
        "semesters_remaining": settings.semesters_remaining,
        "overall_gpa": overall,
        "overall_score": overall_score,
        "total_credits": total_credits,
        "credits_remaining": credits_remaining,
        "score_per_semester": score_per_sem,
        "terms": terms,
        "distribution": dist,
        "fumbles": fumble_rows,
        "fumble_total": fumble_total,
        "score_with_fumbles": score_with,
        "gpa_with_fumbles": gpa_with,
        "future_guess": {
            "grid": counts,
            "delta_score": delta,
            "extra_credits": extra,
            "adjusted_credits": adj_credits,
            "adjusted_score": adj_score,
            "adjusted_gpa": adj_gpa,
        },
        "aggregations": list(AGGREGATIONS),
        "default_scale": [
            {"letter": a, "min_percent": b, "quality_points": c} for a, b, c in DEFAULT_SCALE
        ],
    }
