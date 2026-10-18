"""Server-side LLM client factory (never exposed to the browser). Tests patch the module factories.

Groq is the primary provider. With OLLAMA_BASE_URL set, a local Ollama model is the fallback when a Groq call
fails, or the only provider when no Groq key is configured (ADR-022).
"""

from app.core.config import get_settings
from spa_ai.llm import AIClient, FallbackClient, GroqClient, OllamaClient


def default_ai_client() -> AIClient | None:
    s = get_settings()
    groq = (
        GroqClient(api_key=s.groq_api_key, model=s.groq_model, timeout=s.ai_timeout_seconds) if s.groq_api_key else None
    )
    ollama = (
        OllamaClient(model=s.ollama_model, base_url=s.ollama_base_url, timeout=s.ollama_timeout_seconds)
        if s.ollama_base_url
        else None
    )
    if groq and ollama:
        return FallbackClient(groq, ollama)
    return groq or ollama


def assistant_ai_client() -> AIClient | None:
    """Project Assistant: its own Groq models (ASSISTANT_MODEL, then ASSISTANT_FALLBACK_MODEL) so chat is not starved
    when background jobs use up GROQ_MODEL's daily token quota; then Ollama if configured (ADR-023)."""
    s = get_settings()
    chain: list[AIClient] = []
    if s.groq_api_key:
        for model in dict.fromkeys(m for m in (s.assistant_model, s.assistant_fallback_model) if m):
            chain.append(
                GroqClient(
                    api_key=s.groq_api_key,
                    model=model,
                    timeout=s.ai_timeout_seconds,
                    reasoning_effort="low",
                    max_completion_tokens=900,
                )
            )
    if s.ollama_base_url:
        chain.append(OllamaClient(model=s.ollama_model, base_url=s.ollama_base_url, timeout=s.ollama_timeout_seconds))
    if not chain:
        return None
    client = chain[-1]
    for primary in reversed(chain[:-1]):
        client = FallbackClient(primary, client)
    return client


def concepts_ai_client() -> AIClient | None:
    """Concept tagging (ADR-021) is a simple labelling task: low reasoning effort and a capped answer keep it
    from eating the daily token quota that project processing and report analysis share."""
    s = get_settings()
    groq = (
        GroqClient(
            api_key=s.groq_api_key,
            model=s.groq_model,
            timeout=s.ai_timeout_seconds,
            reasoning_effort="low",
            max_completion_tokens=1500,
        )
        if s.groq_api_key
        else None
    )
    ollama = (
        OllamaClient(model=s.ollama_model, base_url=s.ollama_base_url, timeout=s.ollama_timeout_seconds)
        if s.ollama_base_url
        else None
    )
    if groq and ollama:
        return FallbackClient(groq, ollama)
    return groq or ollama
