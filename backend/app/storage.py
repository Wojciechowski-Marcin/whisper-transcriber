"""Filesystem persistence for transcription jobs.

Each job is stored as ``<OUTPUT_DIR>/<job_id>/`` containing:
  - meta.json        job metadata (id, filename, language, duration, ...)
  - transcript.txt   plain transcript
  - transcript.srt   subtitles (only when segments are available)
  - transcript.vtt   subtitles (only when segments are available)
No media is stored — only the derived text artifacts.
"""
from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

FORMATS = {
    "txt": "transcript.txt",
    "srt": "transcript.srt",
    "vtt": "transcript.vtt",
    "md": "summary.md",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, output_dir: str | Path):
        self.root = Path(output_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    def _job_dir(self, job_id: str) -> Path:
        return self.root / job_id

    def save(
        self,
        *,
        filename: str,
        model: str,
        language: Optional[str],
        duration: Optional[float],
        text: str,
        srt: str = "",
        vtt: str = "",
        has_segments: bool = False,
        has_speakers: bool = False,
        segments: Optional[list[dict]] = None,
        job_id: Optional[str] = None,
    ) -> dict:
        job_id = job_id or uuid.uuid4().hex[:12]
        job_dir = self._job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)

        (job_dir / "transcript.txt").write_text(text, encoding="utf-8")
        if has_segments:
            (job_dir / "transcript.srt").write_text(srt, encoding="utf-8")
            (job_dir / "transcript.vtt").write_text(vtt, encoding="utf-8")
        if segments:
            (job_dir / "segments.json").write_text(
                json.dumps(segments, indent=2), encoding="utf-8"
            )

        meta = {
            "id": job_id,
            "filename": filename,
            "model": model,
            "language": language,
            "duration": duration,
            "has_segments": has_segments,
            "has_speakers": has_speakers,
            "created_at": _now_iso(),
        }
        (job_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return {**meta, "text": text, "segments": segments or []}

    def save_summary(self, job_id: str, preset: str, markdown: str) -> None:
        job_dir = self._job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "summary.md").write_text(markdown, encoding="utf-8")
        (job_dir / "summary.json").write_text(
            json.dumps({"preset": preset, "created_at": _now_iso()}, indent=2),
            encoding="utf-8",
        )
        meta_file = job_dir / "meta.json"
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        meta["has_summary"] = True
        meta_file.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    def list(self) -> list[dict]:
        jobs: list[dict] = []
        if not self.root.exists():
            return jobs
        for job_dir in self.root.iterdir():
            meta_file = job_dir / "meta.json"
            if meta_file.is_file():
                try:
                    jobs.append(json.loads(meta_file.read_text(encoding="utf-8")))
                except (json.JSONDecodeError, OSError):
                    continue
        jobs.sort(key=lambda j: j.get("created_at", ""), reverse=True)
        return jobs

    def get(self, job_id: str) -> Optional[dict]:
        meta_file = self._job_dir(job_id) / "meta.json"
        if not meta_file.is_file():
            return None
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        txt = self._job_dir(job_id) / "transcript.txt"
        meta["text"] = txt.read_text(encoding="utf-8") if txt.is_file() else ""
        seg_file = self._job_dir(job_id) / "segments.json"
        if seg_file.is_file():
            try:
                meta["segments"] = json.loads(seg_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                meta["segments"] = []
        else:
            meta["segments"] = []
        summary_file = self._job_dir(job_id) / "summary.json"
        summary_md = self._job_dir(job_id) / "summary.md"
        if summary_file.is_file() and summary_md.is_file():
            try:
                summary_meta = json.loads(summary_file.read_text(encoding="utf-8"))
                meta["summary"] = summary_md.read_text(encoding="utf-8")
                meta["summary_preset"] = summary_meta.get("preset")
            except (json.JSONDecodeError, OSError):
                pass
        return meta

    def get_summary(self, job_id: str) -> Optional[dict]:
        summary_file = self._job_dir(job_id) / "summary.json"
        summary_md = self._job_dir(job_id) / "summary.md"
        if not (summary_file.is_file() and summary_md.is_file()):
            return None
        try:
            summary_meta = json.loads(summary_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        return {
            "preset": summary_meta.get("preset"),
            "summary": summary_md.read_text(encoding="utf-8"),
        }

    def file_path(self, job_id: str, fmt: str) -> Optional[Path]:
        if fmt == "json":
            path = self._job_dir(job_id) / "meta.json"
        else:
            name = FORMATS.get(fmt)
            if not name:
                return None
            path = self._job_dir(job_id) / name
        return path if path.is_file() else None

    def delete(self, job_id: str) -> bool:
        job_dir = self._job_dir(job_id)
        if job_dir.is_dir():
            shutil.rmtree(job_dir)
            return True
        return False
