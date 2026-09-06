"""Forward-only database migrations.

Schema version 1 is the clean-install baseline shipped as application v1.4.
Databases from before that baseline are intentionally not imported. Every
later schema change must add one numbered migration and leave the existing
v1+ data path intact.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping

from sqlalchemy import text
from sqlalchemy.engine import Connection


# Keep this number stable for the v1.4 data format. Future releases increment
# it and register the migration that moves the previous format forward.
CURRENT_SCHEMA_VERSION = 3
Migration = Callable[[Connection], None]


def _migrate_v2(connection: Connection) -> None:
    connection.execute(
        text(
            "ALTER TABLE categories "
            "ADD COLUMN replace_count INTEGER NOT NULL DEFAULT 1"
        )
    )


def _migrate_v3(connection: Connection) -> None:
    connection.execute(
        text(
            "ALTER TABLE settings "
            "ADD COLUMN gradebooks_json TEXT NOT NULL DEFAULT "
            "'[{\"id\":\"gradebook-1\",\"name\":\"Gradebook 1\"}]'"
        )
    )
    connection.execute(
        text("ALTER TABLE settings ADD COLUMN gradebook_members_json TEXT NOT NULL DEFAULT '{}'" )
    )
    connection.execute(
        text("ALTER TABLE settings ADD COLUMN gradebook_appearance_json TEXT NOT NULL DEFAULT '{}'" )
    )
    connection.execute(
        text("ALTER TABLE settings ADD COLUMN min_credits VARCHAR(16) NOT NULL DEFAULT '1'" )
    )


MIGRATIONS: dict[int, Migration] = {2: _migrate_v2, 3: _migrate_v3}


def apply_forward_migrations(
    conn: Connection,
    current_version: int,
    *,
    target_version: int = CURRENT_SCHEMA_VERSION,
    migrations: Mapping[int, Migration] = MIGRATIONS,
) -> int:
    """Apply each migration after ``current_version`` in order.

    A missing migration is an application error rather than a reason to guess
    how to reshape user data. Each migration and its version update run in the
    caller's transaction.
    """
    version = int(current_version)
    target = int(target_version)
    if version < 0:
        raise RuntimeError(f"Invalid database schema version: {version}")
    if version > target:
        raise RuntimeError(
            f"Database schema version {version} is newer than this application supports ({target})"
        )

    while version < target:
        next_version = version + 1
        migration = migrations.get(next_version)
        if migration is None:
            raise RuntimeError(f"Missing migration for database schema version {next_version}")
        migration(conn)
        conn.execute(
            text("UPDATE schema_version SET version = :version WHERE id = 1"),
            {"version": next_version},
        )
        version = next_version
    return version
