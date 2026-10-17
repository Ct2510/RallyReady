import json
import os
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from common import Store, dump, setup
from domain import EventInput, audit, cancel_all, event_row, identifier, notify, reconcile, split_cost


def create_app(path=None, clock=None):
    store = Store(path or os.getenv("RALLYREADY_DB", "data/rallyready.db"), **({"clock": clock} if clock else {}))
    with store.transaction() as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, host TEXT REFERENCES users(id), title TEXT, sport TEXT, venue TEXT,
                starts_at INTEGER, ends_at INTEGER, cutoff_at INTEGER, capacity INTEGER, minimum INTEGER,
                total_cost INTEGER, offer_minutes INTEGER, backup_plan TEXT,
                lifecycle TEXT NOT NULL DEFAULT 'open', was_ready INTEGER NOT NULL DEFAULT 0, settlement TEXT
            );
            CREATE TABLE IF NOT EXISTS registrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT REFERENCES events(id), user_id TEXT REFERENCES users(id),
                status TEXT NOT NULL CHECK(status IN ('confirmed','waiting','offered','expired','canceled','checked_in')),
                deadline INTEGER, UNIQUE(event,user_id)
            );
            CREATE INDEX IF NOT EXISTS queue ON registrations(event,status,id);
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY, event TEXT REFERENCES events(id), user_id TEXT REFERENCES users(id),
                message TEXT, created INTEGER, seen INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY, event TEXT REFERENCES events(id), action TEXT, created INTEGER, details TEXT
            );
        """)
    app = FastAPI(title="RallyReady", version="1.0.0", docs_url=None, redoc_url=None)
    app.state.store = store
    current = setup(app, store, "RallyReady")

    def host_only(connection, event_id, user):
        event = event_row(connection, event_id)
        if event["host"] != user["id"]:
            raise HTTPException(403, "只有主辦人可以操作")
        return event

    def summary(connection, event):
        counts = {row["status"]: row["amount"] for row in connection.execute(
            "SELECT status,count(*) AS amount FROM registrations WHERE event=? GROUP BY status", (event["id"],))}
        confirmed = counts.get("confirmed", 0) + counts.get("checked_in", 0)
        state = event["lifecycle"]
        if state == "open":
            state = "ready" if confirmed >= event["minimum"] else ("at_risk" if event["was_ready"] else "recruiting")
        return {key: event[key] for key in ("id", "title", "sport", "venue", "starts_at", "ends_at", "cutoff_at",
                                            "capacity", "minimum", "total_cost", "offer_minutes", "backup_plan")} | {
            "state": state, "confirmed": confirmed, "offered": counts.get("offered", 0), "waiting": counts.get("waiting", 0),
            "estimated_cost": (event["total_cost"] + confirmed - 1) // confirmed if confirmed else None,
            "host_name": connection.execute("SELECT nickname FROM users WHERE id=?", (event["host"],)).fetchone()[0]}

    @app.get("/api/events")
    def events():
        with store.transaction() as connection:
            rows = connection.execute("SELECT id FROM events ORDER BY starts_at LIMIT 100").fetchall()
            return [summary(connection, reconcile(connection, row["id"], int(store.clock()))) for row in rows]

    @app.post("/api/events", status_code=201)
    def create_event(payload: EventInput, request: Request):
        now = int(store.clock())
        if payload.cutoff_at.timestamp() <= now or payload.starts_at.timestamp() > now + 366 * 86400:
            raise HTTPException(422, "截止必須在未來，活動須在一年內")
        with store.transaction() as connection:
            user = current(connection, request)
            if connection.execute("SELECT count(*) FROM events WHERE host=?", (user["id"],)).fetchone()[0] >= 50:
                raise HTTPException(409, "每人最多建立 50 個活動")
            event_id = identifier()
            connection.execute(
                "INSERT INTO events (id,host,title,sport,venue,starts_at,ends_at,cutoff_at,capacity,minimum,total_cost,offer_minutes,backup_plan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (event_id, user["id"], payload.title, payload.sport, payload.venue, int(payload.starts_at.timestamp()),
                 int(payload.ends_at.timestamp()), int(payload.cutoff_at.timestamp()), payload.capacity, payload.minimum,
                 payload.total_cost, payload.offer_minutes, payload.backup_plan))
            audit(connection, event_id, "created", now)
            return {"id": event_id}

    @app.get("/api/events/{event_id}")
    def detail(event_id: str, request: Request):
        with store.transaction() as connection:
            event = reconcile(connection, event_id, int(store.clock()))
            result = summary(connection, event)
            try:
                user = current(connection, request)
            except HTTPException:
                return result
            registration = connection.execute("SELECT * FROM registrations WHERE event=? AND user_id=?", (event_id, user["id"])).fetchone()
            is_host = event["host"] == user["id"]
            result.update(is_host=is_host, mine=dict(registration) if registration else None)
            if is_host or registration:
                result["roster"] = [{"nickname": row["nickname"], "status": row["status"],
                                     **({"user_id": row["user_id"]} if is_host else {})} for row in connection.execute(
                    "SELECT users.nickname,registrations.status,user_id FROM registrations JOIN users ON users.id=user_id WHERE event=? ORDER BY registrations.id", (event_id,))]
            if is_host:
                result["audit"] = [dict(row) for row in connection.execute("SELECT action,created,details FROM audit WHERE event=? ORDER BY id DESC LIMIT 50", (event_id,))]
            if event["settlement"] and (is_host or registration):
                result["settlement"] = json.loads(event["settlement"])
            return result

    @app.post("/api/events/{event_id}/join")
    def join(event_id: str, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            now = int(store.clock())
            event = reconcile(connection, event_id, now)
            if event["lifecycle"] != "open" or now >= event["cutoff_at"]:
                return JSONResponse({"detail": "活動已截止或結束招募"}, status_code=409)
            previous = connection.execute("SELECT * FROM registrations WHERE event=? AND user_id=?", (event_id, user["id"])).fetchone()
            if previous and previous["status"] in ("confirmed", "waiting", "offered", "checked_in"):
                return {"status": previous["status"], "deadline": previous["deadline"]}
            occupied = connection.execute("SELECT count(*) FROM registrations WHERE event=? AND status IN ('confirmed','offered','checked_in')", (event_id,)).fetchone()[0]
            status = "confirmed" if occupied < event["capacity"] else "waiting"
            if previous:
                connection.execute("DELETE FROM registrations WHERE id=?", (previous["id"],))
            connection.execute("INSERT INTO registrations (event,user_id,status) VALUES (?,?,?)", (event_id, user["id"], status))
            audit(connection, event_id, "joined_" + status, now)
            reconcile(connection, event_id, now)
            return {"status": status}

    @app.post("/api/events/{event_id}/leave")
    def leave(event_id: str, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            now = int(store.clock())
            event = reconcile(connection, event_id, now)
            if event["lifecycle"] in ("canceled", "settled") or now >= event["starts_at"]:
                return JSONResponse({"detail": "活動已開始或結束，不能退出"}, status_code=409)
            registration = connection.execute("SELECT * FROM registrations WHERE event=? AND user_id=?", (event_id, user["id"])).fetchone()
            if not registration or registration["status"] not in ("confirmed", "waiting", "offered"):
                return JSONResponse({"detail": "沒有可取消的報名"}, status_code=409)
            connection.execute("UPDATE registrations SET status='canceled',deadline=NULL WHERE id=?", (registration["id"],))
            audit(connection, event_id, "left", now)
            reconcile(connection, event_id, now)
            return {"ok": True}

    @app.post("/api/events/{event_id}/accept")
    def accept(event_id: str, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            now = int(store.clock())
            event = reconcile(connection, event_id, now)
            row = connection.execute("SELECT * FROM registrations WHERE event=? AND user_id=?", (event_id, user["id"])).fetchone()
            if not row or row["status"] != "offered" or event["lifecycle"] != "open":
                return JSONResponse({"detail": "目前沒有有效的候補邀請"}, status_code=409)
            connection.execute("UPDATE registrations SET status='confirmed',deadline=NULL WHERE id=?", (row["id"],))
            notify(connection, event_id, user["id"], "已確認候補名額", now)
            audit(connection, event_id, "offer_accepted", now)
            reconcile(connection, event_id, now)
            return {"status": "confirmed"}

    @app.post("/api/events/{event_id}/cancel")
    def cancel(event_id: str, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            event = host_only(connection, event_id, user)
            if event["lifecycle"] in ("canceled", "settled") or store.clock() >= event["starts_at"]:
                raise HTTPException(409, "活動已開始、取消或結算")
            cancel_all(connection, event, int(store.clock()), "主辦人取消活動，請勿前往")
            return {"ok": True}

    @app.post("/api/events/{event_id}/check-in/{user_id}")
    def check_in(event_id: str, user_id: str, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            host_only(connection, event_id, user)
            event = reconcile(connection, event_id, int(store.clock()))
            if event["lifecycle"] != "locked" or not event["starts_at"] - 1800 <= store.clock() <= event["ends_at"] + 86400:
                return JSONResponse({"detail": "只允許已成團活動在開始前 30 分鐘至結束後 24 小時簽到"}, status_code=409)
            changed = connection.execute("UPDATE registrations SET status='checked_in' WHERE event=? AND user_id=? AND status='confirmed'", (event_id, user_id)).rowcount
            if not changed:
                return JSONResponse({"detail": "成員不在可簽到名單"}, status_code=409)
            audit(connection, event_id, "checked_in", int(store.clock()))
            return {"ok": True}

    @app.post("/api/events/{event_id}/settle")
    def settle(event_id: str, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            event = host_only(connection, event_id, user)
            if event["settlement"]:
                return json.loads(event["settlement"])
            event = reconcile(connection, event_id, int(store.clock()))
            if event["lifecycle"] != "locked" or store.clock() < event["ends_at"]:
                return JSONResponse({"detail": "活動結束且成團後才能結算"}, status_code=409)
            people = connection.execute("SELECT nickname FROM registrations JOIN users ON users.id=user_id WHERE event=? AND status='checked_in' ORDER BY registrations.id", (event_id,)).fetchall()
            if not people:
                return JSONResponse({"detail": "至少一名已簽到成員才能結算"}, status_code=409)
            settlement = {"total": event["total_cost"], "currency": "TWD", "people": split_cost(event["total_cost"], people),
                          "settled_at": int(store.clock()), "policy": "checked-in/join-order-remainder-v1", "payment_processed": False}
            connection.execute("UPDATE events SET lifecycle='settled',settlement=? WHERE id=?", (dump(settlement), event_id))
            audit(connection, event_id, "settled", int(store.clock()))
            return settlement

    @app.get("/api/notifications")
    def notifications(request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            rows = connection.execute("SELECT id FROM events WHERE lifecycle='open' AND id IN (SELECT event FROM registrations WHERE user_id=?)", (user["id"],)).fetchall()
            for row in rows:
                reconcile(connection, row["id"], int(store.clock()))
            return [dict(row) for row in connection.execute("SELECT id,event,message,created,seen FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50", (user["id"],))]

    @app.post("/api/notifications/{notification_id}/read")
    def read_notification(notification_id: int, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            changed = connection.execute("UPDATE notifications SET seen=1 WHERE id=? AND user_id=?", (notification_id, user["id"])).rowcount
            if not changed:
                raise HTTPException(404, "通知不存在")
            return {"ok": True}

    @app.get("/api/events/{event_id}/calendar.ics")
    def calendar(event_id: str):
        def escape(value):
            return value.replace("\\", "\\\\").replace("\r", "").replace("\n", "\\n").replace(",", "\\,").replace(";", "\\;")

        def stamp(value):
            return datetime.fromtimestamp(value, timezone.utc).strftime("%Y%m%dT%H%M%SZ")

        with store.transaction() as connection:
            event = reconcile(connection, event_id, int(store.clock()))
            lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//RallyReady//Campus sports//ZH-TW", "BEGIN:VEVENT",
                     "UID:" + event_id + "@rallyready.local", "DTSTAMP:" + stamp(store.clock()),
                     "DTSTART:" + stamp(event["starts_at"]), "DTEND:" + stamp(event["ends_at"]),
                     "SUMMARY:" + escape(event["title"]), "LOCATION:" + escape(event["venue"]),
                     "STATUS:" + ("CANCELLED" if event["lifecycle"] == "canceled" else "TENTATIVE" if event["lifecycle"] == "open" else "CONFIRMED"),
                     "END:VEVENT", "END:VCALENDAR", ""]
            folded = []
            for line in lines:
                fragment = ""
                for character in line:
                    if len((fragment + character).encode()) > 73:
                        folded.append(fragment)
                        fragment = " "
                    fragment += character
                folded.append(fragment)
            return Response("\r\n".join(folded), media_type="text/calendar", headers={"Content-Disposition": 'attachment; filename="event.ics"'})

    return app


app = create_app()
