"""Thin wrapper around the Anthropic SDK: one place for the model name, structured JSON answers,
streaming (long answers), refusal fallback, and token accounting. Tests pass a fake client."""
from __future__ import annotations

import base64
import json
import os
import threading
from dataclasses import dataclass, field

DEFAULT_MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class AIError(RuntimeError):
    """The model could not produce an answer (declined, cut off, or the service is unavailable)."""


class AIUnavailable(AIError):
    """No API key is configured on this server."""


def ai_configured() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def image_block(png: bytes, media_type: str = "image/png") -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64.standard_b64encode(png).decode("ascii")}}


def text_block(text: str) -> dict:
    return {"type": "text", "text": text}


@dataclass
class Usage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, u) -> None:
        if u is None:
            return
        with self._lock:
            self.calls += 1
            self.input_tokens += int(getattr(u, "input_tokens", 0) or 0)
            self.output_tokens += int(getattr(u, "output_tokens", 0) or 0)
            self.cache_read_tokens += int(getattr(u, "cache_read_input_tokens", 0) or 0)

    def to_json(self) -> dict:
        return {"calls": self.calls, "input_tokens": self.input_tokens, "output_tokens": self.output_tokens,
                "cache_read_tokens": self.cache_read_tokens}


class Claude:
    def __init__(self, client=None, model: str | None = None):
        self.model = model or os.environ.get("HAPTUNE_AI_MODEL", DEFAULT_MODEL)
        self._client = client
        self.usage = Usage()

    @property
    def client(self):
        if self._client is None:
            if not ai_configured():
                raise AIUnavailable("AI reading is not set up on this server (no ANTHROPIC_API_KEY).")
            import anthropic
            self._client = anthropic.Anthropic(max_retries=3, timeout=600.0)
        return self._client

    def ask_json(self, system: str, content: list, schema: dict, *, effort: str = "medium",
                 max_tokens: int = 32000) -> dict:
        """One request whose answer must match `schema`. Streams, so long answers don't time out."""
        try:
            with self.client.beta.messages.stream(
                model=self.model,
                max_tokens=max_tokens,
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": content}],
                output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
                betas=[FALLBACK_BETA],
                fallbacks="default",
            ) as stream:
                msg = stream.get_final_message()
        except AIError:
            raise
        except Exception as e:                                   # typed SDK errors are re-raised as one kind
            raise _translate(e) from e
        self.usage.add(getattr(msg, "usage", None))
        if msg.stop_reason == "refusal":
            raise AIError("The reader declined this page.")
        if msg.stop_reason == "max_tokens":
            raise AIError("The answer was too long; try fewer pages at a time.")
        text = "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", "") == "text")
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise AIError(f"Unexpected answer from the reader: {e}") from e

    def ask_text(self, system: str, prompt: str, *, effort: str = "low", max_tokens: int = 4000) -> str:
        """A short plain-text answer (the Academy tutor)."""
        try:
            msg = self.client.beta.messages.create(
                model=self.model, max_tokens=max_tokens,
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": prompt}],
                output_config={"effort": effort}, betas=[FALLBACK_BETA], fallbacks="default",
            )
        except Exception as e:
            raise _translate(e) from e
        self.usage.add(getattr(msg, "usage", None))
        if msg.stop_reason == "refusal":
            raise AIError("The tutor can't help with that one.")
        text = "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", "") == "text").strip()
        if not text:
            raise AIError("The tutor had no answer. Please try again.")
        return text

    def run_tools(self, system: str, user_text: str, tools: list, *, final_tool: str, effort: str = "medium",
                  max_tokens: int = 16000, max_rounds: int = 6) -> dict | None:
        """Lets the model use server tools (web search/fetch) and finish by calling `final_tool`.
        Returns that tool's input, or None if the model never called it."""
        messages: list = [{"role": "user", "content": user_text}]
        nudged = False
        for _ in range(max_rounds):
            try:
                msg = self.client.beta.messages.create(
                    model=self.model, max_tokens=max_tokens, system=system, messages=messages, tools=tools,
                    tool_choice={"type": "auto"}, output_config={"effort": effort},
                    betas=[FALLBACK_BETA], fallbacks="default",
                )
            except Exception as e:
                raise _translate(e) from e
            self.usage.add(getattr(msg, "usage", None))
            if msg.stop_reason == "refusal":
                raise AIError("The search was declined.")
            for b in msg.content:
                if getattr(b, "type", "") == "tool_use" and getattr(b, "name", "") == final_tool:
                    return _as_dict(b.input)
            if msg.stop_reason == "pause_turn":
                # the server-side tool loop paused: send the turn back unchanged and the API resumes it
                messages = messages + [{"role": "assistant", "content": msg.content}]
                continue
            if nudged:
                return None
            nudged = True
            messages = messages + [{"role": "assistant", "content": msg.content},
                                   {"role": "user", "content": f"Now call {final_tool} with what you found."}]
        return None


def _as_dict(x) -> dict:
    if isinstance(x, dict):
        return x
    if isinstance(x, str):
        return json.loads(x)
    return dict(x)


def _translate(e: Exception) -> AIError:
    try:
        import anthropic
    except ImportError:                                          # pragma: no cover
        return AIError(str(e))
    if isinstance(e, anthropic.AuthenticationError):
        return AIUnavailable("The server's AI key was rejected.")
    if isinstance(e, anthropic.RateLimitError):
        return AIError("The reader is busy right now. Please try again in a minute.")
    if isinstance(e, anthropic.APIStatusError):
        return AIError(f"The reader had a problem ({e.status_code}). Please try again.")
    if isinstance(e, anthropic.APIConnectionError):
        return AIError("The server could not reach the reader. Please try again.")
    return AIError(str(e))
