from __future__ import annotations

import json

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.database import Base, engine, ensure_schema, get_db
from backend.paths import current_platform, frozen, frontend_dist, github_repo
from backend.updates import apply_update, check_for_updates, dismiss_update, schedule_app_exit
from backend.version import MACOS_ASSET, WINDOWS_ASSET, __version__
from backend.engine import (
    ACCEPTED_AGGREGATIONS,
    AGGREGATION_LABELS,
    AGGREGATIONS,
    SEASON_LABELS,
    SEASON_ORDER,
    normalize_scale,
    preset_payload,
    resolve_category_policy,
    scale_as_dicts,
)
from backend.models import Assignment, Category, Course, Fumble, ScaleProfile, Semester, Settings
from backend.schemas import (
    AssignmentCreate,
    AssignmentUpdate,
    CategoryCreate,
    CategoryUpdate,
    CourseCreate,
    CourseUpdate,
    FumbleCreate,
    ScaleApply,
    ScaleProfileCreate,
    ScaleProfileUpdate,
    ScaleUpdate,
    SemesterCreate,
    SemesterUpdate,
    SettingsUpdate,
    SnapshotDelete,
    UpdateDismiss,
)
from backend.service import (
    apply_dynamic_weighting,
    apply_score_fields,
    build_gpa,
    coerce_target_letter,
    copy_default_scale,
    create_scale_profile,
    delete_grade_snapshots,
    delete_scale_profile,
    dump_dynamic_weighting,
    grade_prompt_status,
    list_grade_snapshots,
    list_scale_profiles,
    lock_older_unlocked_semesters,
    parse_default_scale,
    parse_dynamic_weighting,
    ProgressionLockedError,
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
    snooze_grade_prompt,
    sort_courses,
    sort_semesters,
    sync_dynamic_weighting_categories,
    sync_primary_scale_json,
    target_gp_from_settings,
    update_primary_scale,
    remove_test_category_id,
)

Base.metadata.create_all(bind=engine)
ensure_schema()

app = FastAPI(title="Grade Calculator")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _settings(db: Session) -> Settings:
    seed_if_needed(db)
    return db.get(Settings, 1)


def _target(db: Session) -> float:
    _, gp = target_gp_from_settings(_settings(db), db)
    return gp


def _gpa_cap(db: Session) -> float | None:
    return _settings(db).gpa_cap


def _owned_category_id(course: Course, category_id: int | None) -> int | None:
    if category_id is None:
        return None
    if not any(cat.id == category_id for cat in course.categories):
        raise HTTPException(400, "Category does not belong to this class")
    return category_id


def _course_or_404(db: Session, course_id: int) -> Course:
    course = (
        db.query(Course)
        .options(
            joinedload(Course.categories).joinedload(Category.assignments),
            joinedload(Course.scale_rows),
        )
        .filter(Course.id == course_id)
        .first()
    )
    if course is None:
        raise HTTPException(404, "Course not found")
    return course


def _course_payload(db: Session, course_id: int) -> dict:
    return refresh_course(db, _course_or_404(db, course_id), _target(db))


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


@app.post("/api/updates/apply")
def post_update_apply(background: BackgroundTasks):
    return _apply_update_response(background)


@app.post("/api/updates/download")
def post_update_download(background: BackgroundTasks):
    return _apply_update_response(background)


@app.get("/api/semesters")
def list_semesters(db: Session = Depends(get_db)):
    target = _target(db)
    semesters = sort_semesters(db.query(Semester).all())
    _apply_dynamic_for_courses(db, [c for s in semesters for c in s.courses])
    return [serialize_semester(s, target, _gpa_cap(db)) for s in semesters]


@app.post("/api/semesters")
def create_semester(body: SemesterCreate, db: Session = Depends(get_db)):
    season = body.season.lower()
    if season not in SEASON_ORDER:
        raise HTTPException(400, "Season must be spring, summer, fall, or transfer")
    dup = db.query(Semester).filter(Semester.year == body.year, Semester.season == season).first()
    if dup:
        raise HTTPException(409, f"{body.year} {season.title()} already exists")
    sem = Semester(year=body.year, season=season, included=body.included, progression_locked=False)
    db.add(sem)
    db.flush()
    if body.lock_previous:
        lock_older_unlocked_semesters(db, sem)
    db.commit()
    db.refresh(sem)
    return serialize_semester(sem, _target(db), _gpa_cap(db))


