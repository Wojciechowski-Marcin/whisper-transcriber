import asyncio

import pytest
from fastapi.testclient import TestClient

from app import main
from app.jobs import JobRegistry
from app.transcribe import ConversionError, TranscriptionResult


@pytest.mark.asyncio
async def test_registry_subscribe_replays_and_terminates():
    reg = JobRegistry()
    job = reg.create()
    seen = []

    async def collect():
        async for snap in reg.subscribe(job.id):
            seen.append(snap["stage"])
            if snap["stage"] in ("done", "error"):
                break

    task = asyncio.create_task(collect())
    await asyncio.sleep(0)  # let the subscriber register its queue
    reg.update(job.id, stage="converting", pct=10.0)
    reg.update(job.id, stage="done", pct=100.0, result={"id": job.id})
    await asyncio.wait_for(task, timeout=2)

    assert seen[0] == "queued"
    assert "converting" in seen
    assert seen[-1] == "done"


@pytest.mark.asyncio
async def test_run_job_drives_stages_and_persists(monkeypatch, tmp_path):
    async def fake_transcribe_upload(**kwargs):
        if kwargs.get("on_convert_progress"):
            kwargs["on_convert_progress"](50.0)
        if kwargs.get("on_transcribe_start"):
            kwargs["on_transcribe_start"](2.0)
        return TranscriptionResult(
            text="hello world",
            language="en",
            duration=2.0,
            segments=[
                {"start": 0.0, "end": 2.0, "text": "hello world", "speaker": "Speaker 1"},
            ],
        )

    monkeypatch.setattr(main, "transcribe_upload", fake_transcribe_upload)
    monkeypatch.setattr(main, "store", main.JobStore(str(tmp_path)))

    job = main.registry.create()
    stages = []

    async def collect():
        async for snap in main.registry.subscribe(job.id):
            stages.append(snap["stage"])
            if snap["stage"] in ("done", "error"):
                break

    task = asyncio.create_task(collect())
    await asyncio.sleep(0)
    await main.run_job(job.id, data=b"x", filename="clip.wav", language=None, diarize=True)
    await asyncio.wait_for(task, timeout=2)

    assert {"converting", "transcribing", "saving"}.issubset(set(stages))
    assert stages[-1] == "done"
    result = main.registry.get(job.id).result
    assert result["has_speakers"] is True
    # grouped speaker transcript
    assert result["text"].startswith("Speaker 1:")


@pytest.mark.asyncio
async def test_run_job_reports_conversion_error(monkeypatch, tmp_path):
    async def boom(**kwargs):
        raise ConversionError("bad media")

    monkeypatch.setattr(main, "transcribe_upload", boom)
    monkeypatch.setattr(main, "store", main.JobStore(str(tmp_path)))

    job = main.registry.create()
    await main.run_job(job.id, data=b"x", filename="clip.wav", language=None, diarize=False)
    state = main.registry.get(job.id)
    assert state.stage == "error"
    assert "bad media" in state.error


def test_sse_endpoint_streams_terminal_state():
    job = main.registry.create()
    main.registry.update(
        job.id, stage="done", pct=100.0, message="Done", result={"id": job.id, "text": "hi"}
    )
    client = TestClient(main.app)
    with client.stream("GET", f"/api/jobs/{job.id}/events") as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = "".join(resp.iter_text())
    assert '"stage": "done"' in body
