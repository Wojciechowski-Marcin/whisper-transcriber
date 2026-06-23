"""FastAPI application: transcription API + static frontend host."""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .jobs import JobRegistry
from .storage import JobStore
from .subtitles import to_srt, to_text, to_vtt
from .transcribe import ConversionError, UpstreamError, transcribe_upload

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("app")

settings = get_settings()
store = JobStore(settings.output_dir)
registry = JobRegistry()

app = FastAPI(title="whisper-transcriber", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

DOWNLOAD_MEDIA = {
    "txt": "text/plain",
    "srt": "application/x-subrip",
    "vtt": "text/vtt",
    "json": "application/json",
}


@app.get("/api/health")
async def health():
    upstream = "unknown"
    try:
        base = settings.whisper_api_url.rsplit("/v1/", 1)[0]
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{base}/health")
            upstream = "ok" if r.status_code == 200 else f"http {r.status_code}"
    except Exception:
        upstream = "unreachable"
    return {"status": "ok", "upstream": upstream, "model": settings.whisper_model}


async def run_job(
    job_id: str,
    *,
    data: bytes,
    filename: str,
    language: Optional[str],
    diarize: bool,
) -> None:
    """Background pipeline: convert -> transcribe -> persist, reporting stages
    to the registry so SSE subscribers can follow along."""
    try:
        registry.update(job_id, stage="converting", pct=None, message="Converting audio…")

        def on_convert_progress(pct: Optional[float]) -> None:
            registry.update(job_id, pct=pct)

        def on_transcribe_start(duration: Optional[float]) -> None:
            eta = duration * settings.whisper_rtf_estimate if duration else None
            registry.update(
                job_id,
                stage="transcribing",
                pct=None,
                message="Transcribing & diarizing…" if diarize else "Transcribing…",
                duration=duration,
                eta_seconds=eta,
            )

        result = await transcribe_upload(
            data=data,
            filename=filename,
            settings=settings,
            language=language,
            diarize=diarize,
            on_convert_progress=on_convert_progress,
            on_transcribe_start=on_transcribe_start,
        )

        registry.update(job_id, stage="saving", pct=None, message="Saving transcript…")
        srt = to_srt(result.segments) if result.has_segments else ""
        vtt = to_vtt(result.segments) if result.has_segments else ""
        text = to_text(result.segments, fallback=result.text)
        job = store.save(
            job_id=job_id,
            filename=filename,
            model=settings.whisper_model,
            language=result.language,
            duration=result.duration,
            text=text,
            srt=srt,
            vtt=vtt,
            has_segments=result.has_segments,
            has_speakers=result.has_speakers,
            segments=result.segments,
        )
        registry.update(job_id, stage="done", pct=100.0, message="Done", result=job)
    except ConversionError as exc:
        registry.update(job_id, stage="error", error=f"Could not decode media: {exc}")
    except UpstreamError as exc:
        registry.update(job_id, stage="error", error=str(exc))
    except Exception as exc:  # noqa: BLE001 — surface any failure to the client
        logger.exception("Job %s failed", job_id)
        registry.update(job_id, stage="error", error=f"Internal error: {exc}")


@app.post("/api/transcribe", status_code=202)
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    diarize: bool = Form(False),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail="Empty file")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds {settings.max_upload_mb} MB limit",
        )

    job = registry.create()
    asyncio.create_task(
        run_job(
            job.id,
            data=data,
            filename=file.filename or "upload",
            language=language,
            diarize=diarize,
        )
    )
    return {"job_id": job.id}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str):
    """Server-Sent Events stream of a job's progress until it completes/errors."""
    if registry.get(job_id) is None:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_stream():
        async for snapshot in registry.subscribe(job_id):
            yield f"data: {json.dumps(snapshot)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Disable proxy buffering so events arrive incrementally behind
            # Traefik / code-server's /proxy/ sub-path.
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/history")
async def history():
    return store.list()


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/jobs/{job_id}/download/{fmt}")
async def download(job_id: str, fmt: str):
    if fmt not in DOWNLOAD_MEDIA:
        raise HTTPException(status_code=400, detail="Invalid format")
    path = store.file_path(job_id, fmt)
    if path is None:
        raise HTTPException(status_code=404, detail="File not available")
    return FileResponse(
        path, media_type=DOWNLOAD_MEDIA[fmt], filename=f"{job_id}.{fmt}"
    )


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    if not store.delete(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"deleted": job_id}


# ─── Serve the built frontend (mounted last so /api/* wins) ───
_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "static"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=_FRONTEND_DIST, html=True), name="frontend")
