from __future__ import annotations

from contextvars import ContextVar

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from backend.migrations import CURRENT_SCHEMA_VERSION, apply_forward_migrations
from backend.paths import user_data_dir

DATA_DIR = user_data_dir()
# This is the stable v1 data path. Future releases must keep this filename and
# use numbered forward migrations when the schema changes.
DB_PATH = DATA_DIR / "grades-v1.db"
DEFAULT_GRADEBOOK_ID = "gradebook-1"

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

_gradebook_id = ContextVar("gradebook_id", default=None)


def set_gradebook_id(value: str | None):
    return _gradebook_id.set(value.strip() if isinstance(value, str) and value.strip() else None)


def reset_gradebook_id(token) -> None:
    _gradebook_id.reset(token)


def current_gradebook_id() -> str | None:
    return _gradebook_id.get()


def active_gradebook_id() -> str:
    """Return the selected gradebook, preserving unscoped API behavior."""
    return current_gradebook_id() or DEFAULT_GRADEBOOK_ID


class Base(DeclarativeBase):
    pass


def initialize_database() -> None:
    """Create the v1.4 baseline or migrate a known v1+ database forward.

    A database without a schema marker is from the pre-v1.4 format (or is
    incomplete), so it is deliberately rejected. The application then starts
    with the new clean-install database path instead of importing old data.
    """
    existing_tables = set(inspect(engine).get_table_names())
    if existing_tables and "schema_version" not in existing_tables:
        raise RuntimeError(
            "Unsupported pre-v1.4 database detected. This release starts with a clean database."
        )

    # Models are imported by backend.main before this function is called.
    Base.metadata.create_all(bind=engine)

    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_version ("
                "id INTEGER PRIMARY KEY CHECK (id = 1), "
                "version INTEGER NOT NULL"
                ")"
            )
        )
        row = conn.execute(text("SELECT version FROM schema_version WHERE id = 1")).first()
        if row is None:
            if existing_tables:
                raise RuntimeError("Database schema marker is incomplete; refusing to import unknown data")
            conn.execute(
                text("INSERT INTO schema_version (id, version) VALUES (1, :version)"),
                {"version": CURRENT_SCHEMA_VERSION},
            )
            return

        apply_forward_migrations(conn, int(row[0]))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
