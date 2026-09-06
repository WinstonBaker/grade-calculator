from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.database import Base


class Semester(Base):
    __tablename__ = "semesters"
    __table_args__ = (UniqueConstraint("gradebook_id", "year", "season"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    gradebook_id: Mapped[str] = mapped_column(String(64), default="gradebook-1", nullable=False, index=True)
    year: Mapped[int] = mapped_column(Integer)
    season: Mapped[str] = mapped_column(String(64))
    included: Mapped[bool] = mapped_column(Boolean, default=True)
    progression_locked: Mapped[bool] = mapped_column(Boolean, default=False)

    courses: Mapped[list[Course]] = relationship(
        back_populates="semester", cascade="all, delete-orphan"
    )
    grade_snapshots: Mapped[list[GradeSnapshot]] = relationship(
        back_populates="semester", cascade="all, delete-orphan"
    )


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    semester_id: Mapped[int] = mapped_column(ForeignKey("semesters.id"))
    code: Mapped[str] = mapped_column(String(64))
    credits: Mapped[float] = mapped_column(Float, default=3.0)
    bonus_points: Mapped[float] = mapped_column(Float, default=0.0)
    bonus_mode: Mapped[str] = mapped_column(String(16), default="none")
    gp_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Final/overall override is applied only when multi-term high-school
    # results are rolled up. It must never change the term grade.
    final_gp_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Decimal places the professor rounds the final percent to before cutoffs; NULL means no rounding.
    grade_rounding: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scale_profile_id: Mapped[int | None] = mapped_column(
        ForeignKey("scale_profiles.id"), nullable=True
    )
    # JSON list of category ids averaged for the "tests" side of exam impact.
    test_category_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    exam_category_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # "weighted" (category weights) or "points" (earned/possible across the course).
    grading_mode: Mapped[str] = mapped_column(String(16), default="weighted")
    # "for_credit" contributes to GPA; "pass_fail" records configured credit labels without GPA points.
    credit_mode: Mapped[str] = mapped_column(String(16), default="for_credit")
    pass_label: Mapped[str] = mapped_column(String(8), default="S")
    fail_label: Mapped[str] = mapped_column(String(8), default="U")
    pass_min_percent: Mapped[float] = mapped_column(Float, default=70.0)
    pass_fail_rows_json: Mapped[str] = mapped_column(Text, default="[]")
    minimum_passing_letter: Mapped[str] = mapped_column(String(8), default="C-")
    pass_fail_override: Mapped[str | None] = mapped_column(String(8), nullable=True)
    dynamic_weighting_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # JSON: {"options":[{"id":"...","weights":{"<category_id>":0.2}}]}
    dynamic_weighting_json: Mapped[str] = mapped_column(Text, default="{}")
    # High-school GPA weighting category. The configured boost lives on Settings.
    gpa_weight_tag: Mapped[str] = mapped_column(String(48), default="unweighted")

    semester: Mapped[Semester] = relationship(back_populates="courses")
    categories: Mapped[list[Category]] = relationship(
        back_populates="course", cascade="all, delete-orphan"
    )
    scale_rows: Mapped[list[GradeScale]] = relationship(
        back_populates="course", cascade="all, delete-orphan"
    )
    fumbles: Mapped[list[Fumble]] = relationship(
        back_populates="course", cascade="all, delete-orphan"
    )


class GradeScale(Base):
    __tablename__ = "grade_scales"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id"))
    letter: Mapped[str] = mapped_column(String(8))
    min_percent: Mapped[float] = mapped_column(Float)
    quality_points: Mapped[float] = mapped_column(Float)

    course: Mapped[Course] = relationship(back_populates="scale_rows")


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id"))
    name: Mapped[str] = mapped_column(String(64))
    weight: Mapped[float] = mapped_column(Float, default=0.0)
    weight_per_item: Mapped[float | None] = mapped_column(Float, nullable=True)
    aggregation: Mapped[str] = mapped_column(String(32), default="average")
    drop_count: Mapped[int] = mapped_column(Integer, default=0)
    replace_count: Mapped[int] = mapped_column(Integer, default=1)
    include_bonus: Mapped[bool] = mapped_column(Boolean, default=False)
    is_bonus_category: Mapped[bool] = mapped_column(Boolean, default=False)
    replace_with_category_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    course: Mapped[Course] = relationship(back_populates="categories")
    assignments: Mapped[list[Assignment]] = relationship(
        back_populates="category", cascade="all, delete-orphan"
    )


class Assignment(Base):
    __tablename__ = "assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    name: Mapped[str] = mapped_column(String(64), default="")
    earned: Mapped[float | None] = mapped_column(Float, nullable=True)
    possible: Mapped[float | None] = mapped_column(Float, nullable=True)
    score_text: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # JSON composite definition for a main assignment; subassignments are kept inline.
    composite_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_bonus: Mapped[bool] = mapped_column(Boolean, default=False)
    bonus_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    comment: Mapped[str | None] = mapped_column(String(500), nullable=True)
    flag_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    category: Mapped[Category] = relationship(back_populates="assignments")


class ScaleProfile(Base):
    __tablename__ = "scale_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    gradebook_id: Mapped[str] = mapped_column(String(64), default="gradebook-1", nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(64), default="Default 1")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    preset_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    pass_label: Mapped[str] = mapped_column(String(8), default="S")
    fail_label: Mapped[str] = mapped_column(String(8), default="U")
    pass_min_percent: Mapped[float] = mapped_column(Float, default=70.0)
    pass_fail_rows_json: Mapped[str] = mapped_column(Text, default="[]")
    minimum_passing_letter: Mapped[str] = mapped_column(String(8), default="C-")

    rows: Mapped[list[ScaleProfileRow]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )


class ScaleProfileRow(Base):
    __tablename__ = "scale_profile_rows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("scale_profiles.id"))
    letter: Mapped[str] = mapped_column(String(8))
    min_percent: Mapped[float] = mapped_column(Float)
    quality_points: Mapped[float] = mapped_column(Float)

    profile: Mapped[ScaleProfile] = relationship(back_populates="rows")


class Settings(Base):
    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    target_letter: Mapped[str] = mapped_column(String(8), default="A")
    semesters_remaining: Mapped[float] = mapped_column(Float, default=8)
    gpa_cap: Mapped[float | None] = mapped_column(Float, nullable=True)
    fail_pass_fail_affects_gpa: Mapped[bool] = mapped_column(Boolean, default=False)
    future_guess_json: Mapped[str] = mapped_column(Text, default="{}")
    default_scale_json: Mapped[str] = mapped_column(Text, default="[]")
    appearance_json: Mapped[str] = mapped_column(Text, default="{}")
    recording_interval_days: Mapped[int] = mapped_column(Integer, default=7)
    grade_prompt_snooze_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    default_recording_semester_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Legacy storage values "college" and "high_school" preserve the original
    # Single-term and Multi-term behaviors for existing gradebooks.
    # uses per-year course units and optional configured grade-point boosts.
    gradebook_type: Mapped[str] = mapped_column(String(24), default="college")
    # [{"id":"unweighted","name":"Unweighted","boost":0}, ...]
    gpa_weight_tags_json: Mapped[str] = mapped_column(Text, default="[]")
    gpa_basis: Mapped[str] = mapped_column(String(16), default="credits")
    # JSON map of gradebook id -> settings values scoped to that gradebook.
    gradebook_settings_json: Mapped[str] = mapped_column(Text, default="{}")
    # User-owned application metadata lives in the same database as grades.
    gradebooks_json: Mapped[str] = mapped_column(
        Text, default='[{"id":"gradebook-1","name":"Gradebook 1"}]'
    )
    gradebook_members_json: Mapped[str] = mapped_column(Text, default="{}")
    gradebook_appearance_json: Mapped[str] = mapped_column(Text, default="{}")
    min_credits: Mapped[str] = mapped_column(String(16), default="1")


class AcademicYear(Base):
    __tablename__ = "academic_years"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    gradebook_id: Mapped[str] = mapped_column(String(64), default="gradebook-1", nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(64))
    # Ordered list of Semester ids. This supports Fall 2026 + Spring 2027 and
    # years with two, three, or another number of terms.
    semester_ids_json: Mapped[str] = mapped_column(Text, default="[]")


class GradeSnapshot(Base):
    __tablename__ = "grade_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    semester_id: Mapped[int] = mapped_column(ForeignKey("semesters.id"))
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    term_gpa: Mapped[float | None] = mapped_column(Float, nullable=True)
    term_wgpa: Mapped[float | None] = mapped_column(Float, nullable=True)
    # JSON: [{"course_id":1,"code":"MAE 310","percent":92.5}]
    courses_json: Mapped[str] = mapped_column(Text, default="[]")

    semester: Mapped[Semester] = relationship(back_populates="grade_snapshots")


class Fumble(Base):
    __tablename__ = "fumbles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id"))
    should_have_been_gp: Mapped[float | None] = mapped_column(Float, nullable=True)

    course: Mapped[Course] = relationship(back_populates="fumbles")