@app.patch("/api/semesters/{semester_id}")
def update_semester(semester_id: int, body: SemesterUpdate, db: Session = Depends(get_db)):
    sem = db.get(Semester, semester_id)
    if sem is None:
        raise HTTPException(404, "Semester not found")
    if body.year is not None:
        sem.year = body.year
    if body.season is not None:
        season = body.season.lower()
        if season not in SEASON_ORDER:
            raise HTTPException(400, "Season must be spring, summer, fall, or transfer")
        sem.season = season
    if body.included is not None:
        sem.included = body.included
    if body.progression_locked is not None:
        sem.progression_locked = body.progression_locked
    clash = (
        db.query(Semester)
        .filter(Semester.year == sem.year, Semester.season == sem.season, Semester.id != sem.id)
        .first()
    )
    if clash:
        raise HTTPException(409, f"{sem.year} {sem.season.title()} already exists")
    db.commit()
    return serialize_semester(sem, _target(db), _gpa_cap(db))


@app.delete("/api/semesters/{semester_id}")
def delete_semester(semester_id: int, db: Session = Depends(get_db)):
    sem = db.get(Semester, semester_id)
    if sem is None:
        raise HTTPException(404, "Semester not found")
    db.delete(sem)
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
    query = db.query(Course)
    if semester_id is not None:
        query = query.filter(Course.semester_id == semester_id)
    courses = query.all()
    _apply_dynamic_for_courses(db, courses)
    payload = [serialize_course(c, target) for c in courses]
    if q:
        needle = q.lower()
        payload = [c for c in payload if needle in (c["code"] or "").lower()]
    payload = sort_courses(payload, sort, desc)
    return payload


@app.post("/api/courses")
def create_course(body: CourseCreate, db: Session = Depends(get_db)):
    if db.get(Semester, body.semester_id) is None:
        raise HTTPException(404, "Semester not found")
    course = Course(
        semester_id=body.semester_id,
        code=body.code.strip(),
        credits=body.credits,
        bonus_points=body.bonus_points,
        gp_override=body.gp_override,
        grade_rounding=body.grade_rounding,
    )
    db.add(course)
    db.commit()
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
    if body.semester_id is not None:
        if db.get(Semester, body.semester_id) is None:
            raise HTTPException(404, "Semester not found")
        course.semester_id = body.semester_id
    if body.code is not None:
        course.code = body.code.strip()
    if body.credits is not None:
        course.credits = body.credits
    if body.bonus_points is not None:
        course.bonus_points = body.bonus_points
    if "gp_override" in body.model_fields_set:
        course.gp_override = body.gp_override
    if "grade_rounding" in body.model_fields_set:
        course.grade_rounding = body.grade_rounding
    if "test_category_ids" in body.model_fields_set:
        owned = [_owned_category_id(course, tid) for tid in (body.test_category_ids or [])]
        set_course_test_category_ids(course, [tid for tid in owned if tid is not None])
    elif "test_category_id" in body.model_fields_set:
        owned = _owned_category_id(course, body.test_category_id)
        set_course_test_category_ids(course, [owned] if owned is not None else [])
    if "exam_category_id" in body.model_fields_set:
        course.exam_category_id = _owned_category_id(course, body.exam_category_id)
    if "dynamic_weighting_enabled" in body.model_fields_set:
        course.dynamic_weighting_enabled = bool(body.dynamic_weighting_enabled)
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
    db.commit()
    return _course_payload(db, course_id)


@app.delete("/api/courses/{course_id}")
def delete_course(course_id: int, db: Session = Depends(get_db)):
    course = db.get(Course, course_id)
    if course is None:
        raise HTTPException(404, "Course not found")
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
    course.scale_profile_id = None
    db.commit()
    return _course_payload(db, course_id)


@app.post("/api/courses/{course_id}/scale/default")
def reset_scale(course_id: int, body: ScaleApply | None = None, db: Session = Depends(get_db)):
    course = _course_or_404(db, course_id)
    profile_id = body.scale_profile_id if body else None
    if profile_id is not None and db.get(ScaleProfile, profile_id) is None:
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
    )
    db.commit()
    db.refresh(profile)
    return serialize_scale_profile(profile)


@app.patch("/api/scale-profiles/{profile_id}")
def patch_scale_profile(profile_id: int, body: ScaleProfileUpdate, db: Session = Depends(get_db)):
    _settings(db)
    profile = db.get(ScaleProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "Default scale not found")
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
    profile = db.get(ScaleProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "Default scale not found")
    try:
        delete_scale_profile(db, profile)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    return {"ok": True}


