from __future__ import annotations

from typing import Any

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
    bonus_mode: str = "none"
    gp_override: float | None = None
    final_gp_override: float | None = None
    grade_rounding: int | None = Field(default=None, ge=0, le=3)
    credit_mode: str = "for_credit"
    gpa_weight_tag: str = "unweighted"


class CourseUpdate(BaseModel):
    semester_id: int | None = None
    code: str | None = None
    credits: float | None = None
    bonus_points: float | None = None
    bonus_mode: str | None = None
    gp_override: float | None = None
    final_gp_override: float | None = None
    grade_rounding: int | None = Field(default=None, ge=0, le=3)
    credit_mode: str | None = None
    pass_fail_override: str | None = None
    test_category_ids: list[int] | None = None
    exam_category_id: int | None = None
    exam_total_points: float | None = Field(default=None, gt=0)
    grading_mode: str | None = None
    dynamic_weighting_enabled: bool | None = None
    dynamic_weighting: dict | None = None
    gpa_weight_tag: str | None = None


class CategoryCreate(BaseModel):
    course_id: int
    name: str
    weight: float = 0.0
    weight_per_item: float | None = None
    aggregation: str = "average"
    drop_count: int = Field(default=0, ge=0)
    replace_count: int = Field(default=0, ge=0)
    include_bonus: bool = False
    is_bonus_category: bool = False
    replace_with_category_id: int | None = None


class CategoryUpdate(BaseModel):
    name: str | None = None
    weight: float | None = None
    weight_per_item: float | None = None
    aggregation: str | None = None
    drop_count: int | None = Field(default=None, ge=0)
    replace_count: int | None = Field(default=None, ge=0)
    include_bonus: bool | None = None
    is_bonus_category: bool | None = None
    replace_with_category_id: int | None = None


class CategoryOrderUpdate(BaseModel):
    category_ids: list[int]


class AssignmentCreate(BaseModel):
    category_id: int
    name: str = ""
    comment: str | None = Field(default=None, max_length=500)
    flag_ids: list[str] | None = None
    score: str | None = None
    earned: float | None = None
    possible: float | None = None
    is_bonus: bool = False
    bonus_type: str | None = None


class AssignmentUpdate(BaseModel):
    name: str | None = None
    comment: str | None = Field(default=None, max_length=500)
    flag_ids: list[str] | None = None
    score: str | None = None
    earned: float | None = None
    possible: float | None = None
    is_bonus: bool | None = None
    bonus_type: str | None = None
    clear_score: bool = False
    composite: dict | None = None
    clear_composite: bool = False


class ScaleRowIn(BaseModel):
    letter: str
    min_percent: float
    quality_points: float


class PassFailRowIn(BaseModel):
    label: str = Field(min_length=1, max_length=8)
    min_percent: float = Field(ge=0, le=100)
    is_passing: bool = False


class PassFailScaleIn(BaseModel):
    rows: list[PassFailRowIn] | None = None
    fail_affects_gpa: bool = False
    # Legacy fields remain accepted so old clients can still save settings.
    pass_label: str = Field(default="S", min_length=1, max_length=8)
    fail_label: str = Field(default="U", min_length=1, max_length=8)
    min_percent: float = Field(default=70.0, ge=0, le=100)


class ScaleUpdate(BaseModel):
    rows: list[ScaleRowIn]
    pass_fail: PassFailScaleIn | None = None
    minimum_passing_letter: str | None = None


class ScaleApply(BaseModel):
    scale_profile_id: int | None = None
    preset_id: str | None = None


class ScaleProfileCreate(BaseModel):
    name: str | None = None
    rows: list[ScaleRowIn] | None = None
    is_primary: bool = False
    preset_id: str | None = None
    pass_fail: PassFailScaleIn | None = None
    minimum_passing_letter: str | None = None


class ScaleProfileUpdate(BaseModel):
    name: str | None = None
    rows: list[ScaleRowIn] | None = None
    is_primary: bool | None = None
    sort_order: int | None = None
    preset_id: str | None = None
    pass_fail: PassFailScaleIn | None = None
    minimum_passing_letter: str | None = None


class SettingsUpdate(BaseModel):
    target_letter: str | None = None
    semesters_remaining: float | None = None
    gpa_cap: float | None = None
    fail_pass_fail_affects_gpa: bool | None = None
    future_guess: dict[str, Any] | None = None
    default_scale: list[ScaleRowIn] | None = None
    recording_interval_days: int | None = None
    default_recording_semester_id: int | None = None
    gradebook_type: str | None = None
    gpa_weight_tags: list[dict] | None = None
    gpa_basis: str | None = None
    high_school_overall_rounding: dict[str, Any] | None = None
    high_school_overall_rounding_by_period: dict[str, Any] | None = None
    high_school_term_weights_by_period: dict[str, Any] | None = None


class AcademicYearCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    semester_ids: list[int] = Field(min_length=1)


class AcademicYearUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    semester_ids: list[int] | None = Field(default=None, min_length=1)


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


class FumbleUpdate(BaseModel):
    should_have_been_gp: float | None = Field(None, description="Quality points, e.g. 4.333; null removes the class from the adjusted fumble calculation")
