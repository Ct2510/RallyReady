import hashlib
import html
import hmac
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

ROOT = Path(__file__).resolve().parent


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    username: str = Field(pattern=r"^[a-zA-Z0-9_]{3,32}$")
    password: str = Field(min_length=10, max_length=128)
    nickname: str = Field(default="新朋友", min_length=1, max_length=30)


class Store:
    def __init__(self, path, clock=time.time):
        self.path = str(path)
        self.clock = clock
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.transaction() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                    nickname TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    expires INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS throttle (
                    bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, resets INTEGER NOT NULL
                );
            """)

    @contextmanager
    def transaction(self):
        connection = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def throttle(self, bucket, limit):
        now = int(self.clock())
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM throttle WHERE bucket=?", (bucket,)).fetchone()
            if row and row["resets"] > now and row["count"] >= limit:
                raise HTTPException(429, "嘗試過於頻繁，請一小時後再試")
            if not row or row["resets"] <= now:
                connection.execute("INSERT OR REPLACE INTO throttle VALUES (?,1,?)", (bucket, now + 3600))
            else:
                connection.execute("UPDATE throttle SET count=count+1 WHERE bucket=?", (bucket,))

    def user(self, connection, token):
        digest = hashlib.sha256(token.encode()).hexdigest()
        row = connection.execute(
            "SELECT users.id, username, nickname FROM sessions JOIN users ON users.id=sessions.user_id "
            "WHERE digest=? AND expires>?", (digest, int(self.clock()))
        ).fetchone()
        if not row:
            raise HTTPException(401, "請先登入")
        return dict(row)


def public_user(user):
    return {key: user[key] for key in ("id", "username", "nickname")}


def setup(app: FastAPI, store: Store, product: str):
    cookie = product.lower() + "_session"

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            expected = str(request.base_url).rstrip("/")
            if request.headers.get("x-requested-with") != "portfolio" or (origin and origin != expected):
                return JSONResponse({"detail": "請使用同源應用程式操作"}, status_code=403)
            length = request.headers.get("content-length")
            if length and (not length.isdecimal() or int(length) > 300_000):
                return JSONResponse({"detail": "請求過大"}, status_code=413)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "no-cache"
        return response

    def current(connection, request):
        return store.user(connection, request.cookies.get(cookie, ""))

    def start_session(connection, user, response):
        token = secrets.token_urlsafe(32)
        connection.execute(
            "INSERT INTO sessions VALUES (?,?,?)",
            (hashlib.sha256(token.encode()).hexdigest(), user["id"], int(store.clock()) + 28800)
        )
        response.set_cookie(cookie, token, max_age=28800, httponly=True, samesite="strict",
                            secure=os.getenv("COOKIE_SECURE", "0") == "1", path="/")
        return public_user(user)

    @app.post("/api/register", status_code=201)
    def register(payload: Credentials, request: Request, response: Response):
        address = request.client.host if request.client else "unknown"
        store.throttle("register:" + address, 20)
        salt = secrets.token_hex(16)
        encoded = hashlib.pbkdf2_hmac("sha256", payload.password.encode(), bytes.fromhex(salt), 600000).hex()
        user = dict(id=secrets.token_hex(12), username=payload.username.lower(), nickname=payload.nickname)
        with store.transaction() as connection:
            try:
                connection.execute("INSERT INTO users VALUES (?,?,?,?,?)",
                                   (*user.values(), salt, encoded))
            except sqlite3.IntegrityError:
                raise HTTPException(409, "帳號已存在")
            return start_session(connection, user, response)

    @app.post("/api/login")
    def login(payload: Credentials, request: Request, response: Response):
        address = request.client.host if request.client else "unknown"
        store.throttle("login:" + address, 30)
        with store.transaction() as connection:
            user = connection.execute("SELECT * FROM users WHERE username=?", (payload.username.lower(),)).fetchone()
            salt = user["salt"] if user else "00" * 16
            encoded = hashlib.pbkdf2_hmac("sha256", payload.password.encode(), bytes.fromhex(salt), 600000).hex()
            if not user or not hmac.compare_digest(encoded, user["password"]):
                raise HTTPException(401, "帳號或密碼錯誤")
            return start_session(connection, user, response)

    @app.post("/api/logout")
    def logout(request: Request, response: Response):
        digest = hashlib.sha256(request.cookies.get(cookie, "").encode()).hexdigest()
        with store.transaction() as connection:
            connection.execute("DELETE FROM sessions WHERE digest=?", (digest,))
        response.delete_cookie(cookie, path="/")
        return {"ok": True}

    @app.get("/api/me")
    def me(request: Request):
        with store.transaction() as connection:
            return current(connection, request)

    @app.get("/health")
    def health():
        return {"status": "ok", "product": product}

    @app.get("/docs", include_in_schema=False)
    def documentation():
        entries = []
        for route in app.routes:
            if getattr(route, "path", "").startswith("/api/"):
                methods = ", ".join(sorted(getattr(route, "methods", [])))
                entries.append("<li><strong>" + html.escape(methods) + "</strong> <code>"
                               + html.escape(route.path) + "</code></li>")
        return HTMLResponse('<!doctype html><html lang="zh-Hant"><meta charset="utf-8">'
                            '<meta name="viewport" content="width=device-width,initial-scale=1">'
                            '<title>' + product + ' API</title><link rel="stylesheet" href="/styles.css">'
                            '<main><section class="panel"><h1>' + product + ' API</h1>'
                            '<p>完整欄位、型別及回應請查看 <a href="/openapi.json">OpenAPI JSON 契約</a>。'
                            '寫入須使用同源工作階段及 X-Requested-With: portfolio，API.md 有流程摘要。</p>'
                            '<p><a href="/">回到應用程式</a></p><ul>' + "".join(entries)
                            + '</ul></section></main></html>')

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(ROOT / "index.html")

    @app.get("/{filename}", include_in_schema=False)
    def asset(filename: str):
        allowed = {"app.js", "styles.css", "sw.js", "manifest.webmanifest", "icon.svg",
                   "icon-192.png", "icon-512.png"}
        if filename not in allowed or not (ROOT / filename).is_file():
            raise HTTPException(404, "找不到檔案")
        media = {"sw.js": "text/javascript", "manifest.webmanifest": "application/manifest+json"}
        return FileResponse(ROOT / filename, media_type=media.get(filename))

    return current


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

