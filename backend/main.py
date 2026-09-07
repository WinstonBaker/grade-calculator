from __future__ import annotations

import json

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.exc import IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.database import active_gradebook_id, get_db, initialize_database, reset_gradebook_id, set_gradebook_id
from backend.paths import current_platform, frozen, frontend_dist, github_repo
from backend.updates import (
    acknowledge_update_status,
    apply_update,
    check_for_updates,
    dismiss_update,
    set_update_notifications_disabled,
    schedule_uninstall,
    schedule_app_exit,
)
from backend.version import MACOS_ASSET, WINDOWS_ASSET, __version__
from backend.gradebook_transfer import (
    export_gradebook_setups,
    gradebook_setup_inventory,
    import_gradebook_setups,
)
from backend.engine import (
    AGGREGATION_LABELS,
    AGGREGATIONS,
    SEASON_LABELS,
    SEASON_ORDER,
    normalize_scale,
    PRESET_MINIMUM_PASSING,
    PRESET_PASS_FAIL,
    SCALE_PRESETS,
    preset_payload,
    resolve_category_policy,
    scale_as_dicts,
)
from backend.models import AcademicYear, Assignment, Category, Course, Fumble, GradeSnapshot, ScaleProfile, Semester, Settings
from backend.schemas import (
    AssignmentCreate,
    AssignmentUpdate,
    AcademicYearCreate,
    AcademicYearUpdate,
    CategoryCreate,
    CategoryOrderUpdate,
    CategoryUpdate,
    CourseCreate,
    CourseUpdate,
    FumbleCreate,
    FumbleUpdate,
    ScaleApply,
    ScaleProfileCreate,
    ScaleProfileUpdate,
    ScaleUpdate,
    SemesterCreate,
    SemesterUpdate,
    SettingsUpdate,
    SnapshotDelete,
    SnapshotUpdate,
    UpdateDismiss,
)


from backend.service import (
    apply_dynamic_weighting,
    apply_score_fields,
    assignment_score_fields,
    build_gpa,
    composite_score_fields,
    coerce_target_letter,
    course_pass_fail,
    copy_default_scale,
    create_scale_profile,
    delete_course_grade_points,
    delete_grade_snapshots,
    delete_scale_profile,
    detach_courses_from_profile,
    dump_dynamic_weighting,
    grade_prompt_status,
    gradebook_academic_year,
    gradebook_academic_years,
    gradebook_scale_profile,
    gradebook_semester,
    gradebook_semesters,
    gpa_weight_tags,
    high_school_term_units,
    update_high_school_overall_settings,
    list_grade_snapshots,
    list_scale_profiles,
    lock_older_unlocked_semesters,
    NoGradesToRecordError,
    normalize_composite,
    normalize_pass_fail,
    parse_default_scale,
    parse_dynamic_weighting,
    ProgressionLockedError,
    patch_grade_snapshot,
    record_all_grade_snapshots,
    record_grade_snapshot,
    refresh_course,
    replace_course_scale,
    replace_profile_rows,
    seed_dynamic_option_from_course,
    seed_if_needed,
    serialize_course,
    serialize_scale_profile,
    serialize_semester,
    set_course_test_category_ids,
    set_primary_profile,
    snapshot_term_gpa,
    snooze_grade_prompt,
    sort_courses,
    sort_semesters,
    sync_dynamic_weighting_categories,
    sync_primary_scale_json,
    target_gp_from_settings,
    settings_for_gradebook,
    update_gradebook_settings,
    update_primary_scale,
    remove_test_category,
)

initialize_database()

app = FastAPI(title="Grade Calculator")
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def capture_gradebook_context(request: Request, call_next):
    token = set_gradebook_id(request.query_params.get("gradebook_id"))
    try:
        return await call_next(request)
    finally:
        reset_gradebook_id(token)


def _settings(db: Session) -> Settings:
    seed_if_needed(db)
    return settings_for_gradebook(db)


def _target(db: Session) -> float:
    _, gp = target_gp_from_settings(_settings(db), db)
    return gp


def _gpa_cap(db: Session) -> float | None:
    return _settings(db).gpa_cap


DEFAULT_APP_GRADEBOOKS = [{"id": "gradebook-1", "name": "Gradebook 1"}]


def _json_value(raw, fallback):
    try:
        value = json.loads(raw or "")
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback
    return value


def _app_state_payload(settings: Settings) -> dict:
    gradebooks = _json_value(settings.gradebooks_json, DEFAULT_APP_GRADEBOOKS)
    if not isinstance(gradebooks, list):
        gradebooks = DEFAULT_APP_GRADEBOOKS
    normalized_gradebooks = []
    seen = set()
    for item in gradebooks:
        if not isinstance(item, dict):
            continue
        gradebook_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        if not gradebook_id or not name or gradebook_id in seen:
            continue
        seen.add(gradebook_id)
        normalized_gradebooks.append({"id": gradebook_id, "name": name})
    if not normalized_gradebooks:
        normalized_gradebooks = [dict(DEFAULT_APP_GRADEBOOKS[0])]

    members = _json_value(settings.gradebook_members_json, {})
    if not isinstance(members, dict):
        members = {}
    normalized_members = {
        gradebook_id: [str(value) for value in values if str(value).strip()]
        for gradebook_id, values in members.items()
        if gradebook_id in seen and isinstance(values, list)
    }

    appearances = _json_value(settings.gradebook_appearance_json, {})
    if not isinstance(appearances, dict):
        appearances = {}
    normalized_appearances = {
        gradebook_id: value
        for gradebook_id, value in appearances.items()
        if gradebook_id in seen and isinstance(value, dict)
    }
    return {
        "gradebooks": normalized_gradebooks,
        "gradebook_members": normalized_members,
        "gradebook_appearance": normalized_appearances,
        "min_credits": str(settings.min_credits or "1"),
    }


def _normalize_app_state(body: dict) -> dict:
    gradebooks = body.get("gradebooks")
    if not isinstance(gradebooks, list):
        raise HTTPException(400, "Gradebooks must be a list")
    normalized_gradebooks = []
    seen = set()
    for item in gradebooks:
        if not isinstance(item, dict):
            continue
        gradebook_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        if not gradebook_id or not name or gradebook_id in seen:
            continue
        seen.add(gradebook_id)
        normalized_gradebooks.append({"id": gradebook_id, "name": name})
    if not normalized_gradebooks:
        raise HTTPException(400, "Keep at least one gradebook")

    members = body.get("gradebook_members")
    if not isinstance(members, dict):
        members = {}
    normalized_members = {
        gradebook_id: [str(value) for value in values if str(value).strip()]
        for gradebook_id, values in members.items()
        if gradebook_id in seen and isinstance(values, list)
    }

    appearances = body.get("gradebook_appearance")
    if not isinstance(appearances, dict):
        appearances = {}
    normalized_appearances = {
        gradebook_id: value
        for gradebook_id, value in appearances.items()
        if gradebook_id in seen and isinstance(value, dict)
    }
    min_credits = str(body.get("min_credits") or "1").strip()
    try:
        if float(min_credits) < 0:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(400, "Minimum credits must be a non-negative number")
    return {
        "gradebooks": normalized_gradebooks,
        "gradebook_members": normalized_members,
        "gradebook_appearance": normalized_appearances,
        "min_credits": min_credits,
    }


