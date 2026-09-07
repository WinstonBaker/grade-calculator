from __future__ import annotations

import json
import math
import re
import uuid
from copy import copy
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.engine import (
    AGGREGATION_LABELS,
    AGGREGATIONS,
    DEFAULT_SCALE,
    DEFAULT_PASS_FAIL,
    PRESET_MINIMUM_PASSING,
    PRESET_PASS_FAIL,
    SEASON_LABELS,
    SEASON_ORDER,
    AssignmentInput,
    CategoryInput,
    CourseInput,
    PassFailScale,
    ScaleRow,
    course_grade,
    course_level_band,
    evaluate_course,
    exam_impact,
    fumble_delta,
    future_guess_delta,
    normalize_scale,
    overall_gpa_from_score,
    parse_score,
    preset_payload,
    scale_as_dicts,
    scale_rows_from_tuples,
    term_score,
    unit_weighted_fumble_delta,
    weighted_gpa,
    round_half_up,
)


def normalize_pass_fail(value=None) -> dict:
    source = value or DEFAULT_PASS_FAIL
    fail_affects_gpa = bool(source.get("fail_affects_gpa", False)) if isinstance(source, dict) else bool(getattr(source, "fail_affects_gpa", False))
    if hasattr(source, "rows"):
        rows = source.rows
    elif isinstance(source, dict) and source.get("rows") is not None:
        rows = source.get("rows")
    else:
        if hasattr(source, "pass_label"):
            pass_label, fail_label, minimum = source.pass_label, source.fail_label, source.min_percent
        elif isinstance(source, dict):
            pass_label = source.get("pass_label", "S")
            fail_label = source.get("fail_label", "U")
            minimum = source.get("min_percent", 70.0)
        else:
            pass_label, fail_label, minimum = "S", "U", 70.0
        rows = [{"label": pass_label, "min_percent": minimum}, {"label": fail_label, "min_percent": 0.0}]
    normalized = []
    seen = set()
    for row in rows or []:
        label = str(row.get("label", "")).strip()[:8] if isinstance(row, dict) else str(getattr(row, "label", "")).strip()[:8]
        raw_min = row.get("min_percent", 0) if isinstance(row, dict) else getattr(row, "min_percent", 0)
        if not label or label.casefold() in seen:
            continue
        try:
            minimum = min(100.0, max(0.0, float(raw_min)))
        except (TypeError, ValueError):
            minimum = 0.0
        seen.add(label.casefold())
        normalized.append({"label": label, "min_percent": minimum, "is_passing": bool(row.get("is_passing", False)) if isinstance(row, dict) else bool(getattr(row, "is_passing", False))})
    if not normalized:
        normalized = [{**dict(row), "is_passing": index == 0} for index, row in enumerate(DEFAULT_PASS_FAIL["rows"])]
    # Keep the user-entered order for ties; the last row is the fail/no-credit outcome
    # when a school uses the same minimum for both labels.
    normalized.sort(key=lambda row: -row["min_percent"])
    selected = next((row for row in normalized if row["is_passing"]), normalized[0])
    for row in normalized:
        row["is_passing"] = row is selected
    return {
        "rows": normalized,
        "pass_label": selected["label"],
        "fail_label": normalized[-1]["label"],
        "min_percent": selected["min_percent"],
        "minimum_passing_label": selected["label"],
        "fail_affects_gpa": fail_affects_gpa,
    }


def pass_fail_row_is_passing(course_data: dict) -> bool:
    config = course_data.get("pass_fail") or {}
    effective = course_data.get("pass_fail_override") or course_data.get("letter")
    if not effective:
        return False
    row = next((item for item in config.get("rows", []) if item.get("label") == effective), None)
    minimum = float(config.get("min_percent", 70))
    return row is not None and float(row.get("min_percent", 0)) >= minimum


def course_meets_passing_cutoff(course_data: dict) -> bool:
    if course_data.get("credit_mode") == "pass_fail":
        return pass_fail_row_is_passing(course_data)
    letter = course_data.get("letter")
    scale = course_data.get("scale") or []
    current = next((row for row in scale if row.get("letter") == letter), None)
    passing = next((row for row in scale if row.get("letter") == course_data.get("minimum_passing_letter")), None)
    return current is not None and passing is not None and float(current.get("min_percent", 0)) >= float(passing.get("min_percent", 0))


def course_pass_fail(course: Course) -> dict:
    raw = None
    try:
        raw = json.loads(course.pass_fail_rows_json or "[]")
    except (TypeError, ValueError):
        pass
    payload = raw if isinstance(raw, dict) else {"rows": raw}
    payload.update({"pass_label": course.pass_label, "fail_label": course.fail_label, "min_percent": course.pass_min_percent})
    return normalize_pass_fail(payload)


def profile_pass_fail(profile: ScaleProfile) -> dict:
    raw = None
    try:
        raw = json.loads(profile.pass_fail_rows_json or "[]")
    except (TypeError, ValueError):
        pass
    payload = raw if isinstance(raw, dict) else {"rows": raw}
    payload.update({"pass_label": profile.pass_label, "fail_label": profile.fail_label, "min_percent": profile.pass_min_percent})
    return normalize_pass_fail(payload)
