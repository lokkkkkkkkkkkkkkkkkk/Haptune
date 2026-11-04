"""Neural source separation for band recordings (server side).

Backends, best first:

* ``demucs`` - Meta's Hybrid Transformer Demucs, 6 stems (vocals, drums, bass, guitar, piano, other).
  MIT-licensed code and weights; needs ``pip install demucs`` (PyTorch). Used when installed.
* ``mdx``    - MDX-Net models run with ONNX Runtime (no PyTorch, ~15 MB runtime, fast on CPU):
  vocals (Kim Vocal 2 / UVR Voc FT) then drums, bass and other on the instrumental (KUIELab MDX-Net).
  Weights are downloaded once from GitHub releases into ``~/.cache/haptune/models``.

Both return float32 stereo stems at 44.1 kHz that sum (approximately) to the input mix.
A melodic instrument inside "other" (violin, flute, erhu ...) is pulled out afterwards by
``lead.extract_lead``.
"""
from __future__ import annotations

import hashlib
import math
import os
import shutil
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass

import numpy as np

SR = 44100
CACHE = os.environ.get("HAPTUNE_MODELS", os.path.join(os.path.expanduser("~"), ".cache", "haptune", "models"))
UVR_RELEASE = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/"


@dataclass(frozen=True)
class MDXSpec:
    file: str
    stem: str
    n_fft: int
    dim_f: int
    dim_t_pow: int
    compensate: float
    size: int                 # bytes, sanity check after download


MDX_MODELS = {
    "vocals": MDXSpec("Kim_Vocal_2.onnx", "vocals", 7680, 3072, 8, 1.009, 66759214),
    "vocals_ft": MDXSpec("UVR-MDX-NET-Voc_FT.onnx", "vocals", 7680, 3072, 8, 1.021, 66762490),
    "drums": MDXSpec("kuielab_b_drums.onnx", "drums", 4096, 2048, 7, 1.035, 21930313),
    "bass": MDXSpec("kuielab_b_bass.onnx", "bass", 16384, 2048, 8, 1.035, 29703204),
    "other": MDXSpec("kuielab_b_other.onnx", "other", 8192, 2048, 8, 1.035, 29703204),
}


def model_path(spec: MDXSpec, download: bool = True) -> str:
    path = os.path.join(CACHE, spec.file)
    if os.path.exists(path) and os.path.getsize(path) == spec.size:
        return path
    alt = os.environ.get("HAPTUNE_MODEL_DIR", "")
    if alt and os.path.exists(os.path.join(alt, spec.file)) and os.path.getsize(os.path.join(alt, spec.file)) == spec.size:
        return os.path.join(alt, spec.file)
    if not download:
        raise FileNotFoundError(path)
    os.makedirs(CACHE, exist_ok=True)
    tmp = path + ".part"
    with urllib.request.urlopen(UVR_RELEASE + spec.file, timeout=60) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    if os.path.getsize(tmp) != spec.size:
        os.remove(tmp)
        raise RuntimeError(f"download of {spec.file} was incomplete")
    os.replace(tmp, path)
    return path