def _owned_category_id(course: Course, category_id: int | None) -> int | None:
    if category_id == -1:
        return -1
    if category_id is None:
        return None
    if not any(cat.id == category_id for cat in course.categories):
        raise HTTPException(400, "Category does not belong to this class")
    return category_id


def _high_school_period_key(semester: Semester | None) -> int | None:
    if semester is None:
        return None
    year = int(semester.year)
    return year - 1 if str(semester.season).lower() in {"spring", "summer"} else year


def _course_or_404(db: Session, course_id: int) -> Course:
    course = (
        db.query(Course)
        .join(Semester, Course.semester_id == Semester.id)
        .options(
            joinedload(Course.categories).joinedload(Category.assignments),
            joinedload(Course.scale_rows),
        )
        .filter(Course.id == course_id, Semester.gradebook_id == active_gradebook_id())
        .first()
    )
    if course is None:
        raise HTTPException(404, "Course not found")
    return course


def _semester_or_404(db: Session, semester_id: int) -> Semester:
    semester = gradebook_semester(db, semester_id)
    if semester is None:
        raise HTTPException(404, "Semester not found")
    return semester


def _academic_year_or_404(db: Session, academic_year_id: int) -> AcademicYear:
    academic_year = gradebook_academic_year(db, academic_year_id)
    if academic_year is None:
        raise HTTPException(404, "Academic year not found")
    return academic_year


def _category_or_404(db: Session, category_id: int) -> Category:
    category = (
        db.query(Category)
        .join(Course, Category.course_id == Course.id)
        .join(Semester, Course.semester_id == Semester.id)
        .filter(Category.id == category_id, Semester.gradebook_id == active_gradebook_id())
        .first()
    )
    if category is None:
        raise HTTPException(404, "Category not found")
    return category


def _assignment_or_404(db: Session, assignment_id: int) -> Assignment:
    assignment = (
        db.query(Assignment)
        .join(Category, Assignment.category_id == Category.id)
        .join(Course, Category.course_id == Course.id)
        .join(Semester, Course.semester_id == Semester.id)
        .filter(Assignment.id == assignment_id, Semester.gradebook_id == active_gradebook_id())
        .first()
    )
    if assignment is None:
        raise HTTPException(404, "Assignment not found")
    return assignment


def _fumble_or_404(db: Session, fumble_id: int) -> Fumble:
    row = (
        db.query(Fumble)
        .join(Course, Fumble.course_id == Course.id)
        .join(Semester, Course.semester_id == Semester.id)
        .filter(Fumble.id == fumble_id, Semester.gradebook_id == active_gradebook_id())
        .first()
    )
    if row is None:
        raise HTTPException(404, "Fumble not found")
    return row


def _course_payload(db: Session, course_id: int) -> dict:
    settings = _settings(db)
    course = _course_or_404(db, course_id)
    score_units = (
        high_school_term_units(db).get(course.semester_id)
        if settings.gradebook_type == "high_school"
        else (1.0 if (settings.gpa_basis or "credits").strip().lower() == "classes" else None)
    )
    payload = refresh_course(
        db, course, _target(db), settings.fail_pass_fail_affects_gpa,
        settings.gradebook_type, gpa_weight_tags(settings), score_units,
    )
    payload["gradebook_type"] = settings.gradebook_type or "college"
    payload["gpa_basis"] = settings.gpa_basis or "credits"
    payload["gpa_weight_tags"] = gpa_weight_tags(settings)
    payload["display_code"] = _display_code_map(db).get(course_id, payload["code"])
    return payload


def _display_code_map(db: Session) -> dict[int, str]:
    """Return chronological duplicate labels without changing editable course codes."""
    semesters = sort_semesters(gradebook_semesters(db))
    courses = [course for semester in semesters for course in semester.courses]
    totals: dict[str, int] = {}
    for course in courses:
        key = str(course.code or "").strip().lower()
        totals[key] = totals.get(key, 0) + 1
    seen: dict[str, int] = {}
    labels: dict[int, str] = {}
    for course in courses:
        key = str(course.code or "").strip().lower()
        seen[key] = seen.get(key, 0) + 1
        labels[course.id] = f"{course.code} ({seen[key]})" if totals[key] > 1 else course.code
    return labels


def _add_display_codes(payload: list[dict], display_codes: dict[int, str]) -> list[dict]:
    for course in payload:
        course["display_code"] = display_codes.get(course["id"], course["code"])
    return payload


def _apply_dynamic_for_courses(db: Session, courses: list[Course]) -> None:
    changed = False
    for course in courses:
        if apply_dynamic_weighting(course):
            changed = True
    if changed:
        db.commit()


@app.get("/api/meta")
def meta(db: Session = Depends(get_db)):
    repo = github_repo()
    settings = _settings(db)
    return {
        "aggregations": list(AGGREGATIONS),
        "aggregation_labels": dict(AGGREGATION_LABELS),
        "seasons": list(SEASON_ORDER),
        "season_labels": dict(SEASON_LABELS),
        "default_scale": scale_as_dicts(parse_default_scale(settings, db)),
        "scale_profiles": [serialize_scale_profile(profile) for profile in list_scale_profiles(db)],
        "scale_presets": preset_payload(),
        "sorts": ["code", "percent", "letter", "gpa", "credits", "score"],
        "version": __version__,
        "frozen": frozen(),
        "platform": current_platform(),
        "github_repo": repo,
        "release_url": f"https://github.com/{repo}/releases/latest",
        "downloads": {
            "windows": f"https://github.com/{repo}/releases/latest/download/{WINDOWS_ASSET}",
            "macos": f"https://github.com/{repo}/releases/latest/download/{MACOS_ASSET}",
        },
    }


@app.post("/api/gradebook-setups/inventory")
def get_gradebook_setup_inventory(body: dict, db: Session = Depends(get_db)):
    """Return all registered gradebooks as a lightweight export tree."""
    gradebooks = body.get("gradebooks") if isinstance(body, dict) else None
    if not isinstance(gradebooks, list):
        raise HTTPException(400, "Provide the gradebooks to include")
    return gradebook_setup_inventory(db, gradebooks)


@app.post("/api/gradebook-setups/export")
def export_setups(body: dict, db: Session = Depends(get_db)):
    selections = body.get("gradebooks") if isinstance(body, dict) else None
    if not isinstance(selections, list):
        raise HTTPException(400, "Choose one or more gradebooks to export")
    include_entered_assignments = body.get("include_entered_assignments") is True if isinstance(body, dict) else False
    return export_gradebook_setups(db, selections, include_entered_assignments)


@app.post("/api/gradebook-setups/import")
def import_setups(body: dict, db: Session = Depends(get_db)):
    payload = body.get("payload") if isinstance(body, dict) else None
    plan = body.get("plan") if isinstance(body, dict) else None
    if not isinstance(payload, dict) or not isinstance(plan, list):
        raise HTTPException(400, "Choose a setup file and placement plan")
    try:
        return import_gradebook_setups(db, payload, plan)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/updates")
def get_updates():
    try:
        return check_for_updates()
    except Exception as exc:
        raise HTTPException(503, str(exc)) from exc


def _apply_update_response(background: BackgroundTasks):
    try:
        result = apply_update()
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    if result.get("restarting"):
        background.add_task(schedule_app_exit)
    return result


