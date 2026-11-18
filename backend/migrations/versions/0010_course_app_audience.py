"""courses: the AdhyaapakAI app's class, stream and goals

The course form now offers exactly what a student picks at sign-up in the app: a class (6-12),
a stream (Science, Commerce, Arts, General) and any of that stream's goals. They are stored as
plain values (not dashboard taxonomy terms): courses.class_level, courses.stream and
courses.target_goals (a JSON list). class_id / stream_id / subject_id stay as they were.

Existing courses get class_level and stream from their taxonomy terms when the names say so
("12" / "Class 12" -> 12, "commerce" -> Commerce); anything else is left empty.

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-16 12:00:00

"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STREAMS = ("Science", "Commerce", "Arts", "General")


def upgrade() -> None:
    with op.batch_alter_table("courses") as batch:
        batch.add_column(sa.Column("class_level", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("stream", sa.String(length=20), nullable=True))
        batch.add_column(sa.Column("target_goals", sa.JSON(), nullable=True))
        batch.create_check_constraint(
            op.f("ck_courses_class_level_range"),
            "class_level IS NULL OR (class_level BETWEEN 1 AND 12)",
        )

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT c.id, cl.name, st.name FROM courses c "
            "LEFT JOIN course_taxonomy_terms cl ON cl.id = c.class_id "
            "LEFT JOIN course_taxonomy_terms st ON st.id = c.stream_id"
        )
    ).all()
    for course_id, class_name, stream_name in rows:
        level = None
        found = re.search(r"\d+", class_name or "")
        if found and 6 <= int(found.group()) <= 12:
            level = int(found.group())
        stream = next(
            (s for s in STREAMS if (stream_name or "").strip().lower() == s.lower()), None
        )
        if level is not None or stream is not None:
            conn.execute(
                sa.text("UPDATE courses SET class_level = :level, stream = :stream WHERE id = :id"),
                {"level": level, "stream": stream, "id": course_id},
            )


def downgrade() -> None:
    with op.batch_alter_table("courses") as batch:
        batch.drop_constraint(op.f("ck_courses_class_level_range"), type_="check")
        batch.drop_column("target_goals")
        batch.drop_column("stream")
        batch.drop_column("class_level")
