"""remove the old Courses module (the dashboard's own course catalogue)

The Course Management "Courses" and "Enrollments" tabs kept courses, lectures, files and
enrollments in this database; the AdhyaapakAI app never read them. Course Management now
works on the app itself (App videos, Courses & prices), so those tables are dropped.

Downgrade recreates them empty, exactly as 0008-0010 made them (the rows are not restored:
restore a backup for that).

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-16

"""

import importlib.util
from collections.abc import Sequence
from pathlib import Path

from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Children first: every foreign key points at a table dropped after it.
TABLES = (
    "course_lecture_variants",
    "course_lecture_resources",
    "course_lectures",
    "course_chapters",
    "course_playlists",
    "course_enrollment_events",
    "course_enrollments",
    "courses",
    "course_assets",
    "course_taxonomy_terms",
)
_REBUILD = (
    "0008_course_management.py",
    "0009_course_contract_alignment.py",
    "0010_course_app_audience.py",
)


def upgrade() -> None:
    for table in TABLES:
        op.drop_table(table)


def downgrade() -> None:
    here = Path(__file__).parent
    for name in _REBUILD:
        spec = importlib.util.spec_from_file_location(f"_rebuild_{name[:4]}", here / name)
        assert spec is not None and spec.loader is not None  # noqa: S101 - files ship together
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.upgrade()