@app.post("/api/updates/dismiss")
def post_update_dismiss(body: UpdateDismiss):
    try:
        return dismiss_update(body.version)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/updates/notifications")
def post_update_notifications(body: dict):
    return set_update_notifications_disabled(bool(body.get("disabled")))


@app.post("/api/uninstall")
def post_uninstall(body: dict):
    if body.get("confirmed") is not True:
        raise HTTPException(400, "Uninstall confirmation is required")
    return schedule_uninstall()


@app.post("/api/updates/status/ack")
def post_update_status_ack():
    return acknowledge_update_status()


@app.post("/api/updates/apply")
def post_update_apply(background: BackgroundTasks):
    return _apply_update_response(background)


@app.post("/api/updates/download")
def post_update_download(background: BackgroundTasks):
    return _apply_update_response(background)


@app.get("/api/semesters")
def list_semesters(db: Session = Depends(get_db)):
    target = _target(db)
    settings = _settings(db)
    semesters = sort_semesters(gradebook_semesters(db))
    _apply_dynamic_for_courses(db, [c for s in semesters for c in s.courses])
    display_codes = _display_code_map(db)
    score_units = (
        high_school_term_units(db)
        if settings.gradebook_type == "high_school"
        else ({s.id: 1.0 for s in semesters} if (settings.gpa_basis or "credits").strip().lower() == "classes" else {})
    )
    payload = [serialize_semester(s, target, settings.gpa_cap, settings.fail_pass_fail_affects_gpa, settings.gradebook_type, gpa_weight_tags(settings), settings.gpa_basis or "credits", score_units.get(s.id)) for s in semesters]
    for semester in payload:
        _add_display_codes(semester["courses"], display_codes)
    return payload


def _academic_year_payload(row: AcademicYear) -> dict:
    try:
        semester_ids = [int(value) for value in json.loads(row.semester_ids_json or "[]")]
    except (TypeError, ValueError, json.JSONDecodeError):
        semester_ids = []
    return {"id": row.id, "name": row.name, "semester_ids": semester_ids}


@app.get("/api/academic-years")
def list_academic_years(db: Session = Depends(get_db)):
    return [_academic_year_payload(row) for row in gradebook_academic_years(db)]


