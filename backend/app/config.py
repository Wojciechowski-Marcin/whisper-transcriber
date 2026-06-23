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
    max_upload_mb: int = 200
    request_timeout: int = 600
    output_dir: str = "/data/outputs"
    allowed_origins: str = "*"

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
