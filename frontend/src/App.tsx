import { useEffect, useState } from "react";
import Dropzone from "./components/Dropzone";
import JobResult from "./components/JobResult";
import HistoryPanel from "./components/HistoryPanel";
import {
  Job,
  HealthInfo,
  uploadFile,
  fetchHistory,
  fetchJob,
  deleteJob,
  fetchHealth,
} from "./lib/api";

type Status = "idle" | "uploading" | "transcribing" | "error";

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);

  async function refreshHistory() {
    try {
      setHistory(await fetchHistory());
    } catch {
      /* non-fatal */
    }
  }

  useEffect(() => {
    refreshHistory();
    fetchHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  async function handleFile(file: File) {
    setError(null);
    setActive(null);
    setStatus("uploading");
    setProgress(0);
    try {
      const job = await uploadFile(file, undefined, (pct) => {
        setProgress(pct);
        if (pct >= 100) setStatus("transcribing");
      });
      setActive(job);
      setStatus("idle");
      refreshHistory();
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
    }
  }

  async function selectJob(id: string) {
    try {
      setActive(await fetchJob(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeJob(id: string) {
    await deleteJob(id);
    if (active?.id === id) setActive(null);
    refreshHistory();
  }

  const busy = status === "uploading" || status === "transcribing";

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">🎙️ Whisper Transcriber</h1>
          <p className="text-sm text-slate-400">
            Upload audio or video — get transcript, SRT &amp; VTT.
          </p>
        </div>
        {health && (
          <div className="text-right text-xs text-slate-500">
            <div>model: {health.model}</div>
            <div>
              endpoint:{" "}
              <span className={health.upstream === "ok" ? "text-emerald-400" : "text-amber-400"}>
                {health.upstream}
              </span>
            </div>
          </div>
        )}
      </header>

      <div className="grid gap-8 md:grid-cols-[1fr_320px]">
        <main className="space-y-5">
          <Dropzone disabled={busy} onSelect={handleFile} />

          {busy && (
            <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-4">
              <div className="mb-2 flex justify-between text-sm text-slate-300">
                <span>{status === "uploading" ? "Uploading…" : "Transcribing…"}</span>
                {status === "uploading" && <span>{progress}%</span>}
              </div>
              <div className="h-2 overflow-hidden rounded bg-slate-700">
                <div
                  className={[
                    "h-full bg-sky-500 transition-all",
                    status === "transcribing" ? "w-full animate-pulse" : "",
                  ].join(" ")}
                  style={status === "uploading" ? { width: `${progress}%` } : undefined}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {active && <JobResult job={active} />}
        </main>

        <aside>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            History
          </h2>
          <HistoryPanel
            jobs={history}
            activeId={active?.id ?? null}
            onSelect={selectJob}
            onDelete={removeJob}
          />
        </aside>
      </div>
    </div>
  );
}