@app.post("/api/academic-years")
def create_academic_year(body: AcademicYearCreate, db: Session = Depends(get_db)):
    name = body.name.strip()
    if db.query(AcademicYear).filter(
        AcademicYear.gradebook_id == active_gradebook_id(),
        func.lower(AcademicYear.name) == name.lower(),
    ).first():
        raise HTTPException(409, "Academic period names must be unique")
    semester_ids = list(dict.fromkeys(body.semester_ids))
    if db.query(Semester).filter(
        Semester.id.in_(semester_ids),
        Semester.gradebook_id == active_gradebook_id(),
    ).count() != len(semester_ids):
        raise HTTPException(404, "One or more terms were not found")
    row = AcademicYear(
        gradebook_id=active_gradebook_id(),
        name=name,
        semester_ids_json=json.dumps(semester_ids),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _academic_year_payload(row)


@app.patch("/api/academic-years/{academic_year_id}")
def update_academic_year(academic_year_id: int, body: AcademicYearUpdate, db: Session = Depends(get_db)):
    row = _academic_year_or_404(db, academic_year_id)
    if body.name is not None:
        name = body.name.strip()
        if db.query(AcademicYear).filter(
            AcademicYear.id != row.id,
            AcademicYear.gradebook_id == active_gradebook_id(),
            func.lower(AcademicYear.name) == name.lower(),
        ).first():
            raise HTTPException(409, "Academic period names must be unique")
        row.name = name
    if body.semester_ids is not None:
        semester_ids = list(dict.fromkeys(body.semester_ids))
        if db.query(Semester).filter(
            Semester.id.in_(semester_ids),
            Semester.gradebook_id == active_gradebook_id(),
        ).count() != len(semester_ids):
            raise HTTPException(404, "One or more terms were not found")
        row.semester_ids_json = json.dumps(semester_ids)
    db.commit()
    return _academic_year_payload(row)


@app.delete("/api/academic-years/{academic_year_id}", status_code=204)
def delete_academic_year(academic_year_id: int, db: Session = Depends(get_db)):
    row = _academic_year_or_404(db, academic_year_id)
    db.delete(row)
    db.commit()


@app.post("/api/semesters")
def create_semester(body: SemesterCreate, db: Session = Depends(get_db)):
    season = body.season.strip().lower()
    if season in {"settings", "overall"}:
        raise HTTPException(409, "Term names cannot be Settings or Overall")
    dup = db.query(Semester).filter(
        Semester.gradebook_id == active_gradebook_id(),
        Semester.year == body.year,
        Semester.season == season,
    ).first()
    if dup:
        raise HTTPException(409, f"{body.year} {season.title()} already exists")
    sem = Semester(
        gradebook_id=active_gradebook_id(),
        year=body.year,
        season=season,
        included=body.included,
        progression_locked=False,
    )
    db.add(sem)
    db.flush()
    if body.lock_previous:
        lock_older_unlocked_semesters(db, sem)
    db.commit()
    db.refresh(sem)
    settings = _settings(db)
    score_units = (
        high_school_term_units(db)
        if settings.gradebook_type == "high_school"
        else ({sem.id: 1.0} if (settings.gpa_basis or "credits").strip().lower() == "classes" else {})
    )
    return serialize_semester(sem, _target(db), settings.gpa_cap, settings.fail_pass_fail_affects_gpa, settings.gradebook_type, gpa_weight_tags(settings), settings.gpa_basis or "credits", score_units.get(sem.id))


@app.patch("/api/semesters/{semester_id}")
def update_semester(semester_id: int, body: SemesterUpdate, db: Session = Depends(get_db)):
    sem = _semester_or_404(db, semester_id)
    if body.year is not None:
        sem.year = body.year
    if body.season is not None:
        season = body.season.strip().lower()
        if season in {"settings", "overall"}:
            raise HTTPException(409, "Term names cannot be Settings or Overall")
        sem.season = season
    if body.included is not None:
        sem.included = body.included
    locking = body.progression_locked is True and not sem.progression_locked
    if body.progression_locked is not None:
        sem.progression_locked = body.progression_locked
    clash = (
        db.query(Semester)
        .filter(
            Semester.gradebook_id == active_gradebook_id(),
            Semester.year == sem.year,
            Semester.season == sem.season,
            Semester.id != sem.id,
        )
        .first()
    )
    if clash:
        raise HTTPException(409, f"{sem.year} {sem.season.title()} already exists")
    settings = _settings(db)
    score_units = (
        high_school_term_units(db)
        if settings.gradebook_type == "high_school"
        else ({sem.id: 1.0} if (settings.gpa_basis or "credits").strip().lower() == "classes" else {})
    )
    payload = serialize_semester(sem, _target(db), settings.gpa_cap, settings.fail_pass_fail_affects_gpa, settings.gradebook_type, gpa_weight_tags(settings), settings.gpa_basis or "credits", score_units.get(sem.id))
    if locking:
        latest = (
            db.query(GradeSnapshot)
            .filter(GradeSnapshot.semester_id == sem.id)
            .order_by(GradeSnapshot.recorded_at.asc(), GradeSnapshot.id.asc())
            .all()
        )
        if latest:
            latest[-1].term_gpa = snapshot_term_gpa(
                payload,
                settings.gpa_cap,
                settings.gpa_basis or "credits",
                settings.gradebook_type or "college",
            )
            latest[-1].term_wgpa = snapshot_term_gpa(
                payload,
                settings.gpa_cap,
                settings.gpa_basis or "credits",
                settings.gradebook_type or "college",
                weighted=True,
            )
    db.commit()
    return payload


@app.delete("/api/semesters/{semester_id}")
def delete_semester(semester_id: int, db: Session = Depends(get_db)):
    sem = _semester_or_404(db, semester_id)
    db.delete(sem)
    db.commit()
    return {"ok": True}


@app.delete("/api/gradebook-data")
def delete_gradebook_data(db: Session = Depends(get_db)):
    """Delete only the data owned by the active gradebook."""
    active_id = active_gradebook_id()
    semesters = gradebook_semesters(db)
    semester_ids = {semester.id for semester in semesters}

    for profile in list_scale_profiles(db):
        for course in (
            db.query(Course)
            .filter(Course.scale_profile_id == profile.id, Course.semester_id.in_(semester_ids or {-1}))
            .all()
        ):
            course.scale_profile_id = None
        db.delete(profile)
    for academic_year in gradebook_academic_years(db):
        db.delete(academic_year)
    for semester in semesters:
        db.delete(semester)

    settings = db.get(Settings, 1)
    if settings is not None:
        try:
            scoped = json.loads(settings.gradebook_settings_json or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            scoped = {}
        if isinstance(scoped, dict):
            scoped.pop(active_id, None)
            settings.gradebook_settings_json = json.dumps(scoped)
    db.commit()
    return {"ok": True}


@app.get("/api/courses")
def list_courses(
    semester_id: int | None = None,
    q: str | None = None,
    sort: str = "code",
    desc: bool = False,
    db: Session = Depends(get_db),
):
    target = _target(db)
    query = db.query(Course).join(Semester, Course.semester_id == Semester.id).filter(Semester.gradebook_id == active_gradebook_id())
    if semester_id is not None:
        query = query.filter(Course.semester_id == semester_id)
    courses = query.all()
    _apply_dynamic_for_courses(db, courses)
    settings = _settings(db)
    score_units = (
        high_school_term_units(db)
        if settings.gradebook_type == "high_school"
        else ({c.semester_id: 1.0 for c in courses} if (settings.gpa_basis or "credits").strip().lower() == "classes" else {})
    )
    payload = _add_display_codes([serialize_course(c, target, settings.fail_pass_fail_affects_gpa, settings.gradebook_type, gpa_weight_tags(settings), score_units.get(c.semester_id)) for c in courses], _display_code_map(db))
    if q:
        needle = q.lower()
        payload = [c for c in payload if needle in (c["code"] or "").lower()]
    payload = sort_courses(payload, sort, desc)
    return payload


@app.post("/api/courses")
def create_course(body: CourseCreate, db: Session = Depends(get_db)):
    _semester_or_404(db, body.semester_id)
    settings = _settings(db)
    if body.credit_mode not in {"for_credit", "pass_fail"}:
        raise HTTPException(400, "credit_mode must be for_credit or pass_fail")
    normalized_code = body.code.strip().lower()
    if settings.gradebook_type != "high_school":
        duplicate = (
            db.query(Course)
            .filter(Course.semester_id == body.semester_id, Course.code.ilike(normalized_code))
            .first()
        )
        if duplicate is not None:
            raise HTTPException(409, "A class with this code already exists in the selected semester")
    course = Course(
        semester_id=body.semester_id,
        code=body.code.strip(),
        credits=body.credits,
        bonus_points=body.bonus_points,
        bonus_mode=body.bonus_mode if body.bonus_mode in {"static", "static_points", "static_percent", "category", "none"} else "none",
        gp_override=body.gp_override,
        final_gp_override=body.final_gp_override,
        grade_rounding=body.grade_rounding,
        credit_mode=body.credit_mode,
        gpa_weight_tag=(body.gpa_weight_tag or "unweighted").strip() or "unweighted",
    )
    db.add(course)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "A class with this code already exists in the selected semester") from exc
    db.refresh(course)
    copy_default_scale(db, course)
    db.commit()
    return _course_payload(db, course.id)


@app.get("/api/courses/{course_id}")
def get_course(course_id: int, db: Session = Depends(get_db)):
    return _course_payload(db, course_id)


@app.patch("/api/courses/{course_id}")
def update_course(course_id: int, body: CourseUpdate, db: Session = Depends(get_db)):
    course = _course_or_404(db, course_id)
    settings = _settings(db)
    next_semester_id = body.semester_id if body.semester_id is not None else course.semester_id
    next_code = body.code.strip() if body.code is not None else course.code
    renamed_courses = [course]
    if body.code is not None:
        original_code = str(course.code or "").strip().lower()
        if original_code:
            renamed_courses = (
                db.query(Course)
                .join(Semester, Course.semester_id == Semester.id)
                .filter(
                    Semester.gradebook_id == active_gradebook_id(),
                    func.lower(Course.code) == original_code,
                )
                .all()
            )
            if course not in renamed_courses:
                renamed_courses.append(course)
    if settings.gradebook_type != "high_school":
        renamed_ids = {item.id for item in renamed_courses}
        for item in renamed_courses:
            semester_id = next_semester_id if item.id == course.id else item.semester_id
            duplicate = (
                db.query(Course)
                .filter(
                    Course.semester_id == semester_id,
                    Course.code.ilike(next_code),
                    ~Course.id.in_(renamed_ids),
                )
                .first()
            )
            if duplicate is not None:
                raise HTTPException(409, "A class with this code already exists in the selected semester")
    if body.semester_id is not None:
        target_semester = _semester_or_404(db, body.semester_id)
        if target_semester.gradebook_id != course.semester.gradebook_id:
            raise HTTPException(400, "A class cannot be moved between gradebooks")
        course.semester_id = body.semester_id
    if body.code is not None:
        for renamed_course in renamed_courses:
            renamed_course.code = next_code
    if body.credits is not None:
        course.credits = body.credits
    if body.credit_mode is not None:
        mode = body.credit_mode.strip().lower()
        if mode not in {"for_credit", "pass_fail"}:
            raise HTTPException(400, "credit_mode must be for_credit or pass_fail")
        course.credit_mode = mode
    if body.gpa_weight_tag is not None:
        course.gpa_weight_tag = body.gpa_weight_tag.strip() or "unweighted"
        if settings.gradebook_type == "high_school":
            selected_semester = gradebook_semester(db, next_semester_id)
            period_key = _high_school_period_key(selected_semester)
            normalized_code = course.code.strip().lower()
            if period_key is not None and normalized_code:
                related_courses = (
                    db.query(Course)
                    .join(Semester, Course.semester_id == Semester.id)
                    .filter(
                        func.lower(Course.code) == normalized_code,
                        Semester.gradebook_id == active_gradebook_id(),
                    )
                    .all()
                )
                for related in related_courses:
                    if _high_school_period_key(related.semester) == period_key:
                        related.gpa_weight_tag = course.gpa_weight_tag
    if "pass_fail_override" in body.model_fields_set:
        value = (body.pass_fail_override or "").strip()
        allowed = {row["label"] for row in course_pass_fail(course)["rows"]}
        if value and value not in allowed:
            raise HTTPException(400, "pass_fail_override must be one of the configured labels")
        course.pass_fail_override = value or None
    if body.bonus_points is not None:
        course.bonus_points = body.bonus_points
    if body.bonus_mode is not None:
        mode = body.bonus_mode.strip().lower()
        if mode not in {"static", "static_points", "static_percent", "category", "none"}:
            raise HTTPException(400, "bonus_mode must be static, static_points, static_percent, category, or none")
        course.bonus_mode = mode
    if "gp_override" in body.model_fields_set:
        course.gp_override = body.gp_override
    if "final_gp_override" in body.model_fields_set:
        course.final_gp_override = body.final_gp_override
    if "grade_rounding" in body.model_fields_set:
        course.grade_rounding = body.grade_rounding
    if "test_category_ids" in body.model_fields_set:
        owned = [_owned_category_id(course, tid) for tid in (body.test_category_ids or [])]
        set_course_test_category_ids(course, [tid for tid in owned if tid is not None])
    if "exam_category_id" in body.model_fields_set:
        course.exam_category_id = _owned_category_id(course, body.exam_category_id)
    if "grading_mode" in body.model_fields_set:
        previous_mode = course.grading_mode or "weighted"
        mode = (body.grading_mode or "weighted").strip().lower()
        if mode not in {"weighted", "points"}:
            raise HTTPException(400, "grading_mode must be weighted or points")
        if mode == "weighted" and (
            course.bonus_mode == "static_points"
            or any(
                category.is_bonus_category and category.aggregation == "points_ratio"
                for category in course.categories
            )
        ):
            course.bonus_mode = "none"
            course.bonus_points = 0
        if mode == "weighted":
            for category in course.categories:
                if not category.is_bonus_category and category.aggregation == "points_ratio":
                    category.aggregation = "average"
        course.grading_mode = mode
        if mode != previous_mode:
            for category in course.categories:
                for assignment in category.assignments:
                    raw = (assignment.score_text or "").strip()
                    if not raw and assignment.earned is not None:
                        raw = f"{assignment.earned:g}"
                    if not raw:
                        continue
                    if mode == "points":
                        raw = raw[1:].strip() if raw.startswith("=") else raw
                        if "/" not in raw and "," not in raw:
                            denominator = 0 if category.is_bonus_category and assignment.is_bonus else 100
                            raw = f"{raw}/{denominator}"
                    elif ("/" in raw or "," in raw) and not raw.startswith("="):
                        raw = f"={raw}"
                    assignment.score_text = raw
        if mode == "points":
            course.dynamic_weighting_enabled = False
    if "dynamic_weighting_enabled" in body.model_fields_set:
        course.dynamic_weighting_enabled = bool(body.dynamic_weighting_enabled)
        if (course.grading_mode or "weighted") == "points":
            course.dynamic_weighting_enabled = False
        if course.dynamic_weighting_enabled:
            payload = parse_dynamic_weighting(course)
            if not payload["options"]:
                course.dynamic_weighting_json = dump_dynamic_weighting(
                    {"options": [seed_dynamic_option_from_course(course)]}
                )
    if "dynamic_weighting" in body.model_fields_set:
        course.dynamic_weighting_json = dump_dynamic_weighting(body.dynamic_weighting)
        if course.dynamic_weighting_enabled:
            payload = parse_dynamic_weighting(course)
            if not payload["options"]:
                course.dynamic_weighting_json = dump_dynamic_weighting(
                    {"options": [seed_dynamic_option_from_course(course)]}
                )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "A class with this code already exists in the selected semester") from exc
    return _course_payload(db, course_id)


