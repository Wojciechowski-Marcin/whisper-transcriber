import { useEffect, useRef, useState } from "react";
import Dropzone from "./components/Dropzone";
import JobResult from "./components/JobResult";
import HistoryPanel from "./components/HistoryPanel";
import ProgressCard from "./components/ProgressCard";
import {
  Job,
  JobProgress,
  HealthInfo,
  Stage,
  startJob,
  subscribeJob,
  fetchHistory,
  fetchJob,
  deleteJob,
  fetchHealth,
} from "./lib/api";

type Status = "idle" | "uploading" | "converting" | "transcribing" | "saving" | "error";
const WORKING: Status[] = ["uploading", "converting", "transcribing", "saving"];

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [uploadPct, setUploadPct] = useState(0);
  const [prog, setProg] = useState<JobProgress | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [diarize, setDiarize] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

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
    return () => unsubRef.current?.();
  }, []);

  async function handleFile(file: File) {
    unsubRef.current?.();
    setError(null);
    setActive(null);
    setProg(null);
    setUploadPct(0);
    setStatus("uploading");
    setStartedAt(Date.now());
    try {
      const jobId = await startJob(file, { diarize }, setUploadPct);
      unsubRef.current = subscribeJob(jobId, {
        onProgress: (p) => {
          setProg(p);
          if (WORKING.includes(p.stage as Status)) setStatus(p.stage as Status);
          else if (p.stage === "queued") setStatus("converting");
        },
        onDone: (job) => {
          setProg(null);
          setStatus("idle");
          setActive(job);
          refreshHistory();
        },
        onError: (msg) => {
          setProg(null);
          setError(msg);
          setStatus("error");
        },
      });
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

  const busy = WORKING.includes(status);
  const stage: Stage = status === "uploading" ? "queued" : (prog?.stage ?? "queued");

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">🎙️ Whisper Transcriber</h1>
          <p className="text-sm text-slate-400">
            Upload audio or video — get transcript, speakers, SRT &amp; VTT.
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
          <Dropzone
            disabled={busy}
            diarize={diarize}
            onDiarizeChange={setDiarize}
            onSelect={handleFile}
          />

          {busy && (
            <ProgressCard
              stage={stage}
              uploading={status === "uploading"}
              pct={status === "uploading" ? uploadPct : prog?.pct ?? null}
              message={status === "uploading" ? "Uploading…" : prog?.message ?? ""}
              etaSec={prog?.eta_seconds ?? null}
              startedAt={startedAt}
            />
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
