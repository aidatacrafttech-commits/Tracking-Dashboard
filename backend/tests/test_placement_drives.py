"""Placement Drives tools on the dashboard: reading a question paper from a PDF, and turning a
results table (from the AdhyaapakAI backend's admin API) into an Excel file. The drives and
their rules are tested in the AdhyaapakAI backend (tests/test_admin_placement.py)."""

from __future__ import annotations

import io
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.main import create_app
from app.services import placement_paper as paper
from tests.conftest import OWNER_TOKEN, VIEWER_TOKEN, make_settings

A = "/api/v1/placement-drives"
OWNER = {"Authorization": f"Bearer {OWNER_TOKEN}"}
VIEWER = {"Authorization": f"Bearer {VIEWER_TOKEN}"}


@pytest.fixture
def api(db_path: Path) -> Iterator[TestClient]:
    application = create_app(make_settings(db_path), start_scheduler=False)
    with TestClient(application) as c:
        yield c
    application.state.engine.dispose()


def error(resp: Any) -> str:
    return str(resp.json()["error"]["code"])


def test_owner_only(api: TestClient) -> None:
    assert api.post(f"{A}/parse-pdf", headers=VIEWER, content=b"%PDF-").status_code == 403
    assert api.post(f"{A}/xlsx", headers=VIEWER, json={}).status_code == 403
    assert api.post(f"{A}/parse-pdf", content=b"%PDF-").status_code == 401


def test_the_old_direct_routes_are_gone(api: TestClient) -> None:
    for path in ("/status", "/drives", "/results?date=2026-12-02", "/sheet-key"):
        assert api.get(A + path, headers=OWNER).status_code == 404


# --- Reading a paper from a PDF ----------------------------------------------------------------


def make_pdf(lines: list[str]) -> bytes:
    """A small one-page PDF with real text (Helvetica), built by hand."""

    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    stream = "BT /F1 10 Tf 12 TL 40 800 Td " + " ".join(f"({esc(t)}) Tj T*" for t in lines) + " ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        "/Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return out


SAMPLE = [
    "Placement Drive Assessment - Technical MCQ Test",
    "Section A: SQL (2 Questions)",
    "1. Which SQL command is used to retrieve data from a table?",
    "A) INSERT B) SELECT C) UPDATE D) DELETE",
    "2. Which clause filters rows",
    "after grouping?",
    "(a) WHERE",
    "(b) HAVING",
    "(c) ORDER BY",
    "(d) LIMIT",
    "Explanation: HAVING filters groups.",
    "Section B: DBMS",
    "3. Which normal form removes partial dependency?",
    "A. 1NF",
    "B. 2NF",
    "C. 3NF",
    "D. BCNF",
    "Answer: B",
    "4. What does the A in ACID stand for?",
    "A) Atomicity",
    "B) Availability",
    "C) Accuracy",
    "Answer Key",
    "1-B 2-B 3-B",
]


def pdf(api: TestClient, data: bytes, kind: str = "application/pdf") -> Any:
    return api.post(f"{A}/parse-pdf", headers={**OWNER, "Content-Type": kind}, content=data)


def test_a_pdf_becomes_questions_for_review(api: TestClient) -> None:
    resp = pdf(api, make_pdf(SAMPLE))

    assert resp.status_code == 200, resp.text
    out = resp.json()
    qs = out["questions"]
    assert out["title"] == "Placement Drive Assessment - Technical MCQ Test"
    assert out["answer_key_found"] is True
    assert [q["section"] for q in qs] == ["SQL", "SQL", "DBMS", "DBMS"]
    assert qs[0]["options"] == ["INSERT", "SELECT", "UPDATE", "DELETE"]
    assert qs[0]["correct_answer"] == 1 and qs[0]["needs_review"] is False
    assert qs[1]["question"] == "Which clause filters rows after grouping?"
    assert qs[1]["explanation"] == "HAVING filters groups."
    assert qs[2]["correct_answer"] == 1 and qs[2]["review_notes"] == []
    # Q4: three options and no answer, so it's flagged for the admin.
    assert qs[3]["correct_answer"] is None and qs[3]["needs_review"] is True
    notes = " ".join(qs[3]["review_notes"])
    assert "option" in notes and "No answer" in notes


def test_only_readable_pdfs_up_to_10_mb(api: TestClient) -> None:
    assert pdf(api, b"hello", "text/plain").status_code == 415
    resp = pdf(api, b"not really a pdf")
    assert resp.status_code == 400 and error(resp) == "pdf_unreadable"
    assert pdf(api, b"%PDF-1.4\n" + b"0" * (paper.MAX_PDF_BYTES + 1)).status_code == 413
    resp = pdf(api, make_pdf([]))  # no text, like a scan
    assert resp.status_code == 400 and "No text" in resp.json()["error"]["message"]


def test_the_reader_handles_common_layouts() -> None:
    out = paper.parse_text(
        "\n".join(
            [
                "Q1. Part of a",
                "longer question?",  # a wrapped line, not a section heading
                "(A) one (B) two (C) three (D) four",
                "Ans: (c)",
                "Page 1 of 2",
                "Q3) Skipped a number?",
                "A) w",
                "B) x",
                "C) y",
                "D) z",
            ]
        )  # fmt: skip
    )
    q1, q2 = out["questions"]
    assert q1["question"] == "Part of a longer question?" and q1["correct_answer"] == 2
    assert q1["options"] == ["one", "two", "three", "four"] and q1["needs_review"] is False
    assert q2["needs_review"] and any("expected 2" in n for n in q2["review_notes"])
    assert any("No section headings" in w for w in out["warnings"])


# --- The Excel file ----------------------------------------------------------------------------


def test_reading_a_pdf_needs_no_app_database(db_path: Path) -> None:
    application = create_app(make_settings(db_path), start_scheduler=False)
    with TestClient(application) as c:
        resp = c.post(
            f"{A}/parse-pdf",
            headers={**OWNER, "Content-Type": "application/pdf"},
            content=make_pdf(SAMPLE),
        )
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["questions"]) == 4


def test_a_results_table_becomes_an_excel_file(db_path: Path) -> None:
    sheet = {
        "name": "2026-12-01 to 2026-12-31",
        "fields": ["candidate_name", "score", "Q1"],
        "rows": [
            {"candidate_name": "=HYPERLINK(1)", "score": 2, "Q1": "A"},
            {"candidate_name": "ANSWER KEY", "score": None, "Q1": "B"},
        ],
    }
    body = {"file": "placement-drive-2026-12-01-to-2026-12-31", "sheets": [sheet]}
    application = create_app(make_settings(db_path), start_scheduler=False)  # no app database
    with TestClient(application) as c:
        assert c.post(f"{A}/xlsx", headers=VIEWER, json=body).status_code == 403
        assert c.post(f"{A}/xlsx", json=body).status_code == 401
        bad = c.post(f"{A}/xlsx", headers=OWNER, json={**body, "file": "../evil"})
        assert bad.status_code == 422
        resp = c.post(f"{A}/xlsx", headers=OWNER, json=body)

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-disposition"] == (
        'attachment; filename="placement-drive-2026-12-01-to-2026-12-31.xlsx"'
    )
    ws = load_workbook(io.BytesIO(resp.content)).active
    assert ws.title == "2026-12-01 to 2026-12-31"
    values = [[c.value for c in row] for row in ws.iter_rows()]
    assert values[0] == ["candidate_name", "score", "Q1"]
    assert values[2] == ["ANSWER KEY", None, "B"]
    cell = ws.cell(row=2, column=1)
    assert cell.value == "=HYPERLINK(1)" and cell.data_type == "s"  # text, not a formula