from backend.models import (
    AcademicYear,
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
from backend.database import DEFAULT_GRADEBOOK_ID, active_gradebook_id, current_gradebook_id


GRADEBOOK_SETTING_FIELDS = (
    "target_letter",
    "semesters_remaining",
    "gpa_cap",
    "fail_pass_fail_affects_gpa",
    "future_guess_json",
    "default_scale_json",
    "gradebook_type",
    "gpa_weight_tags_json",
    "gpa_basis",
    "default_recording_semester_id",
)

GRADEBOOK_SETTING_DEFAULTS = {
    "target_letter": "A",
    "semesters_remaining": 8,
    "gpa_cap": None,
    "fail_pass_fail_affects_gpa": False,
    "future_guess_json": "{}",
    "gradebook_type": "college",
    "gpa_weight_tags_json": "[]",
    "gpa_basis": "credits",
    "default_recording_semester_id": None,
}


def gradebook_semesters(db: Session) -> list[Semester]:
    return db.query(Semester).filter(Semester.gradebook_id == active_gradebook_id()).all()


def gradebook_semester(db: Session, semester_id: int) -> Semester | None:
    return (
        db.query(Semester)
        .filter(Semester.id == semester_id, Semester.gradebook_id == active_gradebook_id())
        .first()
    )


def gradebook_academic_years(db: Session) -> list[AcademicYear]:
    return (
        db.query(AcademicYear)
        .filter(AcademicYear.gradebook_id == active_gradebook_id())
        .order_by(AcademicYear.name.desc(), AcademicYear.id.desc())
        .all()
    )


def gradebook_academic_year(db: Session, academic_year_id: int) -> AcademicYear | None:
    return (
        db.query(AcademicYear)
        .filter(AcademicYear.id == academic_year_id, AcademicYear.gradebook_id == active_gradebook_id())
        .first()
    )


def gradebook_scale_profile(db: Session, profile_id: int) -> ScaleProfile | None:
    return (
        db.query(ScaleProfile)
        .filter(ScaleProfile.id == profile_id, ScaleProfile.gradebook_id == active_gradebook_id())
        .first()
    )


def _gradebook_settings_map(settings: Settings) -> dict:
    try:
        value = json.loads(settings.gradebook_settings_json or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        value = {}
    return value if isinstance(value, dict) else {}


def _settings_values(settings: Settings) -> dict:
    values = {field: getattr(settings, field) for field in GRADEBOOK_SETTING_FIELDS}
    return values


def _gradebook_values(settings: Settings, gradebook_id: str | None = None) -> dict:
    """Return the stored values for one gradebook without dropping metadata."""
    key = gradebook_id or active_gradebook_id()
    values = _gradebook_settings_map(settings)
    existing = values.get(key)
    if isinstance(existing, dict):
        return dict(existing)
    if key == "gradebook-1":
        return _settings_values(settings)
    defaults = dict(GRADEBOOK_SETTING_DEFAULTS)
    defaults["default_scale_json"] = settings.default_scale_json
    return defaults


def _normalize_overall_rounding_by_period(value) -> dict:
    if not isinstance(value, dict):
        return {}
    normalized = {}
    for period, options in value.items():
        if not isinstance(options, dict):
            continue
        normalized[str(period)] = {
            "roundTermPercents": options.get("roundTermPercents") is True or options.get("round_term_percents") is True,
            "roundOverallPercent": options.get("roundOverallPercent") is True or options.get("round_overall_percent") is True,
        }
    return normalized


def _normalize_overall_rounding(value) -> dict:
    if not isinstance(value, dict):
        return {}
    return {
        "roundTermPercents": value.get("roundTermPercents") is True or value.get("round_term_percents") is True,
        "roundOverallPercent": value.get("roundOverallPercent") is True or value.get("round_overall_percent") is True,
    }


def _normalize_term_weights_by_period(value) -> dict:
    if not isinstance(value, dict):
        return {}
    normalized = {}
    for period, weights in value.items():
        if not isinstance(weights, dict):
            continue
        period_weights = {}
        for key, raw_weight in weights.items():
            try:
                weight = float(raw_weight)
            except (TypeError, ValueError):
                continue
            if math.isfinite(weight):
                period_weights[str(key)] = weight
        normalized[str(period)] = period_weights
    return normalized


def high_school_overall_rounding_by_period(db: Session) -> dict:
    settings = db.get(Settings, 1)
    if settings is None:
        return {}
    values = _gradebook_values(settings)
    global_rounding = _normalize_overall_rounding(values.get("high_school_overall_rounding"))
    if global_rounding:
        return {"__default__": global_rounding}
    return _normalize_overall_rounding_by_period(values.get("high_school_overall_rounding_by_period"))


def high_school_overall_rounding(db: Session) -> dict:
    settings = db.get(Settings, 1)
    if settings is None:
        return {"roundTermPercents": False, "roundOverallPercent": False}
    values = _gradebook_values(settings)
    global_rounding = _normalize_overall_rounding(values.get("high_school_overall_rounding"))
    if global_rounding:
        return global_rounding
    legacy = _normalize_overall_rounding_by_period(values.get("high_school_overall_rounding_by_period"))
    return {
        "roundTermPercents": any(item.get("roundTermPercents") is True for item in legacy.values()),
        "roundOverallPercent": any(item.get("roundOverallPercent") is True for item in legacy.values()),
    }


def high_school_term_weights_by_period(db: Session) -> dict:
    settings = db.get(Settings, 1)
    if settings is None:
        return {}
    return _normalize_term_weights_by_period(
        _gradebook_values(settings).get("high_school_term_weights_by_period")
    )


def update_high_school_overall_settings(
    db: Session,
    rounding: dict | None = None,
    rounding_by_period: dict | None = None,
    term_weights_by_period: dict | None = None,
) -> Settings:
    """Persist high-school overall calculation settings inside the active book."""
    settings = db.get(Settings, 1)
    if settings is None:
        seed_if_needed(db)
        settings = db.get(Settings, 1)
    values = _gradebook_settings_map(settings)
    gradebook_id = active_gradebook_id()
    book_values = _gradebook_values(settings, gradebook_id)
    if rounding is not None:
        book_values["high_school_overall_rounding"] = _normalize_overall_rounding(rounding)
    if rounding_by_period is not None:
        merged = high_school_overall_rounding_by_period(db)
        merged.update(_normalize_overall_rounding_by_period(rounding_by_period))
        book_values["high_school_overall_rounding_by_period"] = merged
    if term_weights_by_period is not None:
        merged = high_school_term_weights_by_period(db)
        merged.update(_normalize_term_weights_by_period(term_weights_by_period))
        book_values["high_school_term_weights_by_period"] = merged
    values[gradebook_id] = book_values
    settings.gradebook_settings_json = json.dumps(values)
    return settings


def settings_for_gradebook(db: Session) -> Settings:
    """Return settings with gradebook-scoped values overlaid on the base row."""
    settings = db.get(Settings, 1)
    gradebook_id = current_gradebook_id()
    if settings is None or not gradebook_id:
        return settings
    overrides = _gradebook_settings_map(settings).get(gradebook_id)
    if overrides is None:
        overrides = _settings_values(settings) if gradebook_id == "gradebook-1" else dict(GRADEBOOK_SETTING_DEFAULTS)
        # Keep the shared grade scale as the default for a newly-created book.
        if gradebook_id != "gradebook-1":
            overrides["default_scale_json"] = settings.default_scale_json
    elif gradebook_id != "gradebook-1":
        defaults = dict(GRADEBOOK_SETTING_DEFAULTS)
        defaults["default_scale_json"] = settings.default_scale_json
        defaults.update(overrides)
        overrides = defaults
    effective = copy(settings)
    for field in GRADEBOOK_SETTING_FIELDS:
        if field in overrides:
            value = overrides[field]
            setattr(effective, field, value)
    return effective


def update_gradebook_settings(db: Session, patch: dict) -> Settings:
    """Persist a settings patch for the active gradebook, or globally if none is selected."""
    settings = db.get(Settings, 1)
    if settings is None:
        seed_if_needed(db)
        settings = db.get(Settings, 1)
    gradebook_id = current_gradebook_id()
    if not gradebook_id:
        for field, value in patch.items():
            if field in GRADEBOOK_SETTING_FIELDS:
                setattr(settings, field, value)
        return settings
    effective = settings_for_gradebook(db)
    for field, value in patch.items():
        if field in GRADEBOOK_SETTING_FIELDS:
            setattr(effective, field, value)
    values = _gradebook_settings_map(settings)
    existing = _gradebook_values(settings, gradebook_id)
    values[gradebook_id] = {**existing, **_settings_values(effective)}
    settings.gradebook_settings_json = json.dumps(values)
    return effective


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
                appearance_json="{}",
                recording_interval_days=7,
                grade_prompt_snooze_until=None,
                default_recording_semester_id=None,
                gradebooks_json='[{"id":"gradebook-1","name":"Gradebook 1"}]',
                gradebook_members_json="{}",
                gradebook_appearance_json="{}",
                min_credits="1",
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
        db.add(Semester(gradebook_id=DEFAULT_GRADEBOOK_ID, year=today.year, season=season, included=True))
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


EXPLICIT_EMPTY_TEST_CATEGORY_MARKER = "__explicit_empty__"


def course_test_category_ids(course: Course) -> list[int]:
    """Return the saved test category ids in their configured order."""
    raw = (course.test_category_ids_json or "").strip()
    ids: list[int] = []
    if raw and raw not in ("[]", "{}"):
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            payload = []
        if isinstance(payload, list):
            for item in payload:
                try:
                    ids.append(int(item))
                except (TypeError, ValueError):
                    continue
    seen: set[int] = set()
    ordered: list[int] = []
    for tid in ids:
        if tid in seen:
            continue
        seen.add(tid)
        ordered.append(tid)
    return ordered


def course_test_category_ids_configured(course: Course) -> bool:
    """Distinguish an uninitialized preference from an explicit empty list."""
    raw = (course.test_category_ids_json or "").strip()
    if not raw or raw in ("[]", "{}"):
        return False
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return False
    if not isinstance(payload, list):
        return False
    return EXPLICIT_EMPTY_TEST_CATEGORY_MARKER in payload or bool(course_test_category_ids(course))


def set_course_test_category_ids(course: Course, ids: list[int] | None) -> None:
    cleaned: list[int] = []
    seen: set[int] = set()
    for item in ids or []:
        try:
            tid = int(item)
        except (TypeError, ValueError):
            continue
        if tid in seen:
            continue
        seen.add(tid)
        cleaned.append(tid)
    course.test_category_ids_json = json.dumps(cleaned or [EXPLICIT_EMPTY_TEST_CATEGORY_MARKER])


def remove_test_category(course: Course, category_id: int) -> None:
    ids = [tid for tid in course_test_category_ids(course) if tid != category_id]
    set_course_test_category_ids(course, ids)


def list_scale_profiles(db: Session) -> list[ScaleProfile]:
    return (
        db.query(ScaleProfile)
        .filter(ScaleProfile.gradebook_id == active_gradebook_id())
        .order_by(ScaleProfile.sort_order, ScaleProfile.id)
        .all()
    )


def primary_scale_profile(db: Session) -> ScaleProfile | None:
    primary = (
        db.query(ScaleProfile)
        .filter(
            ScaleProfile.gradebook_id == active_gradebook_id(),
            ScaleProfile.is_primary.is_(True),
        )
        .first()
    )
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
        "pass_fail": profile_pass_fail(profile),
        "minimum_passing_letter": profile.minimum_passing_letter or "C-",
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
    settings = settings_for_gradebook(db)
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
    if current_gradebook_id():
        base = db.get(Settings, 1)
        if base is not None:
            values = _gradebook_settings_map(base)
            values[current_gradebook_id()] = _settings_values(settings)
            base.gradebook_settings_json = json.dumps(values)


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
    pass_fail: dict | None = None,
    minimum_passing_letter: str | None = None,
) -> ScaleProfile:
    profiles = list_scale_profiles(db)
    source = primary_scale_profile(db)
    if rows is None:
        rows = profile_rows_as_tuples(source) if source and source.rows else _scale_from_settings_json(settings_for_gradebook(db))
        if preset_id is None and source is not None:
            preset_id = source.preset_id
    if pass_fail is None:
        pass_fail = profile_pass_fail(source) if source is not None else DEFAULT_PASS_FAIL
    pass_fail = normalize_pass_fail(pass_fail)
    rows = normalize_scale(rows)
    if not profiles:
        is_primary = True
    profile = ScaleProfile(
        gradebook_id=active_gradebook_id(),
        name=(name or "").strip() or next_profile_name(db),
        sort_order=(max((item.sort_order for item in profiles), default=-1) + 1),
        is_primary=False,
        preset_id=preset_id,
        pass_label=pass_fail["pass_label"],
        fail_label=pass_fail["fail_label"],
        pass_min_percent=pass_fail["min_percent"],
        pass_fail_rows_json=json.dumps(pass_fail),
        minimum_passing_letter=(minimum_passing_letter or PRESET_MINIMUM_PASSING.get(preset_id or "", "C-")),
    )
    db.add(profile)
    db.flush()
    replace_profile_rows(db, profile, rows)
    if is_primary:
        set_primary_profile(db, profile)
    return profile


def ensure_scale_profiles(db: Session) -> None:
    profiles = list_scale_profiles(db)
    if not profiles and active_gradebook_id() != DEFAULT_GRADEBOOK_ID:
        source_profiles = (
            db.query(ScaleProfile)
            .filter(ScaleProfile.gradebook_id == DEFAULT_GRADEBOOK_ID)
            .order_by(ScaleProfile.sort_order, ScaleProfile.id)
            .all()
        )
        for source in source_profiles:
            clone = ScaleProfile(
                gradebook_id=active_gradebook_id(),
                name=source.name,
                sort_order=source.sort_order,
                is_primary=bool(source.is_primary),
                preset_id=source.preset_id,
                pass_label=source.pass_label,
                fail_label=source.fail_label,
                pass_min_percent=source.pass_min_percent,
                pass_fail_rows_json=source.pass_fail_rows_json,
                minimum_passing_letter=source.minimum_passing_letter,
            )
            db.add(clone)
            db.flush()
            replace_profile_rows(db, clone, profile_rows_as_tuples(source))
        if source_profiles:
            db.commit()
            profiles = list_scale_profiles(db)
    if profiles:
        changed = False
        # A profile selected from a built-in school preset should keep its
        # pass/fail table in sync with that preset across app upgrades.
        for profile in profiles:
            preset_rows = PRESET_PASS_FAIL.get(profile.preset_id or "")
            if preset_rows is None:
                continue
            expected = normalize_pass_fail(preset_rows)
            current = profile_pass_fail(profile)
            expected_minimum = PRESET_MINIMUM_PASSING.get(profile.preset_id or "", profile.minimum_passing_letter or "C-")
            if current["rows"] != expected["rows"] or current.get("fail_affects_gpa") != expected.get("fail_affects_gpa") or profile.minimum_passing_letter != expected_minimum:
                profile.pass_label = expected["pass_label"]
                profile.fail_label = expected["fail_label"]
                profile.pass_min_percent = expected["min_percent"]
                profile.pass_fail_rows_json = json.dumps(expected)
                profile.minimum_passing_letter = expected_minimum
                changed = True
        if not any(profile.is_primary for profile in profiles):
            set_primary_profile(db, profiles[0])
            changed = True
        if changed:
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
        return
    settings = settings_for_gradebook(db)
    rows = _scale_from_settings_json(settings)
    preset_id = "ncsu" if rows == list(DEFAULT_SCALE) else None
    pass_fail = DEFAULT_PASS_FAIL if preset_id == "ncsu" else DEFAULT_PASS_FAIL
    create_scale_profile(db, name="Default 1", rows=rows, is_primary=True, preset_id=preset_id, pass_fail=pass_fail)
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


def detach_courses_from_profile(db: Session, profile: ScaleProfile) -> None:
    """Freeze classes using a profile before that shared profile is edited."""
    for course in (
        db.query(Course)
        .join(Semester, Course.semester_id == Semester.id)
        .filter(Course.scale_profile_id == profile.id, Semester.gradebook_id == active_gradebook_id())
        .all()
    ):
        replace_course_scale(db, course, profile_rows_as_tuples(profile))
        course.scale_profile_id = None


def copy_default_scale(db: Session, course: Course, profile_id: int | None = None) -> None:
    profile = gradebook_scale_profile(db, profile_id) if profile_id is not None else primary_scale_profile(db)
    if profile is None:
        replace_course_scale(db, course, parse_default_scale(settings_for_gradebook(db), db))
        course.scale_profile_id = None
        pf = DEFAULT_PASS_FAIL
    else:
        replace_course_scale(db, course, profile_rows_as_tuples(profile))
        course.scale_profile_id = profile.id
        pf = profile_pass_fail(profile)
    course.pass_label = pf["pass_label"]
    course.fail_label = pf["fail_label"]
    course.pass_min_percent = pf["min_percent"]
    course.pass_fail_rows_json = json.dumps(pf)
    course.minimum_passing_letter = profile.minimum_passing_letter if profile is not None else "C-"


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
    if profile.preset_id:
        raise ValueError("Built-in school scales cannot be deleted")
    remaining = [item for item in list_scale_profiles(db) if item.id != profile.id]
    if not remaining:
        raise ValueError("Cannot delete the only default scale")
    was_primary = bool(profile.is_primary)
    (
        db.query(Course)
        .join(Semester, Course.semester_id == Semester.id)
        .filter(Course.scale_profile_id == profile.id, Semester.gradebook_id == active_gradebook_id())
        .update({Course.scale_profile_id: None}, synchronize_session=False)
    )
    db.delete(profile)
    db.flush()
    if was_primary:
        set_primary_profile(db, remaining[0])


def apply_score_fields(
    obj: Assignment,
    data,
    is_bonus: bool | None = None,
    require_ratio: bool = False,
    allow_zero_denominator: bool = False,
) -> None:
    bonus = obj.is_bonus if is_bonus is None else is_bonus
    if getattr(data, "clear_score", False):
        obj.earned = None
        obj.possible = None
        obj.score_text = None
        return
    if data.score is not None:
        text = str(data.score).strip()
        if text == "":
            obj.earned = None
            obj.possible = None
            obj.score_text = None
            return
        if allow_zero_denominator and require_ratio and bonus and not text.startswith("=") and "/" not in text and "," not in text:
            obj.earned = float(text)
            obj.possible = 0.0
            obj.score_text = text
            return
        if require_ratio and not text.startswith("=") and "/" not in text and "," not in text:
            raise ValueError("Points grading requires a numerator and denominator, like 3/5")
        if bonus and not text.startswith("=") and "/" not in text and "," not in text:
            obj.earned = float(text)
            obj.possible = None
            obj.score_text = text
            return
        earned, possible = parse_score(text)
        if allow_zero_denominator and bonus and possible not in (None, 0):
            raise ValueError("Bonus points must use a zero denominator, like 1/0")
        if possible == 0 and not allow_zero_denominator:
            raise ValueError("The denominator must be greater than zero")
        obj.earned = earned
        obj.possible = possible
        obj.score_text = text
        return
    if data.earned is not None:
        obj.earned = data.earned
        obj.score_text = None
    if data.possible is not None:
        obj.possible = data.possible


COMPOSITE_MODES = {"points", "percent", "weighted_percent"}


def normalize_composite(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Composite grade must be an object")
    mode = str(data.get("mode") or "percent").strip().lower()
    if mode not in COMPOSITE_MODES:
        raise ValueError("Composite mode must be points, percent, or weighted_percent")
    try:
        drop_count = int(data.get("drop_count") or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("Drop Lowest must be a non-negative integer") from exc
    if drop_count < 0:
        raise ValueError("Drop Lowest must be a non-negative integer")
    total_points = data.get("total_points")
    if total_points in (None, ""):
        total_points = None
    else:
        try:
            total_points = float(total_points)
        except (TypeError, ValueError) as exc:
            raise ValueError("Total Points must be a number") from exc
        if not math.isfinite(total_points) or total_points <= 0:
            raise ValueError("Total Points must be greater than zero")
    raw_items = data.get("items") or []
    if not isinstance(raw_items, list):
        raise ValueError("Composite items must be a list")
    items = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            raise ValueError("Each composite item must be an object")
        name = str(raw_item.get("name") or "").strip()
        score = str(raw_item.get("score") or "").strip()
        if not name and not score:
            continue
        weight = raw_item.get("weight", 1)
        try:
            weight = float(weight or 1)
        except (TypeError, ValueError) as exc:
            raise ValueError("Weighted composite weights must be numbers") from exc
        if mode == "weighted_percent" and weight <= 0:
            raise ValueError("Weighted composite weights must be greater than zero")
        items.append({"name": name, "score": score, "weight": weight})
    return {"mode": mode, "drop_count": drop_count, "total_points": total_points, "items": items}


def _compact_number(value: float) -> str:
    value = float(value)
    if value.is_integer():
        return str(int(value))
    return f"{value:.12g}"


def composite_score_fields(composite: dict, category_aggregation: str) -> dict:
    """Return the effective main-assignment score produced by a composite definition."""
    composite = normalize_composite(composite)
    mode = composite["mode"]
    parsed = []
    for item in composite["items"]:
        raw = item["score"]
        if not raw:
            continue
        if mode == "points":
            earned, possible = parse_score(raw)
            if earned is None or possible is None or possible <= 0:
                raise ValueError("Composite points must use a positive denominator, like 3/5")
            percent = 100.0 * earned / possible
        else:
            if raw.startswith("=") or "/" in raw or "," in raw:
                earned, possible = parse_score(raw)
                if earned is None or possible in (None, 0):
                    raise ValueError("Composite percent scores must be valid percentages")
                percent = 100.0 * earned / possible
            else:
                try:
                    percent = float(raw)
                except (TypeError, ValueError) as exc:
                    raise ValueError("Composite percent scores must be numbers") from exc
            if not math.isfinite(percent):
                raise ValueError("Composite percent scores must be finite")
        parsed.append({"earned": earned if mode == "points" else None, "possible": possible if mode == "points" else None, "percent": percent, "weight": item["weight"]})
    if not parsed:
        return {"earned": None, "possible": None, "score_text": None}
    drop = min(composite["drop_count"], max(len(parsed) - 1, 0))
    kept = sorted(parsed, key=lambda item: item["percent"])[drop:]
    if mode == "points":
        earned = sum(item["earned"] for item in kept)
        possible = sum(item["possible"] for item in kept)
        score_text = f"{_compact_number(earned)}/{_compact_number(possible)}"
        if category_aggregation != "points_ratio":
            score_text = f"={score_text}"
        return {"earned": earned, "possible": possible, "score_text": score_text}
    if mode == "weighted_percent":
        total_weight = sum(item["weight"] for item in kept)
        percent = sum(item["percent"] * item["weight"] for item in kept) / total_weight
    else:
        percent = sum(item["percent"] for item in kept) / len(kept)
    if category_aggregation == "points_ratio":
        total_points = composite.get("total_points")
        if mode == "percent" and total_points:
            earned = percent * total_points / 100.0
            return {
                "earned": earned,
                "possible": total_points,
                "score_text": f"{_compact_number(earned)}/{_compact_number(total_points)}",
            }
        score_text = f"{_compact_number(percent)}/100"
    else:
        score_text = _compact_number(percent)
    return {"earned": percent, "possible": 100.0, "score_text": score_text}


def assignment_composite(a: Assignment) -> dict | None:
    if not getattr(a, "composite_json", None):
        return None
    try:
        payload = json.loads(a.composite_json)
        return normalize_composite(payload)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None


def assignment_score_fields(a: Assignment, category_aggregation: str) -> dict:
    composite = assignment_composite(a)
    if composite is None:
        return {"earned": a.earned, "possible": a.possible, "score_text": a.score_text}
    try:
        return composite_score_fields(composite, category_aggregation)
    except ValueError:
        return {"earned": None, "possible": None, "score_text": None}


def course_to_input(course: Course) -> CourseInput:
    cats = sorted(course.categories, key=lambda c: (c.sort_order, c.id))
    return CourseInput(
        id=course.id,
        code=course.code,
        credits=course.credits,
        bonus_points=course.bonus_points or 0.0,
        bonus_mode=course.bonus_mode or "static",
        gp_override=course.gp_override,
        grade_rounding=course.grade_rounding,
        grading_mode=course.grading_mode or "weighted",
        credit_mode=course.credit_mode or "for_credit",
        pass_fail=PassFailScale(rows=course_pass_fail(course)["rows"], fail_affects_gpa=course_pass_fail(course)["fail_affects_gpa"]),
        pass_fail_override=course.pass_fail_override,
        categories=[
            CategoryInput(
                id=cat.id,
                name=cat.name,
                weight=cat.weight,
                weight_per_item=cat.weight_per_item,
                aggregation=cat.aggregation,
                drop_count=cat.drop_count or 0,
                replace_count=cat.replace_count or 0,
                include_bonus=bool(cat.include_bonus),
                is_bonus_category=bool(cat.is_bonus_category),
                replace_with_category_id=cat.replace_with_category_id,
                assignments=[
                    AssignmentInput(
                        id=a.id,
                        name=a.name,
                        earned=fields["earned"],
                        possible=fields["possible"],
                        is_bonus=a.is_bonus,
                        bonus_type=a.bonus_type,
                    )
                    for a in sorted(cat.assignments, key=lambda x: (x.sort_order, x.id))
                    for fields in [assignment_score_fields(a, cat.aggregation)]
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


def parse_dynamic_weighting(course: Course) -> dict:
    try:
        raw = json.loads(course.dynamic_weighting_json or "{}")
    except (TypeError, json.JSONDecodeError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    options = raw.get("options")
    if not isinstance(options, list):
        options = []
    cleaned = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        opt_id = str(opt.get("id") or uuid.uuid4())
        weights_raw = opt.get("weights") if isinstance(opt.get("weights"), dict) else {}
        weights: dict[str, float] = {}
        for key, value in weights_raw.items():
            try:
                weights[str(key)] = float(value)
            except (TypeError, ValueError):
                continue
        cleaned.append({"id": opt_id, "weights": weights})
    return {"options": cleaned}


def dump_dynamic_weighting(payload: dict | None) -> str:
    if not payload or not isinstance(payload, dict):
        return "{}"
    options = payload.get("options")
    if not isinstance(options, list):
        options = []
    cleaned = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        opt_id = str(opt.get("id") or uuid.uuid4())
        weights_raw = opt.get("weights") if isinstance(opt.get("weights"), dict) else {}
        weights: dict[str, float] = {}
        for key, value in weights_raw.items():
            try:
                weights[str(key)] = float(value)
            except (TypeError, ValueError):
                continue
        cleaned.append({"id": opt_id, "weights": weights})
    return json.dumps({"options": cleaned})


def seed_dynamic_option_from_course(course: Course) -> dict:
    weights = {
        str(cat.id): float(cat.weight or 0.0)
        for cat in sorted(course.categories, key=lambda c: (c.sort_order, c.id))
    }
    return {"id": str(uuid.uuid4()), "weights": weights}


def option_course_percent(course_input: CourseInput, weights: dict[str, float]) -> float | None:
    """Course percent under a fixed-weight scheme (ignores weight_per_item)."""
    alt_cats = [
        replace(
            cat,
            weight=float(weights.get(str(cat.id), 0.0) or 0.0),
            weight_per_item=None,
        )
        for cat in course_input.categories
    ]
    result = evaluate_course(replace(course_input, categories=alt_cats))
    return result.percent


def best_dynamic_option(course: Course) -> tuple[dict | None, list[dict]]:
    """Return (winning option, options with computed percent)."""
    payload = parse_dynamic_weighting(course)
    options = payload["options"]
    if not options:
        return None, []
    course_input = course_to_input(course)
    scored = []
    for opt in options:
        percent = option_course_percent(course_input, opt["weights"])
        scored.append({**opt, "percent": percent})
    with_scores = [row for row in scored if row["percent"] is not None]
    if not with_scores:
        return None, scored
    winner = max(with_scores, key=lambda row: row["percent"])
    return winner, scored


def apply_dynamic_weighting(course: Course) -> bool:
    """Write the best option's weights onto categories. Returns True if anything changed."""
    if (course.grading_mode or "weighted") == "points":
        return False
    if not course.dynamic_weighting_enabled:
        return False
    sync_dynamic_weighting_categories(course)
    winner, _ = best_dynamic_option(course)
    if winner is None:
        return False
    weights = winner["weights"]
    changed = False
    for cat in course.categories:
        next_weight = float(weights.get(str(cat.id), 0.0) or 0.0)
        if cat.weight != next_weight:
            cat.weight = next_weight
            changed = True
        if cat.weight_per_item is not None:
            cat.weight_per_item = None
            changed = True
    return changed


def sync_dynamic_weighting_categories(course: Course) -> bool:
    """Ensure every option has an entry for each current category. Returns True if JSON changed."""
    payload = parse_dynamic_weighting(course)
    if not payload["options"]:
        return False
    cat_ids = {str(cat.id) for cat in course.categories}
    changed = False
    for opt in payload["options"]:
        weights = opt["weights"]
        for cid in cat_ids:
            if cid not in weights:
                weights[cid] = 0.0
                changed = True
        for cid in list(weights.keys()):
            if cid not in cat_ids:
                del weights[cid]
                changed = True
    if changed:
        course.dynamic_weighting_json = dump_dynamic_weighting(payload)
    return changed


DEFAULT_GPA_WEIGHT_TAGS = [
    {"id": "unweighted", "name": "Unweighted", "boost": 0.0},
    {"id": "weighted", "name": "Weighted", "boost": 0.5},
]


def gpa_weight_tags(settings: Settings | None) -> list[dict]:
    """Return a safe, editable high-school GPA-weight configuration."""
    try:
        raw = json.loads((settings.gpa_weight_tags_json if settings else "") or "[]")
    except json.JSONDecodeError:
        raw = []
    tags, seen = [], set()
    for item in raw if isinstance(raw, list) else []:
        tag_id = str(item.get("id") or "").strip().lower()[:48]
        name = str(item.get("name") or "").strip()[:64]
        if not tag_id or not name or tag_id in seen:
            continue
        try:
            boost = float(item.get("boost", 0))
        except (TypeError, ValueError):
            boost = 0.0
        tags.append({"id": tag_id, "name": name, "boost": boost})
        seen.add(tag_id)
    if not tags:
        tags = [dict(tag) for tag in DEFAULT_GPA_WEIGHT_TAGS]
    if not any(tag["id"] == "unweighted" for tag in tags):
        tags.insert(0, {"id": "unweighted", "name": "Unweighted", "boost": 0.0})
    return tags


def high_school_academic_year_key(year: int | float | None, season: str | None) -> int:
    """Return the high-school academic-year start for a calendar term."""
    value = int(year or 0)
    return value - 1 if str(season or "").lower() in {"spring", "summer"} else value


def high_school_term_units(db: Session) -> dict[int, float]:
    """Return each term's share of a high-school academic-year class unit."""
    semesters = gradebook_semesters(db)
    units: dict[int, float] = {}
    for academic_year in gradebook_academic_years(db):
        try:
            semester_ids = [int(value) for value in json.loads(academic_year.semester_ids_json or "[]")]
        except (TypeError, ValueError, json.JSONDecodeError):
            semester_ids = []
        if semester_ids:
            unit = 1 / len(semester_ids)
            units.update({semester_id: unit for semester_id in semester_ids})

    # Older data may not have AcademicYear rows yet. Use every term in the
    # calendar-based period so a three-term period naturally splits into
    # thirds instead of assuming every period has only Fall + Spring.
    counts: dict[int, int] = {}
    for semester in semesters:
        key = high_school_academic_year_key(semester.year, semester.season)
        counts[key] = counts.get(key, 0) + 1
    for semester in semesters:
        key = high_school_academic_year_key(semester.year, semester.season)
        units.setdefault(semester.id, 1 / max(counts.get(key, 1), 1))
    return units


def _high_school_course_percent(course: dict) -> float | None:
    if course.get("gp_override") == -1:
        return None
    if course.get("gp_override") is not None:
        override = float(course.get("gp_override"))
        row = next(
            (entry for entry in course.get("scale") or [] if abs(float(entry.get("quality_points")) - override) < 1e-6),
            None,
        )
        if row is not None and row.get("min_percent") is not None:
            return float(row["min_percent"])
    if course.get("percent") is not None:
        try:
            percent = float(course["percent"])
        except (TypeError, ValueError):
            percent = None
        if percent is not None and math.isfinite(percent):
            return percent
    categories = [
        category
        for category in course.get("categories") or []
        if category.get("percent") is not None and category.get("effective_weight") is not None
    ]
    total_weight = sum(float(category.get("effective_weight") or 0) for category in categories)
    if not total_weight:
        return None
    return sum(
        float(category["percent"]) * float(category.get("effective_weight") or 0)
        for category in categories
    ) / total_weight


def _high_school_overall_grade(course: dict, percent: float, options: dict) -> dict | None:
    final_percent = round_half_up(percent, 0 if options.get("roundOverallPercent") is True else None)
    cutoff_percent = round_half_up(final_percent, course.get("grade_rounding"))
    eligible = [
        row for row in course.get("scale") or []
        if float(row.get("min_percent", 0)) <= float(cutoff_percent)
    ]
    if not eligible:
        return None
    best = max(eligible, key=lambda row: float(row.get("min_percent", 0)))
    grade = copy(course)
    quality_points = float(best.get("quality_points"))
    boost = float(course.get("gpa_weight_boost") or 0)
    # Preserve the raw overall percent while exposing the grade produced by
    # the optional overall rounding steps to every backend GPA calculation.
    grade["percent"] = percent
    grade["letter"] = best.get("letter")
    grade["natural_letter"] = best.get("letter")
    grade["natural_quality_points"] = quality_points
    grade["base_quality_points"] = quality_points
    grade["quality_points"] = quality_points + boost
    grade["gp_override"] = None
    return grade


def high_school_overall_score(
    terms: list[dict],
    term_units: dict[int, float],
    target_gp: float,
    term_weights_by_period: dict | None = None,
    rounding_by_period: dict | None = None,
) -> float:
    """Calculate one score per class using its full period coverage.

    A class keeps the unit share of every term in which it exists, even when
    one of those terms has no grade yet. Its overall percent is calculated from
    the graded term percents, then converted to the period/overall grade.
    """
    overall_classes = high_school_overall_classes(terms, term_units, term_weights_by_period, rounding_by_period)
    return sum(high_school_period_scores(overall_classes, target_gp).values())


def high_school_period_scores(overall_classes: list[dict], target_gp: float) -> dict[str, float]:
    """Return the target-relative score for each academic period."""
    scores: dict[str, float] = {}
    for item in overall_classes:
        final = item.get("final")
        if final is None:
            continue
        quality_points = final.get("base_quality_points", final.get("quality_points"))
        if quality_points is None:
            continue
        period = str(item.get("period"))
        scores[period] = scores.get(period, 0.0) + round(
            3 * (float(quality_points) - target_gp)
        ) * float(item.get("units") or 0)
    return scores


def high_school_final_course(course: dict) -> dict | None:
    """Return the overall-only version of a high-school course.

    Term ``gp_override`` remains on the serialized term row. A separate final
    override is applied only to the copy used by academic-period rollups.
    """
    raw_override = course.get("final_gp_override")
    if raw_override is None:
        return course
    try:
        override = float(raw_override)
    except (TypeError, ValueError):
        return course
    if override == -1:
        return None
    if course.get("credit_mode") == "pass_fail":
        return course
    final = copy(course)
    final["gp_override"] = None
    final["base_quality_points"] = override
    final["quality_points"] = override + float(course.get("gpa_weight_boost") or 0)
    row = next(
        (entry for entry in course.get("scale") or [] if abs(float(entry.get("quality_points")) - override) < 1e-6),
        None,
    )
    if row is not None:
        final["letter"] = row.get("letter")
        final["percent"] = row.get("min_percent")
    return final


def high_school_overall_classes(
    terms: list[dict],
    term_units: dict[int, float],
    term_weights_by_period: dict | None = None,
    rounding_by_period: dict | None = None,
) -> list[dict]:
    """Return one final, weighted class entry for each high-school class."""
    period_term_counts: dict[int, int] = {}
    for term in terms or []:
        period = high_school_academic_year_key(term.get("year"), term.get("season"))
        period_term_counts[period] = period_term_counts.get(period, 0) + 1
    classes: dict[tuple[str, int], dict] = {}
    for term in terms or []:
        unit = float(term_units.get(term["id"], 0) or 0)
        period = high_school_academic_year_key(term.get("year"), term.get("season"))
        occurrences: dict[str, int] = {}
        for course in term.get("courses") or []:
            code = str(course.get("code") or "").strip().lower()
            if not code:
                continue
            occurrence = occurrences.get(code, 0)
            occurrences[code] = occurrence + 1
            key = (code, occurrence)
            current = classes.setdefault(key, {
                "units": 0.0,
                "final": None,
                "latest_id": -1,
                "weight_boost": 0.0,
                "period": period,
                "occurrences": 0,
                "code_key": code,
                "occurrence": occurrence,
                "entries": [],
                "override_candidates": [],
            })
            current["occurrences"] += 1
            current["weight_boost"] = max(current["weight_boost"], float(course.get("gpa_weight_boost") or 0))
            current["entries"].append({"course": course, "term_id": term["id"]})
            final_override = course.get("final_gp_override")
            final_override_active = (
                course.get("credit_mode") != "pass_fail"
                and final_override is not None
                and final_override != -1
            )
            if (
                (course.get("quality_points") is not None or final_override_active)
                and (course.get("gp_override") != -1 or final_override_active)
                and (
                    course.get("credit_mode") != "pass_fail"
                    or (
                        course.get("pass_fail", {}).get("fail_affects_gpa")
                        and not pass_fail_row_is_passing(course)
                    )
                )
            ):
                course_id = int(course.get("id") or 0)
                if final_override_active:
                    current["override_candidates"].append((course_id, course))
                if current["final"] is None or course_id >= current["latest_id"]:
                    current["final"] = course
                    current["latest_id"] = course_id

    for item in classes.values():
        item["units"] = item["occurrences"] / max(period_term_counts.get(item["period"], 1), 1)
        if item["override_candidates"]:
            _, override_course = max(item["override_candidates"], key=lambda entry: entry[0])
            item["final"] = high_school_final_course(override_course)
            if item["final"] is not None:
                base_quality_points = float(item["final"].get("base_quality_points", item["final"].get("quality_points", 0)))
                item["final"]["gpa_weight_boost"] = item["weight_boost"]
                item["final"]["quality_points"] = base_quality_points + item["weight_boost"]
            continue
        representative = item["entries"][0]["course"] if item["entries"] else None
        if representative is None:
            item["final"] = None
            continue
        options = (rounding_by_period or {}).get(
            str(item["period"]),
            (rounding_by_period or {}).get("__default__", {}),
        )
        saved_weights = (term_weights_by_period or {}).get(str(item["period"]), {})
        included = len(item["entries"]) or 1
        graded = []
        for entry in item["entries"]:
            percent = _high_school_course_percent(entry["course"])
            if percent is None:
                continue
            term_key = f'{item["code_key"]}-{item["occurrence"]}:{entry["term_id"]}'
            weight = saved_weights.get(term_key)
            if weight is None:
                weight = 100 / included
            if options.get("roundTermPercents") is True:
                percent = round_half_up(percent, 0)
            graded.append((percent, float(weight)))
        graded_weight = sum(weight for _, weight in graded)
        aggregate_percent = (
            sum(percent * weight for percent, weight in graded) / graded_weight
            if graded_weight > 0
            else None
        )
        item["final"] = (
            _high_school_overall_grade(
                {**representative, "gpa_weight_boost": item["weight_boost"]},
                aggregate_percent,
                options,
            )
            if aggregate_percent is not None
            else None
        )
    return list(classes.values())


def refresh_course(
    db: Session, course: Course, target_gp: float,
    fail_pass_fail_affects_gpa: bool | None = None,
    gradebook_type: str = "college", weight_tags: list[dict] | None = None,
    score_units: float | None = None,
) -> dict:
    """Apply dynamic weighting if needed, then serialize."""
    if apply_dynamic_weighting(course):
        db.commit()
        db.refresh(course)
        for cat in course.categories:
            db.refresh(cat)
    return serialize_course(course, target_gp, fail_pass_fail_affects_gpa, gradebook_type, weight_tags, score_units)


def format_grade_number(value) -> str:
    if value is None:
        return ""
    number = float(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:.2f}".rstrip("0").rstrip(".")


def serialize_assignment(
    a: Assignment,
    display_as_percent: bool = False,
    category_aggregation: str = "average",
) -> dict:
    fields = assignment_score_fields(a, category_aggregation)
    earned = fields["earned"]
    possible = fields["possible"]
    pct = None
    if earned is not None:
        if possible:
            pct = 100.0 * earned / possible
        else:
            pct = earned
    display = ""
    score_input = str(fields["score_text"] or "").strip()
    if earned is not None:
        if display_as_percent and possible:
            display = format_grade_number(pct)
        elif score_input.startswith("=") and possible:
            display = (
                f"{format_grade_number(earned)}/{format_grade_number(possible)}"
                if category_aggregation == "points_ratio"
                else format_grade_number(pct)
            )
        elif possible == 0 and ("/" in score_input or "," in score_input):
            display = f"{format_grade_number(earned)}/{format_grade_number(possible)}"
        elif ("/" in score_input or "," in score_input) and not score_input.startswith("="):
            display = f"{format_grade_number(earned)}/{format_grade_number(possible)}"
        elif possible and possible != 100:
            display = f"{format_grade_number(earned)}/{format_grade_number(possible)}"
        elif a.is_bonus and not possible:
            display = format_grade_number(earned)
        else:
            display = format_grade_number(earned)
    if not score_input:
        score_input = display
    try:
        flag_ids = [str(value) for value in json.loads(a.flag_ids_json or "[]") if value]
    except (TypeError, json.JSONDecodeError):
        flag_ids = []
    return {
        "id": a.id,
        "name": a.name,
        "earned": earned,
        "possible": possible,
        "is_bonus": a.is_bonus,
        "bonus_type": a.bonus_type,
        "percent": pct,
        "display": display,
        "score_input": score_input,
        "sort_order": a.sort_order,
        "composite": assignment_composite(a),
        "comment": a.comment,
        "flag_ids": flag_ids,
    }


def serialize_course(
    course: Course,
    target_gp: float,
    fail_pass_fail_affects_gpa: bool | None = None,
    gradebook_type: str = "college",
    weight_tags: list[dict] | None = None,
    score_units: float | None = None,
) -> dict:
    course_input = course_to_input(course)
    if fail_pass_fail_affects_gpa is not None and course_input.credit_mode == "pass_fail":
        course_input = replace(
            course_input,
            pass_fail=replace(course_input.pass_fail, fail_affects_gpa=bool(fail_pass_fail_affects_gpa)),
        )
    result = course_grade(course_input, target_gp)
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
                "aggregation": (
                    "points_ratio"
                    if course.grading_mode == "points" and not cat.is_bonus_category
                    else cat.aggregation
                ),
                "drop_count": cat.drop_count or 0,
                "replace_count": cat.replace_count or 0,
                "include_bonus": bool(cat.include_bonus),
                "is_bonus_category": bool(cat.is_bonus_category),
                "replace_with_category_id": cat.replace_with_category_id,
                "sort_order": cat.sort_order,
                "percent": computed.percent if computed else None,
                "effective_weight": computed.effective_weight if computed else cat.weight,
                "weighted": computed.weighted if computed else None,
                "score_count": computed.score_count if computed else 0,
                "assignments": [
                    serialize_assignment(
                        a,
                        display_as_percent=False,
                        category_aggregation=(
                            "points_ratio"
                            if course.grading_mode == "points" and not cat.is_bonus_category
                            else cat.aggregation
                        ),
                    )
                    for a in sorted(cat.assignments, key=lambda x: (x.sort_order, x.id))
                ],
            }
        )
    winner, scored_options = best_dynamic_option(course) if course.dynamic_weighting_enabled else (None, [])
    dynamic_payload = parse_dynamic_weighting(course)
    if course.dynamic_weighting_enabled and scored_options:
        dynamic_payload = {
            "options": [
                {"id": opt["id"], "weights": opt["weights"], "percent": opt.get("percent")}
                for opt in scored_options
            ]
        }
    applied_option_id = winner["id"] if winner else None
    payload = {
        "id": course.id,
        "semester_id": course.semester_id,
        "code": course.code,
        "credits": course.credits,
        "bonus_points": course.bonus_points,
        "bonus_mode": course.bonus_mode or "static",
        "gp_override": course.gp_override,
        "final_gp_override": course.final_gp_override,
        "grade_rounding": course.grade_rounding,
        "scale_profile_id": course.scale_profile_id,
        "minimum_passing_letter": course.minimum_passing_letter or "C-",
        "percent": result.percent,
        "letter": result.letter,
        "quality_points": result.quality_points,
        "score": result.score,
        "natural_letter": result.natural_letter,
        "natural_quality_points": result.natural_quality_points,
        "natural_score": result.natural_score,
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
        "test_category_ids": course_test_category_ids(course),
        "test_category_ids_configured": course_test_category_ids_configured(course),
        "exam_category_id": course.exam_category_id,
        "grading_mode": course.grading_mode or "weighted",
        "credit_mode": course.credit_mode or "for_credit",
        "pass_fail_override": course.pass_fail_override,
        "pass_fail": {
            **course_pass_fail(course),
            **({"fail_affects_gpa": bool(fail_pass_fail_affects_gpa)} if fail_pass_fail_affects_gpa is not None else {}),
        },
        "dynamic_weighting_enabled": bool(course.dynamic_weighting_enabled),
        "dynamic_weighting": dynamic_payload,
        "dynamic_weighting_applied_option_id": applied_option_id,
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
    tag_id = (course.gpa_weight_tag or "unweighted").strip().lower()
    tag = next((item for item in (weight_tags or []) if item.get("id") == tag_id), None)
    if tag is None:
        tag = {"id": "unweighted", "name": "Unweighted", "boost": 0.0}
    payload["gpa_weight_tag"] = tag["id"]
    payload["gpa_weight_tag_name"] = tag["name"]
    payload["gpa_weight_boost"] = float(tag["boost"])
    if gradebook_type == "high_school" and payload["quality_points"] is not None:
        payload["base_quality_points"] = payload["quality_points"]
        payload["quality_points"] = payload["quality_points"] + float(tag["boost"])
        if score_units is not None:
            # A term view reports the class's full target-relative score. The
            # academic-year unit share belongs to the overall period score,
            # not to an individual term's score.
            score_delta = round(3 * (payload["base_quality_points"] - target_gp))
            payload["score"] = score_delta
            if payload["natural_quality_points"] is not None:
                natural_delta = round(3 * (payload["natural_quality_points"] - target_gp))
                payload["natural_score"] = natural_delta
    elif score_units is not None:
        # The course's catalog credits remain available for display, but a
        # fixed-unit gradebook scores every class as one unit everywhere that
        # consumes the serialized course payload.
        payload["score"] = term_score(payload["quality_points"], score_units, target_gp)
        payload["natural_score"] = term_score(payload["natural_quality_points"], score_units, target_gp)
    return payload


def cap_gpa(gpa: float | None, gpa_cap: float | None) -> float | None:
    if gpa is None or gpa_cap is None:
        return gpa
    return min(gpa, gpa_cap)


def semester_name(sem: Semester, gradebook_type: str = "college") -> str:
    label = SEASON_LABELS.get(sem.season, sem.season.title())
    if (gradebook_type or "college").strip().lower() == "high_school":
        return label
    return f"{sem.year} {label}"


def _exam_impact_payload(course: Course, target_gp: float) -> dict | None:
    test_ids = course_test_category_ids(course)
    impact = exam_impact(
        course_to_input(course),
        test_ids,
        course.exam_category_id,
        target_gp,
    )
    if not impact:
        return None
    names = {cat.id: cat.name for cat in course.categories}
    impact["test_name"] = ", ".join(names[tid] for tid in test_ids if tid in names) or None
    impact["test_names"] = [names[tid] for tid in test_ids if tid in names]
    impact["exam_name"] = names.get(course.exam_category_id)
    return impact


def serialize_semester(
    sem: Semester,
    target_gp: float,
    gpa_cap: float | None = None,
    fail_pass_fail_affects_gpa: bool | None = None,
    gradebook_type: str = "college",
    weight_tags: list[dict] | None = None,
    gpa_basis: str = "credits",
    score_units: float | None = None,
) -> dict:
    courses = [
        serialize_course(c, target_gp, fail_pass_fail_affects_gpa, gradebook_type, weight_tags, score_units)
        for c in sorted(sem.courses, key=lambda c: (str(c.code or "").strip().casefold(), c.id))
    ]
    unit = lambda course: 1.0 if gpa_basis == "classes" else (course.get("credits") or 0)
    # A class contributes credits to the term only after it has an actual
    # grade or an override.  Newly created classes still carry catalog credits
    # but should not make an otherwise empty term appear attempted.
    credit_counted_courses = [
        c
        for c in courses
        if c.get("gp_override") != -1
        and (c.get("quality_points") is not None or c.get("letter") is not None)
    ]
    gpa_courses = [
        c
        for c in courses
        if c["quality_points"] is not None
        and (
            c.get("credit_mode") != "pass_fail"
            or (c.get("pass_fail", {}).get("fail_affects_gpa") and not pass_fail_row_is_passing(c))
        )
    ]
    # High-school quality_points includes the GPA-weight tag boost for WGPA,
    # while base_quality_points is the override-aware unweighted value.
    gpa_value = lambda c: c.get("base_quality_points", c["quality_points"]) if gradebook_type == "high_school" else c["quality_points"]
    pairs = [
        (unit(c), gpa_value(c)) for c in gpa_courses
    ]
    gpa = cap_gpa(weighted_gpa(pairs, include_zero=any(gpa_value(c) == 0 for c in gpa_courses)), gpa_cap)
    weighted_pairs = [
        (
            unit(c),
            c["quality_points"]
            if gradebook_type == "high_school"
            else c["quality_points"] + float(c.get("gpa_weight_boost") or 0),
        )
        for c in gpa_courses
    ]
    wgpa = cap_gpa(weighted_gpa(weighted_pairs, include_zero=any(c["quality_points"] == 0 for c in gpa_courses)), gpa_cap)
    gpa_credits = sum(unit(c) for c in gpa_courses)
    for_credit_credits = sum(
        unit(c)
        for c in courses
        if c.get("credit_mode") != "pass_fail"
        and c["quality_points"] is not None
        and course_meets_passing_cutoff(c)
    )
    pass_fail_credits = sum(
        unit(c)
        for c in courses
        if c.get("credit_mode") == "pass_fail" and pass_fail_row_is_passing(c)
    )
    total_credits = sum(unit(c) for c in credit_counted_courses)
    attempted_pass_fail_credits = sum(
        unit(c) for c in courses if c.get("credit_mode") == "pass_fail"
    )
    attempted_for_credit_credits = sum(
        unit(c)
        for c in credit_counted_courses
        if c.get("credit_mode") != "pass_fail"
    )
    passed_credits = for_credit_credits + pass_fail_credits
    unpassed_credits = sum(
        unit(c)
        for c in courses
        if (
            (c.get("credit_mode") != "pass_fail" and c["quality_points"] is not None and not course_meets_passing_cutoff(c))
            or (c.get("credit_mode") == "pass_fail" and (c.get("pass_fail_override") or c.get("letter")) is not None
                and not pass_fail_row_is_passing(c))
        )
    )
    score = sum(
        c["score"] or 0
        for c in courses
        if c["quality_points"] is not None
        and (
            c.get("credit_mode") != "pass_fail"
            or (c.get("pass_fail", {}).get("fail_affects_gpa") and not pass_fail_row_is_passing(c))
        )
    )
    return {
        "id": sem.id,
        "year": sem.year,
        "season": sem.season,
        "name": semester_name(sem, gradebook_type),
        "included": sem.included,
        "progression_locked": bool(sem.progression_locked),
        "term_gpa": gpa,
        "term_wgpa": wgpa,
        "term_credits": total_credits,
        "term_passed_credits": passed_credits,
        "term_unpassed_credits": unpassed_credits,
        "term_attempted_for_credit_credits": attempted_for_credit_credits,
        "term_attempted_pass_fail_credits": attempted_pass_fail_credits,
        "term_gpa_credits": gpa_credits,
        "term_affects_gpa_credits": gpa_credits,
        "term_credit_only_credits": max(0, total_credits - gpa_credits),
        "term_for_credit_credits": for_credit_credits,
        "term_pass_fail_credits": pass_fail_credits,
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


def build_gpa(db: Session, semester_ids: set[int] | None = None) -> dict:
    settings = settings_for_gradebook(db)
    gradebook_type = (settings.gradebook_type or "college").strip().lower()
    gpa_basis = (settings.gpa_basis or "credits").strip().lower()
    weight_tags = gpa_weight_tags(settings)
    target_letter, target_gp = target_gp_from_settings(settings, db)
    semesters = sort_semesters(gradebook_semesters(db))
    if semester_ids is not None:
        semesters = [semester for semester in semesters if semester.id in semester_ids]
    changed = False
    for sem in semesters:
        for course in sem.courses:
            if apply_dynamic_weighting(course):
                changed = True
    if changed:
        db.commit()
    score_units = (
        high_school_term_units(db)
        if gradebook_type == "high_school"
        else ({s.id: 1.0 for s in semesters} if gpa_basis == "classes" else {})
    )
    overall_rounding_by_period = high_school_overall_rounding_by_period(db) if gradebook_type == "high_school" else {}
    term_weights_by_period = high_school_term_weights_by_period(db) if gradebook_type == "high_school" else {}
    terms = [
        serialize_semester(
            s, target_gp, settings.gpa_cap, settings.fail_pass_fail_affects_gpa,
            gradebook_type, weight_tags, gpa_basis, score_units.get(s.id),
        )
        for s in semesters
    ]
    code_totals = {}
    for term in terms:
        for course in term["courses"]:
            key = str(course.get("code") or "").strip().lower()
            code_totals[key] = code_totals.get(key, 0) + 1
    code_seen = {}
    for term in terms:
        for course in term["courses"]:
            key = str(course.get("code") or "").strip().lower()
            code_seen[key] = code_seen.get(key, 0) + 1
            course["display_code"] = (
                f'{course["code"]} ({code_seen[key]})' if code_totals[key] > 1 else course["code"]
            )

    included_terms = [t for t in terms if t["included"]]
    overall_classes = []
    overall_period_scores = {}
    if gradebook_type == "high_school":
        # One academic-year course is one unit, distributed equally across the
        # terms that exist for that year. A one-term class in a two-term year
        # therefore carries 0.5 units immediately, without waiting for spring.
        term_units = score_units
        fallback_terms_per_year = {}
        for semester in gradebook_semesters(db):
            key = high_school_academic_year_key(semester.year, semester.season)
            fallback_terms_per_year[key] = fallback_terms_per_year.get(key, 0) + 1
        hs_courses = []
        for term in included_terms:
            unit = term_units.get(term["id"], 1 / max(fallback_terms_per_year.get(high_school_academic_year_key(term["year"], term["season"]), 1), 1))
            for course in term["courses"]:
                course["gpa_units"] = unit
                if course.get("quality_points") is not None and course.get("gp_override") != -1:
                    hs_courses.append((course, unit))
        for term in terms:
            unit = term_units.get(term["id"], 1 / max(fallback_terms_per_year.get(high_school_academic_year_key(term["year"], term["season"]), 1), 1))
            term_score = 0.0
            for course in term["courses"]:
                quality_points = course.get("quality_points")
                if quality_points is None or course.get("gp_override") == -1:
                    continue
                if (
                    course.get("credit_mode") == "pass_fail"
                    and not (
                        course.get("pass_fail", {}).get("fail_affects_gpa")
                        and not pass_fail_row_is_passing(course)
                    )
                ):
                    continue
                # A term score is the raw target-relative score for each
                # class. Academic-year shares are applied only when computing
                # the overall period score below.
                score = round(3 * (
                    course.get("base_quality_points", quality_points) - target_gp
                ))
                course["score"] = score
                term_score += score
            term["term_score"] = term_score
        overall_classes = high_school_overall_classes(
            terms,
            term_units,
            term_weights_by_period,
            overall_rounding_by_period,
        )
        overall_period_scores = high_school_period_scores(overall_classes, target_gp)
        period_included: dict[str, bool] = {}
        for term in terms:
            period = str(high_school_academic_year_key(term["year"], term["season"]))
            period_included[period] = period_included.get(period, True) and bool(term["included"])
        included_periods = {period for period, included in period_included.items() if included}
        included_overall_classes = [
            item for item in overall_classes if str(item.get("period")) in included_periods
        ]
        gpa_pairs = [
            (item["units"], item["final"].get("base_quality_points", item["final"]["quality_points"]))
            for item in included_overall_classes
            if item["final"] is not None
            and (
                item["final"].get("credit_mode") != "pass_fail"
                or (item["final"].get("pass_fail", {}).get("fail_affects_gpa") and not pass_fail_row_is_passing(item["final"]))
            )
        ]
        gpa_credits = sum(unit for unit, _ in gpa_pairs)
        total_credits = sum(item["units"] for item in included_overall_classes if item["final"] is not None and course_meets_passing_cutoff(item["final"]))
        unpassed_credits = sum(item["units"] for item in included_overall_classes if item["final"] is not None and not course_meets_passing_cutoff(item["final"]))
        pass_fail_credits = 0.0
        # High-school weighting changes the reported GPA, but score is the
        # target-relative metric for the unweighted GPA. Each academic year
        # contributes one point, split across the terms that contain it.
        # The period score is based on each class's overall grade multiplied
        # by its coverage across the period's terms. Summing graded term
        # contributions would undercount a class whose final term is still
        # ungraded.
        overall_score = sum(overall_period_scores.get(period, 0) for period in included_periods)
        overall = cap_gpa(weighted_gpa(gpa_pairs, include_zero=any(gp == 0 for _, gp in gpa_pairs)), settings.gpa_cap)
    else:
        overall_score = sum(t["term_score"] for t in included_terms)
        total_credits = sum(t.get("term_passed_credits", t["term_credits"]) for t in included_terms)
        unpassed_credits = sum(t.get("term_unpassed_credits", 0) for t in included_terms)
        pass_fail_credits = sum(t.get("term_pass_fail_credits", 0) for t in included_terms)
        overall_gpa_pairs = [
            (
                1.0 if gpa_basis == "classes" else float(course.get("credits") or 0),
                course["quality_points"],
            )
            for term in included_terms
            for course in term["courses"]
            if course.get("quality_points") is not None
            and course.get("gp_override") != -1
            and (
                course.get("credit_mode") != "pass_fail"
                or (
                    course.get("pass_fail", {}).get("fail_affects_gpa")
                    and not pass_fail_row_is_passing(course)
                )
            )
        ]
        gpa_credits = sum(unit for unit, _ in overall_gpa_pairs)
        overall = cap_gpa(
            weighted_gpa(
                overall_gpa_pairs,
                include_zero=any(gp == 0 for _, gp in overall_gpa_pairs),
            ),
            settings.gpa_cap,
        )

    if gradebook_type == "college" and gpa_basis == "classes":
        class_courses = [
            course for term in included_terms for course in term["courses"]
            if course.get("quality_points") is not None and course.get("gp_override") != -1
        ]
        scored_class_courses = [
            course for course in class_courses
            if course.get("credit_mode") != "pass_fail"
            or (course.get("pass_fail", {}).get("fail_affects_gpa") and not pass_fail_row_is_passing(course))
        ]
        class_pairs = [(1.0, course["quality_points"]) for course in scored_class_courses]
        gpa_credits = float(len(class_pairs))
        total_credits = float(sum(1 for course in class_courses if course_meets_passing_cutoff(course)))
        unpassed_credits = float(sum(1 for course in class_courses if not course_meets_passing_cutoff(course)))
        # Sum each class's already-rounded fixed-unit score. Summing the raw
        # quality-point differences here can leave fractional residue (for
        # example, A+ + A- + B+ becoming -2.001 instead of -2).
        overall_score = sum(course.get("score") or 0 for course in scored_class_courses)
        overall = cap_gpa(weighted_gpa(class_pairs, include_zero=any(gp == 0 for _, gp in class_pairs)), settings.gpa_cap)

    weighted_pairs = []
    weighted_course_info = {}
    if gradebook_type == "high_school":
        # A multi-term class is one overall class for WGPA. Use the same final
        # class result as the overall page instead of averaging each term row.
        weighted_courses = high_school_overall_classes(
            terms,
            term_units,
            term_weights_by_period,
            overall_rounding_by_period,
        )
        weighted_courses = [
            item for item in weighted_courses if str(item.get("period")) in included_periods
        ]
        weighted_entries = ((item["final"], item["units"]) for item in weighted_courses if item["final"] is not None)
        for item in weighted_courses:
            final = item.get("final")
            representative = ((item.get("entries") or [{}])[0].get("course") or {})
            actual_course = final or representative
            if actual_course:
                info = {
                    "course": actual_course,
                    "units": float(item.get("units") or 0),
                    "boost": float(item.get("weight_boost") or 0),
                }
                for entry in item.get("entries") or []:
                    entry_course_id = entry.get("course", {}).get("id")
                    if entry_course_id is not None:
                        weighted_course_info[entry_course_id] = info
                if final is not None:
                    weighted_course_info[final["id"]] = info
    else:
        weighted_entries = (
            (course, 1.0 if gpa_basis == "classes" else float(course.get("credits") or 0))
            for term in included_terms
            for course in term["courses"]
        )
    for course, unit in weighted_entries:
        quality_points = course.get("quality_points")
        if quality_points is None or course.get("gp_override") == -1 or not unit:
            continue
        if gradebook_type == "high_school":
            boost = next((item["weight_boost"] for item in weighted_courses if item["final"] is course), 0.0)
            quality_points = float(course.get("base_quality_points", quality_points))
        else:
            tag = next((item for item in weight_tags if item["id"] == course.get("gpa_weight_tag")), None)
            boost = float(tag["boost"]) if tag else 0.0
        weighted_pairs.append((unit, float(quality_points) + boost))
        if gradebook_type != "high_school":
            weighted_course_info[course["id"]] = {
                "course": course,
                "units": float(unit),
                "boost": boost,
            }
    weighted_overall = cap_gpa(weighted_gpa(weighted_pairs, include_zero=any(gp == 0 for _, gp in weighted_pairs)), settings.gpa_cap) if weighted_pairs else None
    weighted_current_units = sum(unit for unit, _ in weighted_pairs)
    weighted_current_points = sum(unit * quality_points for unit, quality_points in weighted_pairs)

    all_credits = 0.0
    for term in terms:
        for course in term["courses"]:
            if course.get("gp_override") != -1:
                all_credits += 1.0 if gpa_basis == "classes" else (course["credits"] or 0)
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
    fumble_credits_delta = 0
    weighted_fumble_units_delta = 0.0
    weighted_fumble_points_delta = 0.0
    by_id = {}
    course_term = {}
    term_keys = {}
    for term in terms:
        term_keys[term["id"]] = (term["year"], SEASON_ORDER.get(term["season"], 0))
        for course in term["courses"]:
            by_id[course["id"]] = course
            course_term[course["id"]] = term
    included_course_ids = {
        course["id"]
        for term in included_terms
        for course in term["courses"]
    }
    courses_by_code = {}
    for course_id, course in by_id.items():
        code_key = str(course.get("code") or "").strip().lower()
        if code_key:
            courses_by_code.setdefault(code_key, []).append(course_id)
    for fumble in (
        db.query(Fumble)
        .join(Course, Fumble.course_id == Course.id)
        .join(Semester, Course.semester_id == Semester.id)
        .filter(Semester.gradebook_id == active_gradebook_id())
        .all()
    ):
        course = by_id.get(fumble.course_id)
        if not course:
            continue
        weighted_info = weighted_course_info.get(fumble.course_id)
        overall_course = (weighted_info or {}).get("course") or course
        score_quality_points = (
            overall_course.get("base_quality_points", overall_course.get("quality_points"))
            if gradebook_type == "high_school"
            else overall_course.get("quality_points")
        )
        fumble_units = (
            weighted_info["units"]
            if gradebook_type == "high_school" and weighted_info is not None
            else (1.0 if gpa_basis == "classes" else course["credits"])
        )
        weighted_boost = float(
            weighted_info["boost"]
            if weighted_info is not None
            else course.get("gpa_weight_boost") or 0
        )
        weighted_quality_points = (
            float(score_quality_points) + weighted_boost
            if score_quality_points is not None
            else None
        )
        term = course_term.get(fumble.course_id) or {}
        explicit_excluded = fumble.should_have_been_gp is None
        original_key = term_keys.get(term.get("id"))
        has_later_retake = any(
            other_id != fumble.course_id
            and term_keys.get((course_term.get(other_id) or {}).get("id"), (-1, -1)) > (original_key or (-1, -1))
            for other_id in courses_by_code.get(str(course.get("code") or "").strip().lower(), [])
        )
        # A later occurrence can keep an untouched fumble excluded, but it
        # must not overwrite an explicit "Should" selection. Otherwise the
        # dropdown for an earlier multi-term class immediately snaps back to
        # "Not take" after it is changed.
        auto_excluded = (
            gradebook_type == "high_school"
            and has_later_retake
            and fumble.should_have_been_gp is None
        )
        excluded = explicit_excluded or auto_excluded
        if excluded:
            # Not taking the class removes its original contribution, so its
            # score delta is the score recovered by removing it.
            if fumble.course_id in included_course_ids:
                if score_quality_points is None:
                    delta = 0
                else:
                    delta = (
                        -round(3 * (float(score_quality_points) - target_gp)) * float(fumble_units)
                        if gradebook_type == "high_school"
                        else -(course.get("score") or 0)
                    )
            else:
                delta = None
        else:
            delta_fn = unit_weighted_fumble_delta if gradebook_type == "high_school" else fumble_delta
            delta = delta_fn(
                score_quality_points,
                fumble.should_have_been_gp,
                fumble_units,
                target_gp,
            )
        if excluded and fumble.course_id in included_course_ids:
            if score_quality_points is not None:
                basis_units = fumble_units
                fumble_credits_delta -= basis_units
                weighted_fumble_units_delta -= float(weighted_info["units"] if weighted_info else basis_units)
                if weighted_quality_points is not None:
                    weighted_fumble_points_delta -= float(weighted_info["units"] if weighted_info else basis_units) * weighted_quality_points
        elif not excluded and fumble.should_have_been_gp is not None and (
            fumble.course_id in included_course_ids
            # An ungraded class has no current GPA contribution. Selecting a
            # hypothetical grade makes its units part of the adjusted GPA,
            # even when the class's term is not currently included.
            or score_quality_points is None
        ):
            if score_quality_points is None:
                fumble_credits_delta += fumble_units
                weighted_fumble_units_delta += float(fumble_units)
                weighted_fumble_points_delta += float(fumble_units) * (
                    float(fumble.should_have_been_gp) + weighted_boost
                )
            elif weighted_info:
                weighted_fumble_points_delta += float(weighted_info["units"]) * (
                    float(fumble.should_have_been_gp) + weighted_boost - weighted_quality_points
                )
        if delta is not None:
            fumble_total += delta
        gpa_delta = None
        if not excluded and fumble.should_have_been_gp is not None and score_quality_points is not None:
            gpa_delta = float(fumble.should_have_been_gp) - float(score_quality_points)
        fumble_rows.append(
            {
                "id": fumble.id,
                "course_id": course["id"],
                "code": course["code"],
                "did_get": score_quality_points,
                "letter": overall_course.get("letter", course.get("letter")),
                "should_have_been_gp": None if excluded else fumble.should_have_been_gp,
                "credits": 1.0 if gpa_basis == "classes" else course["credits"],
                "delta": delta,
                "gpa_delta": gpa_delta,
                "excluded": excluded,
                "semester_id": term["id"],
                "semester_name": term["name"],
            }
        )

    adjusted_fumble_credits = max(0, gpa_credits + fumble_credits_delta)
    score_with = overall_score + fumble_total
    gpa_with = (
        cap_gpa(overall_gpa_from_score(score_with, adjusted_fumble_credits, target_gp), settings.gpa_cap)
        if adjusted_fumble_credits
        else None
    )
    weighted_fumble_units = max(0, weighted_current_units + weighted_fumble_units_delta)
    weighted_fumble_points = weighted_current_points + weighted_fumble_points_delta
    weighted_with_fumbles = (
        cap_gpa(weighted_fumble_points / weighted_fumble_units, settings.gpa_cap)
        if weighted_fumble_units
        else None
    )

    try:
        guess_raw = json.loads(settings.future_guess_json or "{}")
    except json.JSONDecodeError:
        guess_raw = {}
    if not isinstance(guess_raw, dict):
        guess_raw = {}
    counts: dict[float, dict[str, float]] = {}
    for cred, letters in guess_raw.items():
        if cred == "weighted" or not isinstance(letters, dict):
            continue
        try:
            numeric_credit = float(cred)
            credit_key = int(numeric_credit) if numeric_credit.is_integer() else numeric_credit
        except (TypeError, ValueError):
            continue
        counts[credit_key] = {str(k): float(v) for k, v in letters.items()}
    weighted_counts = {}
    raw_weighted_counts = guess_raw.get("weighted")
    if isinstance(raw_weighted_counts, dict):
        weighted_counts = {
            str(tag_id): {str(letter): float(count) for letter, count in (letters or {}).items()}
            for tag_id, letters in raw_weighted_counts.items()
            if isinstance(letters, dict)
        }
    scale_rows = scale_rows_from_tuples(default_rows)
    guess_counts = counts
    if weighted_counts:
        # Weighted planning still adds one class to the unweighted GPA for
        # every entered cell; its label only changes the WGPA calculation.
        guess_counts = {1: {}}
        for letters in weighted_counts.values():
            for letter, count in letters.items():
                guess_counts[1][letter] = guess_counts[1].get(letter, 0) + count
    delta, extra, _ = future_guess_delta(
        guess_counts,
        scale_rows,
        target_gp,
        1.0 if gpa_basis == "classes" else None,
    )
    adj_credits = gpa_credits + extra if extra else None
    adj_score = (overall_score + delta) if delta is not None else None
    adj_gpa = (
        cap_gpa(overall_gpa_from_score(adj_score, adj_credits, target_gp), settings.gpa_cap)
        if adj_score is not None and adj_credits
        else None
    )
    adjusted_wgpa = None
    if weighted_counts:
        letter_to_gp = {row.letter: row.quality_points for row in scale_rows}
        tag_to_boost = {str(tag["id"]): float(tag.get("boost") or 0) for tag in weight_tags}
        current_units = sum(unit for unit, _ in weighted_pairs)
        current_points = sum(unit * quality_points for unit, quality_points in weighted_pairs)
        future_units = 0.0
        future_points = 0.0
        for tag_id, letters in weighted_counts.items():
            boost = tag_to_boost.get(tag_id, 0.0)
            for letter, count in letters.items():
                number = float(count or 0)
                quality_points = letter_to_gp.get(letter)
                if number <= 0 or quality_points is None:
                    continue
                future_units += number
                future_points += number * (quality_points + boost)
        if future_units:
            adjusted_wgpa = cap_gpa(
                (current_points + future_points) / (current_units + future_units),
                settings.gpa_cap,
            ) if current_units + future_units else None

    return {
        "target_letter": target_letter,
        "target_gp": target_gp,
        "gradebook_type": gradebook_type,
        "gpa_basis": gpa_basis,
        "gpa_weight_tags": weight_tags,
        "high_school_overall_rounding": high_school_overall_rounding(db),
        "high_school_overall_rounding_by_period": overall_rounding_by_period,
        "high_school_term_weights_by_period": term_weights_by_period,
        "high_school_period_scores": overall_period_scores,
        "overall_classes": [
            {
                # Keep an identifiable representative course even before a
                # multi-term class has a final grade, so it can be used by
                # the fumble planner.
                "id": item["final"].get("id") if item["final"] is not None else ((item.get("entries") or [{}])[0].get("course") or {}).get("id"),
                "code": item["final"].get("code") if item["final"] is not None else ((item.get("entries") or [{}])[0].get("course") or {}).get("code"),
                "occurrence": item.get("occurrence"),
                "period": item.get("period"),
                "units": item.get("units"),
                "overall_percent": item["final"].get("percent") if item["final"] is not None else None,
                "letter": item["final"].get("letter") if item["final"] is not None else None,
                "quality_points": item["final"].get("base_quality_points", item["final"].get("quality_points")) if item["final"] is not None else None,
                "weighted_quality_points": item["final"].get("quality_points") if item["final"] is not None else None,
            }
            for item in overall_classes
        ],
        "semesters_remaining": settings.semesters_remaining,
        "gpa_cap": settings.gpa_cap,
        "fail_pass_fail_affects_gpa": bool(settings.fail_pass_fail_affects_gpa),
        "recording_interval_days": settings.recording_interval_days or 7,
        "default_recording_semester_id": settings.default_recording_semester_id,
        "overall_gpa": overall,
        "weighted_overall_gpa": weighted_overall,
        "overall_score": overall_score,
        "total_credits": total_credits,
        "gpa_credits": gpa_credits,
        "affects_gpa_credits": sum(t.get("term_affects_gpa_credits", t.get("term_gpa_credits", 0)) for t in included_terms),
        "credit_only_credits": sum(t.get("term_credit_only_credits", 0) for t in included_terms),
        "for_credit_credits": sum(t.get("term_for_credit_credits", 0) for t in included_terms),
        "pass_fail_credits": pass_fail_credits,
        "unpassed_credits": unpassed_credits,
        "credits_remaining": credits_remaining,
        "score_per_semester": score_per_sem,
        "terms": terms,
        "distribution": dist,
        "fumbles": fumble_rows,
        "fumble_total": fumble_total,
        "score_with_fumbles": score_with,
        "gpa_with_fumbles": gpa_with,
        "weighted_gpa_with_fumbles": weighted_with_fumbles,
        "gpa_credits_with_fumbles": adjusted_fumble_credits,
        "fumble_credits_delta": fumble_credits_delta,
        "future_guess": {
            "grid": {"weighted": weighted_counts} if weighted_counts else counts,
            "delta_score": delta,
            "extra_credits": extra,
            "adjusted_credits": adj_credits,
            "adjusted_score": adj_score,
            "adjusted_gpa": adj_gpa,
            "adjusted_wgpa": adjusted_wgpa,
        },
        "aggregations": list(AGGREGATIONS),
        "aggregation_labels": dict(AGGREGATION_LABELS),
        "default_scale": scale_as_dicts(default_rows),
        "scale_profiles": [serialize_scale_profile(profile) for profile in list_scale_profiles(db)],
        "scale_presets": preset_payload(),
        "level_stats": build_level_stats(
            [c for t in included_terms for c in t["courses"] if c.get("gp_override") != -1]
        ),
        "exam_impact": summarize_exam_impacts(terms),
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
            "score": 0,
            "gpa_credits": 0.0,
            "qp_credits": 0.0,
        }
        credits = float(course.get("credits") or 0)
        cur["courses"] += 1
        cur["credits"] += credits
        cur["score"] += course.get("score") or 0
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
                "score": float(row["score"]),
                "gpa": (row["qp_credits"] / row["gpa_credits"]) if row["gpa_credits"] else None,
            }
        )
    return out


class ProgressionLockedError(ValueError):
    """Raised when recording a snapshot on a locked semester."""


class NoGradesToRecordError(ValueError):
    """Raised when every class in the semester has no percent."""


def serialize_grade_snapshot(snapshot: GradeSnapshot) -> dict:
    courses = [row for row in _parse_snapshot_courses(snapshot) if _course_has_percent(row)]
    return {
        "id": snapshot.id,
        "semester_id": snapshot.semester_id,
        "recorded_at": snapshot.recorded_at.isoformat() if snapshot.recorded_at else None,
        "term_gpa": snapshot.term_gpa,
        "term_wgpa": snapshot.term_wgpa,
        "courses": courses,
    }


def list_grade_snapshots(db: Session, semester_id: int) -> list[dict]:
    rows = (
        db.query(GradeSnapshot)
        .filter(GradeSnapshot.semester_id == semester_id)
        .order_by(GradeSnapshot.recorded_at.asc(), GradeSnapshot.id.asc())
        .all()
    )
    return [serialize_grade_snapshot(row) for row in rows]


def _snapshot_day(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        return value
    else:
        try:
            parsed = datetime.fromisoformat(str(value))
        except ValueError:
            return None
    # The chart labels dates in UTC. Normalize aware legacy timestamps the
    # same way before comparing points from different terms.
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc)
    return parsed.date()


def _parse_snapshot_courses(snapshot: GradeSnapshot) -> list[dict]:
    try:
        courses = json.loads(snapshot.courses_json or "[]")
    except (json.JSONDecodeError, TypeError):
        return []
    return courses if isinstance(courses, list) else []


def _course_has_percent(course: dict) -> bool:
    percent = course.get("percent")
    if percent is None:
        return False
    try:
        return percent == percent and abs(float(percent)) != float("inf")
    except (TypeError, ValueError):
        return False


def _semester_has_recordable_grades(semester: Semester) -> bool:
    """Return whether a semester contains a grade that a snapshot can record."""
    return any(
        _course_has_percent(serialize_course(course, target_gp=0.0))
        for course in semester.courses
    )


def _snapshot_is_empty(snapshot: GradeSnapshot) -> bool:
    courses = [row for row in _parse_snapshot_courses(snapshot) if _course_has_percent(row)]
    return not courses and snapshot.term_gpa is None and snapshot.term_wgpa is None


def _prune_empty_snapshot(db: Session, snapshot: GradeSnapshot) -> bool:
    if not _snapshot_is_empty(snapshot):
        return False
    db.delete(snapshot)
    return True


def snapshot_quality_points(course: dict, weighted: bool = False) -> float | None:
    """Return the GPA points implied by the recorded class percent.

    A GP override changes the live display, but it must not change the GPA
    checkpoint stored in the progression chart. Pass/fail courses are the
    one exception: a failing course contributes zero only when that setting
    is enabled for the gradebook.
    """
    if course.get("gp_override") == -1:
        return None
    if course.get("credit_mode") == "pass_fail":
        if (
            course.get("pass_fail", {}).get("fail_affects_gpa")
            and not pass_fail_row_is_passing(course)
        ):
            return 0.0
        return None
    natural = course.get("natural_quality_points")
    if natural is None:
        return None
    boost = float(course.get("gpa_weight_boost") or 0) if weighted else 0.0
    return float(natural) + boost


def snapshot_term_gpa(
    payload: dict,
    gpa_cap: float | None,
    gpa_basis: str = "credits",
    gradebook_type: str = "college",
    weighted: bool = False,
) -> float | None:
    unit = lambda course: 1.0 if gpa_basis == "classes" else (course.get("credits") or 0)
    pairs = []
    for course in payload.get("courses") or []:
        quality_points = snapshot_quality_points(course, weighted)
        if quality_points is None:
            continue
        course = {**course, "quality_points": quality_points}
        pairs.append((unit(course), quality_points))
    if not pairs:
        return None
    return cap_gpa(weighted_gpa(pairs, include_zero=any(gp == 0 for _, gp in pairs)), gpa_cap)


def record_grade_snapshot(
    db: Session,
    semester: Semester,
    target_gp: float,
    gpa_cap: float | None,
    fail_pass_fail_affects_gpa: bool | None = None,
    gradebook_type: str = "college",
    weight_tags: list[dict] | None = None,
    gpa_basis: str = "credits",
    score_units: float | None = None,
) -> dict:
    if semester.progression_locked:
        raise ProgressionLockedError("Progression is locked for this semester")
    payload = serialize_semester(
        semester,
        target_gp,
        gpa_cap,
        fail_pass_fail_affects_gpa,
        gradebook_type,
        weight_tags,
        gpa_basis,
        score_units,
    )
    recorded_term_gpa = snapshot_term_gpa(payload, gpa_cap, gpa_basis, gradebook_type)
    recorded_term_wgpa = snapshot_term_gpa(payload, gpa_cap, gpa_basis, gradebook_type, weighted=True)
    courses = [
        {
            "course_id": course["id"],
            "code": course["code"],
            "percent": course["percent"],
        }
        for course in payload["courses"]
        if _course_has_percent(course)
    ]
    if not courses:
        raise NoGradesToRecordError("No class grades to record")
    now = _utcnow()
    today = now.date()
    snapshot = next(
        (
            row
            for row in db.query(GradeSnapshot).filter(GradeSnapshot.semester_id == semester.id).all()
            if _snapshot_day(row.recorded_at) == today
        ),
        None,
    )
    if snapshot is None:
        snapshot = GradeSnapshot(
            semester_id=semester.id,
            recorded_at=now,
            term_gpa=recorded_term_gpa,
            term_wgpa=recorded_term_wgpa,
            courses_json=json.dumps(courses),
        )
        db.add(snapshot)
    else:
        snapshot.recorded_at = now
        snapshot.term_gpa = recorded_term_gpa
        snapshot.term_wgpa = recorded_term_wgpa
        snapshot.courses_json = json.dumps(courses)
    settings = settings_for_gradebook(db)
    global_settings = db.get(Settings, 1)
    if global_settings is not None:
        # Progression reminders are program-wide. Recording in any gradebook
        # resets the one shared reminder clock and snooze state.
        global_settings.grade_prompt_snooze_until = None
    if settings is not None:
        # Keep the last selected destination term as a convenience for that
        # gradebook, but never use it to decide whether the global reminder is due.
        settings.default_recording_semester_id = semester.id
        update_gradebook_settings(
            db,
            {"default_recording_semester_id": settings.default_recording_semester_id},
        )
    db.commit()
    db.refresh(snapshot)
    return serialize_grade_snapshot(snapshot)


def patch_grade_snapshot(
    db: Session,
    semester_id: int,
    snapshot_id: int,
    *,
    course_id: int | None = None,
    percent: float | None = None,
    clear_course: bool = False,
    term_gpa: float | None = None,
    clear_term_gpa: bool = False,
) -> dict | None:
    snapshot = db.get(GradeSnapshot, snapshot_id)
    if snapshot is None or snapshot.semester_id != semester_id:
        return None
    if clear_term_gpa:
        snapshot.term_gpa = None
        snapshot.term_wgpa = None
    elif term_gpa is not None:
        snapshot.term_gpa = float(term_gpa)
    if course_id is not None:
        courses = _parse_snapshot_courses(snapshot)
        if clear_course:
            courses = [row for row in courses if int(row.get("course_id") or 0) != int(course_id)]
        else:
            if percent is None:
                raise ValueError("percent is required to edit a class point")
            updated = False
            for row in courses:
                if int(row.get("course_id") or 0) != int(course_id):
                    continue
                row["percent"] = float(percent)
                updated = True
                break
            if not updated:
                raise ValueError("Class point not found on this checkpoint")
        snapshot.courses_json = json.dumps(courses)
    if _prune_empty_snapshot(db, snapshot):
        db.commit()
        return {"id": snapshot_id, "deleted": True}
    db.commit()
    db.refresh(snapshot)
    return serialize_grade_snapshot(snapshot)


def _snapshot_code(value) -> str:
    normalized = re.sub(r"\s+", " ", str(value or "").strip()).casefold()
    # Some older payloads persisted the display-only duplicate suffix, such
    # as "Calculus (2)". It is not part of the class identity.
    return re.sub(r"\s+\(\d+\)$", "", normalized)


def _snapshot_course_code(course: dict) -> str:
    return _snapshot_code(course.get("code") or course.get("display_code"))


def _course_point_targets(
    db: Session,
    semester_id: int,
    course_points: list[tuple[int, int]] | None,
) -> dict[int, set[int]]:
    """Expand selected class points to matching class/date points in this gradebook."""
    requested = [
        (int(snapshot_id), int(course_id))
        for snapshot_id, course_id in course_points or []
    ]
    if not requested:
        return {}
    snapshot_ids = {snapshot_id for snapshot_id, _ in requested}
    source_snapshots = (
        db.query(GradeSnapshot)
        .join(Semester, GradeSnapshot.semester_id == Semester.id)
        .filter(
            GradeSnapshot.semester_id == semester_id,
            GradeSnapshot.id.in_(snapshot_ids),
            Semester.gradebook_id == active_gradebook_id(),
        )
        .all()
    )
    by_source_id = {snapshot.id: snapshot for snapshot in source_snapshots}
    all_snapshots = (
        db.query(GradeSnapshot)
        .join(Semester, GradeSnapshot.semester_id == Semester.id)
        .filter(Semester.gradebook_id == active_gradebook_id())
        .all()
    )
    course_codes = {
        course.id: course.code
        for course in (
            db.query(Course)
            .join(Semester, Course.semester_id == Semester.id)
            .filter(Semester.gradebook_id == active_gradebook_id())
            .all()
        )
    }

    def row_code(row: dict) -> str:
        saved_code = _snapshot_course_code(row)
        if saved_code:
            return saved_code
        try:
            course_id = int(row.get("course_id") or 0)
        except (TypeError, ValueError):
            course_id = 0
        return _snapshot_code(course_codes.get(course_id))

    targets: dict[int, set[int]] = {}
    for snapshot_id, course_id in requested:
        source = by_source_id.get(snapshot_id)
        if source is None:
            continue
        source_point = next(
            (
                row for row in _parse_snapshot_courses(source)
                if int(row.get("course_id") or 0) == course_id
            ),
            None,
        )
        if source_point is None:
            continue
        code = _snapshot_course_code(source_point)
        if not code:
            # Very old checkpoints may contain only the numeric course id.
            # Resolve its current class code so those checkpoints can still
            # participate in same-class/date propagation.
            source_course = (
                db.query(Course)
                .join(Semester, Course.semester_id == Semester.id)
                .filter(
                    Course.id == course_id,
                    Semester.gradebook_id == active_gradebook_id(),
                )
                .first()
            )
            code = _snapshot_code(source_course.code if source_course else None)
        day = _snapshot_day(source.recorded_at)
        if not code or day is None:
            targets.setdefault(snapshot_id, set()).add(course_id)
            continue
        source_occurrence = 0
        for row in _parse_snapshot_courses(source):
            if int(row.get("course_id") or 0) == course_id:
                break
            if row_code(row) == code:
                source_occurrence += 1
        for snapshot in all_snapshots:
            if _snapshot_day(snapshot.recorded_at) != day:
                continue
            snapshot_courses = _parse_snapshot_courses(snapshot)
            if snapshot.id == snapshot_id:
                matching_ids = [
                    int(row.get("course_id") or 0)
                    for row in snapshot_courses
                    if int(row.get("course_id") or 0) == course_id
                ]
            else:
                # Course ids are globally unique and remain the strongest
                # identity when a class was moved or its saved code changed.
                # Older snapshots may not have a code at all, so use the id
                # before falling back to the code/occurrence match.
                matching_by_id = [
                    int(row.get("course_id") or 0)
                    for row in snapshot_courses
                    if int(row.get("course_id") or 0) == course_id
                ]
                if matching_by_id:
                    matching_ids = matching_by_id[:1]
                    targets.setdefault(snapshot.id, set()).update(matching_ids)
                    continue
                matching = [
                    int(row.get("course_id") or 0)
                    for row in snapshot_courses
                    if row_code(row) == code
                ]
                matching_ids = matching[source_occurrence:source_occurrence + 1]
            if matching_ids:
                targets.setdefault(snapshot.id, set()).update(matching_ids)
    return targets


def _same_day_snapshot_ids(
    db: Session,
    semester_id: int,
    snapshot_ids: set[int],
) -> set[int]:
    """Expand aggregate checkpoint deletions to the same displayed day."""
    if not snapshot_ids:
        return set()
    source_rows = (
        db.query(GradeSnapshot)
        .join(Semester, GradeSnapshot.semester_id == Semester.id)
        .filter(
            GradeSnapshot.semester_id == semester_id,
            GradeSnapshot.id.in_(snapshot_ids),
            Semester.gradebook_id == active_gradebook_id(),
        )
        .all()
    )
    days = {_snapshot_day(row.recorded_at) for row in source_rows}
    days.discard(None)
    if not days:
        return {row.id for row in source_rows}
    return {
        row.id
        for row in (
            db.query(GradeSnapshot)
            .join(Semester, GradeSnapshot.semester_id == Semester.id)
            .filter(Semester.gradebook_id == active_gradebook_id())
            .all()
        )
        if _snapshot_day(row.recorded_at) in days
    }


def delete_grade_snapshots(
    db: Session,
    semester_id: int,
    snapshot_ids: list[int] | None = None,
    course_points: list[tuple[int, int]] | None = None,
    gpa_snapshot_ids: list[int] | None = None,
) -> int:
    removed = 0
    by_snapshot = _course_point_targets(db, semester_id, course_points)
    ids = [int(item) for item in (snapshot_ids or []) if item is not None]
    deleted_snapshot_ids = set(ids)
    if ids:
        rows = (
            db.query(GradeSnapshot)
            .filter(GradeSnapshot.semester_id == semester_id, GradeSnapshot.id.in_(ids))
            .all()
        )
        for row in rows:
            db.delete(row)
            removed += 1

    gpa_ids = {int(item) for item in (gpa_snapshot_ids or []) if item is not None}
    valid_gpa_ids = _same_day_snapshot_ids(db, semester_id, gpa_ids)

    touched_ids = (set(by_snapshot) | valid_gpa_ids) - deleted_snapshot_ids
    if touched_ids:
        rows = (
            db.query(GradeSnapshot)
            .join(Semester, GradeSnapshot.semester_id == Semester.id)
            .filter(
                GradeSnapshot.id.in_(touched_ids),
                Semester.gradebook_id == active_gradebook_id(),
            )
            .all()
        )
        for row in rows:
            changed = False
            drop_ids = by_snapshot.get(row.id)
            if drop_ids:
                original_courses = _parse_snapshot_courses(row)
                courses = [
                    item
                    for item in original_courses
                    if int(item.get("course_id") or 0) not in drop_ids
                ]
                row.courses_json = json.dumps(courses)
                removed += len(original_courses) - len(courses)
                # A class deletion makes the aggregate checkpoint incomplete
                # too. Clear it so GPA/WGPA views show the same hole without
                # deleting the other classes from that date.
                if row.term_gpa is not None or row.term_wgpa is not None:
                    row.term_gpa = None
                    row.term_wgpa = None
                    removed += 1
                changed = True
            if row.id in valid_gpa_ids and (row.term_gpa is not None or row.term_wgpa is not None):
                row.term_gpa = None
                row.term_wgpa = None
                removed += 1
                changed = True
            if changed and _prune_empty_snapshot(db, row):
                continue

    db.commit()
    return removed


def delete_course_grade_points(db: Session, semester_id: int, course_id: int) -> int:
    """Remove a deleted class from every saved progression checkpoint in its term."""
    removed = 0
    snapshots = (
        db.query(GradeSnapshot)
        .filter(GradeSnapshot.semester_id == semester_id)
        .all()
    )
    for snapshot in snapshots:
        courses = _parse_snapshot_courses(snapshot)
        remaining = [
            row for row in courses
            if int(row.get("course_id") or 0) != int(course_id)
        ]
        if len(remaining) == len(courses):
            continue
        snapshot.courses_json = json.dumps(remaining)
        removed += len(courses) - len(remaining)
        _prune_empty_snapshot(db, snapshot)
    return removed


def record_all_grade_snapshots(db: Session) -> list[dict]:
    settings = settings_for_gradebook(db)
    target_letter, target_gp = target_gp_from_settings(settings, db)
    gpa_cap = settings.gpa_cap if settings else None
    gradebook_type = (settings.gradebook_type or "college").strip().lower() if settings else "college"
    gpa_basis = (settings.gpa_basis or "credits").strip().lower() if settings else "credits"
    weight_tags = gpa_weight_tags(settings)
    score_units = (
        high_school_term_units(db)
        if gradebook_type == "high_school"
        else ({semester.id: 1.0 for semester in gradebook_semesters(db)} if gpa_basis == "classes" else {})
    )
    results = []
    for semester in sort_semesters(gradebook_semesters(db)):
        if semester.progression_locked:
            continue
        try:
            results.append(
                record_grade_snapshot(
                    db,
                    semester,
                    target_gp,
                    gpa_cap,
                    settings.fail_pass_fail_affects_gpa if settings else None,
                    gradebook_type,
                    weight_tags,
                    gpa_basis,
                    score_units.get(semester.id),
                )
            )
        except NoGradesToRecordError:
            continue
    return results


def latest_grade_snapshot_at(db: Session) -> datetime | None:
    row = (
        db.query(GradeSnapshot)
        .join(Semester, GradeSnapshot.semester_id == Semester.id)
        .order_by(GradeSnapshot.recorded_at.desc())
        .first()
    )
    return row.recorded_at if row else None


def _semester_sort_key(sem: Semester) -> tuple:
    return (sem.year, SEASON_ORDER.get(sem.season, 0), sem.id)


def lock_older_unlocked_semesters(db: Session, new_sem: Semester) -> None:
    new_key = _semester_sort_key(new_sem)
    for other in gradebook_semesters(db):
        if other.id == new_sem.id or other.progression_locked:
            continue
        if _semester_sort_key(other) < new_key:
            other.progression_locked = True


def resolve_default_recording_semester_id(db: Session, settings: Settings | None) -> int | None:
    ranked = sort_semesters(gradebook_semesters(db))
    if not ranked:
        return None
    ids = {sem.id for sem in ranked}
    current = settings.default_recording_semester_id if settings else None
    if current in ids:
        return current
    fallback = ranked[0].id
    if settings is not None:
        settings.default_recording_semester_id = fallback
        update_gradebook_settings(db, {"default_recording_semester_id": fallback})
        db.commit()
    return fallback


def grade_prompt_status(db: Session) -> dict:
    # The progression reminder is intentionally program-wide. It must not be
    # reset, restyled, or independently snoozed when the user changes books.
    settings = db.get(Settings, 1)
    interval = max(int(settings.recording_interval_days or 7), 1) if settings else 7
    now = _utcnow()
    snooze_until = settings.grade_prompt_snooze_until if settings else None
    last_recorded = latest_grade_snapshot_at(db)
    ranked = sort_semesters(db.query(Semester).all())
    unlocked = [sem for sem in ranked if not sem.progression_locked]
    # A seeded fresh install has an empty semester so the user can start
    # entering classes. It should not trigger a recording reminder until at
    # least one unlocked class has an actual grade to record.
    due = any(_semester_has_recordable_grades(sem) for sem in unlocked)
    if due and snooze_until is not None and snooze_until > now:
        due = False
    elif due and last_recorded is not None:
        due = now >= last_recorded + timedelta(days=interval)
    default_id = next((sem.id for sem in ranked if not sem.progression_locked), ranked[0].id if ranked else None)
    settings_map = _gradebook_settings_map(settings) if settings is not None else {}

    def gradebook_type_for(gradebook_id: str) -> str:
        values = settings_map.get(str(gradebook_id))
        if isinstance(values, dict) and values.get("gradebook_type"):
            return str(values["gradebook_type"])
        return (settings.gradebook_type if settings else "college") or "college"

    academic_periods = []
    for academic_year in db.query(AcademicYear).all():
        try:
            semester_ids = [int(value) for value in json.loads(academic_year.semester_ids_json or "[]")]
        except (TypeError, ValueError, json.JSONDecodeError):
            semester_ids = []
        academic_periods.append(
            {
                "id": academic_year.id,
                "gradebook_id": academic_year.gradebook_id,
                "name": academic_year.name,
                "semester_ids": semester_ids,
            }
        )
    return {
        "due": due,
        "recording_interval_days": interval,
        "last_recorded_at": last_recorded.isoformat() if last_recorded else None,
        "snooze_until": snooze_until.isoformat() if snooze_until else None,
        "default_semester_id": default_id,
        "academic_periods": academic_periods,
        "semesters": [
            {
                "id": sem.id,
                "gradebook_id": sem.gradebook_id,
                "gradebook_type": gradebook_type_for(sem.gradebook_id),
                "name": semester_name(sem, gradebook_type_for(sem.gradebook_id)),
                "progression_locked": bool(sem.progression_locked),
            }
            for sem in ranked
        ],
    }


def snooze_grade_prompt(db: Session, days: int = 1) -> dict:
    # Snoozing is a single program-wide action, independent of the active book.
    settings = db.get(Settings, 1)
    if settings is None:
        seed_if_needed(db)
        settings = db.get(Settings, 1)
    settings.grade_prompt_snooze_until = _utcnow() + timedelta(days=max(days, 1))
    db.commit()
    return grade_prompt_status(db)