class MDXNet:
    """One MDX-Net ONNX model (TFC-TDF U-Net on the complex spectrogram), numpy pre/post-processing
    identical to the reference implementation (torch.stft, centre=True, periodic Hann, hop 1024)."""

    hop = 1024

    def __init__(self, spec: MDXSpec, threads: int | None = None):
        import onnxruntime as ort
        self.spec = spec
        self.n_fft, self.dim_f = spec.n_fft, spec.dim_f
        self.dim_t = 2 ** spec.dim_t_pow
        self.n_bins = self.n_fft // 2 + 1
        self.chunk = self.hop * (self.dim_t - 1)
        self.window = np.hanning(self.n_fft + 1)[:-1].astype(np.float32)          # periodic Hann
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = threads
        self.session = ort.InferenceSession(model_path(spec), sess_options=opts, providers=["CPUExecutionProvider"])

    def _stft(self, x: np.ndarray) -> np.ndarray:
        """x: (batch, 2, chunk) -> (batch, 4, dim_f, dim_t) as [L.re, L.im, R.re, R.im]."""
        b = x.shape[0]
        flat = x.reshape(-1, self.chunk)
        pad = self.n_fft // 2
        xp = np.pad(flat, ((0, 0), (pad, pad)), mode="reflect")
        idx = np.arange(self.n_fft)[None, :] + self.hop * np.arange(self.dim_t)[:, None]
        frames = xp[:, idx] * self.window                                        # (B2, T, n_fft)
        Z = np.fft.rfft(frames, axis=-1)                                         # (B2, T, F)
        Z = np.transpose(Z, (0, 2, 1))[:, : self.dim_f, :]                      # (B2, dim_f, T)
        out = np.stack([Z.real, Z.imag], axis=1).reshape(b, 2, 2, self.dim_f, self.dim_t)
        return out.reshape(b, 4, self.dim_f, self.dim_t).astype(np.float32)

    def _istft(self, s: np.ndarray) -> np.ndarray:
        b = s.shape[0]
        full = np.zeros((b, 4, self.n_bins, self.dim_t), dtype=np.float32)
        full[:, :, : self.dim_f] = s
        z = full.reshape(b, 2, 2, self.n_bins, self.dim_t)
        Z = (z[:, :, 0] + 1j * z[:, :, 1]).reshape(b * 2, self.n_bins, self.dim_t)
        frames = np.fft.irfft(np.transpose(Z, (0, 2, 1)), n=self.n_fft, axis=-1) * self.window   # (B2, T, n_fft)
        total = self.n_fft + self.hop * (self.dim_t - 1)
        y = np.zeros((b * 2, total), dtype=np.float64)
        env = np.zeros(total)
        w2 = self.window.astype(np.float64) ** 2
        for t in range(self.dim_t):
            y[:, t * self.hop: t * self.hop + self.n_fft] += frames[:, t]
            env[t * self.hop: t * self.hop + self.n_fft] += w2
        y /= np.where(env > 1e-11, env, 1.0)
        pad = self.n_fft // 2
        y = y[:, pad: pad + self.chunk]
        return y.reshape(b, 2, self.chunk)

    def __call__(self, mix: np.ndarray, batch: int = 1, denoise: bool = True, progress=None) -> np.ndarray:
        """mix: (n, 2) float at 44.1 kHz -> the model's stem, (n, 2)."""
        x = np.asarray(mix, dtype=np.float32).T                                # (2, n)
        n = x.shape[1]
        trim = self.n_fft // 2
        gen = self.chunk - 2 * trim
        pad = gen - n % gen
        xp = np.concatenate([np.zeros((2, trim), np.float32), x, np.zeros((2, pad + trim), np.float32)], axis=1)
        starts = list(range(0, n + pad, gen))
        out = []
        for k in range(0, len(starts), batch):
            waves = np.stack([xp[:, i: i + self.chunk] for i in starts[k: k + batch]])
            spec = self._stft(waves)
            pred = self.session.run(None, {"input": spec})[0]
            if denoise:                                                          # symmetric pass halves the noise
                pred = 0.5 * pred - 0.5 * self.session.run(None, {"input": -spec})[0]
            out.append(self._istft(pred)[:, :, trim:-trim])
            if progress:
                progress(min(1.0, (k + batch) / len(starts)))
        y = np.concatenate(out, axis=0).transpose(1, 0, 2).reshape(2, -1)[:, :n]
        return y.T.astype(np.float32)


def load_stereo(path: str, sr: int = SR) -> np.ndarray:
    """Any audio/video file -> (n, 2) float32 at 44.1 kHz (ffmpeg for compressed formats)."""
    import soundfile as sf
    try:
        data, fsr = sf.read(path, dtype="float32", always_2d=True)
    except Exception:
        if not shutil.which("ffmpeg"):
            raise
        with tempfile.TemporaryDirectory() as td:
            wav = os.path.join(td, "decoded.wav")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-vn", "-ac", "2", "-ar", str(sr), wav],
                           check=True)
            data, fsr = sf.read(wav, dtype="float32", always_2d=True)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    data = data[:, :2]
    if fsr != sr:
        from scipy.signal import resample_poly
        g = math.gcd(int(fsr), sr)
        data = resample_poly(data, sr // g, int(fsr) // g, axis=0).astype(np.float32)
    return data


def _demucs_available() -> bool:
    try:
        import demucs  # noqa: F401
        return True
    except Exception:
        return False


def separate(mix: np.ndarray, backend: str = "auto", progress=None) -> dict[str, np.ndarray]:
    """mix: (n, 2) at 44.1 kHz -> {"vocals", "drums", "bass", "other"[, "piano", "guitar"]} (n, 2) each."""
    say = progress or (lambda stage, frac: None)
    if backend == "auto":
        backend = "demucs" if _demucs_available() else "mdx"
    if backend == "demucs":
        return _separate_demucs(mix, say)
    stems: dict[str, np.ndarray] = {}
    say("vocals", 0.0)
    voc = MDXNet(MDX_MODELS["vocals"])(mix, progress=lambda f: say("vocals", f))
    stems["vocals"] = voc
    inst = mix - voc * MDX_MODELS["vocals"].compensate
    say("drums", 0.0)
    drums = MDXNet(MDX_MODELS["drums"])(inst, denoise=False, progress=lambda f: say("drums", f))
    say("bass", 0.0)
    bass = MDXNet(MDX_MODELS["bass"])(inst, denoise=False, progress=lambda f: say("bass", f))
    stems["drums"], stems["bass"] = drums, bass
    stems["other"] = (inst - drums - bass).astype(np.float32)        # residual keeps the stems summing to the mix
    return stems


def _separate_demucs(mix: np.ndarray, say) -> dict[str, np.ndarray]:
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model
    model = get_model("htdemucs_6s")
    model.eval()
    say("demucs", 0.0)
    wav = torch.from_numpy(np.ascontiguousarray(mix.T))[None]
    ref = wav.mean(1)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        out = apply_model(model, wav, shifts=1, split=True, overlap=0.25, progress=False)[0]
    out = out * (ref.std() + 1e-8) + ref.mean()
    say("demucs", 1.0)
    return {name: out[i].numpy().T.astype(np.float32) for i, name in enumerate(model.sources)}


def file_md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()
