import asyncio

import httpx
import pytest

from app import main
from app.config import Settings
from app.llm import (
    LLMError,
    SUMMARY_PRESETS,
    _split_chunks,
    suggest_speaker_names,
    summarize,
)


def _client_factory(transport):
    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    return factory


def test_split_chunks_single_when_short():
    assert _split_chunks("short transcript", 1000) == ["short transcript"]


def test_split_chunks_splits_on_lines():
    rendered = "\n".join(f"line {i}" for i in range(20))
    chunks = _split_chunks(rendered, 30)
    assert len(chunks) > 1
    assert "".join(chunks).replace("\n", " ").count("line") == 20


@pytest.mark.asyncio
async def test_summarize_single_pass(monkeypatch):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"message": {"content": "## Summary\n- a thing happened"}})

    monkeypatch.setattr(
        "app.llm.httpx.AsyncClient", _client_factory(httpx.MockTransport(handler))
    )
    settings = Settings(summary_chunk_chars=10_000)
    progress = []
    result = await summarize(
        settings,
        segments=[{"text": "hello", "speaker": "Speaker 1"}],
        text="hello",
        has_speakers=True,
        preset="tldr",
        on_progress=lambda i, n: progress.append((i, n)),
    )
    assert "Summary" in result
    assert len(calls) == 1
    assert progress == [(1, 1)]


@pytest.mark.asyncio
async def test_summarize_map_reduce_for_long_transcript(monkeypatch):
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(200, json={"message": {"content": f"note {call_count}"}})

    monkeypatch.setattr(
        "app.llm.httpx.AsyncClient", _client_factory(httpx.MockTransport(handler))
    )
    # Force a tiny chunk size so a short transcript still takes the
    # multi-chunk map-reduce path.
    settings = Settings(summary_chunk_chars=10)
    segments = [{"text": f"speaker line number {i}", "speaker": "Speaker 1"} for i in range(5)]
    progress = []
    result = await summarize(
        settings,
        segments=segments,
        text="",
        has_speakers=True,
        preset="meeting",
        on_progress=lambda i, n: progress.append((i, n)),
    )
    # one map call per chunk + one reduce call
    assert call_count > 2
    assert len(progress) == call_count - 1
    assert result == f"note {call_count}"


def test_all_presets_have_required_prompts():
    for preset in SUMMARY_PRESETS.values():
        assert preset["map_prompt"]
        assert preset["reduce_prompt"]
        assert preset["label"]


@pytest.mark.asyncio
async def test_suggest_speaker_names_parses_json(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "message": {
                    "content": '```json\n{"Speaker 1": "Alice", "Speaker 2": null}\n```'
                }
            },
        )

    monkeypatch.setattr(
        "app.llm.httpx.AsyncClient", _client_factory(httpx.MockTransport(handler))
    )
    settings = Settings()
    segments = [
        {"text": "Hi, I'm Alice", "speaker": "Speaker 1"},
        {"text": "Nice to meet you", "speaker": "Speaker 2"},
    ]
    result = await suggest_speaker_names(settings, segments, text="")
    assert result == {"Speaker 1": "Alice", "Speaker 2": None}


@pytest.mark.asyncio
async def test_suggest_speaker_names_raises_on_unparsable_response(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"message": {"content": "I cannot help with that."}})

    monkeypatch.setattr(
        "app.llm.httpx.AsyncClient", _client_factory(httpx.MockTransport(handler))
    )
    settings = Settings()
    segments = [{"text": "hi", "speaker": "Speaker 1"}]
    with pytest.raises(LLMError):
        await suggest_speaker_names(settings, segments, text="")


@pytest.mark.asyncio
async def test_chat_raises_llm_error_after_retries(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    monkeypatch.setattr(
        "app.llm.httpx.AsyncClient", _client_factory(httpx.MockTransport(handler))
    )
    settings = Settings()
    with pytest.raises(LLMError):
        await summarize(
            settings,
            segments=[],
            text="hi",
            has_speakers=False,
            preset="tldr",
        )


@pytest.mark.asyncio
async def test_run_summarize_job_persists_and_completes(monkeypatch, tmp_path):
    store = main.JobStore(str(tmp_path))
    monkeypatch.setattr(main, "store", store)
    job = store.save(
        filename="clip.wav",
        model="whisper-1",
        language="en",
        duration=1.0,
        text="hello world",
        has_segments=False,
        has_speakers=False,
    )

    async def fake_summarize(settings, *, segments, text, has_speakers, preset, on_progress=None):
        if on_progress:
            on_progress(1, 1)
        return "## TL;DR\n- it happened"

    monkeypatch.setattr(main, "summarize", fake_summarize)

    task = main.registry.create(filename=job["id"])
    stages = []

    async def collect():
        async for snap in main.registry.subscribe(task.id):
            stages.append(snap["stage"])
            if snap["stage"] in ("done", "error"):
                break

    waiter = asyncio.create_task(collect())
    await asyncio.sleep(0)
    await main.run_summarize_job(task.id, job["id"], "tldr")
    await asyncio.wait_for(waiter, timeout=2)

    assert stages[-1] == "done"
    assert "summarizing" in stages
    persisted = store.get_summary(job["id"])
    assert persisted == {"preset": "tldr", "summary": "## TL;DR\n- it happened"}
