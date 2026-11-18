"""App Users: the app-open count from the app's heartbeats (the rest comes from the AdhyaapakAI
backend's admin API)."""

from __future__ import annotations

from app.schemas.common import ApiModel


class AppOpen(ApiModel):
    app_open: int | None  # app heartbeats to this dashboard; None when presence is off
