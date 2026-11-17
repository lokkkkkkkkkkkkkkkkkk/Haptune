"""Stage with friends: requests, messages between friends only, beat-my-score and class challenges, moments on a
Sound, reposts and the Friends feed."""
import io
import json
import os
import struct
import sys

os.environ.setdefault("HAPTUNE_DATA", "")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import pytest
from fastapi.testclient import TestClient

import academy
import accounts
import sounds
from app import app

client = TestClient(app)


def wav(seconds=4.0, rate=8000):
    data = b"\x00\x00" * int(seconds * rate)
    return b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data)) + data


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("HAPTUNE_SIGNIN_REQUIRED", "1")
    academy.reset_engine(f"sqlite:///{tmp_path/'f.db'}")
    monkeypatch.setattr(sounds, "transcode", lambda data, kind: (data, kind, sounds.wav_seconds(data)))
    yield
    accounts.limiter.hits.clear()


def user(name, handle=True):
    h = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": name}).json()["token"]}
    if handle:
        assert client.post("/c/auth/password", json={"handle": name.lower() + "_m", "password": "longenough1"}, headers=h).status_code == 200
    return h


def befriend(a, b, hb):
    assert client.post(f"/c/friends/{hb}", headers=a).json() == {"state": "requested"}
    assert client.post(f"/c/friends/{'ana_m' if hb != 'ana_m' else 'ben_m'}", headers=b).json()["state"] in ("friends", "requested")


def test_friend_requests_accept_decline_and_blocks():
    ana, ben, cai = user("Ana"), user("Ben"), user("Cai")
    assert client.post("/c/friends/ben_m", headers=ana).json() == {"state": "requested"}
    assert client.get("/c/friends/state/ana_m", headers=ben).json() == {"state": "incoming"}
    assert [p["handle"] for p in client.get("/c/friends", headers=ben).json()["incoming"]] == ["ana_m"]
    assert client.post("/c/friends/ana_m", headers=ben).json() == {"state": "friends"}            # asking back = accepting
    assert [p["handle"] for p in client.get("/c/friends", headers=ana).json()["friends"]] == ["ben_m"]
    kinds = [n["kind"] for n in client.get("/c/notifications", headers=ana).json()["items"]]
    assert "friend_accepted" in kinds
    # declining and unfriending
    client.post("/c/friends/ana_m", headers=cai)
    assert client.delete("/c/friends/cai_m", headers=ana).json() == {"state": "none"}
    assert client.get("/c/friends", headers=cai).json()["outgoing"] == []
    # blocked: no requests either way
    client.post("/c/users/cai_m/block", headers=ana)
    assert client.post("/c/friends/ana_m", headers=cai).status_code == 403
    assert client.post("/c/friends/ana_m", headers=ana).status_code == 400                        # that's you
    # a guest without a username can't send requests
    assert client.post("/c/friends/ana_m", headers=user("Dee", handle=False)).status_code == 401


def test_messages_only_between_friends():
    ana, ben, cai = user("Ana"), user("Ben"), user("Cai")
    assert client.post("/c/dms/ben_m", json={"text": "hi"}, headers=ana).status_code == 403
    client.post("/c/friends/ben_m", headers=ana)
    client.post("/c/friends/ana_m", headers=ben)
    assert client.post("/c/dms/ben_m", json={"text": "Shall we play the duet?"}, headers=ana).status_code == 200
    assert client.post("/c/dms/ben_m", json={"text": "Bar 5 is tricky"}, headers=ana).status_code == 200
    t = client.get("/c/dms", headers=ben).json()
    assert t["unread"] == 2 and t["items"][0]["with"]["handle"] == "ana_m" and t["items"][0]["last"]["text"] == "Bar 5 is tricky"
    # one notification per conversation until read
    assert [n["kind"] for n in client.get("/c/notifications", headers=ben).json()["items"]].count("dm") == 1
    th = client.get("/c/dms/ana_m", headers=ben).json()
    assert [m["text"] for m in th["items"]] == ["Shall we play the duet?", "Bar 5 is tricky"] and th["can_send"]
    assert client.get("/c/dms", headers=ben).json()["unread"] == 0
    assert client.get("/c/dms/ben_m", headers=cai).json()["items"] == []
    client.delete("/c/friends/ana_m", headers=ben)
    assert client.post("/c/dms/ana_m", json={"text": "?"}, headers=ben).status_code == 403
    assert client.get("/c/dms/ana_m", headers=ben).json()["can_send"] is False


