from __future__ import annotations

import json
from datetime import date, datetime, timezone
from uuid import uuid4

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.engine import (
    AGGREGATION_LABELS,
    AGGREGATIONS,
    DEFAULT_SCALE,
    SEASON_LABELS,
    SEASON_ORDER,
    SNAPSHOT_INTERVALS,
    AssignmentInput,
    CategoryInput,
    CourseInput,
    ScaleRow,
    course_grade,
    course_level_band,
    exam_impact,
    fumble_delta,
    future_guess_delta,
    normalize_scale,
    overall_gpa_from_score,
    parse_score,
    preset_payload,
    scale_as_dicts,
    scale_rows_from_tuples,
    weighted_gpa,
)
from backend.models import (
    Assignment,
    Category,
    Course,
    Fumble,
    GradeScale,
    GradeSnapshot,
    ScaleProfile,
    ScaleProfileRow,
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
                gpa_cap=None,
                future_guess_json="{}",
                default_scale_json=json.dumps(scale_as_dicts(DEFAULT_SCALE)),
                snapshot_interval="off",
            )
        )
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            settings = db.get(Settings, 1)
    if settings is not None:
        raw = (settings.default_scale_json or "").strip()
        if not raw or raw in ("[]", "{}"):
            settings.default_scale_json = json.dumps(scale_as_dicts(DEFAULT_SCALE))
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
    ensure_scale_profiles(db)


def _scale_from_settings_json(settings: Settings | None) -> list[tuple[str, float, float]]:
    if settings is None:
        return list(DEFAULT_SCALE)
    raw = (settings.default_scale_json or "").strip()
    if not raw or raw in ("[]", "{}"):
        return list(DEFAULT_SCALE)
    try:
        payload = json.loads(raw)
        return normalize_scale(payload)
    except (json.JSONDecodeError, TypeError, ValueError, KeyError):
        return list(DEFAULT_SCALE)


def list_scale_profiles(db: Session) -> list[ScaleProfile]:
    return db.query(ScaleProfile).order_by(ScaleProfile.sort_order, ScaleProfile.id).all()


def primary_scale_profile(db: Session) -> ScaleProfile | None:
    primary = db.query(ScaleProfile).filter(ScaleProfile.is_primary.is_(True)).first()
    if primary is not None:
        return primary
    profiles = list_scale_profiles(db)
    return profiles[0] if profiles else None


def profile_rows_as_tuples(profile: ScaleProfile) -> list[tuple[str, float, float]]:
    rows = sorted(profile.rows, key=lambda row: (-row.min_percent, row.letter))
    return [(row.letter, row.min_percent, row.quality_points) for row in rows]


def serialize_scale_profile(profile: ScaleProfile) -> dict:
    return {
        "id": profile.id,
        "name": profile.name,
        "sort_order": profile.sort_order,
        "is_primary": bool(profile.is_primary),
        "preset_id": profile.preset_id,
        "rows": scale_as_dicts(profile_rows_as_tuples(profile)),
    }


def next_profile_name(db: Session) -> str:
    names = {profile.name for profile in list_scale_profiles(db)}
    index = 1
    while f"Default {index}" in names:
        index += 1
    return f"Default {index}"


def replace_profile_rows(db: Session, profile: ScaleProfile, rows: list[tuple[str, float, float]]) -> None:
    db.query(ScaleProfileRow).filter(ScaleProfileRow.profile_id == profile.id).delete()
    for letter, minimum, qp in rows:
        db.add(
            ScaleProfileRow(
                profile_id=profile.id,
                letter=letter,
                min_percent=minimum,
                quality_points=qp,
            )
        )
    db.flush()
    db.expire(profile, ["rows"])


def sync_primary_scale_json(db: Session, profile: ScaleProfile | None = None) -> None:
    settings = db.get(Settings, 1)
    if settings is None:
        return
    target = profile if profile is not None and profile.is_primary else primary_scale_profile(db)
    if target is None:
        return
    rows = profile_rows_as_tuples(target)
    if not rows:
        rows = list(DEFAULT_SCALE)
    settings.default_scale_json = json.dumps(scale_as_dicts(rows))
    coerce_target_letter(settings, rows)


def set_primary_profile(db: Session, profile: ScaleProfile) -> None:
    for item in list_scale_profiles(db):
        item.is_primary = item.id == profile.id
    profile.is_primary = True
    sync_primary_scale_json(db, profile)


