from __future__ import annotations

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.database import Base


class Semester(Base):
    __tablename__ = "semesters"
    __table_args__ = (UniqueConstraint("year", "season"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    year: Mapped[int] = mapped_column(Integer)
    season: Mapped[str] = mapped_column(String(16))
    included: Mapped[bool] = mapped_column(Boolean, default=True)

    courses: Mapped[list[Course]] = relationship(
        back_populates="semester", cascade="all, delete-orphan"
    )


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    semester_id: Mapped[int] = mapped_column(ForeignKey("semesters.id"))
    code: Mapped[str] = mapped_column(String(64))
    credits: Mapped[float] = mapped_column(Float, default=3.0)
    bonus_points: Mapped[float] = mapped_column(Float, default=0.0)
    gp_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Decimal places the professor rounds the final percent to before cutoffs; NULL means no rounding.
    grade_rounding: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scale_profile_id: Mapped[int | None] = mapped_column(
        ForeignKey("scale_profiles.id"), nullable=True
    )

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
    include_bonus: Mapped[bool] = mapped_column(Boolean, default=False)
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
    is_bonus: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    category: Mapped[Category] = relationship(back_populates="assignments")


class ScaleProfile(Base):
    __tablename__ = "scale_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), default="Default 1")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    preset_id: Mapped[str | None] = mapped_column(String(32), nullable=True)

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
    future_guess_json: Mapped[str] = mapped_column(Text, default="{}")
    default_scale_json: Mapped[str] = mapped_column(Text, default="[]")


class Fumble(Base):
    __tablename__ = "fumbles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id"))
    should_have_been_gp: Mapped[float] = mapped_column(Float)

    course: Mapped[Course] = relationship(back_populates="fumbles")
