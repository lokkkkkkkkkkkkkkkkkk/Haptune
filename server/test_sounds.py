"""Sounds on Stage: posting with limits and checks, layers and versions, likes, reports and takedowns."""
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


def wav(seconds=2.0, rate=8000):
    n = int(seconds * rate)
    data = b"\x00\x00" * n
    return b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data)) + data


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("HAPTUNE_SIGNIN_REQUIRED", "1")
    academy.reset_engine(f"sqlite:///{tmp_path/'s.db'}")
    monkeypatch.setattr(sounds, "transcode", lambda data, kind: (data, kind, sounds.wav_seconds(data) if kind == "audio/wav" else 5.0))
    yield
    accounts.limiter.hits.clear()


def user(name):
    h = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": name}).json()["token"]}
    assert client.post("/c/auth/password", json={"handle": name.lower() + "_m", "password": "longenough1"}, headers=h).status_code == 200
    return h


def post(h, data=None, **form):
    f = {"title": "Riff", "rights": "own", "project": json.dumps({"tempo": 100, "key": {"fifths": 0}, "tracks": [{"kind": "mic"}], "credits": []}), **form}
    return client.post("/c/sounds", data=f, files={"audio": ("mix.wav", io.BytesIO(data if data is not None else wav()), "audio/wav")}, headers=h)


def test_post_play_and_versions():
    a, b = user("Ana"), user("Ben")
    r = post(a, sheet_xml='<?xml version="1.0"?><score-partwise version="4.0"></score-partwise>')
    assert r.status_code == 200 and r.json()["seconds"] == 2.0
    sid = r.json()["id"]
    feed = client.get("/c/sounds").json()["items"]
    assert feed[0]["title"] == "Riff" and feed[0]["has_sheet"] and feed[0]["tempo"] == 100
    au = client.get(f"/c/sounds/{sid}/audio")
    assert au.headers["content-type"] == "audio/wav" and au.headers["x-content-type-options"] == "nosniff" and au.content[:4] == b"RIFF"
    assert "attachment" in client.get(f"/c/sounds/{sid}/audio?download=1").headers["content-disposition"]
    assert client.get(f"/c/sounds/{sid}/sheet").text.startswith("<?xml")
    # Ben layers a track on Ana's Sound: a new version, Ana is told
    lay = post(b, title="Riff + bass", parent_id=sid).json()["id"]
    v = client.get(f"/c/sounds/{sid}").json()["versions"]
    assert [x["id"] for x in v["layers"]] == [lay]
    assert [x["id"] for x in client.get(f"/c/sounds/{lay}").json()["versions"]["before"]] == [sid]
    assert "sound_layered" in [n["kind"] for n in client.get("/c/notifications", headers=a).json()["items"]]
    # likes toggle
    assert client.post(f"/c/sounds/{sid}/like", headers=b).json() == {"liked": True, "likes": 1}
    assert client.post(f"/c/sounds/{sid}/like", headers=b).json() == {"liked": False, "likes": 0}


def test_checks_and_limits():
    a = user("Cai")
    assert post(a, rights="").status_code in (400, 422)                                # whose music is it?
    assert post(a, rights="someone").status_code == 400
    assert post(a, data=b"<html><script>x</script></html>").status_code == 415           # not audio
    assert post(a, data=wav(120)).status_code == 413                                    # free plan: 90 seconds
    assert post(a, project="[1,2]").status_code == 400
    assert post(a, sheet_xml="<html/>").status_code == 400
    g = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "G"}).json()["token"]}
    assert post(g).status_code == 401                                                   # sign in first
    assert sounds.sniff(b"ID3\x04") == "audio/mpeg" and sounds.sniff(b"\x00\x00\x00\x18ftypM4A ") == "audio/mp4" and sounds.sniff(b"<svg") is None


def test_reports_takedown_and_delete():
    a, b, c, d = user("Dee"), user("Eve"), user("Fay"), user("Gus")
    sid = post(a).json()["id"]
    # three reports hide it
    for h in (b, c):
        assert client.post(f"/c/sounds/{sid}/report", json={"reason": "abuse"}, headers=h).json()["hidden"] is False
    assert client.post(f"/c/sounds/{sid}/report", json={"reason": "abuse"}, headers=d).json()["hidden"] is True
    assert client.get(f"/c/sounds/{sid}/audio").status_code == 404
    assert client.get(f"/c/sounds/{sid}", headers=a).status_code == 200              # the author still sees it
    # a rights owner's copyright report takes it down at once
    sid2 = post(a, title="Cover").json()["id"]
    assert client.post(f"/c/sounds/{sid2}/report", json={"reason": "copyright", "owner": True, "note": "my song"}, headers=b).json()["hidden"]
    # only the author deletes
    sid3 = post(a, title="Mine").json()["id"]
    assert client.delete(f"/c/sounds/{sid3}", headers=b).status_code == 403
    assert client.delete(f"/c/sounds/{sid3}", headers=a).json()["ok"]
    assert client.get(f"/c/sounds/{sid3}").status_code == 404


def test_a_minute_of_cd_quality_wav_fits_the_free_plan(monkeypatch):
    # the app uploads its mixdown as WAV (~10 MB a minute); the server keeps AAC, and the size limit is on that
    big = b"RIFF" + struct.pack("<I", 36 + 60 * 176400) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 2, 44100, 176400, 4, 16) \
        + b"data" + struct.pack("<I", 60 * 176400) + b"\x00" * (60 * 176400)
    monkeypatch.setattr(sounds, "transcode", lambda data, kind: (b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 1000, "audio/mp4", 60.0))
    a = user("Hal")
    r = post(a, data=big)
    assert r.status_code == 200 and r.json()["audio_type"] == "audio/mp4"
    # but a stored file over the plan's size is still refused
    monkeypatch.setattr(sounds, "transcode", lambda data, kind: (data, kind, 60.0))
    assert post(a, data=big).status_code == 413


def test_wav_seconds():
    assert sounds.wav_seconds(wav(1.5)) == 1.5
    assert sounds.wav_seconds(b"RIFF....WAVE") is None
