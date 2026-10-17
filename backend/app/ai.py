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
