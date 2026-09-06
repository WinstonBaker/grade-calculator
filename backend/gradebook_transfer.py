"""Portable gradebook setup import and export helpers.

The transfer format deliberately contains structure only: gradebook settings,
periods, terms, classes, grading configuration, and empty categories. It never
serializes assignments, grade snapshots, overrides, or other entered grades.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session, joinedload

from backend.engine import SEASON_LABELS
from backend.models import AcademicYear, Category, Course, GradeScale, ScaleProfile, ScaleProfileRow, Semester, Settings
from backend.service import GRADEBOOK_SETTING_DEFAULTS, _gradebook_settings_map, _gradebook_values


FORMAT = "grade-calculator-gradebook-setup"
VERSION = 1


def _json(value: Any, fallback: Any) -> Any:
    try:
        parsed = json.loads(value or "")
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback
    return parsed if isinstance(parsed, type(fallback)) else fallback


def _rows(rows: list[Any]) -> list[dict]:
    return [
        {
            "letter": str(row.letter),
            "min_percent": float(row.min_percent),
            "quality_points": float(row.quality_points),
        }
        for row in rows
    ]


def _settings_payload(db: Session, gradebook_id: str) -> dict:
    settings = db.get(Settings, 1)
    values = _gradebook_values(settings, gradebook_id) if settings else dict(GRADEBOOK_SETTING_DEFAULTS)
    return {
        "target_letter": str(values.get("target_letter") or "A"),
        "semesters_remaining": float(values.get("semesters_remaining") or 0),
        "gpa_cap": values.get("gpa_cap"),
        "fail_pass_fail_affects_gpa": values.get("fail_pass_fail_affects_gpa") is True,
        "future_guess": _json(values.get("future_guess_json"), {}),
        "default_scale": _json(values.get("default_scale_json"), []),
        "gradebook_type": str(values.get("gradebook_type") or "college"),
        "gpa_weight_tags": _json(values.get("gpa_weight_tags_json"), []),
        "gpa_basis": str(values.get("gpa_basis") or "credits"),
        "high_school_overall_rounding": values.get("high_school_overall_rounding") if isinstance(values.get("high_school_overall_rounding"), dict) else {},
        "high_school_overall_rounding_by_period": values.get("high_school_overall_rounding_by_period") if isinstance(values.get("high_school_overall_rounding_by_period"), dict) else {},
        "high_school_term_weights_by_period": values.get("high_school_term_weights_by_period") if isinstance(values.get("high_school_term_weights_by_period"), dict) else {},
    }


def _course_payload(course: Course) -> dict:
    categories = sorted(course.categories, key=lambda item: (item.sort_order, item.id))
    category_keys = {item.id: f"category-{item.id}" for item in categories}
    dynamic = _json(course.dynamic_weighting_json, {})
    options = dynamic.get("options") if isinstance(dynamic, dict) else None
    if isinstance(options, list):
        dynamic = {
            **dynamic,
            "options": [
                {
                    **option,
                    "weights": {
                        category_keys.get(int(key), str(key)): value
                        for key, value in (option.get("weights") or {}).items()
                    },
                }
                for option in options
                if isinstance(option, dict)
            ],
        }
    test_ids = _json(course.test_category_ids_json, [])
    return {
        "key": f"course-{course.id}",
        "code": course.code,
        "credits": float(course.credits),
        "bonus_points": float(course.bonus_points),
        "bonus_mode": course.bonus_mode,
        "grade_rounding": course.grade_rounding,
        "grading_mode": course.grading_mode,
        "credit_mode": course.credit_mode,
        "gpa_weight_tag": course.gpa_weight_tag,
        "pass_label": course.pass_label,
        "fail_label": course.fail_label,
        "pass_min_percent": float(course.pass_min_percent),
        "pass_fail_rows": _json(course.pass_fail_rows_json, []),
        "minimum_passing_letter": course.minimum_passing_letter,
        "dynamic_weighting_enabled": course.dynamic_weighting_enabled is True,
        "dynamic_weighting": dynamic,
        "scale_profile_key": f"profile-{course.scale_profile_id}" if course.scale_profile_id else None,
        "scale": _rows(course.scale_rows),
        "test_category_keys": [category_keys[item] for item in test_ids if item in category_keys],
        "exam_category_key": category_keys.get(course.exam_category_id),
        "categories": [
            {
                "key": category_keys[category.id],
                "name": category.name,
                "weight": float(category.weight),
                "weight_per_item": category.weight_per_item,
                "aggregation": category.aggregation,
                "drop_count": int(category.drop_count),
                "replace_count": int(category.replace_count or 1),
                "include_bonus": category.include_bonus is True,
                "is_bonus_category": category.is_bonus_category is True,
                "replace_with_key": category_keys.get(category.replace_with_category_id),
                "sort_order": int(category.sort_order),
            }
            for category in categories
        ],
    }


def gradebook_setup_inventory(db: Session, gradebooks: list[dict]) -> dict:
    """Return the lightweight hierarchy used by the export checklist."""
    settings = db.get(Settings, 1)
    supplied = {str(item.get("id")): str(item.get("name") or item.get("id")) for item in gradebooks if item.get("id")}
    payload = []
    for gradebook_id, name in supplied.items():
        values = _gradebook_values(settings, gradebook_id) if settings else dict(GRADEBOOK_SETTING_DEFAULTS)
        gradebook_type = str(values.get("gradebook_type") or "college")
        semesters = (
            db.query(Semester)
            .options(joinedload(Semester.courses))
            .filter(Semester.gradebook_id == gradebook_id)
            .order_by(Semester.year, Semester.season, Semester.id)
            .all()
        )
        by_id = {semester.id: semester for semester in semesters}
        assigned: set[int] = set()
        academic_years = (
            db.query(AcademicYear)
            .filter(AcademicYear.gradebook_id == gradebook_id)
            .order_by(AcademicYear.id)
            .all()
        )
        periods = []
        for record in academic_years:
            ids = [int(value) for value in _json(record.semester_ids_json, []) if str(value).isdigit()]
            terms = [by_id[item] for item in ids if item in by_id]
            if not terms:
                continue
            assigned.update(item.id for item in terms)
            periods.append({
                "key": f"period-{record.id}",
                "name": record.name,
                "terms": [_inventory_term(item, gradebook_type) for item in terms],
            })
        remaining = [semester for semester in semesters if semester.id not in assigned]
        if remaining:
            periods.append({
                "key": "unassigned",
                "name": "Terms",
                "terms": [_inventory_term(item, gradebook_type) for item in remaining],
            })
        payload.append({
            "id": gradebook_id,
            "name": name,
            "gradebook_type": gradebook_type,
            "periods": periods,
        })
    return {"gradebooks": payload}


def _term_name(semester: Semester, gradebook_type: str = "college") -> str:
    label = SEASON_LABELS.get(str(semester.season or "").lower(), str(semester.season or "").title())
    if (gradebook_type or "college").strip().lower() == "high_school":
        return label
    return f"{semester.year} {label}"


def _inventory_term(semester: Semester, gradebook_type: str = "college") -> dict:
    season = str(semester.season or "").lower()
    academic_period_key = semester.year - 1 if season in {"spring", "summer"} else semester.year
    return {
        "id": semester.id,
        "key": f"term-{semester.id}",
        "name": _term_name(semester, gradebook_type),
        "year": semester.year,
        "season": semester.season,
        "academic_period_key": str(academic_period_key),
        "classes": [
            {"id": course.id, "key": f"course-{course.id}", "name": course.code}
            for course in sorted(semester.courses, key=lambda course: (str(course.code or "").strip().casefold(), course.id))
        ],
    }


def export_gradebook_setups(db: Session, selections: list[dict]) -> dict:
    """Create a portable setup-only export for the selected tree leaves."""
    result = []
    for selection in selections:
        gradebook_id = str(selection.get("id") or "").strip()
        if not gradebook_id:
            continue
        selected_terms = {int(value) for value in selection.get("term_ids", []) if str(value).isdigit()}
        selected_courses = {int(value) for value in selection.get("course_ids", []) if str(value).isdigit()}
        term_names = selection.get("term_names") if isinstance(selection.get("term_names"), dict) else {}
        if not selected_terms and not selected_courses:
            continue
        semesters = (
            db.query(Semester)
            .options(
                joinedload(Semester.courses).joinedload(Course.categories),
                joinedload(Semester.courses).joinedload(Course.scale_rows),
            )
            .filter(Semester.gradebook_id == gradebook_id)
            .order_by(Semester.year, Semester.season, Semester.id)
            .all()
        )
        selected = [semester for semester in semesters if semester.id in selected_terms]
        if not selected:
            continue
        profiles = (
            db.query(ScaleProfile)
            .options(joinedload(ScaleProfile.rows))
            .filter(ScaleProfile.gradebook_id == gradebook_id)
            .order_by(ScaleProfile.sort_order, ScaleProfile.id)
            .all()
        )
        values = _gradebook_values(db.get(Settings, 1), gradebook_id)
        gradebook_type = str(values.get("gradebook_type") or "college")
        terms = []
        for semester in selected:
            courses = [course for course in semester.courses if course.id in selected_courses]
            configured_name = term_names.get(str(semester.id)) or term_names.get(semester.id)
            terms.append({
                "key": f"term-{semester.id}",
                "name": str(configured_name) if configured_name and gradebook_type != "high_school" else _term_name(semester, gradebook_type),
                "year": semester.year,
                "season": semester.season,
                "included": semester.included is True,
                "classes": [
                    _course_payload(course)
                    for course in sorted(courses, key=lambda course: (str(course.code or "").strip().casefold(), course.id))
                ],
            })
        period_by_term: dict[int, tuple[str, str]] = {}
        for record in db.query(AcademicYear).filter(AcademicYear.gradebook_id == gradebook_id).order_by(AcademicYear.id):
            for raw_id in _json(record.semester_ids_json, []):
                if str(raw_id).isdigit():
                    period_by_term[int(raw_id)] = (f"period-{record.id}", record.name)
        grouped: dict[str, dict] = {}
        for term, semester in zip(terms, selected):
            period_key, period_name = period_by_term.get(semester.id, ("unassigned", "Terms"))
            group = grouped.setdefault(period_key, {"key": period_key, "name": period_name, "terms": []})
            group["terms"].append(term)
        result.append({
            "source_id": gradebook_id,
            "name": str(selection.get("name") or gradebook_id),
            "settings": _settings_payload(db, gradebook_id),
            "appearance": selection.get("appearance") if isinstance(selection.get("appearance"), dict) else {},
            "scale_profiles": [
                {
                    "key": f"profile-{profile.id}",
                    "name": profile.name,
                    "is_primary": profile.is_primary is True,
                    "preset_id": profile.preset_id,
                    "pass_label": profile.pass_label,
                    "fail_label": profile.fail_label,
                    "pass_min_percent": float(profile.pass_min_percent),
                    "pass_fail_rows": _json(profile.pass_fail_rows_json, []),
                    "minimum_passing_letter": profile.minimum_passing_letter,
                    "rows": _rows(profile.rows),
                }
                for profile in profiles
            ],
            "periods": list(grouped.values()),
        })
    return {
        "format": FORMAT,
        "version": VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "gradebooks": result,
    }


def _valid_export(payload: dict) -> list[dict]:
    if not isinstance(payload, dict) or payload.get("format") != FORMAT:
        raise ValueError("This is not a Grade Calculator gradebook setup file")
    if payload.get("version") != VERSION:
        raise ValueError("This setup file version is not supported")
    gradebooks = payload.get("gradebooks")
    if not isinstance(gradebooks, list) or not gradebooks:
        raise ValueError("The setup file does not contain any gradebooks")
    return [item for item in gradebooks if isinstance(item, dict)]


def _persist_settings(db: Session, gradebook_id: str, raw: dict, replace: bool) -> None:
    settings = db.get(Settings, 1)
    if settings is None:
        raise ValueError("Gradebook settings are unavailable")
    values = _gradebook_settings_map(settings)
    if not replace and gradebook_id in values:
        return
    source = raw if isinstance(raw, dict) else {}
    current = dict(GRADEBOOK_SETTING_DEFAULTS)
    current["default_scale_json"] = settings.default_scale_json
    current.update({
        "target_letter": str(source.get("target_letter") or current["target_letter"]),
        "semesters_remaining": float(source.get("semesters_remaining") or 0),
        "gpa_cap": source.get("gpa_cap"),
        "fail_pass_fail_affects_gpa": source.get("fail_pass_fail_affects_gpa") is True,
        "future_guess_json": json.dumps(source.get("future_guess") if isinstance(source.get("future_guess"), dict) else {}),
        "default_scale_json": json.dumps(source.get("default_scale") if isinstance(source.get("default_scale"), list) else []),
        "gradebook_type": "high_school" if source.get("gradebook_type") == "high_school" else "college",
        "gpa_weight_tags_json": json.dumps(source.get("gpa_weight_tags") if isinstance(source.get("gpa_weight_tags"), list) else []),
        "gpa_basis": "classes" if source.get("gpa_basis") == "classes" else "credits",
        "default_recording_semester_id": None,
        "high_school_overall_rounding": source.get("high_school_overall_rounding") if isinstance(source.get("high_school_overall_rounding"), dict) else {},
        "high_school_overall_rounding_by_period": source.get("high_school_overall_rounding_by_period") if isinstance(source.get("high_school_overall_rounding_by_period"), dict) else {},
        "high_school_term_weights_by_period": source.get("high_school_term_weights_by_period") if isinstance(source.get("high_school_term_weights_by_period"), dict) else {},
    })
    values[gradebook_id] = current
    settings.gradebook_settings_json = json.dumps(values)


def _unique_season(db: Session, gradebook_id: str, year: int, season: str) -> str:
    base = str(season or "term").strip().lower() or "term"
    candidate = base
    number = 2
    while db.query(Semester).filter(
        Semester.gradebook_id == gradebook_id,
        Semester.year == year,
        Semester.season == candidate,
    ).first() is not None:
        candidate = f"{base} imported {number}"
        number += 1
    return candidate


def _unique_code(db: Session, semester_id: int, code: str) -> str:
    base = str(code or "Class").strip() or "Class"
    candidate = base
    number = 2
    while db.query(Course).filter(Course.semester_id == semester_id, Course.code.ilike(candidate)).first() is not None:
        candidate = f"{base} (imported {number})"
        number += 1
    return candidate


def _term_map(gradebook: dict) -> tuple[dict[str, dict], dict[str, dict]]:
    terms: dict[str, dict] = {}
    periods: dict[str, dict] = {}
    for period in gradebook.get("periods", []):
        if not isinstance(period, dict):
            continue
        key = str(period.get("key") or "unassigned")
        periods[key] = period
        for term in period.get("terms", []):
            if isinstance(term, dict) and term.get("key"):
                terms[str(term["key"])] = term
    return terms, periods


def import_gradebook_setups(db: Session, payload: dict, plan: list[dict]) -> dict:
    """Import a validated setup payload with explicit destination mappings."""
    gradebooks = _valid_export(payload)
    source_by_id = {str(item.get("source_id") or item.get("name") or index): item for index, item in enumerate(gradebooks)}
    plans = [item for item in plan if isinstance(item, dict)]
    if not plans:
        raise ValueError("Choose at least one import destination")

    results = []
    for entry in plans:
        source_id = str(entry.get("source_id") or "")
        source = source_by_id.get(source_id)
        if source is None:
            continue
        destination_id = str(entry.get("destination_id") or "").strip()
        destination_name = str(entry.get("destination_name") or source.get("name") or "Imported gradebook").strip()
        if not destination_id or not destination_name:
            raise ValueError("Each imported gradebook needs a destination")
        destination_is_new = entry.get("destination_mode") == "new"
        source_type = "high_school" if source.get("settings", {}).get("gradebook_type") == "high_school" else "college"
        existing_values = _gradebook_values(db.get(Settings, 1), destination_id)
        target_type = "high_school" if existing_values.get("gradebook_type") == "high_school" else "college"
        cross_type = not destination_is_new and source_type != target_type
        class_destinations = entry.get("class_destinations") if isinstance(entry.get("class_destinations"), dict) else {}
        if cross_type:
            for period in source.get("periods", []):
                for term in period.get("terms", []) if isinstance(period, dict) else []:
                    for course_data in term.get("classes", []) if isinstance(term, dict) else []:
                        course_key = str(course_data.get("key") or "") if isinstance(course_data, dict) else ""
                        target_term_id = str(class_destinations.get(course_key) or "")
                        is_target_period = target_term_id.startswith("period:") and target_term_id.removeprefix("period:").isdigit() and db.query(AcademicYear).filter(
                            AcademicYear.id == int(target_term_id.removeprefix("period:")),
                            AcademicYear.gradebook_id == destination_id,
                        ).first() is not None
                        if not is_target_period and (not target_term_id.isdigit() or db.query(Semester).filter(
                            Semester.id == int(target_term_id),
                            Semester.gradebook_id == destination_id,
                        ).first() is None):
                            raise ValueError("Each class converted between gradebook types needs a destination term")
        _persist_settings(db, destination_id, source.get("settings", {}), destination_is_new or entry.get("apply_settings") is True)

        profile_map: dict[str, int] = {}
        for profile_data in source.get("scale_profiles", []):
            if not isinstance(profile_data, dict):
                continue
            profile = ScaleProfile(
                gradebook_id=destination_id,
                name=str(profile_data.get("name") or "Imported scale")[:64],
                sort_order=db.query(ScaleProfile).filter(ScaleProfile.gradebook_id == destination_id).count(),
                is_primary=profile_data.get("is_primary") is True and destination_is_new,
                preset_id=profile_data.get("preset_id") or None,
                pass_label=str(profile_data.get("pass_label") or "S")[:8],
                fail_label=str(profile_data.get("fail_label") or "U")[:8],
                pass_min_percent=float(profile_data.get("pass_min_percent") or 70),
                pass_fail_rows_json=json.dumps(profile_data.get("pass_fail_rows") if isinstance(profile_data.get("pass_fail_rows"), list) else []),
                minimum_passing_letter=str(profile_data.get("minimum_passing_letter") or "C-")[:8],
            )
            db.add(profile)
            db.flush()
            for row in profile_data.get("rows", []):
                if isinstance(row, dict):
                    db.add(ScaleProfileRow(
                        profile_id=profile.id,
                        letter=str(row.get("letter") or "")[:8],
                        min_percent=float(row.get("min_percent") or 0),
                        quality_points=float(row.get("quality_points") or 0),
                    ))
            profile_map[str(profile_data.get("key") or "")] = profile.id

        terms, periods = _term_map(source)
        term_destinations = entry.get("term_destinations") if isinstance(entry.get("term_destinations"), dict) else {}
        period_destinations = entry.get("period_destinations") if isinstance(entry.get("period_destinations"), dict) else {}
        explicit_term_destinations = entry.get("explicit_term_destinations") if isinstance(entry.get("explicit_term_destinations"), dict) else {}
        imported_term_ids: dict[str, int] = {}
        created_term_ids: set[int] = set()

        def has_explicit_class_destinations(term: dict) -> bool:
            classes = [item for item in term.get("classes", []) if isinstance(item, dict)]
            return bool(classes) and all(
                str(item.get("key") or "") in class_destinations
                for item in classes
            )

        def has_some_explicit_class_destinations(term: dict) -> bool:
            return any(
                str(item.get("key") or "") in class_destinations
                for item in term.get("classes", [])
                if isinstance(item, dict)
            )

        def is_explicitly_placed_term(term_key: str) -> bool:
            # A term mapping means the user placed the whole term, even when
            # its destination happens to be a newly-created term. Class-only
            # placement intentionally leaves this map empty.
            return term_key in term_destinations or term_key in explicit_term_destinations

        if not cross_type:
            for term_key, term in terms.items():
                # A term whose exported classes have all been placed explicitly
                # must be created by the placement logic below. Creating its
                # default term here would leave an empty duplicate behind when
                # importing a class into an existing academic period.
                if has_explicit_class_destinations(term):
                    continue
                # When only some classes from a source term were placed, do
                # not create a default destination term for the unplaced
                # classes. The selected classes will create or use their
                # explicit destination in the course loop below.
                if has_some_explicit_class_destinations(term) and not is_explicitly_placed_term(term_key):
                    continue
                chosen = str(term_destinations.get(term_key) or "new")
                if chosen != "new" and chosen.isdigit():
                    existing = db.query(Semester).filter(Semester.id == int(chosen), Semester.gradebook_id == destination_id).first()
                    if existing is not None:
                        imported_term_ids[term_key] = existing.id
                        continue
                year = int(term.get("year") or datetime.now().year)
                semester = Semester(
                    gradebook_id=destination_id,
                    year=year,
                    season=_unique_season(db, destination_id, year, str(term.get("season") or "term")),
                    included=term.get("included") is not False,
                    progression_locked=False,
                )
                db.add(semester)
                db.flush()
                imported_term_ids[term_key] = semester.id
                created_term_ids.add(semester.id)

        if source_type == "high_school" and not cross_type:
            for period_key, period in periods.items():
                period_term_ids = [imported_term_ids[str(item.get("key"))] for item in period.get("terms", []) if isinstance(item, dict) and str(item.get("key")) in imported_term_ids]
                new_ids = [item for item in period_term_ids if item in created_term_ids]
                if not new_ids:
                    continue
                selected = str(period_destinations.get(period_key) or "new")
                target_record = None
                if selected != "new" and selected.isdigit():
                    target_record = db.query(AcademicYear).filter(AcademicYear.id == int(selected), AcademicYear.gradebook_id == destination_id).first()
                if target_record is not None:
                    existing_ids = [int(item) for item in _json(target_record.semester_ids_json, []) if str(item).isdigit()]
                    target_record.semester_ids_json = json.dumps(list(dict.fromkeys([*existing_ids, *new_ids])))
                else:
                    db.add(AcademicYear(
                        gradebook_id=destination_id,
                        name=str(period.get("name") or "Academic period")[:64],
                        semester_ids_json=json.dumps(new_ids),
                    ))

        conflict_strategy = "skip" if entry.get("conflict_strategy") == "skip" else "copy"
        imported_courses = 0
        skipped_courses = 0
        period_term_cache: dict[tuple[str, str], int] = {}
        for term_key, term in terms.items():
            default_semester_id = imported_term_ids.get(term_key)
            class_only_placement = has_some_explicit_class_destinations(term) and not is_explicitly_placed_term(term_key)
            for course_data in term.get("classes", []):
                if not isinstance(course_data, dict):
                    continue
                course_key = str(course_data.get("key") or "")
                chosen_destination = str(class_destinations.get(course_key) or "")
                if class_only_placement and not chosen_destination:
                    continue
                semester_id = default_semester_id
                if chosen_destination.startswith("period:"):
                    period_id = chosen_destination.removeprefix("period:")
                    target_period = db.query(AcademicYear).filter(
                        AcademicYear.id == int(period_id) if period_id.isdigit() else -1,
                        AcademicYear.gradebook_id == destination_id,
                    ).first()
                    if target_period is not None:
                        cache_key = (period_id, term_key)
                        semester_id = period_term_cache.get(cache_key)
                        if semester_id is None:
                            semester = Semester(
                                gradebook_id=destination_id,
                                year=int(term.get("year") or datetime.now().year),
                                season=_unique_season(db, destination_id, int(term.get("year") or datetime.now().year), str(term.get("season") or "import")),
                                included=term.get("included") is not False,
                                progression_locked=False,
                            )
                            db.add(semester)
                            db.flush()
                            existing_ids = [int(item) for item in _json(target_period.semester_ids_json, []) if str(item).isdigit()]
                            target_period.semester_ids_json = json.dumps(list(dict.fromkeys([*existing_ids, semester.id])))
                            semester_id = semester.id
                            period_term_cache[cache_key] = semester_id
                elif chosen_destination.isdigit():
                    destination_term = db.query(Semester).filter(
                        Semester.id == int(chosen_destination),
                        Semester.gradebook_id == destination_id,
                    ).first()
                    if destination_term is not None:
                        semester_id = destination_term.id
                if semester_id is None:
                    if class_only_placement:
                        continue
                    raise ValueError("Each class converted between gradebook types needs a destination term")
                raw_code = str(course_data.get("code") or "Class").strip() or "Class"
                existing = db.query(Course).filter(Course.semester_id == semester_id, Course.code.ilike(raw_code)).first()
                if existing is not None and conflict_strategy == "skip":
                    skipped_courses += 1
                    continue
                code = raw_code if target_type == "high_school" else _unique_code(db, semester_id, raw_code)
                course = Course(
                    semester_id=semester_id,
                    code=code[:64],
                    credits=float(course_data.get("credits") or 0),
                    bonus_points=float(course_data.get("bonus_points") or 0),
                    bonus_mode=str(course_data.get("bonus_mode") or "static")[:16],
                    grade_rounding=course_data.get("grade_rounding") if isinstance(course_data.get("grade_rounding"), int) else None,
                    grading_mode=str(course_data.get("grading_mode") or "weighted")[:16],
                    credit_mode=str(course_data.get("credit_mode") or "for_credit")[:16],
                    gpa_weight_tag=str(course_data.get("gpa_weight_tag") or "unweighted")[:48],
                    pass_label=str(course_data.get("pass_label") or "S")[:8],
                    fail_label=str(course_data.get("fail_label") or "U")[:8],
                    pass_min_percent=float(course_data.get("pass_min_percent") or 70),
                    pass_fail_rows_json=json.dumps(course_data.get("pass_fail_rows") if isinstance(course_data.get("pass_fail_rows"), list) else []),
                    minimum_passing_letter=str(course_data.get("minimum_passing_letter") or "C-")[:8],
                    dynamic_weighting_enabled=course_data.get("dynamic_weighting_enabled") is True,
                    scale_profile_id=profile_map.get(str(course_data.get("scale_profile_key") or "")),
                )
                db.add(course)
                db.flush()
                category_map: dict[str, int] = {}
                for category_data in course_data.get("categories", []):
                    if not isinstance(category_data, dict):
                        continue
                    category = Category(
                        course_id=course.id,
                        name=str(category_data.get("name") or "Category")[:64],
                        weight=float(category_data.get("weight") or 0),
                        weight_per_item=category_data.get("weight_per_item"),
                        aggregation=str(category_data.get("aggregation") or "average")[:32],
                        drop_count=max(0, int(category_data.get("drop_count") or 0)),
                        replace_count=max(0, int(category_data.get("replace_count") or 1)),
                        include_bonus=category_data.get("include_bonus") is True,
                        is_bonus_category=category_data.get("is_bonus_category") is True,
                        sort_order=int(category_data.get("sort_order") or 0),
                    )
                    db.add(category)
                    db.flush()
                    category_map[str(category_data.get("key") or "")] = category.id
                for category_data in course_data.get("categories", []):
                    key = str(category_data.get("key") or "") if isinstance(category_data, dict) else ""
                    replacement = str(category_data.get("replace_with_key") or "") if isinstance(category_data, dict) else ""
                    if key in category_map and replacement in category_map:
                        db.get(Category, category_map[key]).replace_with_category_id = category_map[replacement]
                dynamic = course_data.get("dynamic_weighting") if isinstance(course_data.get("dynamic_weighting"), dict) else {}
                options = dynamic.get("options") if isinstance(dynamic, dict) else None
                if isinstance(options, list):
                    dynamic = {**dynamic, "options": [
                        {**option, "weights": {str(category_map.get(str(key), key)): value for key, value in (option.get("weights") or {}).items()}}
                        for option in options if isinstance(option, dict)
                    ]}
                course.dynamic_weighting_json = json.dumps(dynamic)
                test_ids = [category_map[key] for key in course_data.get("test_category_keys", []) if key in category_map]
                course.test_category_ids_json = json.dumps(test_ids)
                exam_key = str(course_data.get("exam_category_key") or "")
                course.exam_category_id = category_map.get(exam_key)
                for row in course_data.get("scale", []):
                    if isinstance(row, dict):
                        db.add(GradeScale(
                            course_id=course.id,
                            letter=str(row.get("letter") or "")[:8],
                            min_percent=float(row.get("min_percent") or 0),
                            quality_points=float(row.get("quality_points") or 0),
                        ))
                imported_courses += 1
        results.append({
            "id": destination_id,
            "name": destination_name,
            "created": destination_is_new,
            "semester_ids": list(imported_term_ids.values()),
            "imported_courses": imported_courses,
            "skipped_courses": skipped_courses,
            "appearance": source.get("appearance") if destination_is_new and isinstance(source.get("appearance"), dict) else {},
        })
    db.commit()
    return {"gradebooks": results}
