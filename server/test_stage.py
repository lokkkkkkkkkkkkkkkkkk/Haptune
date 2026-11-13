"""Stage: presence, trending, search, the daily challenge with friends, emoji reactions, Notes and passes."""
import os
os.environ.setdefault("HAPTUNE_SIGNIN_REQUIRED", "0")   # these tests use guest accounts; test_hub.py checks the sign-in rule
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "engine"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

import academy  # noqa: E402
import accounts  # noqa: E402
import app as app_module  # noqa: E402
import stage  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    academy.reset_engine(f"sqlite:///{tmp_path}/s.db")
    app_module._limiter.hits.clear()
    accounts.limiter.hits.clear()
    accounts.PRESENCE.clear()
    accounts.PRACTISING.clear()
    monkeypatch.setenv("HAPTUNE_ADMIN_CODE", "let-me-in-please-123")
    yield


def person(name="Aina"):
    r = client.post("/c/auth/guest", json={"name": name})
    tok = r.json()["token"]
    return {"Authorization": f"Bearer {tok}"}, r.json()["me"]


def dev():
    h, me = person("Lok")
    client.post("/c/me/dev", json={"code": "let-me-in-please-123"}, headers=h)
    return h, me


def request(h, title, **kw):
    r = client.post("/c/posts", headers=h, json={"type": "request", "title": title, "licence": "copyrighted", **kw})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_pulse_counts_real_people_and_ranks_what_is_wanted():
    a, _ = person("Aina")
    b, _ = person("Bala")
    c, _ = person("Chen")
    quiet = request(a, "Song nobody else wants")
    hot = request(a, "Song everyone wants", artist="Jay Chou")
    for h in (b, c):
        assert client.post(f"/c/posts/{hot}/want", json={"add": 0}, headers=h).status_code == 200
    p = client.get("/c/pulse", headers=a).json()
    assert p["online"] == 3 and p["today"] == 3 and p["open_requests"] == 2 and p["practising"] == 0
    assert [t["id"] for t in p["trending"]] == [hot, quiet] and p["trending"][0]["heat"] == 2 and p["trending"][0]["kind"] == "request"
    assert client.get("/c/pulse", params={"practising": True}, headers=b).json()["practising"] == 1
    accounts.PRESENCE[next(iter(accounts.PRESENCE))] = time.time() - 900        # one of them left a while ago
    assert client.get("/c/pulse").json()["online"] == 2


def test_search_finds_scores_and_requests_by_song_or_artist():
    a, _ = person()
    rid = request(a, "稻香 easy piano", song="稻香", artist="Jay Chou")
    xml = open(os.path.join(HERE, "..", "engine", "samples", "minuet_violin.musicxml"), encoding="utf-8").read()
    sid = client.post("/c/posts", headers=a, json={"type": "share", "title": "Minuet in G", "artist": "Petzold", "licence": "pd", "xml": xml}).json()["id"]
    assert client.get("/c/search", params={"q": "jay"}).json() == {"scores": [], "requests": client.get("/c/search", params={"q": "稻香"}).json()["requests"]}
    assert [x["id"] for x in client.get("/c/search", params={"q": "稻香"}).json()["requests"]] == [rid]
    assert [x["id"] for x in client.get("/c/search", params={"q": "minuet"}).json()["scores"]] == [sid]
    assert client.get("/c/search", params={"q": "m"}).json() == {"scores": [], "requests": []}
    front = client.get("/c/stage", headers=a).json()
    assert [p["id"] for p in front["new_scores"]] == [sid] and [p["id"] for p in front["wanted"]] == [rid] and front["counts"]["scores_week"] == 1


def test_daily_challenge_with_friends_and_a_nudge():
    a, am = person("Aina")
    b, bm = person("Bala")
    c, cm = person("Chen")
    d = client.get("/c/daily", headers=a).json()
    assert d["players"] == 0 and d["mine"] is None and d["title"]
    assert client.post("/c/daily/entry", json={"song": "not-today", "accuracy": 0.9}, headers=a).status_code == 400
    r = client.post("/c/daily/entry", json={"song": d["song"], "accuracy": 0.8, "tempo_pct": 100, "seconds": 40}, headers=a).json()
    assert r["earned"] == 5 and r["mine"]["rank"] == 1 and r["streak"] == 1
    again = client.post("/c/daily/entry", json={"song": d["song"], "accuracy": 0.7}, headers=a).json()
    assert again["earned"] == 0 and again["mine"]["accuracy"] == 0.8                       # the best try counts, Notes once a day
    client.post("/c/daily/entry", json={"song": d["song"], "accuracy": 0.95}, headers=b)
    assert client.get("/c/daily", headers=a).json()["mine"]["rank"] == 2
    # friends: Aina follows Bala (played) and Chen (not yet)
    for m in (bm, cm):
        assert client.post(f"/c/users/{m['handle']}/follow", headers=a).status_code == 200
    d = client.get("/c/daily", headers=a).json()
    assert [e["user"]["handle"] for e in d["friends"]] == [bm["handle"], am["handle"]]
    assert [u["handle"] for u in d["waiting"]] == [cm["handle"]]
    assert client.post("/c/daily/nudge", json={"handle": cm["handle"]}, headers=a).json() == {"ok": True}
    assert client.post("/c/daily/nudge", json={"handle": cm["handle"]}, headers=a).json().get("already")
    assert client.post("/c/daily/nudge", json={"handle": bm["handle"]}, headers=a).json().get("played")
    assert client.post("/c/daily/nudge", json={"handle": am["handle"]}, headers=c).status_code == 403   # not following
    kinds = [n["kind"] for n in client.get("/c/notifications", headers=c).json()["items"]]
    assert kinds.count("nudge") == 1
    assert client.get("/c/pulse", headers=a).json()["daily"]["players"] == 2


