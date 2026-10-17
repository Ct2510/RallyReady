import secrets

from fastapi.testclient import TestClient

from test_events import game, payload
from test_security import account, environment


def test_discovery_filters_and_literal_search(game):
    application, timer, people, event_id = game
    host = people[0][0]
    host.post("/api/events", json=payload(timer[0], title="週末籃球", sport="籃球", venue="北區球場"))
    assert len(host.get("/api/events?sport=羽球").json()) == 1
    assert host.get("/api/events?q=北區").json()[0]["sport"] == "籃球"
    assert host.get("/api/events?q=%25").json() == []
    assert host.get("/api/events?sport=不存在").status_code == 422
    host.post(f"/api/events/{event_id}/cancel")
    assert all(item["id"] != event_id for item in host.get("/api/events?only_joinable=true").json())


def test_past_event_toggle(game):
    application, timer, people, event_id = game
    timer[0] += 20000
    host = people[0][0]
    assert host.get("/api/events").json() == []
    assert host.get("/api/events?include_past=true").json()[0]["id"] == event_id


def test_my_activities_are_private_and_include_hosted_and_joined(game):
    application, timer, people, event_id = game
    host, host_user = people[0]
    assert TestClient(application).get("/api/my-events").status_code == 401
    assert host.get("/api/my-events").json()[0]["is_host"] is True
    assert people[1][0].get("/api/my-events").json() == []
    people[1][0].post(f"/api/events/{event_id}/join")
    mine = people[1][0].get("/api/my-events").json()[0]
    assert mine["my_status"] == "confirmed" and mine["is_host"] is False


def test_queue_position_excludes_current_offers(game):
    application, timer, people, event_id = game
    for client, user in people[:4]:
        client.post(f"/api/events/{event_id}/join")
    assert people[3][0].get(f"/api/events/{event_id}").json()["mine"]["queue_position"] == 2
    people[0][0].post(f"/api/events/{event_id}/leave")
    assert people[3][0].get(f"/api/events/{event_id}").json()["mine"]["queue_position"] == 1


def test_host_announcement_is_private_and_idempotent(game):
    application, timer, people, event_id = game
    for client, user in people[:3]:
        client.post(f"/api/events/{event_id}/join")
    message = {"text": "集合位置改到體育館北門，請提前十分鐘到場。", "request_id": secrets.token_hex(16)}
    endpoint = f"/api/events/{event_id}/announcements"
    assert people[1][0].post(endpoint, json=message).status_code == 403
    first = people[0][0].post(endpoint, json=message)
    assert first.status_code == 201 and first.json()["notified"] == 2
    assert people[0][0].post(endpoint, json=message).json()["replayed"] is True
    assert people[0][0].post(endpoint, json=message | {"text": "不同內容不能重用請求代碼"}).status_code == 409
    notes = people[1][0].get("/api/notifications").json()
    assert len([note for note in notes if note["message"].startswith("主辦公告")]) == 1
    public = TestClient(application).get(f"/api/events/{event_id}").json()
    assert "announcements" not in public
    assert "announcements" not in people[4][0].get(f"/api/events/{event_id}").json()
    assert people[1][0].get(f"/api/events/{event_id}").json()["announcements"][0]["text"] == message["text"]


def test_canceled_activity_cannot_publish_announcement(game):
    application, timer, people, event_id = game
    people[0][0].post(f"/api/events/{event_id}/cancel")
    response = people[0][0].post(f"/api/events/{event_id}/announcements", json={"text": "這場活動已取消。", "request_id": secrets.token_hex(16)})
    assert response.status_code == 409
