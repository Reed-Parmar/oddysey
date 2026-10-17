"""LLM clients: Groq (OpenAI-compatible chat completions) and a fake for tests.

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
    ) -> None:
        self.model = model
        self._api_key = api_key
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
                    self._sleep(_RETRY_BACKOFF_S)
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
