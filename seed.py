import hashlib
import os
import secrets
import time

from app import create_app
from domain import audit, reconcile


def main():
    store = create_app().state.store
    password = secrets.token_urlsafe(16)
    now = int(time.time())
    with store.transaction() as connection:
        if connection.execute("SELECT 1 FROM users LIMIT 1").fetchone() or connection.execute("SELECT 1 FROM events LIMIT 1").fetchone():
            raise SystemExit("只允許在全新示範資料庫執行；既有資料不會被刪除。")
        users = []
        for index, nickname in enumerate(["示範主辦", "示範球友 A", "示範球友 B", "示範候補 C"]):
            identifier = secrets.token_hex(12)
            salt = secrets.token_hex(16)
            encoded = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600000).hex()
            connection.execute("INSERT INTO users VALUES (?,?,?,?,?)", (identifier, f"demo{index}", nickname, salt, encoded))
            users.append(identifier)
        for index, (title, sport, capacity, minimum, fee) in enumerate([
            ("下課後，羽球雙打", "羽球", 4, 4, 601), ("週末籃球半場", "籃球", 6, 4, 300), ("桌球練習・候補體驗", "桌球", 2, 2, 301)
        ]):
            event_id = secrets.token_urlsafe(12)
            start = now + 86400 + index * 7200
            connection.execute(
                "INSERT INTO events (id,host,title,sport,venue,starts_at,ends_at,cutoff_at,capacity,minimum,total_cost,offer_minutes,backup_plan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (event_id, users[0], title, sport, "原創虛構場館，非真實預約", start, start + 7200, start - 3600,
                 capacity, minimum, fee, 15, "場館無法使用時由主辦人取消，站內通知不等於已聯絡本人。"))
            audit(connection, event_id, "demo_created", now)
            for participant, user_id in enumerate(users):
                status = "confirmed" if participant < capacity else "waiting"
                connection.execute("INSERT INTO registrations (event,user_id,status) VALUES (?,?,?)", (event_id, user_id, status))
            reconcile(connection, event_id, now)
    print("已建立 3 場明確標示為虛構的活動。")
    print("帳號 demo0（主辦），demo1 / demo2 / demo3（球友）")
    print("本機隨機示範密碼：", password)
    print("此密碼只供本機示範；不要把資料庫或密碼傳上 GitHub。")


if __name__ == "__main__":
    main()