@app.delete("/api/courses/{course_id}")
def delete_course(course_id: int, db: Session = Depends(get_db)):
    course = _course_or_404(db, course_id)
    delete_course_grade_points(db, course.semester_id, course.id)
    db.delete(course)
    db.commit()
    return {"ok": True}


@app.put("/api/courses/{course_id}/scale")
def update_scale(course_id: int, body: ScaleUpdate, db: Session = Depends(get_db)):
    course = _course_or_404(db, course_id)
    try:
        rows = normalize_scale(body.rows)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    replace_course_scale(db, course, rows)
    if body.pass_fail is not None:
        pf = normalize_pass_fail(body.pass_fail)
        course.pass_label = pf["pass_label"]
        course.fail_label = pf["fail_label"]
        course.pass_min_percent = pf["min_percent"]
        course.pass_fail_rows_json = json.dumps(pf)
        if course.pass_fail_override not in {None, *[row["label"] for row in pf["rows"]]}:
            course.pass_fail_override = None
    if body.minimum_passing_letter is not None:
        value = body.minimum_passing_letter.strip()
        if value not in {row[0] for row in rows}:
            raise HTTPException(400, "minimum_passing_letter must be one of the grade scale letters")
        course.minimum_passing_letter = value
    course.scale_profile_id = None
    db.commit()
    return _course_payload(db, course_id)


@app.post("/api/courses/{course_id}/scale/default")
def reset_scale(course_id: int, body: ScaleApply | None = None, db: Session = Depends(get_db)):
    course = _course_or_404(db, course_id)
    profile_id = body.scale_profile_id if body else None
    preset_id = body.preset_id if body else None
    if preset_id is not None:
        preset = next((item for item in SCALE_PRESETS if item["id"] == preset_id), None)
        if preset is None:
            raise HTTPException(404, "Default scale not found")
        replace_course_scale(db, course, normalize_scale(preset["rows"]))
        pf = normalize_pass_fail(PRESET_PASS_FAIL.get(preset_id))
        course.pass_label = pf["pass_label"]
        course.fail_label = pf["fail_label"]
        course.pass_min_percent = pf["min_percent"]
        course.pass_fail_rows_json = json.dumps(pf)
        course.minimum_passing_letter = PRESET_MINIMUM_PASSING.get(preset_id, course.minimum_passing_letter)
        course.scale_profile_id = None
        db.commit()
        return _course_payload(db, course_id)
    if profile_id is not None and gradebook_scale_profile(db, profile_id) is None:
        raise HTTPException(404, "Default scale not found")
    copy_default_scale(db, course, profile_id)
    db.commit()
    return _course_payload(db, course_id)


@app.get("/api/scale-profiles")
def get_scale_profiles(db: Session = Depends(get_db)):
    _settings(db)
    return [serialize_scale_profile(profile) for profile in list_scale_profiles(db)]


@app.post("/api/scale-profiles")
def post_scale_profile(body: ScaleProfileCreate, db: Session = Depends(get_db)):
    _settings(db)
    rows = None
    if body.rows is not None:
        try:
            rows = normalize_scale(body.rows)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    profile = create_scale_profile(
        db,
        name=body.name,
        rows=rows,
        is_primary=body.is_primary,
        preset_id=body.preset_id,
        pass_fail=body.pass_fail.model_dump() if body.pass_fail is not None else None,
        minimum_passing_letter=body.minimum_passing_letter,
    )
    db.commit()
    db.refresh(profile)
    return serialize_scale_profile(profile)


