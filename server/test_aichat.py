"""Hapi everywhere (/ai/chat): the tool loop with a fake model, read-only tools, and the action checks."""
import json
import os
import sys
from types import SimpleNamespace as NS

os.environ.setdefault("HAPTUNE_SIGNIN_REQUIRED", "0")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "engine"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import academy  # noqa: E402
import accounts  # noqa: E402
import aichat  # noqa: E402
import app as app_module  # noqa: E402
from app import app  # noqa: E402
from haptune.ai.claude import Claude  # noqa: E402

client = TestClient(app)
LIB = [{"id": "p1", "title": "Ode to Joy"}, {"id": "p2", "title": "Amazing Grace"}]


class FakeAPI:
    """Plays back model turns: each is a list of blocks; tool_use turns end with stop_reason tool_use."""

    def __init__(self, turns):
        self.turns, self.calls = list(turns), []
        self.beta = NS(messages=NS(create=self.create))

    def create(self, **kw):
        self.calls.append(kw)
        blocks = self.turns.pop(0)
        stop = "tool_use" if any(b.type == "tool_use" for b in blocks) else "end_turn"
        return NS(content=blocks, stop_reason=stop, usage=None)


def use(i, name, inp):
    return NS(type="tool_use", id=f"tu{i}", name=name, input=inp)


def text(s):
    return NS(type="text", text=s)


@pytest.fixture(autouse=True)
def fresh(monkeypatch, tmp_path):
    academy.reset_engine(f"sqlite:///{tmp_path}/a.db")
    app_module._limiter.hits.clear()
    accounts.limiter.hits.clear()
    monkeypatch.setitem(accounts.OVERRIDES, "free", {"read_pages": None, "find": None, "tutor": None})
    monkeypatch.setattr(aichat, "configured", lambda: True)
    yield


def run(monkeypatch, turns, **body):
    api = FakeAPI(turns)
    monkeypatch.setattr(aichat, "_client", lambda: Claude(client=api, model="claude-haiku-5-5"))
    body = {"messages": [{"role": "user", "text": "What should I practise?"}], "context": {"screen": "home", "library": LIB}, **body}
    return client.post("/ai/chat", json=body), api


def test_tools_then_buttons_then_answer(monkeypatch):
    r, api = run(monkeypatch, [
        [use(1, "my_practice", {}), use(2, "search_stage", {"query": "grace"})],
        [use(3, "suggest_actions", {"actions": [
            {"type": "play_along", "label": "Play Along", "piece_id": "p2"},
            {"type": "open_piece", "label": "Not mine", "piece_id": "zzz"},            # not in the library: dropped
            {"type": "open_screen", "label": "Hack", "screen": "../../admin"},          # not a screen: dropped
            {"type": "open_screen", "label": "Sound check", "screen": "soundCheck"}]})],
        [text("Try **Amazing Grace** at 80% today. The buttons start Play Along or check your mic.")],
    ], lang="ms")
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["text"].startswith("Try Amazing Grace")                                   # Markdown removed
    assert j["actions"] == [{"type": "play_along", "label": "Play Along", "piece_id": "p2"},
                            {"type": "open_screen", "label": "Sound check", "screen": "soundCheck"}]
    # the model saw what's on screen, in the right language, and the tool results came back to it
    sys_text = " ".join(b["text"] for b in api.calls[0]["system"])
    assert "Bahasa Melayu" in sys_text and "Amazing Grace" in sys_text
    results = api.calls[1]["messages"][-1]["content"]
    assert [x["tool_use_id"] for x in results] == ["tu1", "tu2"] and not any(x["is_error"] for x in results)
    assert "Shown 2 button" in api.calls[2]["messages"][-1]["content"][0]["content"]
    assert len(api.calls) == 3 and api.calls[0]["tools"] == aichat.TOOLS


def test_a_bad_tool_goes_back_as_an_error(monkeypatch):
    r, api = run(monkeypatch, [[use(1, "delete_everything", {})], [text("I can't do that, but here is how to practise.")]])
    assert r.status_code == 200 and r.json()["actions"] == []
    assert api.calls[1]["messages"][-1]["content"][0]["is_error"] is True


def test_transpose_and_speed_need_an_open_piece():
    acts = [{"type": "transpose", "label": "Up", "semitones": 2}, {"type": "set_speed", "label": "Slower", "percent": 70},
            {"type": "set_speed", "label": "Too fast", "percent": 400}]
    assert aichat.check_actions(acts, {"library": LIB}) == []
    ok = aichat.check_actions(acts, {"piece": {"id": "p1", "title": "Ode to Joy"}})
    assert [a["type"] for a in ok] == ["transpose", "set_speed"]


def test_checks(monkeypatch):
    r, _ = run(monkeypatch, [], messages=[{"role": "assistant", "text": "hi"}])
    assert r.status_code == 422                                                        # must end with the person
    r, _ = run(monkeypatch, [], context={"library": [{"id": str(i), "title": "x" * 200} for i in range(100)]})
    assert r.status_code == 422                                                        # context too big
    monkeypatch.setattr(aichat, "configured", lambda: False)
    r, _ = run(monkeypatch, [])
    assert r.status_code == 503


def test_free_plan_without_tutor_gets_the_plans(monkeypatch):
    monkeypatch.setitem(accounts.OVERRIDES, "free", {"tutor": 0})
    r, api = run(monkeypatch, [])
    assert r.status_code == 402 and r.json()["detail"]["code"] == "plan_required" and not api.calls


def test_stage_and_teacher_tools_on_an_empty_server():
    assert aichat.tool_search_stage("anything") == {"posts": [], "sounds": []}
    assert aichat.tool_find_teachers("violin") == {"open_classes": [], "verified_tutors": []}
    assert aichat.tool_my_practice(None)["signed_in"] is False
    guest = client.post("/c/auth/guest", json={"name": "G"}).json()["token"]
    me = accounts.current("Bearer " + guest)
    assert aichat.tool_my_practice(me) == {"signed_in": True, "recent_takes": [], "classes": [], "due": []}
    json.dumps(aichat.TOOLS)
