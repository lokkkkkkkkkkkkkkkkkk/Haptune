"""API smoke tests (run: python -m pytest -q server)."""
import io
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))

from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402
from haptune import dsp  # noqa: E402
from haptune.demo_pieces import ODE_TO_JOY_JIANPU, minuet_in_g  # noqa: E402
from haptune.synth import Mistake, perform  # noqa: E402

client = TestClient(app)


def _wav(y):
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, y, dsp.SR, format="WAV")
    return buf.getvalue()


def test_home_page_points_to_the_app():
    r = client.get("/")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert "Haptune server is running" in r.text and "github.io/Haptune" in r.text


def test_health_and_instruments():
    assert client.get("/health").json()["ok"]
    keys = {i["key"] for i in client.get("/instruments").json()["instruments"]}
    assert {"piano", "violin", "guitar", "voice_soprano", "erhu"} <= keys


def test_jianpu_import():
    r = client.post("/score/import", files={"file": ("ode.jianpu", ODE_TO_JOY_JIANPU.encode(), "text/plain")})
    assert r.status_code == 200
    body = r.json()
    assert body["score"]["schema"] == "haptune.score/1"
    assert len(body["score"]["notes"]) == 30 and "<score-partwise" in body["musicxml"]


def test_analyze_json_and_html():
    sc = minuet_in_g()
    perf = perform(sc, "violin", mistakes=[Mistake(13, "wrong", -1)], seed=21)
    files = {"audio": ("take.wav", _wav(perf.audio), "audio/wav")}
    data = {"score_json": json.dumps(sc.to_json()), "instrument": "violin"}
    r = client.post("/analyze", files=files, data=data)
    assert r.status_code == 200
    out = r.json()
    assert out["scores"]["counts"]["wrong"] == 1
    assert any(e["type"] == "wrong_note" for e in out["watch_events"])
    r = client.post("/analyze", files=files, data={**data, "format": "html"})
    assert r.status_code == 200 and "<svg" in r.text


def test_transcribe_and_scale():
    sc = minuet_in_g(qpm=100)
    perf = perform(sc, "flute", seed=11)
    r = client.post("/score/transcribe", files={"file": ("solo.wav", _wav(perf.audio), "audio/wav")},
                    data={"instrument": "flute"})
    assert r.status_code == 200 and len(r.json()["score"]["notes"]) == len(sc.notes)
    r = client.get("/exercise/scale", params={"tonic": "D", "kind": "major", "octaves": 2, "instrument": "violin"})
    assert r.status_code == 200 and r.json()["score"]["notes"][0]["p"] == 62


def test_abc_import():
    abc = "X:1\nT:Scale\nM:4/4\nL:1/4\nK:C\nC D E F | G A B c |]\n"
    r = client.post("/score/import", files={"file": ("scale.abc", abc.encode(), "text/plain")})
    assert r.status_code == 200, r.text
    assert [n["p"] for n in r.json()["score"]["notes"]][:4] == [60, 62, 64, 65]


def test_split_job_lifecycle(monkeypatch, tmp_path):
    """The job API end to end, with the heavy pipeline replaced by a stub that writes its outputs."""
    import time as _time
    import haptune.band as band

    def fake_split(path, out_dir, instruments=None, title=None, progress=None, **kw):
        os.makedirs(os.path.join(out_dir, "stems"), exist_ok=True)
        progress("vocals", 0.5)
        with open(os.path.join(out_dir, "stems", "vocals.m4a"), "wb") as f:
            f.write(b"fake-audio")
        sc = minuet_in_g()
        res = {"title": title, "bpm": 96, "key": "G major", "duration": 30.0, "offset": 0.5,
               "parts": [{"id": "vocals", "name": "Voice", "instrument": "voice_soprano", "role": "vocals",
                          "file": "stems/vocals.m4a", "score_part": "P1", "activity": [0.5] * 30}],
               "chords": [{"beat": 0, "label": "G"}], "score": sc.to_json(), "musicxml": "<score-partwise/>"}
        with open(os.path.join(out_dir, "split.json"), "w") as f:
            json.dump(res, f)
        return res

    monkeypatch.setattr(band, "band_split", fake_split)
    r = client.post("/jobs/split", files={"file": ("song.wav", _wav(minuet_in_g().notes and __import__("numpy").zeros(2205)), "audio/wav")},
                    data={"instruments": "voice,violin", "title": "Song"})
    assert r.status_code == 200
    jid = r.json()["id"]
    for _ in range(100):
        st = client.get(f"/jobs/{jid}").json()
        if st["status"] in ("done", "error"):
            break
        _time.sleep(0.05)
    assert st["status"] == "done", st
    res = client.get(f"/jobs/{jid}/result").json()
    assert res["parts"][0]["file"] == "stems/vocals.m4a" and res["title"] == "Song"
    assert client.get(f"/jobs/{jid}/files/stems/vocals.m4a").content == b"fake-audio"
    assert client.get(f"/jobs/{jid}/files/../../etc/passwd").status_code == 404
    assert client.get("/jobs/nope").status_code == 404