@app.patch("/api/scale-profiles/{profile_id}")
def patch_scale_profile(profile_id: int, body: ScaleProfileUpdate, db: Session = Depends(get_db)):
    _settings(db)
    profile = gradebook_scale_profile(db, profile_id)
    if profile is None:
        raise HTTPException(404, "Default scale not found")
    if any(field in body.model_fields_set for field in ("rows", "pass_fail", "minimum_passing_letter")):
        detach_courses_from_profile(db, profile)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(400, "Name cannot be empty")
        profile.name = name
    if body.sort_order is not None:
        profile.sort_order = body.sort_order
    if body.rows is not None:
        try:
            rows = normalize_scale(body.rows)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        replace_profile_rows(db, profile, rows)
        if profile.is_primary:
            sync_primary_scale_json(db, profile)
    if body.pass_fail is not None:
        pf = normalize_pass_fail(body.pass_fail)
        profile.pass_label = pf["pass_label"]
        profile.fail_label = pf["fail_label"]
        profile.pass_min_percent = pf["min_percent"]
        profile.pass_fail_rows_json = json.dumps(pf)
    if body.minimum_passing_letter is not None:
        value = body.minimum_passing_letter.strip()
        if value not in {row.letter for row in profile.rows}:
            raise HTTPException(400, "minimum_passing_letter must be one of the grade scale letters")
        profile.minimum_passing_letter = value
    if "preset_id" in body.model_fields_set:
        profile.preset_id = body.preset_id or None
    if body.is_primary:
        set_primary_profile(db, profile)
    db.commit()
    db.refresh(profile)
    return serialize_scale_profile(profile)


@app.delete("/api/scale-profiles/{profile_id}")
def remove_scale_profile(profile_id: int, db: Session = Depends(get_db)):
    _settings(db)
    profile = gradebook_scale_profile(db, profile_id)
    if profile is None:
        raise HTTPException(404, "Default scale not found")
    try:
        delete_scale_profile(db, profile)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    return {"ok": True}


def _category_policy(*, aggregation, drop_count, include_bonus, replace_with_category_id):
    if aggregation not in AGGREGATIONS:
        raise HTTPException(400, f"Unknown aggregation {aggregation}")
    return resolve_category_policy(
        aggregation,
        drop_count,
        include_bonus,
        replace_with_category_id,
    )


@app.post("/api/categories")
def create_category(body: CategoryCreate, db: Session = Depends(get_db)):
    course = _course_or_404(db, body.course_id)
    policy = _category_policy(
        aggregation="points_ratio" if course.grading_mode == "points" else body.aggregation,
        drop_count=body.drop_count,
        include_bonus=body.include_bonus,
        replace_with_category_id=body.replace_with_category_id,
    )
    replace_count = max(int(body.replace_count or 0), 0)
    replace_with_category_id = policy.replace_with_category_id if replace_count > 0 else None
    order = len(course.categories)
    cat = Category(
        course_id=body.course_id,
        name=body.name,
        weight=body.weight,
        weight_per_item=body.weight_per_item,
        aggregation=policy.aggregation,
        drop_count=policy.drop_count,
        replace_count=replace_count,
        include_bonus=policy.include_bonus,
        is_bonus_category=body.is_bonus_category,
        replace_with_category_id=replace_with_category_id,
        sort_order=order,
    )
    db.add(cat)
    db.flush()
    if course.dynamic_weighting_enabled:
        sync_dynamic_weighting_categories(course)
        # Seed new category weight into options from the create payload.
        payload = parse_dynamic_weighting(course)
        for opt in payload["options"]:
            opt["weights"][str(cat.id)] = float(body.weight or 0.0)
        course.dynamic_weighting_json = dump_dynamic_weighting(payload)
    db.commit()
    return _course_payload(db, body.course_id)


@app.patch("/api/categories/{category_id}")
def update_category(category_id: int, body: CategoryUpdate, db: Session = Depends(get_db)):
    cat = _category_or_404(db, category_id)
    if body.name is not None:
        cat.name = body.name
    course = _course_or_404(db, cat.course_id)
    if not course.dynamic_weighting_enabled:
        if body.weight is not None:
            cat.weight = body.weight
        if "weight_per_item" in body.model_fields_set:
            cat.weight_per_item = body.weight_per_item
    aggregation = body.aggregation if body.aggregation is not None else cat.aggregation
    if course.grading_mode == "points" and not cat.is_bonus_category:
        aggregation = "points_ratio"
    drop_count = body.drop_count if body.drop_count is not None else cat.drop_count
    replace_count = body.replace_count if body.replace_count is not None else (cat.replace_count or 0)
    include_bonus = body.include_bonus if "include_bonus" in body.model_fields_set else bool(cat.include_bonus)
    is_bonus_category = (
        body.is_bonus_category
        if "is_bonus_category" in body.model_fields_set
        else bool(cat.is_bonus_category)
    )
    replace_with = (
        body.replace_with_category_id
        if "replace_with_category_id" in body.model_fields_set
        else cat.replace_with_category_id
    )
    previous_aggregation = cat.aggregation
    policy = _category_policy(
        aggregation=aggregation,
        drop_count=drop_count,
        include_bonus=include_bonus,
        replace_with_category_id=replace_with,
    )
    cat.aggregation = policy.aggregation
    if previous_aggregation != cat.aggregation:
        for assignment in cat.assignments:
            raw = (assignment.score_text or "").strip()
            if not raw and assignment.earned is not None:
                if assignment.possible not in (None, 100):
                    raw = f"{assignment.earned:g}/{assignment.possible:g}"
                else:
                    raw = f"{assignment.earned:g}"
            if not raw:
                continue
            if cat.aggregation == "average" and previous_aggregation == "points_ratio":
                if ("/" in raw or "," in raw) and not raw.startswith("="):
                    raw = f"={raw}"
            elif cat.aggregation == "points_ratio" and previous_aggregation != "points_ratio":
                if "/" not in raw and "," not in raw:
                    raw = f"{raw}/100"
            assignment.score_text = raw
    cat.drop_count = policy.drop_count
    cat.replace_count = max(int(replace_count or 0), 0)
    cat.include_bonus = policy.include_bonus
    cat.is_bonus_category = is_bonus_category
    cat.replace_with_category_id = policy.replace_with_category_id if cat.replace_count > 0 else None
    db.commit()
    return _course_payload(db, cat.course_id)


@app.put("/api/courses/{course_id}/categories/order")
def reorder_categories(course_id: int, body: CategoryOrderUpdate, db: Session = Depends(get_db)):
    course = _course_or_404(db, course_id)
    owned = {cat.id: cat for cat in course.categories}
    ids = body.category_ids
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "category_ids must be unique")
    if set(ids) != set(owned):
        raise HTTPException(400, "category_ids must include every category in this class")
    for index, cid in enumerate(ids):
        owned[cid].sort_order = index
    db.commit()
    return _course_payload(db, course_id)


@app.delete("/api/categories/{category_id}")
def delete_category(category_id: int, db: Session = Depends(get_db)):
    cat = _category_or_404(db, category_id)
    course_id = cat.course_id
    db.query(Category).filter(
        Category.replace_with_category_id == category_id,
        Category.course_id.in_(
            db.query(Course.id)
            .join(Semester, Course.semester_id == Semester.id)
            .filter(Semester.gradebook_id == active_gradebook_id())
        ),
    ).update({Category.replace_with_category_id: None}, synchronize_session=False)
    course = _course_or_404(db, course_id)
    if course is not None:
        remove_test_category(course, category_id)
        if course.exam_category_id == category_id:
            course.exam_category_id = None
    db.delete(cat)
    db.flush()
    if course is not None and course.dynamic_weighting_enabled:
        sync_dynamic_weighting_categories(course)
    db.commit()
    return _course_payload(db, course_id)


