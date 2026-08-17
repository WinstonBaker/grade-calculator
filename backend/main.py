from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload

from backend.database import Base, engine, get_db
from backend.paths import current_platform, frozen, frontend_dist, github_repo
from backend.updates import check_for_updates, download_update
from backend.version import MACOS_ASSET, WINDOWS_ASSET, __version__
from backend.engine import AGGREGATIONS, DEFAULT_SCALE, SEASON_ORDER
from backend.models import Assignment, Category, Course, Fumble, GradeScale, Semester, Settings
from backend.schemas import (
    AssignmentCreate,
    AssignmentUpdate,
    CategoryCreate,
    CategoryUpdate,
    CourseCreate,
    CourseUpdate,
    FumbleCreate,
    ScaleUpdate,
    SemesterCreate,
    SemesterUpdate,
    SettingsUpdate,
)
from backend.service import (
    apply_score_fields,
    build_gpa,
    copy_default_scale,
    seed_if_needed,
    serialize_course,
    serialize_semester,
    sort_courses,
    sort_semesters,
    target_gp_from_settings,
)

Base.metadata.create_all(bind=engine)

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
    _, gp = target_gp_from_settings(_settings(db))
    return gp


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


@app.get("/api/meta")
def meta():
    repo = github_repo()
    return {
        "aggregations": list(AGGREGATIONS),
        "seasons": list(SEASON_ORDER),
        "default_scale": [
            {"letter": a, "min_percent": b, "quality_points": c} for a, b, c in DEFAULT_SCALE
        ],
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


@app.post("/api/updates/download")
def post_update_download():
    try:
        return download_update()
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/semesters")
def list_semesters(db: Session = Depends(get_db)):
    target = _target(db)
    semesters = sort_semesters(db.query(Semester).all())
    return [serialize_semester(s, target) for s in semesters]


@app.post("/api/semesters")
def create_semester(body: SemesterCreate, db: Session = Depends(get_db)):
    season = body.season.lower()
    if season not in SEASON_ORDER:
        raise HTTPException(400, "Season must be spring, summer, or fall")
    dup = db.query(Semester).filter(Semester.year == body.year, Semester.season == season).first()
    if dup:
        raise HTTPException(409, f"{body.year} {season.title()} already exists")
    sem = Semester(year=body.year, season=season, included=body.included)
    db.add(sem)
    db.commit()
    db.refresh(sem)
    return serialize_semester(sem, _target(db))


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
            raise HTTPException(400, "Season must be spring, summer, or fall")
        sem.season = season
    if body.included is not None:
        sem.included = body.included
    clash = (
        db.query(Semester)
        .filter(Semester.year == sem.year, Semester.season == sem.season, Semester.id != sem.id)
        .first()
    )
    if clash:
        raise HTTPException(409, f"{sem.year} {sem.season.title()} already exists")
    db.commit()
    return serialize_semester(sem, _target(db))


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
    )
    db.add(course)
    db.commit()
    db.refresh(course)
    copy_default_scale(db, course)
    db.commit()
    return serialize_course(_course_or_404(db, course.id), _target(db))


@app.get("/api/courses/{course_id}")
def get_course(course_id: int, db: Session = Depends(get_db)):
    return serialize_course(_course_or_404(db, course_id), _target(db))


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
    db.commit()
    return serialize_course(_course_or_404(db, course_id), _target(db))


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
    db.query(GradeScale).filter(GradeScale.course_id == course.id).delete()
    for row in body.rows:
        db.add(
            GradeScale(
                course_id=course.id,
                letter=row.letter,
                min_percent=row.min_percent,
                quality_points=row.quality_points,
            )
        )
    db.commit()
    return serialize_course(_course_or_404(db, course_id), _target(db))


@app.post("/api/categories")
def create_category(body: CategoryCreate, db: Session = Depends(get_db)):
    course = db.get(Course, body.course_id)
    if course is None:
        raise HTTPException(404, "Course not found")
    if body.aggregation not in AGGREGATIONS:
        raise HTTPException(400, f"Unknown aggregation {body.aggregation}")
    order = len(course.categories)
    cat = Category(
        course_id=body.course_id,
        name=body.name,
        weight=body.weight,
        weight_per_item=body.weight_per_item,
        aggregation=body.aggregation,
        drop_count=body.drop_count,
        replace_with_category_id=body.replace_with_category_id,
        sort_order=order,
    )
    db.add(cat)
    db.commit()
    return serialize_course(_course_or_404(db, body.course_id), _target(db))


@app.patch("/api/categories/{category_id}")
def update_category(category_id: int, body: CategoryUpdate, db: Session = Depends(get_db)):
    cat = db.get(Category, category_id)
    if cat is None:
        raise HTTPException(404, "Category not found")
    if body.name is not None:
        cat.name = body.name
    if body.weight is not None:
        cat.weight = body.weight
    if "weight_per_item" in body.model_fields_set:
        cat.weight_per_item = body.weight_per_item
    if body.aggregation is not None:
        if body.aggregation not in AGGREGATIONS:
            raise HTTPException(400, f"Unknown aggregation {body.aggregation}")
        cat.aggregation = body.aggregation
    if body.drop_count is not None:
        cat.drop_count = body.drop_count
    if "replace_with_category_id" in body.model_fields_set:
        cat.replace_with_category_id = body.replace_with_category_id
    db.commit()
    return serialize_course(_course_or_404(db, cat.course_id), _target(db))


@app.delete("/api/categories/{category_id}")
def delete_category(category_id: int, db: Session = Depends(get_db)):
    cat = db.get(Category, category_id)
    if cat is None:
        raise HTTPException(404, "Category not found")
    course_id = cat.course_id
    db.query(Category).filter(Category.replace_with_category_id == category_id).update(
        {Category.replace_with_category_id: None}
    )
    db.delete(cat)
    db.commit()
    return serialize_course(_course_or_404(db, course_id), _target(db))


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
    return serialize_course(_course_or_404(db, cat.course_id), _target(db))


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
    return serialize_course(_course_or_404(db, course_id), _target(db))


@app.delete("/api/assignments/{assignment_id}")
def delete_assignment(assignment_id: int, db: Session = Depends(get_db)):
    item = db.get(Assignment, assignment_id)
    if item is None:
        raise HTTPException(404, "Assignment not found")
    course_id = item.category.course_id
    db.delete(item)
    db.commit()
    return serialize_course(_course_or_404(db, course_id), _target(db))


@app.get("/api/gpa")
def get_gpa(db: Session = Depends(get_db)):
    _settings(db)
    return build_gpa(db)


@app.patch("/api/settings")
def update_settings(body: SettingsUpdate, db: Session = Depends(get_db)):
    settings = _settings(db)
    if body.target_letter is not None:
        settings.target_letter = body.target_letter
    if body.semesters_remaining is not None:
        settings.semesters_remaining = body.semesters_remaining
    if body.future_guess is not None:
        import json

        settings.future_guess_json = json.dumps(body.future_guess)
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
if DIST.exists():

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404, "Not found")
        candidate = DIST / full_path
        if full_path and candidate.exists() and candidate.is_file():
            return FileResponse(candidate)
        index = DIST / "index.html"
        if index.exists():
            return FileResponse(index)
        raise HTTPException(404, "Frontend is not built")
