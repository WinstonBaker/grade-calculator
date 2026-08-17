from __future__ import annotations

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from backend.paths import user_data_dir

DATA_DIR = user_data_dir()
DB_PATH = DATA_DIR / "grades.db"

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def ensure_schema() -> None:
    """Add columns that create_all will not attach to an existing SQLite file."""
    insp = inspect(engine)
    tables = set(insp.get_table_names())
    if "settings" in tables:
        cols = {col["name"] for col in insp.get_columns("settings")}
        if "default_scale_json" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE settings ADD COLUMN default_scale_json TEXT DEFAULT '[]'"))
        if "gpa_cap" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE settings ADD COLUMN gpa_cap FLOAT"))
    if "courses" in tables:
        cols = {col["name"] for col in insp.get_columns("courses")}
        if "scale_profile_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE courses ADD COLUMN scale_profile_id INTEGER"))
        if "grade_rounding" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE courses ADD COLUMN grade_rounding INTEGER"))
        if "test_category_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE courses ADD COLUMN test_category_id INTEGER"))
        if "exam_category_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE courses ADD COLUMN exam_category_id INTEGER"))
    if "scale_profiles" in tables:
        cols = {col["name"] for col in insp.get_columns("scale_profiles")}
        if "preset_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE scale_profiles ADD COLUMN preset_id VARCHAR(32)"))
    if "categories" in tables:
        cols = {col["name"] for col in insp.get_columns("categories")}
        added_include_bonus = False
        if "include_bonus" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE categories ADD COLUMN include_bonus BOOLEAN DEFAULT 0"))
            added_include_bonus = True
        with engine.begin() as conn:
            migrate_legacy_category_modes(conn, reset_plain_drop_counts=added_include_bonus)


def migrate_legacy_category_modes(conn, *, reset_plain_drop_counts: bool) -> None:
    """Map packed aggregation strings onto orthogonal category knobs."""
    if reset_plain_drop_counts:
        conn.execute(
            text(
                "UPDATE categories SET include_bonus = 1, drop_count = 0, aggregation = 'average' "
                "WHERE aggregation = 'average_plus_bonus'"
            )
        )
        conn.execute(
            text(
                "UPDATE categories SET drop_count = 0, aggregation = 'average' "
                "WHERE aggregation = 'replace_min_with'"
            )
        )
        conn.execute(
            text(
                "UPDATE categories SET drop_count = 0 "
                "WHERE aggregation IN ('average', 'points_ratio')"
            )
        )
        conn.execute(
            text("UPDATE categories SET aggregation = 'average' WHERE aggregation = 'drop_lowest'")
        )
        return
    leftover = conn.execute(
        text(
            "SELECT COUNT(*) FROM categories WHERE aggregation IN "
            "('drop_lowest', 'average_plus_bonus', 'replace_min_with')"
        )
    ).scalar()
    if not leftover:
        return
    conn.execute(
        text(
            "UPDATE categories SET include_bonus = 1, drop_count = 0, aggregation = 'average' "
            "WHERE aggregation = 'average_plus_bonus'"
        )
    )
    conn.execute(
        text(
            "UPDATE categories SET drop_count = 0, aggregation = 'average' "
            "WHERE aggregation = 'replace_min_with'"
        )
    )
    conn.execute(
        text("UPDATE categories SET aggregation = 'average' WHERE aggregation = 'drop_lowest'")
    )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
