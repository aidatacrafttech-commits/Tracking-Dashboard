"""Placement drive tools the dashboard keeps for itself (nothing of the app's here):

- parse_pdf: reads an uploaded question paper (a PDF) into questions for the admin to check
  before the drive is saved through the AdhyaapakAI backend's admin API.
- results_xlsx: the Excel file of a results table the admin API hands out (results/sheet).

The drives, their rules and their results live in the AdhyaapakAI backend
(routes/admin_placement.py); the dashboard only calls its admin API.
"""

from __future__ import annotations

import io
import re
from typing import Any

LETTERS = "ABCD"


def _number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 200


class PaperError(ValueError):
    """The upload can't be read as a paper (the message is shown to the admin)."""


_QUESTION = re.compile(r"^(?:Q(?:uestion)?\s*\.?\s*)?(\d{1,3})\s*[.):]\s*(.*)$", re.I)
_OPTION = re.compile(r"^\(?([A-Da-d])\s*[.)\]:]\s*(.*)$")
# Several options on one line: "A) SELECT   B) INSERT ...". Capitals only, so a word that
# ends in "a." mid-sentence isn't taken for an option.
_INLINE_OPTION = re.compile(r"(?:^|\s)\(?([A-D])[.)\]]\s+")
_ANSWER = re.compile(
    r"^(?:correct\s+)?(?:answer|ans)\s*(?:is)?\s*[:.\-–]?\s*\(?([A-Da-d])\)?(?:[.)\s]|$)(.*)$",
    re.I,
)
_EXPLANATION = re.compile(r"^(?:explanation|solution|reason)\s*[:.\-–]\s*(.*)$", re.I)
_SECTION = re.compile(r"^(?i:section|part)\b\s*([A-Z]|\d{1,2}|[IVX]{1,4})?\b\s*[:.\-–—]?\s*(.*)$")
_SECTION_TAIL = re.compile(r"\s*[\-–—:(]*\s*\d+\s*(?:questions?|qs?|marks?|mcqs?)\)?\s*$", re.I)
_KEY_HEADING = re.compile(r"^(?:answer\s*key|answers|answer\s*sheet|key)\s*[:.\-–]?\s*$", re.I)
_KEY_PAIR = re.compile(r"(?:Q\s*)?(\d{1,3})\s*[.):\-–=]?\s*\(?([A-Da-d])\)?(?![A-Za-z])")
_PAGE_NOISE = re.compile(r"^(?:page\s*\d+(?:\s*(?:of|/)\s*\d+)?|\d{1,3})$", re.I)


def pdf_text(data: bytes) -> str:
    """All text in a PDF, page by page. PaperError for anything that isn't a readable PDF."""
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    if len(data) > MAX_PDF_BYTES:
        raise PaperError("The PDF is larger than 10 MB.")
    if not data.startswith(b"%PDF-"):
        raise PaperError("That file isn't a PDF.")
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise PaperError("The PDF is password-protected. Upload an unprotected copy.")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise PaperError(f"The PDF has more than {MAX_PDF_PAGES} pages.")
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except PaperError:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise PaperError("The PDF couldn't be read. Try saving it again as a PDF.") from exc
    if not text.strip():
        raise PaperError(
            "No text found in the PDF. A scanned paper (an image of text) can't be read; "
            "upload one with real text."
        )
    return text


def parse_pdf(data: bytes) -> dict[str, Any]:
    return parse_text(pdf_text(data))


def parse_text(text: str) -> dict[str, Any]:
    """Questions found in a paper's text, for the admin to review before saving.

    Each question has section, question, options (4 slots), correct_answer (0-3, or None
    when the paper doesn't give it), explanation, needs_review and review_notes (why the
    reader isn't sure). Nothing is saved."""
    lines = [" ".join(line.replace(" ", " ").split()) for line in text.splitlines()]
    lines = [line for line in lines if line and not _PAGE_NOISE.match(line)]

    body, key_lines = lines, []
    for i, line in enumerate(lines):
        if _KEY_HEADING.match(line) and i > 0:
            body, key_lines = lines[:i], lines[i + 1 :]
            break
    key: dict[int, int] = {}
    for line in key_lines:
        for n, letter in _KEY_PAIR.findall(line):
            key.setdefault(int(n), LETTERS.index(letter.upper()))

    title = ""
    section: str | None = None
    sections_seen = False
    found: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    part: str | None = None  # "question" | "option" | "explanation"
    skip: set[int] = set()
    for i, line in enumerate(body):
        if i in skip:
            continue
        heading = _section_heading(body, i)
        if heading:
            section, sections_seen, current, part = heading[0], True, None, None
            if heading[1]:
                skip.add(i + 1)  # the heading's name was on the next line
            continue
        m = _QUESTION.match(line)
        if m and m.group(2) and not _ANSWER.match(m.group(2)):
            current = {
                "printed_number": int(m.group(1)),
                "section": section,
                "question": m.group(2),
                "options": [],
                "inline_answer": None,
                "explanation": "",
            }
            found.append(current)
            part = "question"
            continue
        if current is None:
            if not found and not title and len(line) <= 160:
                title = line
            continue
        m = _ANSWER.match(line)
        if m:
            current["inline_answer"] = LETTERS.index(m.group(1).upper())
            m2 = _EXPLANATION.match(m.group(2).strip(" .-–:"))
            if m2:
                current["explanation"], part = m2.group(1), "explanation"
            continue
        m = _EXPLANATION.match(line)
        if m:
            current["explanation"], part = m.group(1), "explanation"
            continue
        if _OPTION.match(line) and part != "explanation":
            current["options"].extend(_split_options(line))
            part = "option"
            continue
        # A continuation of whatever came last.
        if part == "question":
            current["question"] += " " + line
        elif part == "option" and current["options"]:
            letter, value = current["options"][-1]
            current["options"][-1] = (letter, f"{value} {line}".strip())
        elif part == "explanation":
            current["explanation"] += " " + line

    questions = [_review(raw, key, sections_seen) for raw in found]
    expected = 1
    for q, raw in zip(questions, found, strict=True):
        n = raw["printed_number"]
        if n != expected:
            q["review_notes"].append(
                f"Numbered {n} in the PDF; expected {expected}. Check nothing was missed or merged."
            )
        expected = n + 1
        q["needs_review"] = bool(q["review_notes"])

    warnings = []
    if not questions:
        warnings.append(
            "No questions found. Questions should start with a number (1. or Q1.) and have "
            "options A) to D)."
        )
    if not sections_seen and questions:
        warnings.append(
            'No section headings found ("Section A: SQL"); every question is in "General". '
            "Set the sections."
        )
    if questions and not key and all(q["correct_answer"] is None for q in questions):
        warnings.append("No answers found in the PDF. Pick the correct option for every question.")
    return {
        "title": title,
        "questions": questions,
        "answer_key_found": bool(key),
        "warnings": warnings,
    }