def test_one_emoji_each_and_they_count_as_likes():
    a, _ = person("Aina")
    b, _ = person("Bala")
    pid = request(a, "Canon in D for flute")
    t = f"p:{pid}"
    assert client.post("/c/emoji", json={"target": t, "kind": "fire"}, headers=b).json() == {"mine": "fire", "counts": {"fire": 1}, "total": 1}
    assert client.post("/c/emoji", json={"target": t, "kind": "love"}, headers=b).json() == {"mine": "love", "counts": {"love": 1}, "total": 1}
    assert client.post("/c/emoji", json={"target": t, "kind": "love"}, headers=a).json()["counts"] == {"love": 2}
    assert client.get(f"/c/posts/{pid}", headers=a).json()["likes"] == 2
    assert client.post("/c/emoji", json={"target": t, "kind": "love"}, headers=b).json() == {"mine": None, "counts": {"love": 1}, "total": 1}
    got = client.get("/c/emoji", params={"targets": t}, headers=a).json()["items"][t]
    assert got == {"counts": {"love": 1}, "mine": "love"}
    assert client.post("/c/emoji", json={"target": t, "kind": "clap"}, headers=b).status_code == 422


def test_notes_rank_and_a_pro_pass():
    h, me = person("Aina")
    r = client.get("/c/rewards", headers=h).json()
    assert r["notes"] == 100 and r["rank"]["id"] == "listener" and r["rank"]["next"] == "player"   # welcome Notes are not rank
    assert [x["id"] for x in r["redeem"]] == ["plus_week", "pro_3", "pro_7"] and all(x["why"] == "notes" for x in r["redeem"])
    client.post("/c/practice", json={"minutes": 10}, headers=h)
    assert client.get("/c/rewards", headers=h).json()["rank"]["lifetime"] == 5
    assert client.post("/c/rewards/redeem", json={"item": "pro_3"}, headers=h).status_code == 402
    d, _ = dev()
    client.post("/c/admin/credits", json={"handle": me["handle"], "delta": 2000}, headers=d)
    got = client.post("/c/rewards/redeem", json={"item": "pro_3"}, headers=h)
    assert got.status_code == 200, got.text
    now = got.json()
    assert now["tier"] == "pro" and now["tier_source"] == "notes" and now["credits"] == 100 + 5 + 2000 - 700
    # a three-day pass gets a tenth of the month's AI pages, at least one
    month = accounts.plan_table()["pro"]["read_pages"]
    assert now["limits"]["read_pages"] == max(1, int(month * 0.1 + 0.5))
    again = client.post("/c/rewards/redeem", json={"item": "pro_7"}, headers=h)
    assert again.status_code == 409 and again.json()["detail"]["code"] == "wait"                    # once a month
    assert client.get("/c/rewards", headers=h).json()["history"][0]["reason"] == "pass"


def test_passes_are_capped_for_the_whole_server(monkeypatch):
    monkeypatch.setattr(stage, "PASSES_PER_MONTH", 1)
    d, _ = dev()
    people = [person(n) for n in ("Aina", "Bala")]
    for h, me in people:
        client.post("/c/admin/credits", json={"handle": me["handle"], "delta": 2000}, headers=d)
    assert client.post("/c/rewards/redeem", json={"item": "pro_3"}, headers=people[0][0]).status_code == 200
    r = client.post("/c/rewards/redeem", json={"item": "pro_3"}, headers=people[1][0])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "sold_out"
    assert client.post("/c/rewards/redeem", json={"item": "plus_week"}, headers=people[1][0]).status_code == 200   # Plus is not capped


def test_new_columns_are_added_to_a_database_made_by_an_older_version(tmp_path):
    """People's accounts live in a database on the server's disk. A new version must add its columns to it."""
    url = f"sqlite:///{tmp_path}/old.db"
    academy.reset_engine(url)
    academy.engine()                                             # make every table
    old = create_engine(url)
    with old.begin() as c:                                       # take away a column, as if made before it existed
        c.execute(text("ALTER TABLE accounts DROP COLUMN pass_days"))
        c.execute(text("ALTER TABLE accounts DROP COLUMN stripe_customer"))
    academy.reset_engine(url)
    h, me = person("Aina")                                       # would fail with "no such column" without the upgrade
    assert client.get("/c/me", headers=h).json()["handle"] == me["handle"]
