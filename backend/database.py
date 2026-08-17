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
    if "courses" in tables:
        cols = {col["name"] for col in insp.get_columns("courses")}
        if "scale_profile_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE courses ADD COLUMN scale_profile_id INTEGER"))
    if "scale_profiles" in tables:
        cols = {col["name"] for col in insp.get_columns("scale_profiles")}
        if "preset_id" not in cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE scale_profiles ADD COLUMN preset_id VARCHAR(32)"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