def _review(raw: dict[str, Any], key: dict[int, int], sections_seen: bool) -> dict[str, Any]:
    notes = []
    by_letter: dict[str, str] = {}
    for letter, value in raw["options"]:
        by_letter.setdefault(letter, value.strip())
    options = [by_letter.get(letter, "") for letter in LETTERS]
    if sum(1 for o in options if o) != 4 or len(raw["options"]) != 4:
        notes.append(f"Found {len(raw['options'])} option(s); a question needs exactly four (A-D).")
    answer = key.get(raw["printed_number"])
    inline = raw["inline_answer"]
    if answer is not None and inline is not None and answer != inline:
        notes.append(
            f"The answer key says {LETTERS[answer]} but the question says {LETTERS[inline]}."
        )
    if answer is None:
        answer = inline
    if answer is None:
        notes.append("No answer found. Pick the correct option.")
    section = raw["section"]
    if not section:
        section = "General"
        if sections_seen:
            notes.append("Comes before the first section heading. Set its section.")
    if len(raw["question"]) > 600:
        notes.append("Very long question text: it may include text that isn't part of it.")
    return {
        "section": section,
        "question": raw["question"].strip(),
        "options": options,
        "correct_answer": answer,
        "explanation": raw["explanation"].strip(),
        "needs_review": bool(notes),
        "review_notes": notes,
    }


def _section_heading(lines: list[str], i: int) -> tuple[str, bool] | None:
    """(name, name_on_next_line) when lines[i] is a heading such as "Section A: SQL
    (8 Questions)". Only taken as one when a question follows, so a question that wraps
    onto a line starting "Part of ..." isn't split."""
    line = lines[i]
    m = _SECTION.match(line)
    if not m or len(line) > 80 or _OPTION.match(line):
        return None
    name = _SECTION_TAIL.sub("", m.group(2)).strip(" -–—:")
    nxt = lines[i + 1] if i + 1 < len(lines) else ""
    if _QUESTION.match(nxt):
        return (name or f"Section {m.group(1) or ''}".strip(), False)
    # "Section A" with the subject on its own line, then the first question.
    after = lines[i + 2] if i + 2 < len(lines) else ""
    if not name and nxt and len(nxt) <= 60 and not _OPTION.match(nxt) and _QUESTION.match(after):
        return (_SECTION_TAIL.sub("", nxt).strip(" -–—:") or nxt, True)
    return None


def _split_options(line: str) -> list[tuple[str, str]]:
    """[(letter, text)] for one line holding one or more options."""
    marks = list(_INLINE_OPTION.finditer(line))
    if len(marks) > 1 and marks[0].start() == 0:
        out = []
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(line)
            out.append((m.group(1).upper(), line[m.end() : end].strip()))
        return out
    m = _OPTION.match(line)
    assert m is not None  # noqa: S101 - callers check _OPTION first
    return [(m.group(1).upper(), m.group(2).strip())]


# --- Excel -----------------------------------------------------------------------------------


# The largest results table the dashboard turns into an Excel file (POST /placement-drives/xlsx).
XLSX_MAX_BYTES = 32 * 1024 * 1024


def results_xlsx(sheets: list[tuple[str, list[str], list[dict[str, Any]]]]) -> bytes:
    """A workbook with one sheet per (title, fields, rows). Every value is written as data,
    never as a formula: a candidate name typed as "=..." stays text."""
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    wb.remove(wb.active)
    for title, fields, rows in sheets:
        ws = wb.create_sheet(title=title[:31])
        ws.append(fields)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for r, row in enumerate(rows, 2):
            for c, field in enumerate(fields, 1):
                value = row.get(field, "")
                cell = ws.cell(row=r, column=c, value="" if value is None else value)
                if isinstance(value, str) and value.startswith("="):
                    cell.data_type = "s"
        ws.freeze_panes = "A2"
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
