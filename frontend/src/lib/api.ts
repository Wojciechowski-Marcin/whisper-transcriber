export interface Job {
  id: string;
  filename: string;
  model: string;
  language: string | null;
  duration: number | null;
  has_segments: boolean;
  created_at: string;
  text?: string;
}

export interface HealthInfo {
  status: string;
  upstream: string;
  model: string;
}

/** Upload a file with progress reporting (XHR — fetch lacks upload progress). */
export function uploadFile(
  file: File,
  language: string | undefined,
  onProgress: (pct: number) => void,
): Promise<Job> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    if (language) form.append("language", language);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/transcribe");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let detail = `Request failed (${xhr.status})`;
        try {
          detail = JSON.parse(xhr.responseText).detail || detail;
        } catch {
          /* ignore */
        }
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(form);
  });
}

export async function fetchHistory(): Promise<Job[]> {
  const res = await fetch("/api/history");
  if (!res.ok) throw new Error("Failed to load history");
  return res.json();
}

export async function fetchJob(id: string): Promise<Job> {
  const res = await fetch(`/api/jobs/${id}`);
  if (!res.ok) throw new Error("Job not found");
  return res.json();
}

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete");
}

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch("/api/health");
  return res.json();
}

export function downloadUrl(id: string, fmt: "txt" | "srt" | "vtt" | "json"): string {
  return `/api/jobs/${id}/download/${fmt}`;
}
