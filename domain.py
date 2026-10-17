import secrets
from datetime import datetime
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from common import dump


class EventInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=70)
    sport: Literal["羽球", "籃球", "排球", "桌球", "其他"]
    venue: str = Field(min_length=1, max_length=120)
    starts_at: datetime
    ends_at: datetime
    cutoff_at: datetime
    capacity: int = Field(strict=True, ge=2, le=32)
    minimum: int = Field(strict=True, ge=2, le=32)
    total_cost: int = Field(strict=True, ge=0, le=100000)
    offer_minutes: int = Field(strict=True, ge=1, le=120, default=15)
    backup_plan: str = Field(min_length=1, max_length=300)

    @model_validator(mode="after")
    def chronology(self):
        if any(value.tzinfo is None or value.utcoffset() is None for value in (self.starts_at, self.ends_at, self.cutoff_at)):
            raise ValueError("時間必須帶時區")
        if not self.cutoff_at < self.starts_at < self.ends_at:
            raise ValueError("必須是截止 < 開始 < 結束")
        if self.minimum > self.capacity:
            raise ValueError("成團門檻不得大於容量")
        if (self.ends_at - self.starts_at).total_seconds() > 86400:
            raise ValueError("活動最長 24 小時")
        return self


def notify(connection, event_id, user_id, message, now):
    connection.execute("INSERT INTO notifications (event,user_id,message,created) VALUES (?,?,?,?)",
                       (event_id, user_id, message, now))


def audit(connection, event_id, action, now, details=None):
    connection.execute("INSERT INTO audit (event,action,created,details) VALUES (?,?,?,?)",
                       (event_id, action, now, dump(details or {})))


def event_row(connection, event_id):
    row = connection.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if not row:
        raise HTTPException(404, "活動不存在")
    return row


def cancel_all(connection, event, now, reason):
    connection.execute("UPDATE events SET lifecycle='canceled' WHERE id=?", (event["id"],))
    for member in connection.execute("SELECT user_id FROM registrations WHERE event=? AND status IN ('confirmed','offered','waiting','checked_in')", (event["id"],)):
        notify(connection, event["id"], member["user_id"], reason, now)
    connection.execute("UPDATE registrations SET status='canceled',deadline=NULL WHERE event=? AND status IN ('confirmed','offered','waiting','checked_in')", (event["id"],))
    audit(connection, event["id"], "event_canceled", now, {"reason": reason})


def reconcile(connection, event_id, now):
    event = event_row(connection, event_id)
    if event["lifecycle"] in ("canceled", "settled"):
        return event
    expired = connection.execute("SELECT * FROM registrations WHERE event=? AND status='offered' AND deadline<=?", (event_id, now)).fetchall()
    for member in expired:
        connection.execute("UPDATE registrations SET status='expired',deadline=NULL WHERE id=?", (member["id"],))
        notify(connection, event_id, member["user_id"], "候補邀請已逾時；如尚未截止可重新排隊", now)
        audit(connection, event_id, "offer_expired", now)
    confirmed = connection.execute("SELECT count(*) FROM registrations WHERE event=? AND status IN ('confirmed','checked_in')", (event_id,)).fetchone()[0]
    if confirmed >= event["minimum"]:
        connection.execute("UPDATE events SET was_ready=1 WHERE id=?", (event_id,))
    if now >= event["cutoff_at"]:
        if confirmed < event["minimum"]:
            cancel_all(connection, event, now, "截止後低於成團門檻，活動取消；沒有收款或退款操作")
        elif event["lifecycle"] == "open":
            connection.execute("UPDATE events SET lifecycle='locked' WHERE id=?", (event_id,))
            connection.execute("UPDATE registrations SET status='expired',deadline=NULL WHERE event=? AND status IN ('waiting','offered')", (event_id,))
            audit(connection, event_id, "quorum_locked", now)
        return event_row(connection, event_id)
    occupied = connection.execute("SELECT count(*) FROM registrations WHERE event=? AND status IN ('confirmed','checked_in','offered')", (event_id,)).fetchone()[0]
    waiting = connection.execute("SELECT * FROM registrations WHERE event=? AND status='waiting' ORDER BY id LIMIT ?", (event_id, event["capacity"] - occupied)).fetchall()
    for member in waiting:
        deadline = min(now + event["offer_minutes"] * 60, event["cutoff_at"])
        connection.execute("UPDATE registrations SET status='offered',deadline=? WHERE id=?", (deadline, member["id"]))
        notify(connection, event_id, member["user_id"], "名額已保留，請在期限內主動接受候補邀請", now)
        audit(connection, event_id, "offer_created", now, {"deadline": deadline})
    return event_row(connection, event_id)


def split_cost(total, people):
    if not people:
        raise HTTPException(409, "至少一名已簽到成員才能結算")
    base, remainder = divmod(total, len(people))
    return [{"nickname": person["nickname"], "amount": base + int(index < remainder)} for index, person in enumerate(people)]


def identifier():
    return secrets.token_urlsafe(12)
