"""Live presence: the mobile app's heartbeats, verified with the app's own login token."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.errors import AuthenticationError
from app.main import create_app
from app.services.presence import PresenceTracker, verify_app_token
from tests.conftest import OWNER_TOKEN, VIEWER_TOKEN, make_settings

SECRET = "adhyaapak-jwt-secret-for-tests-only"
HB = "/api/v1/integrations/presence/heartbeat"
PRESENCE = "/api/v1/app-users/presence"
USER = "65a1b2c3d4e5f60718293a4b"
OTHER = "65a1b2c3d4e5f60718293a4c"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token(
    sub: str = USER,
    *,
    secret: str = SECRET,
    alg: str = "HS256",
    exp: datetime | None = None,
) -> str:
    exp = exp or datetime.now(UTC) + timedelta(days=30)
    head = b64(json.dumps({"alg": alg, "typ": "JWT"}).encode())
    body = b64(json.dumps({"sub": sub, "email": "x@y.z", "exp": int(exp.timestamp())}).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{b64(sig)}"


def app_auth(tok: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture
def papp(db_path: Path) -> Iterator[FastAPI]:
    application = create_app(
        make_settings(db_path, adhyaapak_jwt_secret=SecretStr(SECRET)), start_scheduler=False
    )
    yield application
    application.state.engine.dispose()


@pytest.fixture
def api(papp: FastAPI) -> Iterator[TestClient]:
    with TestClient(papp) as c:
        yield c


def live(api: TestClient) -> dict[str, object]:
    """The app-open count the App Users screen adds to the admin API's Online now."""
    return api.get(PRESENCE, headers={"Authorization": f"Bearer {VIEWER_TOKEN}"}).json()


def test_open_apps_are_counted_and_leave_at_once(api: TestClient) -> None:
    assert live(api)["app_open"] == 0
    assert api.post(HB, json={"state": "active"}, headers=app_auth(token())).status_code == 204
    api.post(HB, json={"state": "active"}, headers=app_auth(token()))  # same user twice
    api.post(HB, json={}, headers=app_auth(token(OTHER)))  # "active" is the default
    assert live(api)["app_open"] == 2
    assert api.post(HB, json={"state": "background"}, headers=app_auth(token())).status_code == 204
    assert live(api)["app_open"] == 1


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": f"Bearer {OWNER_TOKEN}"},  # dashboard tokens are not app tokens
        app_auth(token(secret="some-other-secret")),
        app_auth(token(alg="none")),
        app_auth(token(exp=datetime.now(UTC) - timedelta(seconds=1))),
        app_auth(token(sub="not-a-user-id")),
        app_auth("a.b"),
        app_auth("!!.@@.##"),
    ],
)
def test_bad_or_missing_tokens_are_refused(api: TestClient, headers: dict[str, str]) -> None:
    resp = api.post(HB, json={"state": "active"}, headers=headers)
    assert resp.status_code == 401
    assert live(api)["app_open"] == 0


def test_unknown_fields_and_states_are_refused(api: TestClient) -> None:
    assert api.post(HB, json={"state": "online"}, headers=app_auth(token())).status_code == 422
    assert api.post(HB, json={"x": 1}, headers=app_auth(token())).status_code == 422


def test_not_configured(db_path: Path) -> None:
    application = create_app(make_settings(db_path), start_scheduler=False)
    with TestClient(application) as c:
        assert c.post(HB, json={}).status_code == 401
        resp = c.post(HB, json={}, headers=app_auth(token()))
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "presence_not_configured"
    application.state.engine.dispose()


def test_the_token_is_never_logged_and_heartbeats_stay_out_of_info(
    api: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    tok = token()
    api.post(HB, json={"state": "active"}, headers=app_auth(tok))
    api.post(HB, json={"state": "active"}, headers=app_auth(token(secret="wrong")))
    assert all(tok not in r.getMessage() + str(r.__dict__) for r in caplog.records)
    access = [r for r in caplog.records if r.name == "app.access" and HB in r.getMessage()]
    assert [r.levelno for r in access] == [logging.DEBUG, logging.INFO]  # failures stay visible


def test_tracker_drops_apps_that_stop_beating() -> None:
    tracker = PresenceTracker(timedelta(seconds=75))
    tracker.beat(USER, now=0)
    tracker.beat(OTHER, now=50)
    assert tracker.online(now=74) == 2
    assert tracker.online(now=76) == 1  # USER missed two heartbeats (killed app)
    tracker.leave(OTHER)
    assert tracker.online(now=77) == 0


def test_verify_app_token() -> None:
    now = datetime.now(UTC)
    assert verify_app_token(token(), SECRET, now) == USER
    with pytest.raises(AuthenticationError):
        verify_app_token(token(), "wrong", now)
    with pytest.raises(AuthenticationError):
        verify_app_token(token(exp=now + timedelta(seconds=5)), SECRET, now + timedelta(seconds=6))


def test_the_app_open_count_alone_for_the_admin_api_screen(api: TestClient) -> None:
    # The App Users screen reads its counts from the AdhyaapakAI backend's admin API; only the
    # heartbeat count (kept here) comes from the dashboard, with no database read.
    viewer = {"Authorization": f"Bearer {VIEWER_TOKEN}"}
    assert api.get("/api/v1/app-users/presence", headers=viewer).json() == {"app_open": 0}
    api.post(HB, json={"state": "active"}, headers=app_auth(token()))
    assert api.get("/api/v1/app-users/presence", headers=viewer).json() == {"app_open": 1}
    assert api.get("/api/v1/app-users/presence").status_code == 401


def test_the_app_open_count_is_null_when_presence_is_off(db_path: Path) -> None:
    application = create_app(make_settings(db_path), start_scheduler=False)
    with TestClient(application) as c:
        resp = c.get(
            "/api/v1/app-users/presence", headers={"Authorization": f"Bearer {VIEWER_TOKEN}"}
        )
        assert resp.json() == {"app_open": None}
    application.state.engine.dispose()
