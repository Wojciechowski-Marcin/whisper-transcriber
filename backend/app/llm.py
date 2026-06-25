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


# Appended to every summarization system prompt. The transcript comes from
# automatic speech recognition (often non-English), so faithfulness and
# language-matching matter more than polish.
_FAITHFULNESS_RULES = (
    "Rules:\n"
    "- Base everything strictly on the transcript. Never invent names, events, "
    "numbers, or details that the transcript does not support.\n"
    "- The transcript is from automatic speech recognition and may contain "
    "mishearings; interpret charitably and skip anything inaudible or unclear "
    "rather than guessing.\n"
    "- Write your response in the same language as the transcript.\n"
)

# A "map" prompt turns one chunk into faithful working notes; it is reused for
# every chunk and the results are merged by the matching "reduce" prompt.
_MAP_SUFFIX = (
    "These are working notes for one part of a longer recording; they will be "
    "merged, in order, with notes from the other parts — so keep them concise "
    "and factual rather than polished. Preserve concrete specifics: names, "
    "numbers, dates, decisions, and outcomes, and keep events in the order they "
    "happen. Record only what this excerpt supports and skip anything it does "
    "not cover.\n\n" + _FAITHFULNESS_RULES
)

# A "reduce" prompt produces the final document. It runs on EITHER the whole
# transcript (short recordings) OR the concatenated, in-order per-chunk notes
# (long recordings), so it must read naturally for both — never assume "notes".
_REDUCE_SUFFIX = (
    "You are given source material about a single recording: either the "
    "transcript itself, or a set of chronological notes summarizing consecutive "
    "parts of it. Produce the document described above. Where the same point or "
    "event appears more than once, state it a single time. Use the exact "
    "headings given, in the given order, and omit any heading that would have "
    "no real content (do not write \"none\" or \"N/A\"). Output clean "
    "GitHub-flavoured markdown with no preamble, meta-commentary, or "
    "sign-off.\n\n" + _FAITHFULNESS_RULES
)

SUMMARY_PRESETS: dict[str, dict[str, str]] = {
    "dnd": {
        "label": "D&D session recap",
        "map_prompt": (
            "You are taking notes on part of a recorded Dungeons & Dragons "
            "session. Capture, in order: what happens in the story; where the "
            "party goes; which NPCs they meet and what is learned about each; "
            "what each player character does, says, or decides; how fights play "
            "out and who does what; loot, gold, or rewards gained; and any "
            "cliffhanger, plan, or unanswered question. Write down character "
            "and place names exactly as spoken, and note any especially "
            "dramatic, funny, or memorable moment.\n\n" + _MAP_SUFFIX
        ),
        "reduce_prompt": (
            "You are writing the recap of a single Dungeons & Dragons session "
            "for the players to read before the next game. Make it engaging and "
            "in-world, not a dry list. Use these sections, in this order:\n"
            "## Recap — two to four paragraphs telling the story of the session "
            "in order, naming the characters involved and how events unfolded.\n"
            "## NPCs — each as `**Name** — who they are and what happened with "
            "them`.\n"
            "## Locations — places the party visited.\n"
            "## Notable Moments — the most dramatic, funny, or memorable beats.\n"
            "## Loot & Rewards — items, gold, or boons gained.\n"
            "## Open Threads — cliffhangers, unresolved questions, and plans for "
            "next time.\n\n" + _REDUCE_SUFFIX
        ),
    },
    "meeting": {
        "label": "Meeting notes",
        "map_prompt": (
            "You are taking notes on part of a meeting. Record: the topics "
            "discussed, the key points and arguments made on each, any "
            "decisions reached, and any action items — including who is "
            "responsible and any deadline whenever stated.\n\n" + _MAP_SUFFIX
        ),
        "reduce_prompt": (
            "You are writing the notes for a single meeting. Use these "
            "sections, in this order:\n"
            "## TL;DR — two to four sentences on what the meeting covered and "
            "concluded.\n"
            "## Key Points — the main topics and the substance of what was said "
            "about each.\n"
            "## Decisions — what was actually decided.\n"
            "## Action Items — each as `- [ ] **owner** — task (deadline)` when "
            "an owner is identifiable, otherwise `- [ ] task`.\n\n"
            + _REDUCE_SUFFIX
        ),
    },
    "call": {
        "label": "Call summary",
        "map_prompt": (
            "You are taking notes on part of a phone or video call. Record: the "
            "apparent purpose, the topics discussed, questions raised and the "
            "answers given, any agreements or outcomes, and any follow-ups or "
            "next steps mentioned.\n\n" + _MAP_SUFFIX
        ),
        "reduce_prompt": (
            "You are writing the summary of a single call. Use these sections, "
            "in this order:\n"
            "## Purpose — why the call happened, in a sentence or two.\n"
            "## Discussion — what was talked through and any answers reached.\n"
            "## Outcomes — what was agreed or concluded.\n"
            "## Next Steps — each as `- [ ] **owner** — task` when an owner is "
            "identifiable, otherwise `- [ ] task`.\n\n" + _REDUCE_SUFFIX
        ),
    },
    "tldr": {
        "label": "General TL;DR",
        "map_prompt": (
            "You are taking notes on part of a recording. Capture the key "
            "takeaways, important facts, and anything a reader would need to "
            "understand what was said and why it matters.\n\n" + _MAP_SUFFIX
        ),
        "reduce_prompt": (
            "You are writing a tight TL;DR of a recording. Open with a one- to "
            "two-sentence overview of what the recording is about, then give a "
            "short bulleted list (aim for three to seven bullets) of the most "
            "important takeaways. Keep it scannable; do not use section "
            "headings.\n\n" + _REDUCE_SUFFIX
        ),
    },
}


