"""Convert any audio/video upload to WAV and proxy it to the upstream
OpenAI-compatible transcription endpoint."""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from dataclasses import dataclass, field
from typing import Optional

import httpx

from .config import Settings

logger = logging.getLogger("transcribe")


class ConversionError(Exception):
    """ffmpeg failed to decode/convert the upload."""


class UpstreamError(Exception):
    """The transcription endpoint returned an error or unreadable response."""


@dataclass
class TranscriptionResult:
    text: str
    language: Optional[str] = None
    duration: Optional[float] = None
    segments: list[dict] = field(default_factory=list)

    @property
    def has_segments(self) -> bool:
        return len(self.segments) > 0


async def convert_to_wav(input_path: str) -> str:
    """Run ffmpeg to produce a 16 kHz mono WAV. Works for audio and video
    (``-vn`` drops any video stream). Returns the output path; caller cleans up."""
    fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", input_path,
        "-vn", "-ac", "1", "-ar", "16000",
        "-f", "wav", out_path,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
    except FileNotFoundError:
        os.unlink(out_path)
        raise ConversionError("ffmpeg not found on PATH")
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        os.unlink(out_path)
        tail = (stderr or b"").decode("utf-8", "replace").strip()[-500:]
        raise ConversionError(tail or "ffmpeg failed to convert the file")
    return out_path


def _parse_response(payload: object) -> TranscriptionResult:
    """Normalize an OpenAI-style transcription response into a result.

    Accepts both ``verbose_json`` (with ``segments``) and plain ``{"text": ...}``.
    Falls back to a raw string body when the endpoint returns ``response_format=text``.
    """
    if isinstance(payload, str):
        return TranscriptionResult(text=payload.strip())
    if not isinstance(payload, dict):
        raise UpstreamError("Unexpected transcription response shape")

    text = (payload.get("text") or "").strip()
    language = payload.get("language")
    duration = payload.get("duration")
    segments: list[dict] = []
    for seg in payload.get("segments") or []:
        if "start" in seg and "end" in seg:
            segments.append(
                {
                    "start": float(seg["start"]),
                    "end": float(seg["end"]),
                    "text": (seg.get("text") or "").strip(),
                }
            )
    if not text and segments:
        text = " ".join(s["text"] for s in segments).strip()
    return TranscriptionResult(
        text=text,
        language=language,
        duration=float(duration) if duration is not None else None,
        segments=segments,
    )


async def transcribe_upload(
    *, data: bytes, filename: str, settings: Settings, language: Optional[str] = None
) -> TranscriptionResult:
    """Full pipeline: bytes -> ffmpeg WAV -> upstream transcription -> result."""
    in_fd, in_path = tempfile.mkstemp(suffix=os.path.splitext(filename)[1] or ".bin")
    wav_path: Optional[str] = None
    try:
        with os.fdopen(in_fd, "wb") as fh:
            fh.write(data)

        wav_path = await convert_to_wav(in_path)

        with open(wav_path, "rb") as wav:
            files = {"file": ("audio.wav", wav, "audio/wav")}
            form = {
                "model": settings.whisper_model,
                "response_format": "verbose_json",
            }
            if language:
                form["language"] = language
            headers = {"Authorization": f"Bearer {settings.whisper_api_key}"}
            async with httpx.AsyncClient(timeout=settings.request_timeout) as client:
                resp = await client.post(
                    settings.whisper_api_url, files=files, data=form, headers=headers
                )

        if resp.status_code >= 400:
            raise UpstreamError(
                f"Transcription endpoint returned {resp.status_code}: "
                f"{resp.text[:300]}"
            )

        content_type = resp.headers.get("content-type", "")
        payload = resp.json() if "json" in content_type else resp.text
        return _parse_response(payload)
    finally:
        for path in (in_path, wav_path):
            if path and os.path.exists(path):
                try:
                    os.unlink(path)
                except OSError:
                    logger.warning("Failed to remove temp file %s", path)
