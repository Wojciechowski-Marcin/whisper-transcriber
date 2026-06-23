"""Build SRT and WebVTT subtitle files (and a grouped transcript) from segments.

A *segment* is a dict with ``start`` and ``end`` (seconds, float) and ``text``,
and optionally a ``speaker`` label (e.g. ``"Speaker 1"``) from a diarization-capable
endpoint. When speakers are present they are woven into every output; otherwise the
formatters behave exactly as before. No external dependencies — trivially unit-tested.
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
    """Render segments as an SRT document. When a segment carries a ``speaker``,
    its cue text is prefixed with ``Speaker N: ``."""
    lines: list[str] = []
    for index, seg in enumerate(segments, start=1):
        start = _format_timestamp(float(seg["start"]), millis_sep=",")
        end = _format_timestamp(float(seg["end"]), millis_sep=",")
        text = _clean(seg["text"])
        speaker = seg.get("speaker")
        if speaker:
            text = f"{speaker}: {text}"
        lines.append(str(index))
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")  # blank separator
    return "\n".join(lines).strip() + "\n" if lines else ""


def to_vtt(segments: Iterable[Mapping]) -> str:
    """Render segments as a WebVTT document. When a segment carries a ``speaker``,
    the cue uses a WebVTT ``<v Speaker N>`` voice tag."""
    body: list[str] = ["WEBVTT", ""]
    for seg in segments:
        start = _format_timestamp(float(seg["start"]), millis_sep=".")
        end = _format_timestamp(float(seg["end"]), millis_sep=".")
        text = _clean(seg["text"])
        speaker = seg.get("speaker")
        body.append(f"{start} --> {end}")
        body.append(f"<v {speaker}>{text}" if speaker else text)
        body.append("")
    return "\n".join(body).strip() + "\n"


def to_text(segments: Iterable[Mapping], fallback: str = "") -> str:
    """Render a plain-text transcript. With speakers, consecutive same-speaker
    segments are merged into ``Speaker N: …`` turns separated by blank lines.
    Without speakers (or segments) returns ``fallback`` (the joined transcript)."""
    segs = list(segments)
    if not any(s.get("speaker") for s in segs):
        return fallback
    turns: list[str] = []
    current_speaker: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        if buffer:
            turns.append(f"{current_speaker}: " + " ".join(buffer).strip())

    for seg in segs:
        speaker = seg.get("speaker") or "Speaker ?"
        text = _clean(seg["text"])
        if not text:
            continue
        if speaker != current_speaker:
            flush()
            current_speaker = speaker
            buffer = [text]
        else:
            buffer.append(text)
    flush()
    return "\n\n".join(turns).strip() + "\n" if turns else fallback
