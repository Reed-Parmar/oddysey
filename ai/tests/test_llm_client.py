import json

import httpx
import pytest

from spa_ai.llm import AIClient, AIError, FakeAIClient, FallbackClient, GroqClient, OllamaClient


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


# ---------------------------------------------------------------- ADR-022: Ollama fallback (no network: MockTransport)


def _ollama(handler):
    return OllamaClient(
        model="llama3.1:8b",
        base_url="http://ollama.local:11434",
        transport=httpx.MockTransport(handler),
    )


def test_ollama_client_sends_json_chat_and_parses_the_answer():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"message": {"role": "assistant", "content": '{"ok": true}'}}
        )

    assert _ollama(handler).chat_json("sys", "user") == {"ok": True}
    assert seen["url"] == "http://ollama.local:11434/api/chat"
    body = seen["body"]
    assert (
        body["format"] == "json"
        and body["stream"] is False
        and body["options"] == {"temperature": 0}
    )
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(500, json={}), "http_500"),
        (httpx.Response(200, json={"message": {"content": "not json"}}), "invalid_json"),
        (httpx.Response(200, json={"message": {"content": "[1]"}}), "not_an_object"),
        (httpx.Response(200, json={"nope": 1}), "malformed_completion"),
    ],
)
def test_ollama_client_errors_are_ai_errors(response, code):
    with pytest.raises(AIError, match=code):
        _ollama(lambda request: response).chat_json("s", "u")


def test_fallback_uses_ollama_only_when_the_primary_fails_and_reports_the_model():
    groq = FakeAIClient(AIError("http_429"), model="groq-model")
    local = FakeAIClient({"a": 1}, model="local-model")
    client = FallbackClient(groq, local)
    assert client.chat_json("s", "u") == {"a": 1} and client.model == "local-model"

    ok = FallbackClient(FakeAIClient({"b": 2}, model="groq-model"), local)
    assert ok.chat_json("s", "u") == {"b": 2} and ok.model == "groq-model"
    assert len(local.calls) == 1  # not called when the primary answers


def test_fallback_raises_the_primary_error_when_both_fail():
    client = FallbackClient(FakeAIClient(AIError("http_400")), FakeAIClient(AIError("timeout")))
    with pytest.raises(AIError, match="http_400"):
        client.chat_json("s", "u")


def test_interactive_options_are_opt_in_and_gpt_oss_only():
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=_completion('{"ok": 1}'))

    t = httpx.MockTransport(handler)
    GroqClient("k", "openai/gpt-oss-20b", transport=t).chat_json("s", "u")
    GroqClient(
        "k", "openai/gpt-oss-20b", transport=t, reasoning_effort="low", max_completion_tokens=900
    ).chat_json("s", "u")
    GroqClient("k", "llama-3.1-8b-instant", transport=t, reasoning_effort="low").chat_json("s", "u")
    assert "reasoning_effort" not in bodies[0] and "max_completion_tokens" not in bodies[0]
    assert bodies[1]["reasoning_effort"] == "low" and bodies[1]["max_completion_tokens"] == 900
    assert "reasoning_effort" not in bodies[2]


@pytest.mark.parametrize(
    ("header", "expected"), [("3", 3.0), ("30", 6.0), ("0.1", 0.5), ("soon", 2.0)]
)
def test_429_honours_retry_after_with_a_cap(header, expected):
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, headers={"retry-after": header})
        return httpx.Response(200, json=_completion('{"ok": 1}'))

    sleeps: list[float] = []
    assert _client(handler, sleeps).chat_json("s", "u") == {"ok": 1}
    assert sleeps == [expected]