def _category_policy(*, aggregation, drop_count, include_bonus, replace_with_category_id):
    if aggregation not in ACCEPTED_AGGREGATIONS:
        raise HTTPException(400, f"Unknown aggregation {aggregation}")
    return resolve_category_policy(
        aggregation,
        drop_count,
        include_bonus,
        replace_with_category_id,
    )


@app.post("/api/categories")
def create_category(body: CategoryCreate, db: Session = Depends(get_db)):
    course = db.get(Course, body.course_id)
    if course is None:
        raise HTTPException(404, "Course not found")
    policy = _category_policy(
        aggregation=body.aggregation,
        drop_count=body.drop_count,
        include_bonus=body.include_bonus,
        replace_with_category_id=body.replace_with_category_id,
    )
    order = len(course.categories)
    cat = Category(
        course_id=body.course_id,
        name=body.name,
        weight=body.weight,
        weight_per_item=body.weight_per_item,
        aggregation=policy.aggregation,
        drop_count=policy.drop_count,
        include_bonus=policy.include_bonus,
        replace_with_category_id=policy.replace_with_category_id,
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
    cat = db.get(Category, category_id)
    if cat is None:
        raise HTTPException(404, "Category not found")
    if body.name is not None:
        cat.name = body.name
    course = _course_or_404(db, cat.course_id)
    if not course.dynamic_weighting_enabled:
        if body.weight is not None:
            cat.weight = body.weight
        if "weight_per_item" in body.model_fields_set:
            cat.weight_per_item = body.weight_per_item
    aggregation = body.aggregation if body.aggregation is not None else cat.aggregation
    drop_count = body.drop_count if body.drop_count is not None else cat.drop_count
    include_bonus = body.include_bonus if "include_bonus" in body.model_fields_set else bool(cat.include_bonus)
    replace_with = (
        body.replace_with_category_id
        if "replace_with_category_id" in body.model_fields_set
        else cat.replace_with_category_id
    )
    policy = _category_policy(
        aggregation=aggregation,
        drop_count=drop_count,
        include_bonus=include_bonus,
        replace_with_category_id=replace_with,
    )
    cat.aggregation = policy.aggregation
    cat.drop_count = policy.drop_count
    cat.include_bonus = policy.include_bonus
    cat.replace_with_category_id = policy.replace_with_category_id
    db.commit()
    return _course_payload(db, cat.course_id)


@app.delete("/api/categories/{category_id}")
def delete_category(category_id: int, db: Session = Depends(get_db)):
    cat = db.get(Category, category_id)
    if cat is None:
        raise HTTPException(404, "Category not found")
    course_id = cat.course_id
    db.query(Category).filter(Category.replace_with_category_id == category_id).update(
        {Category.replace_with_category_id: None}
    )
    course = db.get(Course, course_id)
    if course is not None:
        remove_test_category_id(course, category_id)
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
    cat = db.get(Category, body.category_id)
    if cat is None:
        raise HTTPException(404, "Category not found")
    item = Assignment(
        category_id=body.category_id,
        name=body.name,
        is_bonus=body.is_bonus,
        sort_order=len(cat.assignments),
    )
    apply_score_fields(item, body, body.is_bonus)
    db.add(item)
    db.commit()
    return _course_payload(db, cat.course_id)


@app.patch("/api/assignments/{assignment_id}")
def update_assignment(assignment_id: int, body: AssignmentUpdate, db: Session = Depends(get_db)):
    item = db.get(Assignment, assignment_id)
    if item is None:
        raise HTTPException(404, "Assignment not found")
    if body.name is not None:
        item.name = body.name
    if body.is_bonus is not None:
        item.is_bonus = body.is_bonus
    apply_score_fields(item, body, item.is_bonus)
    db.commit()
    course_id = item.category.course_id
    return _course_payload(db, course_id)


@app.delete("/api/assignments/{assignment_id}")
def delete_assignment(assignment_id: int, db: Session = Depends(get_db)):
    item = db.get(Assignment, assignment_id)
    if item is None:
        raise HTTPException(404, "Assignment not found")
    course_id = item.category.course_id
    db.delete(item)
    db.commit()
    return _course_payload(db, course_id)


@app.get("/api/gpa")
def get_gpa(db: Session = Depends(get_db)):
    _settings(db)
    return build_gpa(db)


@app.get("/api/semesters/{semester_id}/snapshots")
def get_semester_snapshots(semester_id: int, db: Session = Depends(get_db)):
    sem = db.get(Semester, semester_id)
    if sem is None:
        raise HTTPException(404, "Semester not found")
    return list_grade_snapshots(db, semester_id)


@app.post("/api/semesters/{semester_id}/snapshots")
def create_semester_snapshot(semester_id: int, db: Session = Depends(get_db)):
    sem = db.get(Semester, semester_id)
    if sem is None:
        raise HTTPException(404, "Semester not found")
    if sem.progression_locked:
        raise HTTPException(409, "Progression is locked for this semester")
    _apply_dynamic_for_courses(db, list(sem.courses))
    try:
        return record_grade_snapshot(db, sem, _target(db), _gpa_cap(db))
    except ProgressionLockedError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.delete("/api/semesters/{semester_id}/snapshots")
def delete_semester_snapshots(semester_id: int, body: SnapshotDelete, db: Session = Depends(get_db)):
    sem = db.get(Semester, semester_id)
    if sem is None:
        raise HTTPException(404, "Semester not found")
    if not body.ids:
        raise HTTPException(400, "Provide snapshot ids to delete")
    deleted = delete_grade_snapshots(db, semester_id, body.ids)
    return {"deleted": deleted}


@app.post("/api/snapshots/record-all")
def create_all_snapshots(db: Session = Depends(get_db)):
    _settings(db)
    semesters = db.query(Semester).all()
    _apply_dynamic_for_courses(db, [c for s in semesters for c in s.courses])
    return record_all_grade_snapshots(db)


@app.get("/api/grade-prompt")
def get_grade_prompt(db: Session = Depends(get_db)):
    _settings(db)
    return grade_prompt_status(db)


@app.post("/api/grade-prompt/snooze")
def post_grade_prompt_snooze(db: Session = Depends(get_db)):
    _settings(db)
    return snooze_grade_prompt(db, days=1)


@app.get("/api/appearance")
def get_appearance(db: Session = Depends(get_db)):
    settings = _settings(db)
    raw = (settings.appearance_json or "").strip()
    if not raw or raw == "{}":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


@app.put("/api/appearance")
def put_appearance(body: dict, db: Session = Depends(get_db)):
    settings = _settings(db)
    settings.appearance_json = json.dumps(body)
    db.commit()
    return body


@app.patch("/api/settings")
def update_settings(body: SettingsUpdate, db: Session = Depends(get_db)):
    settings = _settings(db)
    if body.target_letter is not None:
        settings.target_letter = body.target_letter
    if body.semesters_remaining is not None:
        settings.semesters_remaining = body.semesters_remaining
    if "gpa_cap" in body.model_fields_set:
        if body.gpa_cap is not None and body.gpa_cap <= 0:
            raise HTTPException(400, "GPA cap must be greater than zero")
        settings.gpa_cap = body.gpa_cap
    if body.recording_interval_days is not None:
        if body.recording_interval_days < 1:
            raise HTTPException(400, "Recording interval must be at least 1 day")
        settings.recording_interval_days = int(body.recording_interval_days)
    if "default_recording_semester_id" in body.model_fields_set:
        sem_id = body.default_recording_semester_id
        if sem_id is not None and db.get(Semester, sem_id) is None:
            raise HTTPException(404, "Semester not found")
        settings.default_recording_semester_id = sem_id
    if body.future_guess is not None:
        settings.future_guess_json = json.dumps(body.future_guess)
    if body.default_scale is not None:
        try:
            rows = normalize_scale(body.default_scale)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        update_primary_scale(db, rows)
        coerce_target_letter(settings, rows)
    db.commit()
    return build_gpa(db)


@app.post("/api/fumbles")
def create_fumble(body: FumbleCreate, db: Session = Depends(get_db)):
    if db.get(Course, body.course_id) is None:
        raise HTTPException(404, "Course not found")
    row = Fumble(course_id=body.course_id, should_have_been_gp=body.should_have_been_gp)
    db.add(row)
    db.commit()
    return build_gpa(db)


@app.delete("/api/fumbles/{fumble_id}")
def delete_fumble(fumble_id: int, db: Session = Depends(get_db)):
    row = db.get(Fumble, fumble_id)
    if row is None:
        raise HTTPException(404, "Fumble not found")
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
