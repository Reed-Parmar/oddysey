"""LLM clients: Groq (OpenAI-compatible chat completions), optional local Ollama fallback, and a fake for tests.

Never log prompts, responses or API keys (CLAUDE.md non-negotiables).
"""

from __future__ import annotations

import copy
import json
import time
from collections.abc import Callable
from typing import Protocol, runtime_checkable

import httpx


class AIError(Exception):
    """Any failure to obtain a usable JSON object from the model."""


@runtime_checkable
class AIClient(Protocol):
    model: str

    def chat_json(self, system: str, user: str) -> dict: ...


_RETRY_BACKOFF_S = 2.0
_MAX_RETRY_AFTER_S = 6.0


def _retry_delay(response: httpx.Response | None) -> float:
    """Groq's `retry-after` (seconds) on a 429, capped; the fixed backoff otherwise."""
    if response is None or response.status_code != 429:
        return _RETRY_BACKOFF_S
    try:
        hint = float(response.headers.get("retry-after", ""))
    except ValueError:
        return _RETRY_BACKOFF_S
    return max(0.5, min(_MAX_RETRY_AFTER_S, hint))


class GroqClient:
    """Groq chat-completions client: temperature 0, JSON mode, one retry (C-15)."""

    def __init__(
        self,
        api_key: str,
        model: str,
        timeout: float = 10.0,
        base_url: str = "https://api.groq.com/openai/v1",
        sleep: Callable[[float], None] = time.sleep,
        transport: httpx.BaseTransport | None = None,
        reasoning_effort: str | None = None,
        max_completion_tokens: int | None = None,
    ) -> None:
        """`reasoning_effort` (gpt-oss models only) and `max_completion_tokens` are opt-in, for short interactive
        answers that must fit the account's tokens-per-minute budget (ADR-023)."""
        self.model = model
        self._api_key = api_key
        self._reasoning_effort = reasoning_effort
        self._max_completion_tokens = max_completion_tokens
        self._timeout = timeout
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._sleep = sleep
        self._transport = transport

    def __repr__(self) -> str:  # never expose the key
        return f"GroqClient(model={self.model!r})"

    def _post(self, client: httpx.Client, payload: dict) -> httpx.Response:
        return client.post(
            self._url,
            json=payload,
            headers={"Authorization": f"Bearer {self._api_key}"},
        )

    def chat_json(self, system: str, user: str) -> dict:
        payload = {
            "model": self.model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if self._reasoning_effort and self.model.startswith("openai/gpt-oss"):
            payload["reasoning_effort"] = self._reasoning_effort
        if self._max_completion_tokens:
            payload["max_completion_tokens"] = self._max_completion_tokens
        response: httpx.Response | None = None
        with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
            for attempt in range(2):
                retryable = False
                try:
                    response = self._post(client, payload)
                except httpx.TimeoutException as exc:
                    if attempt == 0:
                        retryable = True
                    else:
                        raise AIError("timeout") from exc
                except httpx.HTTPError as exc:
                    raise AIError(type(exc).__name__) from exc
                else:
                    status = response.status_code
                    if status == 429 or status >= 500:
                        if attempt == 0:
                            retryable = True
                        else:
                            raise AIError(f"http_{status}")
                    elif status >= 400:
                        raise AIError(f"http_{status}")
                    else:
                        break
                if retryable:
                    self._sleep(_retry_delay(response))
        assert response is not None
        return _parse_completion(response)


def _parse_completion(response: httpx.Response) -> dict:
    try:
        body = response.json()
        content = body["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise AIError("malformed_completion") from exc
    if not isinstance(content, str):
        raise AIError("malformed_completion")
    try:
        parsed = json.loads(content)
    except ValueError as exc:
        raise AIError("invalid_json") from exc
    if not isinstance(parsed, dict):
        raise AIError("not_an_object")
    return parsed


class OllamaClient:
    """Local Ollama model via its native chat API (`/api/chat`, JSON format, temperature 0, no streaming).

    For self-hosted / offline use; it never leaves the configured host. Same contract as GroqClient:
    a dict or AIError. Local models are slower, so the default timeout is longer.
    """

    def __init__(
        self,
        model: str,
        base_url: str = "http://localhost:11434",
        timeout: float = 120.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.model = model
        self._url = base_url.rstrip("/") + "/api/chat"
        self._timeout = timeout
        self._transport = transport

    def __repr__(self) -> str:
        return f"OllamaClient(model={self.model!r})"

    def chat_json(self, system: str, user: str) -> dict:
        payload = {
            "model": self.model,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.post(self._url, json=payload)
        except httpx.TimeoutException as exc:
            raise AIError("timeout") from exc
        except httpx.HTTPError as exc:
            raise AIError(type(exc).__name__) from exc
        if response.status_code >= 400:
            raise AIError(f"http_{response.status_code}")
        try:
            content = response.json()["message"]["content"]
        except (ValueError, KeyError, TypeError) as exc:
            raise AIError("malformed_completion") from exc
        if not isinstance(content, str):
            raise AIError("malformed_completion")
        try:
            parsed = json.loads(content)
        except ValueError as exc:
            raise AIError("invalid_json") from exc
        if not isinstance(parsed, dict):
            raise AIError("not_an_object")
        return parsed


class FallbackClient:
    """Tries `primary` (Groq), then `fallback` (Ollama) on any AIError. `model` names the model that produced
    the last answer, so stored provenance stays truthful. When both fail, the primary's error is raised (its
    code, e.g. http_400, is what callers act on)."""

    def __init__(self, primary: AIClient, fallback: AIClient) -> None:
        self.primary = primary
        self.fallback = fallback
        self.model = primary.model

    def __repr__(self) -> str:
        return f"FallbackClient({self.primary!r} -> {self.fallback!r})"

    def chat_json(self, system: str, user: str) -> dict:
        try:
            result = self.primary.chat_json(system, user)
            self.model = self.primary.model
            return result
        except AIError as primary_error:
            try:
                result = self.fallback.chat_json(system, user)
            except AIError:
                raise primary_error from None
            self.model = self.fallback.model
            return result


class FakeAIClient:
    """Deterministic stand-in for tests. Records every (system, user) call."""

    def __init__(
        self,
        responder: Callable[[str, str], dict] | dict | Exception,
        model: str = "fake-model",
    ) -> None:
        self.model = model
        self._responder = responder
        self.calls: list[tuple[str, str]] = []

    def chat_json(self, system: str, user: str) -> dict:
        self.calls.append((system, user))
        r = self._responder
        if isinstance(r, Exception):
            raise r
        if isinstance(r, dict):
            return copy.deepcopy(r)
        return r(system, user)