@app.post("/api/assignments")
def create_assignment(body: AssignmentCreate, db: Session = Depends(get_db)):
    cat = _category_or_404(db, body.category_id)
    if body.bonus_type not in {None, "assignment", "category"}:
        raise HTTPException(400, "Bonus type must be assignment or category")
    item = Assignment(
        category_id=body.category_id,
        name=body.name,
        comment=body.comment.strip() or None if body.comment else None,
        flag_ids_json=json.dumps([str(value) for value in (body.flag_ids or []) if value]),
        is_bonus=body.is_bonus,
        bonus_type=body.bonus_type if body.is_bonus else None,
        sort_order=len(cat.assignments),
    )
    try:
        apply_score_fields(
            item,
            body,
            body.is_bonus,
            require_ratio=not cat.is_bonus_category and cat.course.grading_mode == "points",
            allow_zero_denominator=bool(
                cat.course.grading_mode == "points"
                or (not cat.is_bonus_category and cat.aggregation == "points_ratio")
            ),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    db.add(item)
    db.commit()
    return _course_payload(db, cat.course_id)


@app.patch("/api/assignments/{assignment_id}")
def update_assignment(assignment_id: int, body: AssignmentUpdate, db: Session = Depends(get_db)):
    item = _assignment_or_404(db, assignment_id)
    if body.name is not None:
        item.name = body.name
    if "comment" in body.model_fields_set:
        item.comment = body.comment.strip() if body.comment and body.comment.strip() else None
    if "flag_ids" in body.model_fields_set:
        item.flag_ids_json = json.dumps([str(value) for value in (body.flag_ids or []) if value])
    if body.is_bonus is not None:
        item.is_bonus = body.is_bonus
        if not body.is_bonus:
            item.bonus_type = None
    if body.bonus_type is not None:
        if body.bonus_type not in {"assignment", "category"}:
            raise HTTPException(400, "Bonus type must be assignment or category")
        item.bonus_type = body.bonus_type
    category_aggregation = (
        "points_ratio"
        if item.category.course.grading_mode == "points" and not item.category.is_bonus_category
        else item.category.aggregation
    )
    try:
        if "composite" in body.model_fields_set and body.composite is not None:
            composite = normalize_composite(body.composite)
            fields = composite_score_fields(composite, category_aggregation)
            item.composite_json = json.dumps(composite, separators=(",", ":"))
            item.earned = fields["earned"]
            item.possible = fields["possible"]
            item.score_text = fields["score_text"]
        elif body.clear_composite:
            fields = assignment_score_fields(item, category_aggregation)
            item.composite_json = None
            item.earned = fields["earned"]
            item.possible = fields["possible"]
            item.score_text = fields["score_text"]
        else:
            apply_score_fields(
                item,
                body,
                item.is_bonus,
                require_ratio=(
                    not item.category.is_bonus_category and item.category.course.grading_mode == "points"
                ),
                allow_zero_denominator=bool(
                    item.category.course.grading_mode == "points"
                    or (
                        not item.category.is_bonus_category
                        and item.category.aggregation == "points_ratio"
                    )
                ),
            )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    course_id = item.category.course_id
    return _course_payload(db, course_id)


@app.delete("/api/assignments/{assignment_id}")
def delete_assignment(assignment_id: int, db: Session = Depends(get_db)):
    item = _assignment_or_404(db, assignment_id)
    course_id = item.category.course_id
    db.delete(item)
    db.commit()
    return _course_payload(db, course_id)


@app.get("/api/gpa")
def get_gpa(semester_ids: str | None = None, db: Session = Depends(get_db)):
    _settings(db)
    selected = None
    if semester_ids is not None:
        if semester_ids == "__none__":
            selected = set()
        else:
            try:
                selected = {int(value) for value in semester_ids.split(",") if value.strip()}
            except ValueError as exc:
                raise HTTPException(400, "semester_ids must be comma-separated integers") from exc
    return build_gpa(db, selected)


@app.get("/api/semesters/{semester_id}/snapshots")
def get_semester_snapshots(semester_id: int, db: Session = Depends(get_db)):
    _semester_or_404(db, semester_id)
    return list_grade_snapshots(db, semester_id)


@app.post("/api/semesters/{semester_id}/snapshots")
def create_semester_snapshot(semester_id: int, db: Session = Depends(get_db)):
    sem = _semester_or_404(db, semester_id)
    if sem.progression_locked:
        raise HTTPException(409, "Progression is locked for this semester")
    _apply_dynamic_for_courses(db, list(sem.courses))
    try:
        settings = _settings(db)
        gradebook_type = (settings.gradebook_type or "college").strip().lower()
        score_units = (
            high_school_term_units(db)
            if gradebook_type == "high_school"
            else ({sem.id: 1.0} if (settings.gpa_basis or "credits").strip().lower() == "classes" else {})
        )
        return record_grade_snapshot(
            db,
            sem,
            _target(db),
            settings.gpa_cap,
            settings.fail_pass_fail_affects_gpa,
            gradebook_type,
            gpa_weight_tags(settings),
            settings.gpa_basis or "credits",
            score_units.get(sem.id),
        )
    except ProgressionLockedError as exc:
        raise HTTPException(409, str(exc)) from exc
    except NoGradesToRecordError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.patch("/api/semesters/{semester_id}/snapshots/{snapshot_id}")
def update_semester_snapshot(
    semester_id: int,
    snapshot_id: int,
    body: SnapshotUpdate,
    db: Session = Depends(get_db),
):
    _semester_or_404(db, semester_id)
    try:
        updated = patch_grade_snapshot(
            db,
            semester_id,
            snapshot_id,
            course_id=body.course_id,
            percent=body.percent,
            clear_course=body.clear_course,
            term_gpa=body.term_gpa,
            clear_term_gpa=body.clear_term_gpa,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if updated is None:
        raise HTTPException(404, "Snapshot not found")
    return updated


@app.delete("/api/semesters/{semester_id}/snapshots")
def delete_semester_snapshots(semester_id: int, body: SnapshotDelete, db: Session = Depends(get_db)):
    _semester_or_404(db, semester_id)
    if not body.ids and not body.course_points and not body.gpa_snapshot_ids:
        raise HTTPException(400, "Provide snapshot ids or points to delete")
    deleted = delete_grade_snapshots(
        db,
        semester_id,
        snapshot_ids=body.ids,
        course_points=[(point.snapshot_id, point.course_id) for point in body.course_points],
        gpa_snapshot_ids=body.gpa_snapshot_ids,
    )
    return {"deleted": deleted}


@app.post("/api/snapshots/record-all")
def create_all_snapshots(db: Session = Depends(get_db)):
    _settings(db)
    semesters = gradebook_semesters(db)
    _apply_dynamic_for_courses(db, [c for s in semesters for c in s.courses])
    return record_all_grade_snapshots(db)


@app.get("/api/app-state")
def get_app_state(db: Session = Depends(get_db)):
    settings = db.get(Settings, 1)
    if settings is None:
        seed_if_needed(db)
        settings = db.get(Settings, 1)
    return _app_state_payload(settings)


@app.put("/api/app-state")
def put_app_state(body: dict, db: Session = Depends(get_db)):
    settings = db.get(Settings, 1)
    if settings is None:
        seed_if_needed(db)
        settings = db.get(Settings, 1)
    state = _normalize_app_state(body if isinstance(body, dict) else {})
    settings.gradebooks_json = json.dumps(state["gradebooks"], separators=(",", ":"))
    settings.gradebook_members_json = json.dumps(state["gradebook_members"], separators=(",", ":"))
    settings.gradebook_appearance_json = json.dumps(state["gradebook_appearance"], separators=(",", ":"))
    settings.min_credits = state["min_credits"]
    db.commit()
    return state


@app.get("/api/grade-prompt")
def get_grade_prompt(db: Session = Depends(get_db)):
    # This endpoint is intentionally global. Do not resolve active-gradebook
    # settings here: changing books must not affect reminder timing or state.
    return grade_prompt_status(db)


@app.post("/api/grade-prompt/snooze")
def post_grade_prompt_snooze(db: Session = Depends(get_db)):
    # Snooze is stored on the one global Settings row, independent of the
    # gradebook in the request URL.
    return snooze_grade_prompt(db, days=1)


@app.get("/api/appearance")
def get_appearance(db: Session = Depends(get_db)):
    settings = db.get(Settings, 1)
    if settings is None:
        seed_if_needed(db)
        settings = db.get(Settings, 1)
    raw = (settings.appearance_json or "").strip()
    if not raw or raw == "{}":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


@app.put("/api/appearance")
def put_appearance(body: dict, db: Session = Depends(get_db)):
    settings = db.get(Settings, 1)
    if settings is None:
        seed_if_needed(db)
        settings = db.get(Settings, 1)
    settings.appearance_json = json.dumps(body)
    db.commit()
    return body


@app.patch("/api/settings")
def update_settings(body: SettingsUpdate, db: Session = Depends(get_db)):
    settings = _settings(db)
    global_settings = db.get(Settings, 1)
    if body.target_letter is not None:
        settings.target_letter = body.target_letter
    if body.semesters_remaining is not None:
        settings.semesters_remaining = body.semesters_remaining
    if "gpa_cap" in body.model_fields_set:
        if body.gpa_cap is not None and body.gpa_cap <= 0:
            raise HTTPException(400, "GPA cap must be greater than zero")
        settings.gpa_cap = body.gpa_cap
    if body.fail_pass_fail_affects_gpa is not None:
        settings.fail_pass_fail_affects_gpa = body.fail_pass_fail_affects_gpa
    if body.recording_interval_days is not None:
        if body.recording_interval_days < 1:
            raise HTTPException(400, "Recording interval must be at least 1 day")
        # Reminder timing is shared across gradebooks. Keep it on the base
        # settings row instead of the active gradebook's scoped overlay.
        global_settings.recording_interval_days = int(body.recording_interval_days)
    if "default_recording_semester_id" in body.model_fields_set:
        sem_id = body.default_recording_semester_id
        if sem_id is not None and gradebook_semester(db, sem_id) is None:
            raise HTTPException(404, "Semester not found")
        settings.default_recording_semester_id = sem_id
    if body.gradebook_type is not None:
        gradebook_type = body.gradebook_type.strip().lower()
        if gradebook_type not in {"college", "high_school"}:
            raise HTTPException(400, "gradebook type must be Single-term or Multi-term")
        settings.gradebook_type = gradebook_type
    if body.gpa_basis is not None:
        basis = body.gpa_basis.strip().lower()
        if basis not in {"credits", "classes"}:
            raise HTTPException(400, "gpa_basis must be credits or classes")
        settings.gpa_basis = basis
    if body.high_school_overall_rounding is not None or body.high_school_overall_rounding_by_period is not None or body.high_school_term_weights_by_period is not None:
        update_high_school_overall_settings(
            db,
            body.high_school_overall_rounding,
            body.high_school_overall_rounding_by_period,
            body.high_school_term_weights_by_period,
        )
    if body.gpa_weight_tags is not None:
        tags = []
        seen = set()
        for raw in body.gpa_weight_tags:
            tag_id = str(raw.get("id") or "").strip().lower().replace(" ", "-")[:48]
            name = str(raw.get("name") or "").strip()[:64]
            try:
                boost = float(raw.get("boost", 0))
            except (TypeError, ValueError) as exc:
                raise HTTPException(400, "Weight boosts must be numbers") from exc
            if not tag_id or not name or tag_id in seen:
                raise HTTPException(400, "Each GPA weight needs a unique name")
            seen.add(tag_id)
            tags.append({"id": tag_id, "name": name, "boost": boost})
        if not any(tag["id"] == "unweighted" for tag in tags):
            tags.insert(0, {"id": "unweighted", "name": "Unweighted", "boost": 0.0})
        settings.gpa_weight_tags_json = json.dumps(tags)
    if body.future_guess is not None:
        settings.future_guess_json = json.dumps(body.future_guess)
    if body.default_scale is not None:
        try:
            rows = normalize_scale(body.default_scale)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        update_primary_scale(db, rows)
        settings.default_scale_json = json.dumps(scale_as_dicts(rows))
        coerce_target_letter(settings, rows)
    update_gradebook_settings(
        db,
        {field: getattr(settings, field) for field in (
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
        )},
    )
    db.commit()
    return build_gpa(db)


@app.post("/api/fumbles")
def create_fumble(body: FumbleCreate, db: Session = Depends(get_db)):
    _course_or_404(db, body.course_id)
    if db.query(Fumble).filter(Fumble.course_id == body.course_id).first() is not None:
        raise HTTPException(409, "A fumble already exists for this class")
    row = Fumble(course_id=body.course_id, should_have_been_gp=body.should_have_been_gp)
    db.add(row)
    db.commit()
    return build_gpa(db)


@app.patch("/api/fumbles/{fumble_id}")
def update_fumble(fumble_id: int, body: FumbleUpdate, db: Session = Depends(get_db)):
    row = _fumble_or_404(db, fumble_id)
    row.should_have_been_gp = body.should_have_been_gp
    db.commit()
    return build_gpa(db)


@app.delete("/api/fumbles/{fumble_id}")
def delete_fumble(fumble_id: int, db: Session = Depends(get_db)):
    row = _fumble_or_404(db, fumble_id)
    db.delete(row)
    db.commit()
    return build_gpa(db)


DIST = frontend_dist()


@app.exception_handler(StarletteHTTPException)
async def http_exception_with_spa(request: Request, exc: StarletteHTTPException):
    """Serve the built UI for unknown pages without stealing API methods."""
    if (
        DIST.exists()
        and exc.status_code == 404
        and request.method in {"GET", "HEAD"}
        and not request.url.path.startswith("/api")
    ):
        relative = request.url.path.lstrip("/")
        candidate = DIST / relative
        if relative and candidate.is_file():
            return FileResponse(candidate)
        index = DIST / "index.html"
        if index.exists():
            return FileResponse(index)
    return await http_exception_handler(request, exc)
