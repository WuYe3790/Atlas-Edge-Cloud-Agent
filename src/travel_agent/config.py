from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class LLMConfig:
    api_key: str
    base_url: str
    model: str
    thinking_model: str
    temperature: float
    timeout: int
    verbose: bool


def load_llm_config() -> LLMConfig:
    load_dotenv()

    return LLMConfig(
        api_key=os.getenv("LLM_API_KEY", "").strip(),
        base_url=os.getenv("LLM_BASE_URL", "https://aistudio.baidu.com/llm/lmapi/v3").strip(),
        model=os.getenv("LLM_MODEL", "ernie-4.5-vl-28b-a3b-thinking").strip(),
        thinking_model=os.getenv("LLM_THINKING_MODEL", os.getenv("LLM_MODEL", "ernie-4.5-vl-28b-a3b-thinking")).strip(),
        temperature=float(os.getenv("LLM_TEMPERATURE", "0.3")),
        timeout=int(os.getenv("LLM_TIMEOUT", "60")),
        verbose=os.getenv("LANGCHAIN_VERBOSE", "false").strip().lower() in {"1", "true", "yes", "y"},
    )
