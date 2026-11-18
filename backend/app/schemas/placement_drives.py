"""Placement Drives tools on the dashboard: a paper read from a PDF, and a results table to turn
into an Excel file. (Drives and results come from the AdhyaapakAI backend's admin API.)"""

from __future__ import annotations

from pydantic import Field, field_validator

from app.schemas.common import ApiModel, InputModel


class QuestionOut(ApiModel):
    section: str
    question: str
    options: list[str]
    correct_answer: int | None
    explanation: str


class ParsedQuestion(QuestionOut):
    needs_review: bool
    review_notes: list[str]


class ParsedPaper(ApiModel):
    title: str
    questions: list[ParsedQuestion]
    answer_key_found: bool
    warnings: list[str]


Cell = str | int | float | bool | None


class SheetIn(InputModel):
    """One sheet of a results table, as the app's admin API hands it out (results/sheet)."""

    name: str = Field(min_length=1, max_length=100)
    fields: list[str] = Field(min_length=1, max_length=2_000)
    rows: list[dict[str, Cell]] = Field(max_length=200_000)

    @field_validator("name")
    @classmethod
    def _sheet_name(cls, value: str) -> str:
        # Excel refuses these characters in a sheet's name.
        cleaned = "".join(" " if c in "[]:*?/\\" else c for c in value).strip()
        if not cleaned:
            raise ValueError("a sheet needs a name")
        return cleaned


class XlsxIn(InputModel):
    file: str = Field(pattern=r"^placement-drive-[0-9a-z-]{1,60}$")
    sheets: list[SheetIn] = Field(min_length=1, max_length=5)
