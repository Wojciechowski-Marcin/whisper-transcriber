"""FastAPI application: transcription API + static frontend host."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .storage import JobStore
from .subtitles import to_srt, to_vtt
from .transcribe import ConversionError, UpstreamError, transcribe_upload

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("app")

settings = get_settings()
store = JobStore(settings.output_dir)

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


@app.post("/api/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail="Empty file")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds {settings.max_upload_mb} MB limit",
        )

    try:
        result = await transcribe_upload(
            data=data,
            filename=file.filename or "upload",
            settings=settings,
            language=language,
        )
    except ConversionError as exc:
        raise HTTPException(status_code=422, detail=f"Could not decode media: {exc}")
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    srt = to_srt(result.segments) if result.has_segments else ""
    vtt = to_vtt(result.segments) if result.has_segments else ""
    job = store.save(
        filename=file.filename or "upload",
        model=settings.whisper_model,
        language=result.language,
        duration=result.duration,
        text=result.text,
        srt=srt,
        vtt=vtt,
        has_segments=result.has_segments,
    )
    return job


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
