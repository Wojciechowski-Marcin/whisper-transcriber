"""Convert any audio/video upload to WAV and proxy it to the upstream
OpenAI-compatible transcription endpoint."""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from dataclasses import dataclass, field
from typing import Callable, Optional

import httpx

from .config import Settings

logger = logging.getLogger("transcribe")

# Called during conversion with a 0–100 percentage, or ``None`` when the total
# duration is unknown and progress can only be shown as indeterminate.
ProgressCallback = Callable[[Optional[float]], None]


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

    @property
    def has_speakers(self) -> bool:
        return any(s.get("speaker") for s in self.segments)


async def _probe_duration(input_path: str) -> Optional[float]:
    """Best-effort media duration in seconds via ffprobe. Returns ``None`` if
    ffprobe is unavailable or the duration can't be read (progress then shows
    as indeterminate). ffprobe ships with the apt ``ffmpeg`` package used in the
    Docker image; the imageio-ffmpeg dev shim does not include it."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nokey=1:noprint_wrappers=1",
        input_path,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
    except FileNotFoundError:
        return None
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        return None
    try:
        value = float(out.decode("utf-8", "replace").strip())
    except ValueError:
        return None
    return value if value > 0 else None


async def _read_ffmpeg_progress(
    stream: asyncio.StreamReader,
    duration: Optional[float],
    on_progress: Optional[ProgressCallback],
) -> None:
    """Drain ffmpeg's ``-progress pipe:1`` output (must be read so the pipe
    doesn't fill and stall ffmpeg) and translate ``out_time_us`` into a %."""
    while True:
        raw = await stream.readline()
        if not raw:
            break
        if on_progress is None or not duration:
            continue
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("out_time_us="):
            try:
                micros = int(line.split("=", 1)[1])
            except ValueError:
                continue
            pct = (micros / 1_000_000) / duration * 100
            on_progress(max(0.0, min(99.0, pct)))


async def convert_to_wav(
    input_path: str, on_progress: Optional[ProgressCallback] = None
) -> tuple[str, Optional[float]]:
    """Run ffmpeg to produce a 16 kHz mono WAV. Works for audio and video
    (``-vn`` drops any video stream). Returns ``(output_path, duration_seconds)``;
    caller cleans up the output. Reports conversion progress via ``on_progress``
    when the duration is known, else signals indeterminate with a single
    ``on_progress(None)``."""
    duration = await _probe_duration(input_path)
    if on_progress is not None and duration is None:
        on_progress(None)

    fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats", "-y",
        "-i", input_path,
        "-vn", "-ac", "1", "-ar", "16000",
        "-f", "wav", "-progress", "pipe:1", out_path,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
    except FileNotFoundError:
        os.unlink(out_path)
        raise ConversionError("ffmpeg not found on PATH")

    # Drain stderr concurrently so a full pipe never deadlocks the subprocess.
    assert proc.stdout is not None and proc.stderr is not None
    stderr_task = asyncio.create_task(proc.stderr.read())
    await _read_ffmpeg_progress(proc.stdout, duration, on_progress)
    stderr = await stderr_task
    await proc.wait()

    if proc.returncode != 0:
        if os.path.exists(out_path):
            os.unlink(out_path)
        tail = (stderr or b"").decode("utf-8", "replace").strip()[-500:]
        raise ConversionError(tail or "ffmpeg failed to convert the file")
    if on_progress is not None and duration:
        on_progress(100.0)
    return out_path, duration


def _parse_response(payload: object) -> TranscriptionResult:
    """Normalize an OpenAI-style transcription response into a result.

    Accepts both ``verbose_json`` (with ``segments``) and plain ``{"text": ...}``.
    Falls back to a raw string body when the endpoint returns ``response_format=text``.
    A diarization-capable endpoint may attach a ``speaker`` label to each segment;
    it is preserved when present and simply absent otherwise.
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
            entry = {
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "text": (seg.get("text") or "").strip(),
            }
            speaker = seg.get("speaker")
            if speaker:
                entry["speaker"] = str(speaker)
            segments.append(entry)
    if not text and segments:
        text = " ".join(s["text"] for s in segments).strip()
    return TranscriptionResult(
        text=text,
        language=language,
        duration=float(duration) if duration is not None else None,
        segments=segments,
    )


async def _post_to_upstream(
    wav_path: str,
    settings: Settings,
    language: Optional[str],
    diarize: bool,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> TranscriptionResult:
    with open(wav_path, "rb") as wav:
        files = {"file": ("audio.wav", wav, "audio/wav")}
        form = {"model": settings.whisper_model, "response_format": "verbose_json"}
        if language:
            form["language"] = language
        if diarize:
            # Honoured by diarization-capable endpoints (e.g. the homelab
            # service); generic OpenAI/Groq endpoints ignore the extra fields.
            form["diarize"] = "true"
            # Bounding the speaker count keeps clustering from running away on
            # long/noisy audio (observed: 1200+ spurious speakers on an
            # unbounded ~105 min recording that should have had ~5).
            if min_speakers is not None:
                form["min_speakers"] = str(min_speakers)
            if max_speakers is not None:
                form["max_speakers"] = str(max_speakers)
        headers = {"Authorization": f"Bearer {settings.whisper_api_key}"}
        # Fast connect (fail quickly if the endpoint is down) but a long/unbounded
        # read: diarization on CPU can run for a long time and must not ReadTimeout.
        # request_timeout <= 0 means wait indefinitely.
        read_timeout = settings.request_timeout if settings.request_timeout > 0 else None
        timeout = httpx.Timeout(
            connect=15.0, read=read_timeout, write=read_timeout, pool=read_timeout
        )
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                settings.whisper_api_url, files=files, data=form, headers=headers
            )

    if resp.status_code >= 400:
        raise UpstreamError(
            f"Transcription endpoint returned {resp.status_code}: {resp.text[:300]}"
        )
    content_type = resp.headers.get("content-type", "")
    payload = resp.json() if "json" in content_type else resp.text
    return _parse_response(payload)


async def transcribe_upload(
    *,
    data: bytes,
    filename: str,
    settings: Settings,
    language: Optional[str] = None,
    diarize: bool = False,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
    on_convert_progress: Optional[ProgressCallback] = None,
    on_transcribe_start: Optional[Callable[[Optional[float]], None]] = None,
) -> TranscriptionResult:
    """Full pipeline: bytes -> ffmpeg WAV -> upstream transcription -> result.

    ``on_convert_progress`` reports conversion %; ``on_transcribe_start`` fires
    once with the measured duration just before the (opaque) upstream call, so a
    caller can switch to a duration-based estimate for the transcription stage.
    """
    in_fd, in_path = tempfile.mkstemp(suffix=os.path.splitext(filename)[1] or ".bin")
    wav_path: Optional[str] = None
    try:
        with os.fdopen(in_fd, "wb") as fh:
            fh.write(data)

        wav_path, duration = await convert_to_wav(in_path, on_progress=on_convert_progress)
        if on_transcribe_start is not None:
            on_transcribe_start(duration)

        result = await _post_to_upstream(
            wav_path, settings, language, diarize, min_speakers, max_speakers
        )
        if result.duration is None:
            result.duration = duration
        return result
    finally:
        for path in (in_path, wav_path):
            if path and os.path.exists(path):
                try:
                    os.unlink(path)
                except OSError:
                    logger.warning("Failed to remove temp file %s", path)