def test_beat_my_score_and_a_class_challenge():
    ana, ben = user("Ana"), user("Ben")
    assert client.post("/c/duels", json={"handle": "ben_m", "piece_title": "Minuet", "score": 0.8}, headers=ana).status_code == 403   # friends only
    client.post("/c/friends/ben_m", headers=ana)
    client.post("/c/friends/ana_m", headers=ben)
    d = client.post("/c/duels", json={"handle": "ben_m", "piece_title": "Minuet", "catalog_id": "mutopia-1", "score": 0.8}, headers=ana).json()
    assert d["score"] == 80 and not d["over"] and d["to"]["handle"] == "ben_m"
    assert client.post(f"/c/duels/{d['id']}/entry", json={"score": 0.9}, headers=ana).status_code == 404     # not your own
    got = client.get("/c/duels", headers=ben).json()["open"]
    assert [x["piece_title"] for x in got] == ["Minuet"]
    r = client.post(f"/c/duels/{d['id']}/entry", json={"score": 0.92}, headers=ben).json()
    assert r["over"] and r["winner"]["handle"] == "ben_m" and r["mine"] == 92
    assert client.post(f"/c/duels/{d['id']}/entry", json={"score": 0.99}, headers=ben).status_code == 409    # once
    n = client.get("/c/notifications", headers=ana).json()["items"][0]
    assert n["kind"] == "duel_answered" and n["data"]["won"] is True
    # a class challenge: only the teacher opens it; students can improve their score
    t, s = ana, ben
    cls = client.post("/academy/classes", json={"name": "Strings"}, headers=t).json()["class"]
    client.post("/academy/join", json={"code": cls["join_code"]}, headers=s)
    assert client.post("/c/duels", json={"class_id": cls["id"], "piece_title": "Scales", "score": 0.7}, headers=s).status_code == 403
    cd = client.post("/c/duels", json={"class_id": cls["id"], "piece_title": "Scales", "score": 0.7}, headers=t).json()
    assert cd["class"]["name"] == "Strings"
    client.post(f"/c/duels/{cd['id']}/entry", json={"score": 0.6}, headers=s)
    r = client.post(f"/c/duels/{cd['id']}/entry", json={"score": 0.75}, headers=s).json()
    assert r["mine"] == 75 and not r["over"] and r["board"][0]["who"]["handle"] == "ben_m"
    assert client.get(f"/c/duels/{cd['id']}", headers=user("Eve")).status_code == 404


def test_moments_on_a_sound_reposts_and_the_friends_feed():
    ana, ben, cai = user("Ana"), user("Ben"), user("Cai")
    f = {"title": "Riff", "rights": "own", "project": json.dumps({"tempo": 100, "key": {"fifths": 0}, "tracks": [{"kind": "mic"}], "credits": []})}
    sid = client.post("/c/sounds", data=f, files={"audio": ("mix.wav", io.BytesIO(wav()), "audio/wav")}, headers=ana).json()["id"]
    assert client.post(f"/c/sounds/{sid}/moments", json={"at": 2.5, "text": "love this bit"}, headers=ben).status_code == 200
    assert client.post(f"/c/sounds/{sid}/moments", json={"at": 99, "text": "the end"}, headers=cai).status_code == 200
    m = client.get(f"/c/sounds/{sid}/moments").json()["items"]
    assert [(x["at"], x["text"]) for x in m] == [(2.5, "love this bit"), (4.0, "the end")]                  # kept inside the Sound
    assert client.delete(f"/c/moments/{m[1]['id']}", headers=ben).status_code == 403
    assert client.delete(f"/c/moments/{m[1]['id']}", headers=ana).status_code == 200                       # the owner may remove
    # Ben follows Cai; Cai reposts Ana's Sound; it shows in Ben's Friends feed, credited to Cai
    client.post("/c/users/cai_m/follow", headers=ben)
    assert client.post("/c/reposts", json={"target": f"s:{sid}"}, headers=cai).json() == {"reposted": True, "count": 1}
    feed = client.get("/c/feed/friends", headers=ben).json()["items"]
    assert feed[0]["kind"] == "sound" and feed[0]["sound"]["id"] == sid and feed[0]["by"]["handle"] == "cai_m" and feed[0]["reposts"] == 1
    assert client.post("/c/reposts", json={"target": "s:nope1234"}, headers=cai).status_code == 404
    assert client.delete(f"/c/reposts/s:{sid}", headers=cai).json() == {"reposted": False, "count": 0}
    assert client.get("/c/feed/friends", headers=ben).json()["items"] == []
