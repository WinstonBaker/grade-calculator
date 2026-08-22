from __future__ import annotations

from pydantic import BaseModel, Field


class SemesterCreate(BaseModel):
    year: int
    season: str
    included: bool = True
    lock_previous: bool = False


class SemesterUpdate(BaseModel):
    year: int | None = None
    season: str | None = None
    included: bool | None = None
    progression_locked: bool | None = None


class CourseCreate(BaseModel):
    semester_id: int
    code: str
    credits: float = 3.0
    bonus_points: float = 0.0
    gp_override: float | None = None
    grade_rounding: int | None = Field(default=None, ge=0, le=3)


class CourseUpdate(BaseModel):
    semester_id: int | None = None
    code: str | None = None
    credits: float | None = None
    bonus_points: float | None = None
    gp_override: float | None = None
    grade_rounding: int | None = Field(default=None, ge=0, le=3)
    test_category_id: int | None = None
    test_category_ids: list[int] | None = None
    exam_category_id: int | None = None
    grading_mode: str | None = None
    dynamic_weighting_enabled: bool | None = None
    dynamic_weighting: dict | None = None


class CategoryCreate(BaseModel):
    course_id: int
    name: str
    weight: float = 0.0
    weight_per_item: float | None = None
    aggregation: str = "average"
    drop_count: int = Field(default=0, ge=0)
    include_bonus: bool = False
    replace_with_category_id: int | None = None


class CategoryUpdate(BaseModel):
    name: str | None = None
    weight: float | None = None
    weight_per_item: float | None = None
    aggregation: str | None = None
    drop_count: int | None = Field(default=None, ge=0)
    include_bonus: bool | None = None
    replace_with_category_id: int | None = None


class CategoryOrderUpdate(BaseModel):
    category_ids: list[int]


class AssignmentCreate(BaseModel):
    category_id: int
    name: str = ""
    score: str | None = None
    earned: float | None = None
    possible: float | None = None
    is_bonus: bool = False


class AssignmentUpdate(BaseModel):
    name: str | None = None
    score: str | None = None
    earned: float | None = None
    possible: float | None = None
    is_bonus: bool | None = None
    clear_score: bool = False


class ScaleRowIn(BaseModel):
    letter: str
    min_percent: float
    quality_points: float


class ScaleUpdate(BaseModel):
    rows: list[ScaleRowIn]


class ScaleApply(BaseModel):
    scale_profile_id: int | None = None


class ScaleProfileCreate(BaseModel):
    name: str | None = None
    rows: list[ScaleRowIn] | None = None
    is_primary: bool = False
    preset_id: str | None = None


class ScaleProfileUpdate(BaseModel):
    name: str | None = None
    rows: list[ScaleRowIn] | None = None
    is_primary: bool | None = None
    sort_order: int | None = None
    preset_id: str | None = None


class SettingsUpdate(BaseModel):
    target_letter: str | None = None
    semesters_remaining: float | None = None
    gpa_cap: float | None = None
    future_guess: dict[str, dict[str, int]] | None = None
    default_scale: list[ScaleRowIn] | None = None
    recording_interval_days: int | None = None
    default_recording_semester_id: int | None = None


class SnapshotCoursePoint(BaseModel):
    snapshot_id: int
    course_id: int


class SnapshotDelete(BaseModel):
    ids: list[int] = Field(default_factory=list)
    course_points: list[SnapshotCoursePoint] = Field(default_factory=list)
    gpa_snapshot_ids: list[int] = Field(default_factory=list)


class SnapshotUpdate(BaseModel):
    course_id: int | None = None
    percent: float | None = None
    clear_course: bool = False
    term_gpa: float | None = None
    clear_term_gpa: bool = False


class UpdateDismiss(BaseModel):
    version: str


class FumbleCreate(BaseModel):
    course_id: int
    should_have_been_gp: float = Field(..., description="Quality points, e.g. 4.333")
