"""HTTP API for the parts that are too heavy for the phone.

    uvicorn app:app --host 0.0.0.0 --port 8000

The app works offline for MusicXML / MIDI / jianpu scores and for live practice. It calls this
server only for:
  POST /score/import      PDF / photo of sheet music (OMR), ABC, MEI, Humdrum -> score
  POST /score/transcribe  a solo recording                                     -> score
  POST /jobs/split        a band recording -> background job (separate, transcribe each part)
  GET  /jobs/{id}         job progress;  /jobs/{id}/result  parts + multi-part score
  GET  /jobs/{id}/files/stems/<part>.m4a                                       practice stems
  POST /analyze           a take + score                                       -> full report
  GET  /exercise/scale    scale / arpeggio generator                           -> score
All score responses carry the canonical score JSON ("haptune.score/1") plus MusicXML for display.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))

from haptune import __version__, dsp                           # noqa: E402
from haptune.evaluate import evaluate                          # noqa: E402
from haptune.exercises import PATTERNS, scale                  # noqa: E402
from haptune.export import write_musicxml                      # noqa: E402
from haptune.follower import simulate                          # noqa: E402
from haptune.instruments import PROFILES                       # noqa: E402
from haptune.jianpu import parse_jianpu                        # noqa: E402
from haptune.master_score import recording_to_score            # noqa: E402
from haptune.report import build_report                        # noqa: E402
from haptune.score import Score, load_score                    # noqa: E402

MAX_UPLOAD = 40 * 1024 * 1024
MAX_RECORDING = 300 * 1024 * 1024        # band recordings may arrive as videos
JOBS_DIR = os.environ.get("HAPTUNE_JOBS", os.path.join(tempfile.gettempdir(), "haptune-jobs"))
JOB_TTL = 24 * 3600
app = FastAPI(title="Haptune engine", version=__version__)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=int(os.environ.get("HAPTUNE_WORKERS", "1")))


async def _save(upload: UploadFile, d: str, limit: int = MAX_UPLOAD) -> str:
    data = await upload.read()
    if len(data) > limit:
        raise HTTPException(413, f"file too large ({limit // (1024 * 1024)} MB max)")
    name = os.path.basename(upload.filename or "upload.bin") or "upload.bin"
    path = os.path.join(d, name)
    with open(path, "wb") as f:
        f.write(data)
    return path


def _payload(sc: Score, musicxml_path: str | None = None) -> dict:
    out = {"score": sc.to_json()}
    if musicxml_path and os.path.exists(musicxml_path):
        with open(musicxml_path, encoding="utf-8", errors="replace") as f:
            out["musicxml"] = f.read()
    return out


@app.get("/health")
def health():
    return {"ok": True, "version": __version__}


@app.get("/instruments")
def instruments():
    return {"instruments": [p.to_dict() for p in PROFILES.values()]}


@app.post("/score/import")
async def import_score(file: UploadFile = File(...)):
    with tempfile.TemporaryDirectory() as d:
        path = await _save(file, d)
        ext = os.path.splitext(path)[1].lower()
        try:
            if ext in (".txt", ".jianpu"):
                with open(path, encoding="utf-8") as f:
                    sc = parse_jianpu(f.read())
                xml = write_musicxml(sc, os.path.join(d, "out.musicxml"))
            elif ext in (".pdf", ".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff"):
                if ext in (".heic", ".tif", ".tiff"):
                    path = _to_png(path, d)
                sc = load_score(path, keep_dir=os.path.join(d, "omr"))
                xml = sc.source.get("musicxml")
            elif ext in (".abc", ".mei", ".krn", ".kern"):
                import music21 as m21
                xml = os.path.join(d, "converted.musicxml")
                m21.converter.parse(path).write("musicxml", fp=xml)
                sc = load_score(xml)
            else:
                sc = load_score(path)
                xml = path if ext in (".musicxml", ".xml") else write_musicxml(sc, os.path.join(d, "out.musicxml"))
        except (ValueError, KeyError, RuntimeError) as e:
            raise HTTPException(422, f"could not read the score: {e}")
        except Exception as e:                                   # music21 / OMR failures on odd files
            raise HTTPException(422, f"could not read the score: {e}")
        return JSONResponse(_payload(sc, xml))


def _to_png(path: str, d: str) -> str:
    from PIL import Image
    out = os.path.join(d, "page.png")
    Image.open(path).convert("RGB").save(out)
    return out


@app.post("/score/transcribe")
async def transcribe(file: UploadFile = File(...), instrument: str = Form("piano"),
                     bpm: float | None = Form(None), a4: float = Form(440.0)):
    with tempfile.TemporaryDirectory() as d:
        path = await _save(file, d, MAX_RECORDING)
        try:
            y = dsp.load_audio(path)
            sc = recording_to_score(y, instrument, a4=a4, title=os.path.splitext(file.filename or "Recording")[0],
                                    bpm_hint=bpm)
        except ValueError as e:
            raise HTTPException(422, str(e))
        xml = write_musicxml(sc, os.path.join(d, "transcription.musicxml"))
        return JSONResponse(_payload(sc, xml))


# ---------------------------------------------------------------------------
# Band split jobs (minutes of CPU: run in the background, poll for progress)
# ---------------------------------------------------------------------------
def _cleanup_old_jobs():
    now = time.time()
    with _lock:
        old = [k for k, j in _jobs.items() if now - j["created"] > JOB_TTL]
        for k in old:
            shutil.rmtree(_jobs[k]["dir"], ignore_errors=True)
            del _jobs[k]


def _run_split(jid: str, path: str, instruments: list[str], title: str | None):
    from haptune.band import band_split

    def progress(stage: str, frac: float):
        with _lock:
            _jobs[jid].update(status="running", stage=stage, progress=round(float(frac), 3))

    try:
        band_split(path, os.path.join(_jobs[jid]["dir"], "out"), instruments=instruments, title=title,
                   progress=progress)
        with _lock:
            _jobs[jid].update(status="done", stage="done", progress=1.0)
    except Exception as e:                                       # report any failure to the app
        with _lock:
            _jobs[jid].update(status="error", message=f"{type(e).__name__}: {e}")


@app.post("/jobs/split")
async def start_split(file: UploadFile = File(...), instruments: str = Form(""), title: str = Form("")):
    _cleanup_old_jobs()
    jid = uuid.uuid4().hex[:16]
    d = os.path.join(JOBS_DIR, jid)
    os.makedirs(d, exist_ok=True)
    path = await _save(file, d, MAX_RECORDING)
    with _lock:
        _jobs[jid] = {"id": jid, "status": "queued", "stage": "queued", "progress": 0.0, "message": None,
                      "dir": d, "created": time.time()}
    names = [s.strip() for s in instruments.split(",") if s.strip()]
    _pool.submit(_run_split, jid, path, names, title.strip() or os.path.splitext(file.filename or "Recording")[0])
    return {"id": jid}


def _job(jid: str) -> dict:
    with _lock:
        j = _jobs.get(jid)
        if j is None:
            raise HTTPException(404, "no such job (jobs are kept for 24 hours)")
        return dict(j)


@app.get("/jobs/{jid}")
def job_status(jid: str):
    j = _job(jid)
    return {k: j[k] for k in ("id", "status", "stage", "progress", "message")}


@app.get("/jobs/{jid}/result")
def job_result(jid: str):
    j = _job(jid)
    if j["status"] != "done":
        raise HTTPException(409, f"job is {j['status']}")
    return FileResponse(os.path.join(j["dir"], "out", "split.json"), media_type="application/json")


@app.get("/jobs/{jid}/files/{rel:path}")
def job_file(jid: str, rel: str):
    j = _job(jid)
    base = os.path.realpath(os.path.join(j["dir"], "out"))
    path = os.path.realpath(os.path.join(base, rel))
    if not path.startswith(base + os.sep) or not os.path.isfile(path):
        raise HTTPException(404, "no such file")
    return FileResponse(path)


# ---------------------------------------------------------------------------
@app.post("/analyze")
async def analyze(audio: UploadFile = File(...), score_json: str | None = Form(None),
                  score_file: UploadFile | None = File(None), instrument: str = Form("piano"),
                  target_qpm: float | None = Form(None), metronome: bool = Form(False),
                  level: str = Form("intermediate"), a4: float = Form(440.0),
                  format: str = Form("json")):
    with tempfile.TemporaryDirectory() as d:
        if score_json:
            sc = Score.from_json(json.loads(score_json))
            xml = None
        elif score_file is not None:
            spath = await _save(score_file, d)
            sc = load_score(spath)
            xml = spath if spath.lower().endswith((".musicxml", ".xml")) else None
        else:
            raise HTTPException(400, "send score_json or score_file")
        y = dsp.load_audio(await _save(audio, d, MAX_RECORDING))
        ev = evaluate(sc, y, instrument, a4=a4, target_qpm=target_qpm, metronome=metronome, level=level)
        buzzes = simulate(sc, y, instrument, mode="tempo" if metronome else "follow", qpm=target_qpm, a4=a4).buzzed
        if format == "html":
            return HTMLResponse(build_report(sc, ev, xml, buzzes))
        out = ev.to_json()
        out["watch_events"] = [b.to_json() for b in buzzes]
        return JSONResponse(out)


@app.get("/exercise/scale")
def exercise(tonic: str = "C", kind: str = Query("major", description="one of: " + ", ".join(PATTERNS)), octaves: int = 1,
             instrument: str = "piano", qpm: float = 80):
    try:
        sc = scale(tonic, kind, octaves, instrument, qpm=qpm)
    except KeyError as e:
        raise HTTPException(422, str(e))
    with tempfile.TemporaryDirectory() as d:
        xml = write_musicxml(sc, os.path.join(d, "scale.musicxml"))
        return JSONResponse(_payload(sc, xml))
