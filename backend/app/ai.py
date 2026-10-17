"""Server-side Groq client factory (never exposed to the browser). Tests patch the module factories."""

from app.core.config import get_settings
from spa_ai.llm import AIClient, GroqClient


def default_ai_client() -> AIClient | None:
    s = get_settings()
    if not s.groq_api_key:
        return None
    return GroqClient(api_key=s.groq_api_key, model=s.groq_model, timeout=s.ai_timeout_seconds)
