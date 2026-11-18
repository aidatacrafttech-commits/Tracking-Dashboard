"""Placement drives: the two tools the dashboard keeps for the Placement Drives screen. The
drives themselves are read and saved through the AdhyaapakAI backend's admin API
(/api/admin/placement, x-admin-secret); nothing here touches the app.

POST /api/v1/placement-drives/parse-pdf  body: the PDF (application/pdf, 10 MB max): questions
                                         for review; nothing is saved or kept
POST /api/v1/placement-drives/xlsx       body: {file, sheets: [{name, fields, rows}]}, a results
                                         table from the admin API (results/sheet): the Excel file.
                                         Nothing is logged or kept.

Owner only: papers carry answer keys and results carry students' details.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app.core.errors import AppError
from app.core.security import require_owner
from app.schemas.placement_drives import ParsedPaper, XlsxIn
from app.services.placement_paper import MAX_PDF_BYTES, PaperError, parse_pdf, results_xlsx

router = APIRouter(
    prefix="/placement-drives", tags=["placement drives"], dependencies=[Depends(require_owner)]
)
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class PdfError(AppError):
    def __init__(self, status_code: int, message: str, code: str) -> None:
        super().__init__(message, code=code)
        self.status_code = status_code


@router.post("/parse-pdf", response_model=ParsedPaper)
async def parse_pdf_upload(request: Request) -> ParsedPaper:
    """The PDF is read in memory and dropped: nothing is stored."""
    kind = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if kind != "application/pdf":
        raise PdfError(415, "Upload a PDF file.", "pdf_required")
    data = await request.body()
    if len(data) > MAX_PDF_BYTES:
        raise PdfError(413, "The PDF is larger than 10 MB.", "pdf_too_large")
    try:
        parsed = await run_in_threadpool(parse_pdf, data)
    except PaperError as exc:
        raise PdfError(400, str(exc), "pdf_unreadable") from exc
    finally:
        del data
    return ParsedPaper.model_validate(parsed)


@router.post("/xlsx")
async def xlsx(body: XlsxIn) -> Response:
    """The results table the app's admin API handed the browser, as an Excel file. Every value
    is written as data, never a formula (results_xlsx); nothing is logged or kept."""
    content = await run_in_threadpool(
        results_xlsx, [(sheet.name, sheet.fields, sheet.rows) for sheet in body.sheets]
    )
    return Response(
        content=content,
        media_type=XLSX,
        headers={
            "Content-Disposition": f'attachment; filename="{body.file}.xlsx"',
            "Cache-Control": "no-store",
        },
    )
