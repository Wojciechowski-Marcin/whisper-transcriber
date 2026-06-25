"""Ollama-backed summarization and speaker-name suggestion.

Long transcripts are handled via map-reduce: split into ``summary_chunk_chars``
chunks, summarize each ("map"), then summarize the concatenated chunk-notes
("reduce") — keeping every LLM call within context regardless of transcript
length.
"""
from __future__ import annotations

import json
import re
from typing import Callable, Optional

import httpx

from .config import Settings

ProgressCallback = Callable[[int, int], None]


class LLMError(Exception):
    """The Ollama endpoint failed or returned something unusable."""


SUMMARY_PRESETS: dict[str, dict[str, str]] = {
    "dnd": {
        "label": "D&D session recap",
        "map_prompt": (
            "You are summarizing part of a transcript from a Dungeons & Dragons "
            "session. Note in bullet points: what happened, locations visited, "
            "NPCs encountered, notable party actions, and any loot/rewards. Be "
            "concise — this is an intermediate note that will be merged with "
            "others."
        ),
        "reduce_prompt": (
            "You are writing a recap of a Dungeons & Dragons session from a set "
            "of notes covering different parts of it. Produce a markdown recap "
            "with sections: ## What Happened, ## Locations, ## NPCs, ## Party "
            "Actions, ## Loot & Rewards, ## Open Threads. Merge duplicate "
            "information across notes."
        ),
    },
    "meeting": {
        "label": "Meeting notes",
        "map_prompt": (
            "Summarize this part of a meeting transcript in bullet points: key "
            "points discussed, decisions made, and action items mentioned. Be "
            "concise — this is an intermediate note that will be merged with "
            "others."
        ),
        "reduce_prompt": (
            "Write meeting notes from a set of notes covering different parts "
            "of the meeting. Produce markdown with sections: ## TL;DR, ## Key "
            "Points, ## Decisions, ## Action Items. Merge duplicate information "
            "across notes."
        ),
    },
    "call": {
        "label": "Call summary",
        "map_prompt": (
            "Summarize this part of a phone/video call transcript in bullet "
            "points: purpose, topics discussed, and outcomes. Be concise — this "
            "is an intermediate note that will be merged with others."
        ),
        "reduce_prompt": (
            "Write a call summary from a set of notes covering different parts "
            "of the call. Produce markdown with sections: ## Purpose, ## "
            "Discussion, ## Outcomes, ## Next Steps. Merge duplicate information "
            "across notes."
        ),
    },
    "tldr": {
        "label": "General TL;DR",
        "map_prompt": (
            "Summarize this part of a transcript in concise bullet points "
            "capturing the key takeaways. This is an intermediate note that "
            "will be merged with others."
        ),
        "reduce_prompt": (
            "Write a concise bulleted TL;DR from a set of notes covering "
            "different parts of a transcript. Merge duplicate information "
            "across notes."
        ),
    },
}


async def _chat(settings: Settings, system: str, user: str, *, retries: int = 2) -> str:
    timeout = httpx.Timeout(
        connect=15.0,
        read=settings.llm_timeout or None,
        write=settings.llm_timeout or None,
        pool=settings.llm_timeout or None,
    )
    payload = {
        "model": settings.ollama_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "think": False,
        "options": {"temperature": 0.2},
    }
    last_exc: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(f"{settings.ollama_url}/api/chat", json=payload)
            resp.raise_for_status()
            data = resp.json()
            return data["message"]["content"].strip()
        except Exception as exc:  # noqa: BLE001 — retry any transient failure
            last_exc = exc
            if attempt == retries:
                break
    raise LLMError(f"Ollama request failed: {last_exc}")


def render_transcript(segments: list[dict], text: str, has_speakers: bool) -> str:
    if has_speakers and segments:
        lines = []
        for seg in segments:
            speaker = seg.get("speaker") or "Speaker ?"
            seg_text = (seg.get("text") or "").strip()
            if seg_text:
                lines.append(f"{speaker}: {seg_text}")
        return "\n".join(lines)
    return text


def _split_chunks(rendered: str, chunk_chars: int) -> list[str]:
    if len(rendered) <= chunk_chars:
        return [rendered]
    lines = rendered.split("\n")
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for line in lines:
        if current and current_len + len(line) + 1 > chunk_chars:
            chunks.append("\n".join(current))
            current = []
            current_len = 0
        current.append(line)
        current_len += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


async def summarize(
    settings: Settings,
    segments: list[dict],
    text: str,
    has_speakers: bool,
    preset: str,
    on_progress: Optional[ProgressCallback] = None,
) -> str:
    spec = SUMMARY_PRESETS[preset]
    rendered = render_transcript(segments, text, has_speakers)
    chunks = _split_chunks(rendered, settings.summary_chunk_chars)

    if len(chunks) == 1:
        if on_progress:
            on_progress(1, 1)
        return await _chat(settings, spec["reduce_prompt"], chunks[0])

    notes = []
    for i, chunk in enumerate(chunks, start=1):
        if on_progress:
            on_progress(i, len(chunks))
        notes.append(await _chat(settings, spec["map_prompt"], chunk))

    combined = "\n\n---\n\n".join(notes)
    return await _chat(settings, spec["reduce_prompt"], combined)


_NAME_SYSTEM_PROMPT = (
    "You are analyzing a transcript with anonymous speaker labels (e.g. "
    '"Speaker 1"). Infer each speaker\'s real name from in-conversation cues '
    "such as self-introductions or other speakers addressing them by name. "
    "Respond with ONLY a raw JSON object mapping each speaker label to their "
    "inferred name (string) or null if no name can be inferred. No markdown "
    "fences, no commentary. Example: "
    '{"Speaker 1": "Alice", "Speaker 2": null}'
)


def _strip_code_fences(content: str) -> str:
    content = re.sub(r"```(?:json)?\s*", "", content)
    content = re.sub(r"```\s*", "", content)
    return content.strip()


async def suggest_speaker_names(
    settings: Settings, segments: list[dict], text: str
) -> dict[str, Optional[str]]:
    rendered = render_transcript(segments, text, True)
    rendered = rendered[: settings.summary_chunk_chars]
    labels = sorted({seg.get("speaker") for seg in segments if seg.get("speaker")})

    content = await _chat(settings, _NAME_SYSTEM_PROMPT, rendered)
    content = _strip_code_fences(content)
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if not match:
        raise LLMError("Could not parse speaker-name suggestions from model output")
    try:
        parsed = json.loads(match.group())
    except json.JSONDecodeError as exc:
        raise LLMError(f"Invalid JSON from model: {exc}") from exc

    result: dict[str, Optional[str]] = {}
    for label in labels:
        name = parsed.get(label)
        result[label] = name if isinstance(name, str) and name.strip() else None
    return result
