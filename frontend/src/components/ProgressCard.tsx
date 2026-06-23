import { useEffect, useRef, useState } from "react";
import { Stage } from "../lib/api";
import { formatClock } from "../lib/format";

interface Props {
  stage: Stage; // queued | converting | transcribing | saving (+ "uploading" pseudo)
  uploading: boolean;
  pct: number | null; // real % when known (upload / convert)
  message: string;
  etaSec: number | null; // estimated transcribe duration
  startedAt: number; // ms epoch when the job began (for elapsed clock)
}

const LABELS: Record<string, string> = {
  uploading: "Uploading",
  queued: "Queued",
  converting: "Converting audio",
  transcribing: "Transcribing",
  saving: "Saving transcript",
};

export default function ProgressCard({
  stage,
  uploading,
  pct,
  message,
  etaSec,
  startedAt,
}: Props) {
  // Tick a clock so the elapsed time and the transcribe estimate animate.
  const [now, setNow] = useState(Date.now());
  const transcribeStart = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (stage === "transcribing" && transcribeStart.current === null) {
      transcribeStart.current = Date.now();
    }
    if (stage !== "transcribing") {
      transcribeStart.current = stage === "saving" ? transcribeStart.current : null;
    }
  }, [stage]);

  const elapsed = (now - startedAt) / 1000;
  const label = uploading ? LABELS.uploading : LABELS[stage] ?? message ?? "Working";

  // Determine the bar fill.
  let width: number | null = null; // null → indeterminate animation
  let estimating = false;
  if (uploading || stage === "converting") {
    width = pct; // may be null while ffprobe duration is unknown
  } else if (stage === "transcribing") {
    if (etaSec && transcribeStart.current) {
      const t = (now - transcribeStart.current) / 1000;
      // Eased asymptote toward 95% — never completes until the server says done.
      width = (1 - Math.exp(-t / etaSec)) * 95;
      estimating = true;
    }
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-4">
      <div className="mb-2 flex justify-between text-sm text-slate-300">
        <span>{message || `${label}…`}</span>
        <span className="tabular-nums text-slate-400">
          {width != null && <span className="mr-3">{Math.round(width)}%</span>}
          {formatClock(elapsed)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-slate-700">
        {width != null ? (
          <div
            className="h-full bg-sky-500 transition-all duration-300 ease-out"
            style={{ width: `${Math.max(2, width)}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded bg-sky-500" />
        )}
      </div>
      {estimating && (
        <p className="mt-1.5 text-xs text-slate-500">
          {etaSec ? `~${formatClock(etaSec)} estimated · ` : ""}endpoint is processing —
          the bar is an estimate
        </p>
      )}
    </div>
  );
}