def create_scale_profile(
    db: Session,
    name: str | None = None,
    rows: list[tuple[str, float, float]] | None = None,
    is_primary: bool = False,
    preset_id: str | None = None,
) -> ScaleProfile:
    profiles = list_scale_profiles(db)
    source = primary_scale_profile(db)
    if rows is None:
        rows = profile_rows_as_tuples(source) if source and source.rows else _scale_from_settings_json(db.get(Settings, 1))
        if preset_id is None and source is not None:
            preset_id = source.preset_id
    rows = normalize_scale(rows)
    if not profiles:
        is_primary = True
    profile = ScaleProfile(
        name=(name or "").strip() or next_profile_name(db),
        sort_order=(max((item.sort_order for item in profiles), default=-1) + 1),
        is_primary=False,
        preset_id=preset_id,
    )
    db.add(profile)
    db.flush()
    replace_profile_rows(db, profile, rows)
    if is_primary:
        set_primary_profile(db, profile)
    return profile


def ensure_scale_profiles(db: Session) -> None:
    profiles = list_scale_profiles(db)
    if profiles:
        if not any(profile.is_primary for profile in profiles):
            set_primary_profile(db, profiles[0])
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
        return
    settings = db.get(Settings, 1)
    rows = _scale_from_settings_json(settings)
    preset_id = "ncsu" if rows == list(DEFAULT_SCALE) else None
    create_scale_profile(db, name="Default 1", rows=rows, is_primary=True, preset_id=preset_id)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()


def parse_default_scale(settings: Settings | None, db: Session | None = None) -> list[tuple[str, float, float]]:
    if db is not None:
        profile = primary_scale_profile(db)
        if profile is not None and profile.rows:
            try:
                return normalize_scale(profile_rows_as_tuples(profile))
            except ValueError:
                pass
    return _scale_from_settings_json(settings)


def default_scale_dicts(settings: Settings | None) -> list[dict]:
    return scale_as_dicts(parse_default_scale(settings))


def coerce_target_letter(settings: Settings, scale: list[tuple[str, float, float]]) -> None:
    letters = {letter for letter, _, _ in scale}
    if settings.target_letter in letters:
        return
    settings.target_letter = "A" if "A" in letters else scale[0][0]


def replace_course_scale(db: Session, course: Course, rows: list[tuple[str, float, float]]) -> None:
    db.query(GradeScale).filter(GradeScale.course_id == course.id).delete()
    for letter, minimum, qp in rows:
        db.add(
            GradeScale(
                course_id=course.id,
                letter=letter,
                min_percent=minimum,
                quality_points=qp,
            )
        )


def copy_default_scale(db: Session, course: Course, profile_id: int | None = None) -> None:
    profile = db.get(ScaleProfile, profile_id) if profile_id is not None else primary_scale_profile(db)
    if profile is None:
        replace_course_scale(db, course, parse_default_scale(db.get(Settings, 1), db))
        course.scale_profile_id = None
        return
    replace_course_scale(db, course, profile_rows_as_tuples(profile))
    course.scale_profile_id = profile.id


def update_primary_scale(db: Session, rows: list[tuple[str, float, float]]) -> ScaleProfile:
    rows = normalize_scale(rows)
    profile = primary_scale_profile(db)
    if profile is None:
        profile = create_scale_profile(db, name="Default 1", rows=rows, is_primary=True)
    else:
        replace_profile_rows(db, profile, rows)
        sync_primary_scale_json(db, profile)
    return profile


