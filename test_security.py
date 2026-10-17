import hashlib

import pytest
from fastapi.testclient import TestClient

from app import create_app

HEADERS = {"X-Requested-With": "portfolio"}
PASSWORD = "Portfolio-demo-2026!"


@pytest.fixture
def environment(tmp_path):
    timer = [1800000000.0]
    application = create_app(tmp_path / "test.db", clock=lambda: timer[0])
    return application, timer


def account(application, username="tester", nickname="測試成員"):
    client = TestClient(application, headers=HEADERS)
    response = client.post("/api/register", json={"username": username, "password": PASSWORD, "nickname": nickname})
    assert response.status_code == 201, response.text
    return client, response.json()


@pytest.mark.parametrize("path", ["/", "/app.js", "/styles.css", "/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png"])
def test_static_files(environment, path):
    application, timer = environment
    with TestClient(application) as client:
        assert client.get(path).status_code == 200


def test_private_source_not_served(environment):
    application, timer = environment
    with TestClient(application) as client:
        assert client.get("/common.py").status_code == 404
        assert client.get("/requirements.txt").status_code == 404


def test_api_documentation_has_no_external_script_dependency(environment):
    application, timer = environment
    with TestClient(application) as client:
        response = client.get("/docs")
        assert response.status_code == 200
        assert 'href="/openapi.json"' in response.text
        assert "<script" not in response.text
        assert "/api/register" in client.get("/openapi.json").json()["paths"]


def test_auth_lifecycle(environment):
    application, timer = environment
    client, user = account(application)
    cookie = next(iter(client.cookies.values()))
    assert client.get("/api/me").json()["id"] == user["id"]
    assert "httponly" in client.post("/api/login", json={"username": "tester", "password": PASSWORD}).headers["set-cookie"].lower()
    with application.state.store.transaction() as connection:
        row = connection.execute("SELECT * FROM sessions WHERE digest=?", (hashlib.sha256(cookie.encode()).hexdigest(),)).fetchone()
        assert row and row["digest"] != cookie
        stored = connection.execute("SELECT password FROM users").fetchone()[0]
        assert stored != PASSWORD
    client.post("/api/logout")
    assert client.get("/api/me").status_code == 401


def test_session_expiry(environment):
    application, timer = environment
    client, user = account(application)
    timer[0] += 28801
    assert client.get("/api/me").status_code == 401


def test_wrong_password_and_duplicate(environment):
    application, timer = environment
    client, user = account(application)
    assert client.post("/api/login", json={"username": "tester", "password": "wrong-password!"}).status_code == 401
    assert client.post("/api/register", json={"username": "TESTER", "password": PASSWORD}).status_code == 409


@pytest.mark.parametrize("username,password", [("a", PASSWORD), ("bad name", PASSWORD), ("valid", "short")])
def test_invalid_credentials(environment, username, password):
    application, timer = environment
    with TestClient(application, headers=HEADERS) as client:
        assert client.post("/api/register", json={"username": username, "password": password}).status_code == 422


def test_csrf_and_security_headers(environment):
    application, timer = environment
    with TestClient(application) as client:
        assert client.post("/api/register", json={}).status_code == 403
        assert client.post("/api/logout", headers=HEADERS | {"Origin": "https://evil.example"}).status_code == 403
        response = client.get("/api/me")
        assert response.headers["cache-control"] == "no-store"
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
        assert client.post("/api/logout", headers=HEADERS | {"Content-Length": "300001"}).status_code == 413


def test_rate_limit(environment):
    application, timer = environment
    with TestClient(application, headers=HEADERS) as client:
        for attempt in range(30):
            response = client.post("/api/login", json={"username": "nobody", "password": PASSWORD})
            assert response.status_code == 401
        assert client.post("/api/login", json={"username": "nobody", "password": PASSWORD}).status_code == 429
        timer[0] += 3601
        assert client.post("/api/login", json={"username": "nobody", "password": PASSWORD}).status_code == 401

