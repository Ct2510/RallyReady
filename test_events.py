from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from domain import EventInput, split_cost
from test_security import HEADERS, account, environment


def payload(now, **changes):
    def stamp(seconds):
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()

    return {"title": "週五羽球臨打", "sport": "羽球", "venue": "虛構校園體育館 A 場",
            "starts_at": stamp(now + 7200), "ends_at": stamp(now + 10800), "cutoff_at": stamp(now + 3600),
            "capacity": 2, "minimum": 2, "total_cost": 301, "offer_minutes": 1,
            "backup_plan": "下雨改室內；場館關閉則由主辦人取消", **changes}


@pytest.fixture
def game(environment):
    application, timer = environment
    people = [account(application, f"player{index}", f"球友{index}") for index in range(5)]
    host = people[0][0]
    response = host.post("/api/events", json=payload(timer[0]))
    assert response.status_code == 201, response.text
    event_id = response.json()["id"]
    return application, timer, people, event_id


def test_fifo_offer_accept_and_capacity(game):
    application, timer, people, event_id = game
    for index, (client, user) in enumerate(people[:4]):
        assert client.post(f"/api/events/{event_id}/join").json()["status"] == ("confirmed" if index < 2 else "waiting")
    people[0][0].post(f"/api/events/{event_id}/leave")
    first = people[2][0].get(f"/api/events/{event_id}").json()
    assert first["mine"]["status"] == "offered"
    assert first["confirmed"] == 1 and first["offered"] == 1
    assert people[3][0].get(f"/api/events/{event_id}").json()["mine"]["status"] == "waiting"
    assert people[4][0].post(f"/api/events/{event_id}/join").json()["status"] == "waiting"
    assert people[2][0].post(f"/api/events/{event_id}/accept").json()["status"] == "confirmed"
    assert people[2][0].post(f"/api/events/{event_id}/accept").status_code == 409
    assert people[2][0].post(f"/api/events/{event_id}/join").json()["status"] == "confirmed"


def test_expired_offer_is_not_accepted_and_promotes_next(game):
    application, timer, people, event_id = game
    for client, user in people[:4]:
        client.post(f"/api/events/{event_id}/join")
    people[0][0].post(f"/api/events/{event_id}/leave")
    timer[0] += 60
    assert people[2][0].post(f"/api/events/{event_id}/accept").status_code == 409
    with application.state.store.transaction() as connection:
        statuses = [row["status"] for row in connection.execute("SELECT status FROM registrations WHERE event=? ORDER BY id", (event_id,))]
        assert statuses == ["canceled", "confirmed", "expired", "offered"]
    assert people[3][0].post(f"/api/events/{event_id}/accept").status_code == 200


def test_rejoin_moves_to_back_of_queue(game):
    application, timer, people, event_id = game
    for client, user in people[:4]:
        client.post(f"/api/events/{event_id}/join")
    people[2][0].post(f"/api/events/{event_id}/leave")
    people[2][0].post(f"/api/events/{event_id}/join")
    people[0][0].post(f"/api/events/{event_id}/leave")
    assert people[3][0].get(f"/api/events/{event_id}").json()["mine"]["status"] == "offered"


def test_parallel_joins_never_oversell(game):
    application, timer, people, event_id = game
    def join(client):
        return client.post(f"/api/events/{event_id}/join").json()["status"]

    with ThreadPoolExecutor(max_workers=5) as pool:
        statuses = list(pool.map(join, [person[0] for person in people]))
    assert statuses.count("confirmed") == 2
    assert statuses.count("waiting") == 3


def test_parallel_accept_is_idempotently_safe(game):
    application, timer, people, event_id = game
    for client, user in people[:3]:
        client.post(f"/api/events/{event_id}/join")
    people[0][0].post(f"/api/events/{event_id}/leave")
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda ignored: people[2][0].post(f"/api/events/{event_id}/accept").status_code, range(2)))
    assert sorted(responses) == [200, 409]
    detail = people[0][0].get(f"/api/events/{event_id}").json()
    assert detail["confirmed"] == 2 and detail["offered"] == 0


def test_cutoff_without_quorum_cancels_even_on_failed_join(game):
    application, timer, people, event_id = game
    people[0][0].post(f"/api/events/{event_id}/join")
    timer[0] += 3600
    assert people[1][0].post(f"/api/events/{event_id}/join").status_code == 409
    with application.state.store.transaction() as connection:
        assert connection.execute("SELECT lifecycle FROM events WHERE id=?", (event_id,)).fetchone()[0] == "canceled"


def test_late_dropout_below_minimum_cancels(game):
    application, timer, people, event_id = game
    for client, user in people[:2]:
        client.post(f"/api/events/{event_id}/join")
    timer[0] += 3600
    assert people[0][0].get(f"/api/events/{event_id}").json()["state"] == "locked"
    people[1][0].post(f"/api/events/{event_id}/leave")
    assert people[0][0].get(f"/api/events/{event_id}").json()["state"] == "canceled"


