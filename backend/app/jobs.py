"""In-memory registry of in-flight transcription jobs + progress fan-out.

Jobs live here only while running (and briefly after, for late SSE subscribers);
finished transcripts are persisted separately by ``storage.JobStore``. Assumes a
single uvicorn worker — the registry is process-local.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator, Optional

TERMINAL_STAGES = ("done", "error")


@dataclass
class JobState:
    id: str
    filename: str = ""
    stage: str = "queued"
    pct: Optional[float] = None  # None = indeterminate
    message: str = ""
    duration: Optional[float] = None
    eta_seconds: Optional[float] = None
    error: Optional[str] = None
    result: Optional[dict] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    @property
    def terminal(self) -> bool:
        return self.stage in TERMINAL_STAGES

    @property
    def status(self) -> str:
        if self.stage == "error":
            return "error"
        return "done" if self.stage == "done" else "running"

    def snapshot(self) -> dict:
        data: dict = {
            "id": self.id,
            "filename": self.filename,
            "stage": self.stage,
            "status": self.status,
            "pct": self.pct,
            "message": self.message,
            "duration": self.duration,
            "eta_seconds": self.eta_seconds,
            "created_at": datetime.fromtimestamp(
                self.created_at, timezone.utc
            ).isoformat(),
        }
        if self.error:
            data["error"] = self.error
        if self.result is not None:
            data["job"] = self.result
        return data


class JobRegistry:
    def __init__(self, ttl_seconds: float = 300.0) -> None:
        self._jobs: dict[str, JobState] = {}
        self._subs: dict[str, set[asyncio.Queue]] = {}
        self._ttl = ttl_seconds

    def create(self, filename: str = "") -> JobState:
        self._prune()
        job_id = uuid.uuid4().hex[:12]
        state = JobState(id=job_id, filename=filename)
        self._jobs[job_id] = state
        self._subs[job_id] = set()
        return state

    def get(self, job_id: str) -> Optional[JobState]:
        return self._jobs.get(job_id)

    def list_active(self) -> list[dict]:
        """Snapshots of jobs still tracked in memory that aren't yet persisted
        (running or failed), newest first. Done jobs are omitted — they live on
        disk via JobStore and are listed from there."""
        self._prune()
        items = [
            st.snapshot() for st in self._jobs.values() if st.stage != "done"
        ]
        items.sort(key=lambda s: s.get("created_at", ""), reverse=True)
        return items

    def update(self, job_id: str, **fields) -> None:
        state = self._jobs.get(job_id)
        if state is None:
            return
        for key, value in fields.items():
            setattr(state, key, value)
        state.updated_at = time.time()
        snap = state.snapshot()
        for queue in list(self._subs.get(job_id, ())):
            queue.put_nowait(snap)

    async def subscribe(self, job_id: str) -> AsyncIterator[dict]:
        """Yield the current state immediately, then each update until terminal."""
        state = self._jobs.get(job_id)
        if state is None:
            return
        queue: asyncio.Queue = asyncio.Queue()
        self._subs.setdefault(job_id, set()).add(queue)
        try:
            yield state.snapshot()
            if state.terminal:
                return
            while True:
                snap = await queue.get()
                yield snap
                if snap.get("stage") in TERMINAL_STAGES:
                    return
        finally:
            self._subs.get(job_id, set()).discard(queue)

    def _prune(self) -> None:
        now = time.time()
        stale = [
            jid
            for jid, st in self._jobs.items()
            if st.terminal and now - st.updated_at > self._ttl
        ]
        for jid in stale:
            self._jobs.pop(jid, None)
            self._subs.pop(jid, None)
