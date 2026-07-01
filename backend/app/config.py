"""Application configuration, loaded from environment variables."""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Upstream transcription endpoint (OpenAI-compatible /audio/transcriptions)
    whisper_api_url: str = "http://192.168.40.180:9000/v1/audio/transcriptions"
    whisper_api_key: str = "not-needed"
    whisper_model: str = "whisper-1"

    # App behaviour
    max_upload_mb: int = 1024
    # Upstream request timeout (s). Diarization (esp. on CPU) is slow, so this is
    # generous; raise it further for very long recordings.
    request_timeout: int = 1800
    output_dir: str = "/data/outputs"
    allowed_origins: str = "*"

    # Ollama LLM endpoint (summarization + speaker-name suggestion).
    # An 8B-class instruct model is the sweet spot: strong enough for
    # structured multi-section summaries while a q4_K_M quant still fits
    # entirely in 8 GB VRAM (no CPU spill).
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1:8b-instruct-q4_K_M"
    # Context window (tokens) requested per LLM call. Must comfortably exceed
    # one chunk (~summary_chunk_chars/3 tokens) plus the document-so-far and
    # prompt overhead, or Ollama silently truncates the input.
    # 16384 fits a ~28000-char chunk (~9300 tokens) + ~2000-token running
    # document + prompt, with headroom for the output.
    ollama_num_ctx: int = 16384
    # Refine chain chunk size (chars). Larger chunks = fewer refine steps =
    # less accumulated drift across iterations. At 28000 chars a 76k-char
    # transcript is ~3 chunks instead of 7, which is a big quality win for
    # long D&D sessions. Must stay within ollama_num_ctx (see above).
    summary_chunk_chars: int = 28000
    # httpx read timeout (s) for LLM calls; 0 = no timeout (long map-reduce runs).
    llm_timeout: int = 0

    # Estimated processing time as a fraction of audio duration. Used only to
    # drive the client-side progress estimate during the (opaque) transcribe
    # stage: eta_seconds = duration * whisper_rtf_estimate. GPU Whisper is well
    # below 1.0 (faster than real time); bump it up for slower/CPU endpoints.
    whisper_rtf_estimate: float = 0.5

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
