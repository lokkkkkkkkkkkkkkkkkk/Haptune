"""Developer mode > Brand: owner only, in Developer mode; the name and icon are committed through GitHub's API
(replaced here by a fake), plain SVGs only, and every save is audited."""
import base64
import json
import os
import sys

os.environ.setdefault("HAPTUNE_DATA", "")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import pytest
from fastapi.testclient import TestClient

import academy
import accounts
import brand as B
from app import app

client = TestClient(app)
SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#6E56CF"/></svg>'


class FakeGitHub:
    def __init__(self):
        self.files = {"web/brand.json": json.dumps({"name": "Haptune", "shortName": "Haptune", "icon": "assets/brand/icon.svg"}).encode(),
                      "web/assets/brand/icon.svg": SVG.encode()}
        self.puts = []

    def __call__(self, method, path, body=None):
        p = path.split("?")[0].removeprefix("/contents/")
        if method == "GET":
            return {"sha": "s1", "content": base64.b64encode(self.files[p]).decode()} if p in self.files else {}
        self.puts.append((p, body["message"]))
        self.files[p] = base64.b64decode(body["content"])
        return {"content": {"path": p}}


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("HAPTUNE_SIGNIN_REQUIRED", "1")
    monkeypatch.setenv("HAPTUNE_OWNER_EMAILS", "boss@gmail.com")
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    monkeypatch.setenv("GITHUB_REPO", "me/Haptune")
    academy.reset_engine(f"sqlite:///{tmp_path/'b.db'}")
    gh = FakeGitHub()
    monkeypatch.setattr(B, "_gh", gh)
    yield gh
    accounts.limiter.hits.clear()


def owner_in_dev_mode(monkeypatch):
    h = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "Boss"}).json()["token"]}
    monkeypatch.setattr(accounts, "verify_google", lambda cred: {"sub": "g-boss", "email": "boss@gmail.com", "email_verified": "true", "given_name": "Boss"})
    client.post("/c/auth/google", json={"credential": "c" * 40}, headers=h)
    sec = client.post("/c/me/2fa/setup", headers=h).json()["secret"]
    client.post("/c/me/2fa/enable", json={"code": accounts.totp(sec)}, headers=h)
    r = client.post("/c/me/devmode", json={"on": True, "code": accounts.totp(sec, 1)}, headers=h)
    assert r.status_code == 200, r.text
    return h


def test_owner_renames_and_changes_the_icon(monkeypatch, fresh):
    h = owner_in_dev_mode(monkeypatch)
    cur = client.get("/c/admin/brand", headers=h).json()
    assert cur["configured"] and cur["name"] == "Haptune" and cur["icon_svg"].startswith("<svg")
    new = SVG.replace("#6E56CF", "#FF0000")
    r = client.post("/c/admin/brand", json={"name": "Melody Pal", "short_name": "Melody", "icon_svg": new}, headers=h)
    assert r.status_code == 200, r.text
    b = json.loads(fresh.files["web/brand.json"])
    assert b["name"] == "Melody Pal" and b["shortName"] == "Melody" and fresh.files["web/assets/brand/icon.svg"].decode() == new
    assert [p for p, _ in fresh.puts] == ["web/assets/brand/icon.svg", "web/brand.json"]
    # the same again changes nothing
    client.post("/c/admin/brand", json={"name": "Melody Pal", "short_name": "Melody", "icon_svg": new}, headers=h)
    assert len(fresh.puts) == 2


def test_only_plain_pictures_and_only_the_owner(monkeypatch, fresh):
    h = owner_in_dev_mode(monkeypatch)
    bad = SVG.replace("<rect", "<script>alert(1)</script><rect")
    assert client.post("/c/admin/brand", json={"name": "X App", "icon_svg": bad}, headers=h).status_code == 400
    assert client.post("/c/admin/brand", json={"name": "X App", "icon_png_b64": base64.b64encode(b"not a png").decode()}, headers=h).status_code == 400
    g = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "G"}).json()["token"]}
    assert client.post("/c/admin/brand", json={"name": "Hacked"}, headers=g).status_code in (401, 403)
    assert not fresh.puts


def test_without_github_settings_it_says_what_to_do(monkeypatch, fresh):
    h = owner_in_dev_mode(monkeypatch)
    monkeypatch.delenv("GITHUB_TOKEN")
    assert client.get("/c/admin/brand", headers=h).json()["configured"] is False
