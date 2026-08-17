from __future__ import annotations

from pydantic import BaseModel, Field


class SemesterCreate(BaseModel):
    year: int
    season: str
    included: bool = True


class SemesterUpdate(BaseModel):
    year: int | None = None
    season: str | None = None
    included: bool | None = None


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
    exam_category_id: int | None = None


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
    snapshot_interval: str | None = None


class FumbleCreate(BaseModel):
    course_id: int
    should_have_been_gp: float = Field(..., description="Quality points, e.g. 4.333")


class CategoryTemplate(BaseModel):
    name: str
    weight: float = 0.0
    weight_per_item: float | None = None
    aggregation: str = "average"
    drop_count: int = Field(default=0, ge=0)
    include_bonus: bool = False
    replace_with: str | None = None


class CourseTemplate(BaseModel):
    code: str
    credits: float = 3.0
    categories: list[CategoryTemplate] = Field(default_factory=list)


class ExportRequest(BaseModel):
    course_ids: list[int] = Field(default_factory=list)


class ImportRequest(BaseModel):
    semester_id: int
    courses: list[CourseTemplate]
