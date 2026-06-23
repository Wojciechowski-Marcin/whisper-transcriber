"""Build SRT and WebVTT subtitle files from transcript segments.

A *segment* is a dict with ``start`` and ``end`` (seconds, float) and ``text``.
These formatters have no external dependencies so they are trivially unit-tested.
"""
from __future__ import annotations

from typing import Iterable, Mapping


def _format_timestamp(seconds: float, *, millis_sep: str) -> str:
    """Format seconds as HH:MM:SS<sep>mmm (sep is ',' for SRT, '.' for VTT)."""
    if seconds < 0:
        seconds = 0.0
    millis = int(round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{millis_sep}{millis:03d}"


def _clean(text: str) -> str:
    return (text or "").strip()


def to_srt(segments: Iterable[Mapping]) -> str:
    """Render segments as an SRT document."""
    lines: list[str] = []
    for index, seg in enumerate(segments, start=1):
        start = _format_timestamp(float(seg["start"]), millis_sep=",")
        end = _format_timestamp(float(seg["end"]), millis_sep=",")
        lines.append(str(index))
        lines.append(f"{start} --> {end}")
        lines.append(_clean(seg["text"]))
        lines.append("")  # blank separator
    return "\n".join(lines).strip() + "\n" if lines else ""


def to_vtt(segments: Iterable[Mapping]) -> str:
    """Render segments as a WebVTT document."""
    body: list[str] = ["WEBVTT", ""]
    for seg in segments:
        start = _format_timestamp(float(seg["start"]), millis_sep=".")
        end = _format_timestamp(float(seg["end"]), millis_sep=".")
        body.append(f"{start} --> {end}")
        body.append(_clean(seg["text"]))
        body.append("")
    return "\n".join(body).strip() + "\n"