def delete_scale_profile(db: Session, profile: ScaleProfile) -> None:
    remaining = [item for item in list_scale_profiles(db) if item.id != profile.id]
    if not remaining:
        raise ValueError("Cannot delete the only default scale")
    was_primary = bool(profile.is_primary)
    db.query(Course).filter(Course.scale_profile_id == profile.id).update(
        {Course.scale_profile_id: None}
    )
    db.delete(profile)
    db.flush()
    if was_primary:
        set_primary_profile(db, remaining[0])


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
        grade_rounding=course.grade_rounding,
        categories=[
            CategoryInput(
                id=cat.id,
                name=cat.name,
                weight=cat.weight,
                weight_per_item=cat.weight_per_item,
                aggregation=cat.aggregation,
                drop_count=cat.drop_count or 0,
                include_bonus=bool(cat.include_bonus),
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


def target_gp_from_settings(settings: Settings, db: Session | None = None) -> tuple[str, float]:
    scale = parse_default_scale(settings, db)
    letter = settings.target_letter or "A"
    lookup = {row[0]: row[2] for row in scale}
    if letter in lookup:
        return letter, lookup[letter]
    if "A" in lookup:
        return "A", lookup["A"]
    best = max(scale, key=lambda row: row[2])
    return best[0], best[2]


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
                "drop_count": cat.drop_count or 0,
                "include_bonus": bool(cat.include_bonus),
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
        "grade_rounding": course.grade_rounding,
        "scale_profile_id": course.scale_profile_id,
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
        "level_band": course_level_band(course.code),
        "test_category_id": course.test_category_id,
        "exam_category_id": course.exam_category_id,
        "exam_impact": _exam_impact_payload(course, target_gp),
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


def cap_gpa(gpa: float | None, gpa_cap: float | None) -> float | None:
    if gpa is None or gpa_cap is None:
        return gpa
    return min(gpa, gpa_cap)


def semester_name(sem: Semester) -> str:
    label = SEASON_LABELS.get(sem.season, sem.season.title())
    return f"{sem.year} {label}"


def _exam_impact_payload(course: Course, target_gp: float) -> dict | None:
    impact = exam_impact(
        course_to_input(course),
        course.test_category_id,
        course.exam_category_id,
        target_gp,
    )
    if not impact:
        return None
    names = {cat.id: cat.name for cat in course.categories}
    impact["test_name"] = names.get(course.test_category_id)
    impact["exam_name"] = names.get(course.exam_category_id)
    return impact


def serialize_semester(sem: Semester, target_gp: float, gpa_cap: float | None = None) -> dict:
    courses = [serialize_course(c, target_gp) for c in sem.courses]
    pairs = [
        (c["credits"], c["quality_points"])
        for c in courses
        if c["quality_points"] is not None
    ]
    gpa = cap_gpa(weighted_gpa(pairs), gpa_cap)
    credits = sum(c["credits"] for c in courses if c["quality_points"] is not None and c["quality_points"] > 0)
    score = sum(c["score"] or 0 for c in courses if c["quality_points"] is not None)
    return {
        "id": sem.id,
        "year": sem.year,
        "season": sem.season,
        "name": semester_name(sem),
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
    target_letter, target_gp = target_gp_from_settings(settings, db)
    semesters = sort_semesters(db.query(Semester).all())
    terms = [serialize_semester(s, target_gp, settings.gpa_cap) for s in semesters]

    included_terms = [t for t in terms if t["included"]]
    overall_score = sum(t["term_score"] for t in included_terms)
    total_credits = sum(t["term_credits"] for t in included_terms)
    overall = (
        cap_gpa(overall_gpa_from_score(overall_score, total_credits, target_gp), settings.gpa_cap)
        if total_credits
        else None
    )

    all_credits = 0.0
    for term in terms:
        for course in term["courses"]:
            all_credits += course["credits"] or 0
    credits_remaining = all_credits - total_credits
    remaining_sems = settings.semesters_remaining or 0
    score_per_sem = (overall_score / remaining_sems) if remaining_sems else None

    included_courses = [c for t in included_terms for c in t["courses"] if c["quality_points"] is not None]
    default_rows = parse_default_scale(settings, db)
    letters = [letter for letter, _, _ in default_rows if letter != "F"]
    seen = set(letters)
    for course in included_courses:
        letter = course.get("letter")
        if letter and letter != "F" and letter not in seen:
            letters.append(letter)
            seen.add(letter)
    dist = []
    for letter in letters:
        matched = [c for c in included_courses if c["letter"] == letter]
        qp = next((c["quality_points"] for c in matched if c["quality_points"] is not None), None)
        if qp is None:
            qp = next((row[2] for row in default_rows if row[0] == letter), 0.0)
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
    gpa_with = (
        cap_gpa(overall_gpa_from_score(score_with, total_credits, target_gp), settings.gpa_cap)
        if total_credits
        else None
    )

    try:
        guess_raw = json.loads(settings.future_guess_json or "{}")
    except json.JSONDecodeError:
        guess_raw = {}
    counts: dict[int, dict[str, int]] = {}
    for cred, letters in guess_raw.items():
        counts[int(cred)] = {str(k): int(v) for k, v in letters.items()}
    scale_rows = scale_rows_from_tuples(default_rows)
    delta, extra, _ = future_guess_delta(counts, scale_rows, target_gp)
    adj_credits = total_credits + extra if extra else None
    adj_score = (overall_score + delta) if delta is not None else None
    adj_gpa = (
        cap_gpa(overall_gpa_from_score(adj_score, adj_credits, target_gp), settings.gpa_cap)
        if adj_score is not None and adj_credits
        else None
    )

    return {
        "target_letter": target_letter,
        "target_gp": target_gp,
        "semesters_remaining": settings.semesters_remaining,
        "gpa_cap": settings.gpa_cap,
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
        "aggregation_labels": dict(AGGREGATION_LABELS),
        "default_scale": scale_as_dicts(default_rows),
        "scale_profiles": [serialize_scale_profile(profile) for profile in list_scale_profiles(db)],
        "scale_presets": preset_payload(),
        "level_stats": build_level_stats([c for t in included_terms for c in t["courses"]]),
        "exam_impact": summarize_exam_impacts(terms),
        "snapshot_interval": settings.snapshot_interval or "off",
    }


def _pack_exam_rows(rows: list[dict]) -> dict:
    deltas = [r["delta"] for r in rows if r.get("delta") is not None]
    changes = [r["letter_change"] for r in rows if r.get("letter_change")]
    return {
        "avg_delta": (sum(deltas) / len(deltas)) if deltas else None,
        "courses": len(rows),
        "with_exam": len(deltas),
        "letter_up": changes.count("up"),
        "letter_down": changes.count("down"),
        "letter_same": changes.count("same"),
    }


def summarize_exam_impacts(terms: list[dict]) -> dict:
    by_term = []
    included_rows: list[dict] = []
    for term in terms:
        rows = []
        for course in term["courses"]:
            impact = course.get("exam_impact")
            if not impact:
                continue
            row = {"course_id": course["id"], "code": course["code"], **impact}
            rows.append(row)
            if term["included"]:
                included_rows.append(row)
        by_term.append(
            {
                "semester_id": term["id"],
                "name": term["name"],
                "included": term["included"],
                "rows": rows,
                **_pack_exam_rows(rows),
            }
        )
    return {"cumulative": _pack_exam_rows(included_rows), "terms": by_term}


def build_level_stats(courses: list[dict]) -> list[dict]:
    buckets: dict[str, dict] = {}
    for course in courses:
        band = course.get("level_band") or course_level_band(course.get("code") or "")
        cur = buckets.get(band) or {
            "level": band,
            "courses": 0,
            "credits": 0.0,
            "gpa_credits": 0.0,
            "qp_credits": 0.0,
        }
        credits = float(course.get("credits") or 0)
        cur["courses"] += 1
        cur["credits"] += credits
        qp = course.get("quality_points")
        if qp is not None and qp > 0 and credits:
            cur["gpa_credits"] += credits
            cur["qp_credits"] += qp * credits
        buckets[band] = cur

    def sort_key(row: dict) -> tuple:
        if row["level"] == "other":
            return (1, 0)
        try:
            return (0, int(row["level"]))
        except ValueError:
            return (1, 0)

    out = []
    for row in sorted(buckets.values(), key=sort_key):
        out.append(
            {
                "level": row["level"],
                "courses": row["courses"],
                "credits": row["credits"],
                "gpa": (row["qp_credits"] / row["gpa_credits"]) if row["gpa_credits"] else None,
            }
        )
    return out


def export_course_templates(courses: list[Course]) -> dict:
    payload = []
    for course in sorted(courses, key=lambda c: (c.code or "").lower()):
        cats = sorted(course.categories, key=lambda c: (c.sort_order, c.id))
        by_id = {c.id: c for c in cats}
        payload.append(
            {
                "code": course.code,
                "credits": course.credits,
                "categories": [
                    {
                        "name": cat.name,
                        "weight": cat.weight,
                        "weight_per_item": cat.weight_per_item,
                        "aggregation": cat.aggregation,
                        "drop_count": cat.drop_count or 0,
                        "include_bonus": bool(cat.include_bonus),
                        "replace_with": (
                            by_id[cat.replace_with_category_id].name
                            if cat.replace_with_category_id in by_id
                            else None
                        ),
                    }
                    for cat in cats
                ],
            }
        )
    return {"version": 1, "courses": payload}


def import_course_templates(db: Session, semester_id: int, templates: list) -> list[Course]:
    created: list[Course] = []
    for item in templates:
        code = (item.code if hasattr(item, "code") else item.get("code") or "").strip()
        if not code:
            continue
        credits = item.credits if hasattr(item, "credits") else item.get("credits", 3.0)
        course = Course(semester_id=semester_id, code=code, credits=credits)
        db.add(course)
        db.flush()
        copy_default_scale(db, course)
        cats_in = item.categories if hasattr(item, "categories") else item.get("categories") or []
        created_cats: list[Category] = []
        for order, cat in enumerate(cats_in):
            name = cat.name if hasattr(cat, "name") else cat.get("name") or "Category"
            created_cats.append(
                Category(
                    course_id=course.id,
                    name=name,
                    weight=cat.weight if hasattr(cat, "weight") else cat.get("weight", 0.0),
                    weight_per_item=(
                        cat.weight_per_item if hasattr(cat, "weight_per_item") else cat.get("weight_per_item")
                    ),
                    aggregation=cat.aggregation if hasattr(cat, "aggregation") else cat.get("aggregation", "average"),
                    drop_count=cat.drop_count if hasattr(cat, "drop_count") else cat.get("drop_count", 0),
                    include_bonus=bool(
                        cat.include_bonus if hasattr(cat, "include_bonus") else cat.get("include_bonus", False)
                    ),
                    sort_order=order,
                )
            )
        db.add_all(created_cats)
        db.flush()
        by_name = {c.name: c for c in created_cats}
        for cat, src in zip(created_cats, cats_in):
            replace_with = src.replace_with if hasattr(src, "replace_with") else src.get("replace_with")
            if replace_with and replace_with in by_name and by_name[replace_with].id != cat.id:
                cat.replace_with_category_id = by_name[replace_with].id
        created.append(course)
    return created


def snapshot_status(db: Session) -> dict:
    settings = db.get(Settings, 1)
    interval = (settings.snapshot_interval if settings else None) or "off"
    days = SNAPSHOT_INTERVALS.get(interval)
    last = db.query(GradeSnapshot).order_by(GradeSnapshot.recorded_at.desc()).first()
    last_at = last.recorded_at if last else None
    due = False
    if days:
        if last_at is None:
            due = db.query(Course).count() > 0
        else:
            stamp = last_at if last_at.tzinfo else last_at.replace(tzinfo=timezone.utc)
            due = (datetime.now(timezone.utc) - stamp).days >= days
    return {
        "interval": interval if interval in SNAPSHOT_INTERVALS else "off",
        "last_recorded_at": last_at.isoformat() if last_at else None,
        "due": due,
    }


def record_grade_snapshots(db: Session, target_gp: float) -> list[dict]:
    now = datetime.now(timezone.utc)
    batch_id = str(uuid4())
    rows = []
    for course in db.query(Course).all():
        payload = serialize_course(course, target_gp)
        row = GradeSnapshot(
            course_id=course.id,
            recorded_at=now,
            percent=payload["percent"],
            letter=payload["letter"],
            batch_id=batch_id,
        )
        db.add(row)
        rows.append(row)
    db.flush()
    return [serialize_snapshot(r, None) for r in rows]


def serialize_snapshot(row: GradeSnapshot, code: str | None = None) -> dict:
    return {
        "id": row.id,
        "course_id": row.course_id,
        "code": code,
        "recorded_at": row.recorded_at.isoformat() if row.recorded_at else None,
        "percent": row.percent,
        "letter": row.letter,
        "batch_id": row.batch_id,
    }


def list_snapshots(db: Session, course_id: int | None = None) -> list[dict]:
    query = db.query(GradeSnapshot)
    if course_id is not None:
        query = query.filter(GradeSnapshot.course_id == course_id)
    rows = query.order_by(GradeSnapshot.recorded_at.asc(), GradeSnapshot.id.asc()).all()
    codes = {c.id: c.code for c in db.query(Course).all()}
    return [serialize_snapshot(row, codes.get(row.course_id)) for row in rows]
