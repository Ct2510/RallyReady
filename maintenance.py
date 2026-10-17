import os
import time

from app import create_app
from domain import reconcile


def main():
    store = create_app(os.getenv("RALLYREADY_DB", "data/rallyready.db")).state.store
    with store.transaction() as connection:
        rows = connection.execute("SELECT id FROM events WHERE lifecycle IN ('open','locked')").fetchall()
        for row in rows:
            reconcile(connection, row["id"], int(time.time()))
    print(f"已檢查 {len(rows)} 個活動；通知儲存於站內，未寄信或發送推播。")


if __name__ == "__main__":
    main()
