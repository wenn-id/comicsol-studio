"""Durable Studio state in one SQLite file: projects, idempotency, runs, and activity."""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

MIGRATIONS: tuple[tuple[str, ...], ...] = (
    (
        """
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            storage_name TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            revision INTEGER NOT NULL CHECK (revision >= 1),
            fingerprint TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE creations (
            idempotency_key TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            subject TEXT NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            message TEXT,
            result TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
        """,
        "CREATE INDEX runs_project ON runs (project_id, created_at)",
        """
        CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            at REAL NOT NULL,
            kind TEXT NOT NULL,
            message TEXT NOT NULL,
            data TEXT
        )
        """,
        "CREATE INDEX events_project ON events (project_id, id)",
    ),
)

ACTIVE_RUN_STATES = ("queued", "running")


class Store:
    def __init__(self, path: Path, *, clock=time.time) -> None:
        self.path = path
        self.clock = clock
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
            row = db.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
            current = int(row["value"]) if row else 0
            if current > len(MIGRATIONS):
                raise RuntimeError("the Studio database was written by a newer Studio")
            for version in range(current, len(MIGRATIONS)):
                for statement in MIGRATIONS[version]:
                    db.execute(statement)
                db.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)",
                    (str(version + 1),),
                )
            # A process that stopped mid-run leaves nothing running behind it.
            db.execute(
                "UPDATE runs SET status = 'failed', message = ?, updated_at = ? "
                "WHERE status IN ('queued', 'running')",
                ("Studio stopped before this finished.", self.clock()),
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    # meta ---------------------------------------------------------------

    def meta(self, key: str) -> str | None:
        with self.read() as db:
            row = db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return None if row is None else str(row["value"])

    def set_meta_once(self, key: str, value: str) -> str:
        """Store `value` unless the key already exists; return the stored value."""
        with self.transaction() as db:
            db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", (key, value))
            row = db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return str(row["value"])

    # events -------------------------------------------------------------

    def add_event(
        self, project_id: str, kind: str, message: str, data: dict[str, Any] | None = None
    ) -> None:
        with self.transaction() as db:
            db.execute(
                "INSERT INTO events (project_id, at, kind, message, data) VALUES (?, ?, ?, ?, ?)",
                (
                    project_id,
                    self.clock(),
                    kind,
                    message,
                    None if data is None else json.dumps(data, sort_keys=True),
                ),
            )

    def events(self, project_id: str, *, after: int = 0, limit: int = 200) -> list[dict]:
        with self.read() as db:
            rows = db.execute(
                "SELECT id, at, kind, message, data FROM events "
                "WHERE project_id = ? AND id > ? ORDER BY id DESC LIMIT ?",
                (project_id, after, limit),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "at": row["at"],
                "kind": row["kind"],
                "message": row["message"],
                "data": None if row["data"] is None else json.loads(row["data"]),
            }
            for row in rows
        ]

    # runs ---------------------------------------------------------------

    def create_run(
        self, run_id: str, project_id: str, kind: str, subject: str, provider: str
    ) -> dict:
        now = self.clock()
        with self.transaction() as db:
            active = db.execute(
                "SELECT id FROM runs WHERE project_id = ? AND kind = ? AND subject = ? "
                "AND status IN ('queued', 'running')",
                (project_id, kind, subject),
            ).fetchone()
            if active is not None:
                return self._run(db, active["id"])
            db.execute(
                "INSERT INTO runs (id, project_id, kind, subject, provider, status, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
                (run_id, project_id, kind, subject, provider, now, now),
            )
            return self._run(db, run_id)

    def update_run(
        self,
        run_id: str,
        status: str,
        message: str | None = None,
        result: Any = None,
    ) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE runs SET status = ?, message = ?, result = ?, updated_at = ? "
                "WHERE id = ?",
                (
                    status,
                    message,
                    None if result is None else json.dumps(result, sort_keys=True),
                    self.clock(),
                    run_id,
                ),
            )

    def run(self, run_id: str) -> dict | None:
        with self.read() as db:
            return self._run(db, run_id)

    def runs(self, project_id: str, *, limit: int = 100) -> list[dict]:
        with self.read() as db:
            rows = db.execute(
                "SELECT id FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
                (project_id, limit),
            ).fetchall()
            return [self._run(db, row["id"]) for row in rows]  # type: ignore[misc]

    @staticmethod
    def _run(db: sqlite3.Connection, run_id: str) -> dict | None:
        row = db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "kind": row["kind"],
            "subject": row["subject"],
            "provider": row["provider"],
            "status": row["status"],
            "message": row["message"],
            "result": None if row["result"] is None else json.loads(row["result"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
