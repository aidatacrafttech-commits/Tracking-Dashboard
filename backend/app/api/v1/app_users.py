"""App Users: the one number the dashboard keeps. Everything else on the screen comes from the
AdhyaapakAI backend's admin API (/api/admin/users, x-admin-secret).

GET /api/v1/app-users/presence   owner and viewer: how many have the app open, from the app's
                                 heartbeats to this dashboard (services/presence.py). null when
                                 ADHYAAPAK_JWT_SECRET is unset. Reads nothing of the app.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.api.deps import get_settings, require_read
from app.core.config import Settings
from app.schemas.app_users import AppOpen

router = APIRouter(prefix="/app-users", tags=["app users"])


@router.get("/presence", response_model=AppOpen, dependencies=[Depends(require_read)])
def presence(request: Request, settings: Settings = Depends(get_settings)) -> AppOpen:
    if not settings.adhyaapak_jwt_secret:
        return AppOpen(app_open=None)
    return AppOpen(app_open=len(request.app.state.presence.online_ids()))