def test_at_risk_state_and_offer_does_not_count_as_quorum(game):
    application, timer, people, event_id = game
    for client, user in people[:3]:
        client.post(f"/api/events/{event_id}/join")
    assert people[0][0].get(f"/api/events/{event_id}").json()["state"] == "ready"
    people[0][0].post(f"/api/events/{event_id}/leave")
    assert people[1][0].get(f"/api/events/{event_id}").json()["state"] == "at_risk"
    timer[0] += 3600
    assert people[2][0].get(f"/api/events/{event_id}").json()["state"] == "canceled"


def test_privacy_host_authorization_and_notifications(game):
    application, timer, people, event_id = game
    for client, user in people[:3]:
        client.post(f"/api/events/{event_id}/join")
    public = TestClient(application).get(f"/api/events/{event_id}").json()
    assert "roster" not in public and "audit" not in public and "mine" not in public
    participant = people[1][0].get(f"/api/events/{event_id}").json()
    assert all("user_id" not in row for row in participant["roster"])
    assert people[1][0].post(f"/api/events/{event_id}/cancel").status_code == 403
    assert people[1][0].post(f"/api/events/{event_id}/settle").status_code == 403
    assert people[1][0].post(f"/api/events/{event_id}/check-in/{people[0][1]['id']}").status_code == 403
    people[0][0].post(f"/api/events/{event_id}/leave")
    notifications = people[2][0].get("/api/notifications").json()
    assert len(notifications) == 1
    notification_id = notifications[0]["id"]
    assert people[1][0].post(f"/api/notifications/{notification_id}/read").status_code == 404
    assert people[2][0].post(f"/api/notifications/{notification_id}/read").status_code == 200


def test_check_in_settlement_and_exact_remainder(game):
    application, timer, people, event_id = game
    host = people[0][0]
    for client, user in people[:2]:
        client.post(f"/api/events/{event_id}/join")
    assert host.post(f"/api/events/{event_id}/check-in/{people[0][1]['id']}").status_code == 409
    assert host.post(f"/api/events/{event_id}/settle").status_code == 409
    timer[0] += 7200
    for client, user in people[:2]:
        assert host.post(f"/api/events/{event_id}/check-in/{user['id']}").status_code == 200
    timer[0] += 3600
    settlement = host.post(f"/api/events/{event_id}/settle")
    assert settlement.status_code == 200
    assert [person["amount"] for person in settlement.json()["people"]] == [151, 150]
    assert settlement.json()["payment_processed"] is False
    assert host.post(f"/api/events/{event_id}/settle").json() == settlement.json()
    assert host.post(f"/api/events/{event_id}/check-in/{people[0][1]['id']}").status_code == 409


def test_zero_attendance_is_not_settled(game):
    application, timer, people, event_id = game
    for client, user in people[:2]:
        client.post(f"/api/events/{event_id}/join")
    timer[0] += 10801
    assert people[0][0].post(f"/api/events/{event_id}/settle").status_code == 409


def test_cancel_notifies_and_ics_escapes_injection(game):
    application, timer, people, event_id = game
    people[1][0].post(f"/api/events/{event_id}/join")
    with application.state.store.transaction() as connection:
        connection.execute("UPDATE events SET title=? WHERE id=?", ("羽球\r\nATTENDEE:hacker@example.test,;" * 5, event_id))
    people[0][0].post(f"/api/events/{event_id}/cancel")
    calendar = people[0][0].get(f"/api/events/{event_id}/calendar.ics").text
    assert "STATUS:CANCELLED" in calendar
    assert "\r\nATTENDEE:" not in calendar
    assert all(len(line.encode()) <= 75 for line in calendar.split("\r\n"))
    assert people[1][0].get("/api/notifications").json()[0]["message"].startswith("主辦人取消")


@pytest.mark.parametrize("changes", [{"minimum": 3}, {"capacity": 1}, {"total_cost": -1}, {"total_cost": True}, {"offer_minutes": 0}, {"starts_at": "2026-10-17T19:00:00"}, {"backup_plan": ""}])
def test_invalid_event(environment, changes):
    application, timer = environment
    with pytest.raises(ValueError):
        EventInput.model_validate(payload(timer[0], **changes))


@pytest.mark.parametrize("total,count", [(0, 3), (100, 3), (301, 2), (100000, 32), (1, 5)])
def test_settlement_conserves_integer_money(total, count):
    result = split_cost(total, [{"nickname": str(index)} for index in range(count)])
    assert sum(person["amount"] for person in result) == total
    assert max(person["amount"] for person in result) - min(person["amount"] for person in result) <= 1