# ISO 639-1 codes (as returned by Whisper) → English language name, used to
# build an explicit "write in X" instruction. Smaller instruct models tend to
# default to English unless told the target language by name.
_LANG_NAMES: dict[str, str] = {
    "en": "English", "pl": "Polish", "de": "German", "fr": "French",
    "es": "Spanish", "it": "Italian", "pt": "Portuguese", "nl": "Dutch",
    "ru": "Russian", "uk": "Ukrainian", "cs": "Czech", "sk": "Slovak",
    "sv": "Swedish", "no": "Norwegian", "da": "Danish", "fi": "Finnish",
    "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "ar": "Arabic",
    "tr": "Turkish", "hu": "Hungarian", "ro": "Romanian", "el": "Greek",
}


def _language_directive(language: Optional[str]) -> str:
    """An explicit, leading instruction to answer in the transcript's language.

    Falls back to the raw code if unknown, and to the soft "same language" rule
    baked into the prompts when the language is missing entirely.
    """
    if not language:
        return ""
    name = _LANG_NAMES.get(language.lower().strip(), language)
    return f"Write your entire response in {name}.\n\n"


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
        "options": {"temperature": 0.2, "num_ctx": settings.ollama_num_ctx},
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
    language: Optional[str] = None,
    on_progress: Optional[ProgressCallback] = None,
) -> str:
    spec = SUMMARY_PRESETS[preset]
    directive = _language_directive(language)
    map_prompt = directive + spec["map_prompt"]
    reduce_prompt = directive + spec["reduce_prompt"]
    rendered = render_transcript(segments, text, has_speakers)
    chunks = _split_chunks(rendered, settings.summary_chunk_chars)

    if len(chunks) == 1:
        if on_progress:
            on_progress(1, 1)
        return await _chat(settings, reduce_prompt, chunks[0])

    notes = []
    for i, chunk in enumerate(chunks, start=1):
        if on_progress:
            on_progress(i, len(chunks))
        notes.append(await _chat(settings, map_prompt, chunk))

    combined = "\n\n---\n\n".join(notes)
    return await _chat(settings, reduce_prompt, combined)


_NAME_SYSTEM_PROMPT = (
    "You identify who the anonymous speakers in a transcript really are. The "
    "transcript labels speakers generically (e.g. \"Speaker 1\"). For each "
    "label, decide the speaker's real name using ONLY explicit evidence in the "
    "conversation:\n"
    "- the speaker introduces themselves (\"I'm Anna\", \"Marek here\"), or\n"
    "- another speaker clearly addresses or refers to that specific speaker by "
    "name (\"Thanks, Anna\", said in reply to Speaker 2 → Speaker 2 is Anna).\n"
    "Be conservative. Do NOT infer a name from topic, role, gender, or vibe, "
    "and do NOT carry a name over to a speaker just because it was mentioned "
    "nearby. If the evidence is weak, ambiguous, or absent, the name is null. "
    "Never assign the same name to two different speakers; if you cannot tell "
    "two apart, leave the less certain one null. Keep names in their original "
    "language and spelling.\n\n"
    "Think it through carefully: go through the speaker labels one at a time "
    "and state, in a short line each, the specific evidence you found (quote it) "
    "or that there is none. THEN, on the final line, output only the answer as "
    "a single-line raw JSON object mapping every label to a name (string) or "
    "null — no code fences, nothing after it. Example final line:\n"
    '{"Speaker 1": "Anna", "Speaker 2": null}'
)


def _extract_last_json_object(content: str) -> dict:
    """Return the last flat ``{...}`` object in the text that parses as JSON.

    The model reasons in prose before emitting its answer, so we take the final
    JSON object rather than the first (and ignore braces inside the reasoning).
    """
    candidates = re.findall(r"\{[^{}]*\}", content, re.DOTALL)
    for cand in reversed(candidates):
        try:
            return json.loads(cand)
        except json.JSONDecodeError:
            continue
    raise LLMError("Could not parse speaker-name suggestions from model output")


async def suggest_speaker_names(
    settings: Settings, segments: list[dict], text: str
) -> dict[str, Optional[str]]:
    rendered = render_transcript(segments, text, True)
    rendered = rendered[: settings.summary_chunk_chars]
    labels = sorted({seg.get("speaker") for seg in segments if seg.get("speaker")})

    user = (
        "Speaker labels to resolve: " + ", ".join(labels) + "\n\n"
        "Transcript:\n" + rendered
    )
    content = await _chat(settings, _NAME_SYSTEM_PROMPT, user)
    parsed = _extract_last_json_object(content)

    result: dict[str, Optional[str]] = {}
    used: set[str] = set()
    for label in labels:
        name = parsed.get(label)
        name = name.strip() if isinstance(name, str) and name.strip() else None
        # Belt-and-braces against the model reusing one name for two speakers.
        if name and name.casefold() in used:
            name = None
        if name:
            used.add(name.casefold())
        result[label] = name
    return result
