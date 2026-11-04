"""Band split: role planning, chord recognition, lead-line extraction and the whole pipeline on a
synthesised trio (separation is stubbed with the true stems, so these tests need no model files)."""
import os

import numpy as np
import pytest

from haptune import band, chords, dsp
from haptune.demo_pieces import _MINUET, minuet_in_g
from haptune.instruments import get_profile
from haptune.lead import extract_lead
from haptune.synth import perform, render_tone
from haptune.transcribe import transcribe_mono

SR = dsp.SR
PROGRESSION = [(55, 59, 62), (55, 60, 64), (57, 60, 64), (55, 59, 62), (57, 60, 64), (55, 59, 62), (54, 57, 62), (54, 57, 62)] * 2


def _piano_waltz(qpm=96, lead_in=0.5, n=None, seed=4):
    beat = 60 / qpm
    y = np.zeros(n or int((lead_in + 48 * beat + 3) * SR))
    r = np.random.default_rng(seed)
    for b, ch in enumerate(PROGRESSION):
        for k in range(3):
            on = lead_in + (b * 3 + k) * beat
            for p in (ch if k == 0 else ch[1:]):
                t = render_tone("piano", p, beat * 0.95, SR, 0.6, r)
                s = int(on * SR)
                y[s:s + len(t)] += t[:max(0, len(y) - s)]
    return y


@pytest.fixture(scope="module")
def trio():
    vio = perform(minuet_in_g(), "violin", qpm=96, reverb=0.15, snr_db=45, seed=7)
    pia = _piano_waltz(n=len(vio.audio) + SR)
    v = np.pad(vio.audio.astype(np.float64), (0, len(pia) - len(vio.audio)))
    pia *= np.sqrt((v ** 2).mean() / ((pia ** 2).mean() + 1e-12))       # same loudness
    return v, pia, vio


def test_plan_roles():
    assert band.plan(["Voice", "violin", "keyboard"]) == {"vocals": "voice", "lead": "violin", "keys": "keyboard"}
    assert band.plan(["erhu", "guitar", "drums"]) == {"lead": "erhu", "keys": "guitar", "drums": "percussion"}
    assert band.plan([]) == {}


def test_chords_follow_the_progression(trio):
    _, pia, _ = trio
    beats = 0.5 + np.arange(48) * 60 / 96
    spans = chords.chord_spans(pia.astype(np.float32), beats, SR, key_fifths=1)
    labels = [s["label"] for s in spans]
    # G C Am G Am G D (D) per bar, repeated: the main harmonies must all be found
    assert {"G", "C", "Am", "D"} <= set(labels), labels
    assert len(labels) <= 16


def test_lead_line_comes_out_of_the_keyboard(trio):
    v, pia, vio = trio
    res = extract_lead(v + pia, SR, get_profile("violin"))
    notes = [n for n in transcribe_mono(res.lead, get_profile("violin")) if n.pitch is not None]
    truth = [(p.onset, int(round(p.midi))) for p in vio.notes]
    hit, used = 0, set()
    for t, p in truth:
        for j, n in enumerate(notes):
            if j not in used and n.pitch == p and abs(n.onset - t) < 0.1:
                used.add(j)
                hit += 1
                break
    assert hit / len(truth) >= 0.6, f"recall {hit}/{len(truth)}"
    assert len(notes) - hit <= 30


def test_band_split_pipeline(trio, tmp_path, monkeypatch):
    from scipy.signal import resample_poly
    v, pia, _ = trio
    other = resample_poly(v + pia, 2, 1).astype(np.float32)
    n = len(other)
    stems = {"vocals": np.zeros((n, 2), np.float32), "drums": np.zeros((n, 2), np.float32),
             "bass": np.zeros((n, 2), np.float32), "other": np.stack([other, other], 1)}
    monkeypatch.setattr(band, "separate", lambda mix, backend="auto", progress=None: stems)
    src = tmp_path / "trio.wav"
    import soundfile as sf
    sf.write(src, stems["other"], 44100)
    stages = []
    res = band.band_split(str(src), str(tmp_path / "out"), instruments=["violin", "keyboard"], title="Trio",
                          progress=lambda s, f: stages.append(s))
    assert [p["id"] for p in res["parts"]] == ["lead", "keys"]
    assert abs(res["bpm"] - 96) < 3 and res["key"] == "G major"
    assert res["chords"] and res["score"]["parts"][0]["instrument"] == "violin"
    lead = [n["p"] for n in res["score"]["notes"] if n["part"] == "P1"]
    truth = [p for bar in _MINUET for p, _ in bar]
    in_tune = sum(1 for p in lead if p in set(truth)) / max(1, len(lead))
    assert 40 <= len(lead) <= 90 and in_tune >= 0.6, (len(lead), in_tune)
    for p in res["parts"]:
        assert os.path.getsize(tmp_path / "out" / p["file"]) > 1000
    assert "<harmony" in res["musicxml"]                      # chord symbols on the keyboard staff
    assert {"lead", "transcribe", "chords", "encode", "done"} <= set(stages)


def test_mdx_spectrogram_round_trip():
    """The numpy STFT/iSTFT around the ONNX model matches the reference (torch.stft, centre=True)."""
    from scipy.signal import butter, sosfiltfilt

    from haptune.separate import MDX_MODELS, MDXNet
    m = MDXNet.__new__(MDXNet)                          # no ONNX session needed for the transforms
    spec = MDX_MODELS["vocals"]
    m.n_fft, m.dim_f, m.dim_t = spec.n_fft, spec.dim_f, 2 ** spec.dim_t_pow
    m.n_bins, m.chunk = m.n_fft // 2 + 1, m.hop * (2 ** spec.dim_t_pow - 1)
    m.window = np.hanning(m.n_fft + 1)[:-1].astype(np.float32)
    x = np.random.default_rng(0).standard_normal((1, 2, m.chunk)).astype(np.float32)
    x = sosfiltfilt(butter(8, 15000, fs=44100, output="sos"), x, axis=-1).astype(np.float32)
    y = m._istft(m._stft(x))
    assert m._stft(x).shape == (1, 4, spec.dim_f, 2 ** spec.dim_t_pow)
    assert np.abs(y - x)[..., 8000:-8000].max() < 1e-3 * np.abs(x).max()
