import pytest
from sqlalchemy import create_engine, inspect, text

import backend.database as database
from backend.migrations import apply_forward_migrations
from backend.models import AcademicYear, Assignment, Category, Course, Fumble, GradeScale, GradeSnapshot, ScaleProfile, ScaleProfileRow, Semester, Settings


def test_forward_migrations_run_in_order_and_update_marker():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)"))
        conn.execute(text("INSERT INTO schema_version (id, version) VALUES (1, 1)"))
        events = []

        def migrate_two(connection):
            events.append("v2")

        def migrate_three(connection):
            events.append("v3")

        final = apply_forward_migrations(
            conn,
            1,
            target_version=3,
            migrations={2: migrate_two, 3: migrate_three},
        )
        stored = conn.execute(text("SELECT version FROM schema_version WHERE id = 1")).scalar_one()

    assert final == 3
    assert stored == 3
    assert events == ["v2", "v3"]


def test_missing_future_migration_fails_loudly():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)"))
        conn.execute(text("INSERT INTO schema_version (id, version) VALUES (1, 1)"))
        with pytest.raises(RuntimeError, match="Missing migration"):
            apply_forward_migrations(conn, 1, target_version=2, migrations={})


def test_unmarked_database_is_rejected_instead_of_adopted(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE semesters (id INTEGER PRIMARY KEY, year INTEGER, season TEXT)"))
    monkeypatch.setattr(database, "engine", engine)

    with pytest.raises(RuntimeError, match="pre-v1.4"):
        database.initialize_database()


def test_clean_database_gets_baseline_marker(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    monkeypatch.setattr(database, "engine", engine)
    database.initialize_database()

    with engine.connect() as conn:
        version = conn.execute(text("SELECT version FROM schema_version WHERE id = 1")).scalar_one()
    assert version == database.CURRENT_SCHEMA_VERSION
    assert "schema_version" in inspect(engine).get_table_names()
