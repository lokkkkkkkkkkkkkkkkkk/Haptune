"""Developer mode > Brand: the app's name and icon in one place, for the website (and so Google search), the
installed web app and the Android app.

The name and icon live in the repository (web/brand.json and the icon file). Saving here commits those two files
through GitHub's API; .github/workflows/brand.yml then makes every icon size (tools/brand.cjs), commits them and
starts the website and Android builds. So a change reaches the website in a few minutes and the Android app with
its next build, with no computer needed.

Server settings (Fly secrets), both needed for saving; without them the page shows what to do instead:
  GITHUB_TOKEN   a fine-grained token for this repository only, with Contents: read and write, Actions: read and
                 write (github.com > Settings > Developer settings > Fine-grained tokens)
  GITHUB_REPO    owner/name, e.g. lokkkkkkkkkkkkkkkkkk/Haptune
Owner only, in Developer mode; every save goes to the audit log.
"""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import accounts as A
from academy import engine

router = APIRouter(prefix="/c/admin/brand", tags=["admin"])

API = "https://api.github.com"
BRANCH = os.environ.get("GITHUB_BRANCH", "main")
MAX_ICON = 400 * 1024


def _cfg() -> tuple[str, str] | None:
    tok, repo = os.environ.get("GITHUB_TOKEN", "").strip(), os.environ.get("GITHUB_REPO", "").strip()
    return (tok, repo) if tok and re.fullmatch(r"[\w.-]+/[\w.-]+", repo) else None


def _gh(method: str, path: str, body: dict | None = None) -> dict:
    """One GitHub API call. Tests replace this function."""
    cfg = _cfg()
    if not cfg:
        raise HTTPException(503, {"code": "brand_not_set_up", "message": "Saving needs GITHUB_TOKEN and GITHUB_REPO on the server."})
    tok, repo = cfg
    req = urllib.request.Request(f"{API}/repos/{repo}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                                          "User-Agent": "melovyn-server", **({"Content-Type": "application/json"} if body is not None else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code == 404 and method == "GET":
            return {}
        raise HTTPException(502, f"GitHub said no ({e.code}). Check that the token may write to {repo}.")
    except HTTPException:
        raise
    except Exception:                                               # noqa: BLE001
        raise HTTPException(502, "GitHub could not be reached. Please try again.")


def _read(path: str) -> tuple[str | None, bytes | None]:
    r = _gh("GET", f"/contents/{path}?ref={BRANCH}")
    if not r or "content" not in r:
        return None, None
    return r.get("sha"), base64.b64decode(r["content"])


def _write(path: str, data: bytes, message: str) -> None:
    sha, old = _read(path)
    if old == data:
        return
    _gh("PUT", f"/contents/{path}", {"message": message, "content": base64.b64encode(data).decode(), "branch": BRANCH, **({"sha": sha} if sha else {})})


@router.get("")
def get_brand(me: A.Me = Depends(A.require_scope("owner"))):
    """The name and icon now (read from the repository when the server may, else the defaults)."""
    cfg = _cfg()
    out = {"configured": bool(cfg), "repo": cfg[1] if cfg else "", "name": "Melovyn", "short_name": "Melovyn", "icon_svg": "", "icon_png": ""}
    if cfg:
        _, raw = _read("web/brand.json")
        if raw:
            b = json.loads(raw)
            out.update(name=b.get("name") or out["name"], short_name=b.get("shortName") or b.get("name") or out["short_name"])
            _, icon = _read("web/" + (b.get("icon") or "assets/brand/icon.svg"))
            if icon:
                key = "icon_svg" if (b.get("icon") or "").endswith(".svg") else "icon_png"
                out[key] = icon.decode() if key == "icon_svg" else base64.b64encode(icon).decode()
    return out


class BrandIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=30)
    short_name: str = Field("", max_length=12)
    icon_svg: str = Field("", max_length=MAX_ICON)
    icon_png_b64: str = Field("", max_length=MAX_ICON * 2)


def _clean_svg(svg: str) -> str:
    s = svg.strip()
    if not s.startswith("<svg") or "</svg>" not in s:
        raise HTTPException(400, "That isn't an SVG picture.")
    if re.search(r"<script|on\w+\s*=|javascript:|<foreignObject|xlink:href\s*=\s*[\"']https?:", s, re.I):
        raise HTTPException(400, "The SVG has scripts or outside links in it; please export a plain picture.")
    return s


@router.post("")
def save_brand(body: BrandIn, me: A.Me = Depends(A.require_scope("owner"))):
    name = body.name.strip()
    short = (body.short_name or name).strip()[:12]
    if not re.fullmatch(r"[\w .&'’\-+!]{2,30}", name, re.UNICODE):
        raise HTTPException(400, "Use letters, numbers and simple punctuation for the name.")
    icon_path = None
    if body.icon_svg:
        icon_path, data = "assets/brand/icon.svg", _clean_svg(body.icon_svg).encode()
    elif body.icon_png_b64:
        data = base64.b64decode(body.icon_png_b64)
        if not data.startswith(b"\x89PNG"):
            raise HTTPException(400, "That isn't a PNG picture.")
        w, h = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        if w < 512 or h < 512 or w != h:
            raise HTTPException(400, "The icon must be square and at least 512 × 512 pixels.")
        icon_path = "assets/brand/icon.png"
    _, cur = _read("web/brand.json")
    brand = json.loads(cur) if cur else {"icon": "assets/brand/icon.svg", "background": "#8E52DE"}
    brand.update(name=name, shortName=short, **({"icon": icon_path} if icon_path else {}))
    who = me.acc.get("handle") or me.id
    if icon_path:
        _write(f"web/{icon_path}", data, f"Brand: new icon (by @{who} in Developer mode)")
    _write("web/brand.json", (json.dumps(brand, indent=2, ensure_ascii=False) + "\n").encode(), f"Brand: {name} (by @{who} in Developer mode)")
    with engine().begin() as c:
        A.audit(c, me, "brand_saved", None, after={"name": name, "short_name": short, "icon": icon_path or "unchanged"})
    return {"ok": True, "name": name, "short_name": short, "icon": brand.get("icon")}
