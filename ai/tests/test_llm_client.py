import json

import httpx
import pytest

from spa_ai.llm import AIClient, AIError, FakeAIClient, GroqClient


def _completion(content: str) -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": content}}]}


def _client(handler, sleeps: list[float]) -> GroqClient:
    return GroqClient(
        "test-key",
        "test-model",
        base_url="https://groq.test/openai/v1",
        sleep=sleeps.append,
        transport=httpx.MockTransport(handler),
    )


def test_success_request_shape():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_completion('{"projects": []}'))

    sleeps: list[float] = []
    assert _client(handler, sleeps).chat_json("sys", "usr") == {"projects": []}
    assert sleeps == []
    req = seen[0]
    assert str(req.url) == "https://groq.test/openai/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer test-key"
    body = json.loads(req.content)
    assert body["model"] == "test-model"
    assert body["temperature"] == 0
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"] == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "usr"},
    ]


@pytest.mark.parametrize("first", [429, 500, 503, "timeout"])
def test_one_retry_then_success(first):
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            if first == "timeout":
                raise httpx.ReadTimeout("slow", request=request)
            return httpx.Response(first)
        return httpx.Response(200, json=_completion('{"ok": 1}'))

    sleeps: list[float] = []
    assert _client(handler, sleeps).chat_json("s", "u") == {"ok": 1}
    assert len(calls) == 2
    assert sleeps == [2.0]


@pytest.mark.parametrize("status", [429, 502])
def test_retry_exhausted_raises(status):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(status)

    sleeps: list[float] = []
    with pytest.raises(AIError):
        _client(handler, sleeps).chat_json("s", "u")
    assert len(calls) == 2 and sleeps == [2.0]


def test_timeout_twice_raises():
    def handler(request):
        raise httpx.ConnectTimeout("x", request=request)

    with pytest.raises(AIError):
        _client(handler, []).chat_json("s", "u")


def test_4xx_not_retried():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(401)

    sleeps: list[float] = []
    with pytest.raises(AIError):
        _client(handler, sleeps).chat_json("s", "u")
    assert len(calls) == 1 and sleeps == []


@pytest.mark.parametrize(
    "body",
    [
        _completion("not json"),
        _completion("[1, 2]"),
        {"choices": []},
        {"unexpected": True},
        {"choices": [{"message": {"content": None}}]},
    ],
)
def test_malformed_completion_raises(body):
    with pytest.raises(AIError):
        _client(lambda r: httpx.Response(200, json=body), []).chat_json("s", "u")


def test_non_json_http_body_raises():
    with pytest.raises(AIError):
        _client(lambda r: httpx.Response(200, text="<html>"), []).chat_json("s", "u")


def test_repr_hides_key():
    assert "test-key" not in repr(_client(lambda r: httpx.Response(200), []))


def test_fake_client_modes():
    f = FakeAIClient({"a": [1]})
    out = f.chat_json("s", "u")
    out["a"].append(2)
    assert f.chat_json("s2", "u2") == {"a": [1]}
    assert f.calls == [("s", "u"), ("s2", "u2")]
    assert isinstance(f, AIClient)
    assert FakeAIClient(lambda s, u: {"echo": u}).chat_json("s", "x") == {"echo": "x"}
    with pytest.raises(AIError):
        FakeAIClient(AIError("boom")).chat_json("s", "u")
