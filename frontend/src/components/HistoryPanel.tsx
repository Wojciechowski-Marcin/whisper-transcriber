import { Job } from "../lib/api";
import { formatDate, formatDuration } from "../lib/format";

interface Props {
  jobs: Job[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  converting: "Converting",
  transcribing: "Transcribing",
  saving: "Saving",
};

function StatusBadge({ job }: { job: Job }) {
  if (job.status === "error") {
    return (
      <span className="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
        Failed
      </span>
    );
  }
  if (job.status === "running") {
    const label = STAGE_LABEL[job.stage ?? "queued"] ?? "Working";
    const pct = job.pct != null ? ` ${Math.round(job.pct)}%` : "…";
    return (
      <span className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        {label}
        {pct}
      </span>
    );
  }
  return null;
}

export default function HistoryPanel({ jobs, activeId, onSelect, onDelete }: Props) {
  if (jobs.length === 0) {
    return (
      <p className="text-sm text-slate-500">No transcriptions yet. Upload a file to begin.</p>
    );
  }

  return (
    <ul className="space-y-2">
      {jobs.map((job) => {
        const running = job.status === "running";
        return (
          <li
            key={job.id}
            className={[
              "group flex items-center justify-between rounded-lg border px-3 py-2 text-sm",
              job.id === activeId
                ? "border-sky-500 bg-sky-500/10"
                : "border-slate-700 bg-slate-900/40 hover:border-slate-500",
            ].join(" ")}
          >
            <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(job.id)}>
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-slate-200">{job.filename}</span>
                <StatusBadge job={job} />
              </div>
              <div className="text-xs text-slate-500">
                {formatDate(job.created_at)}
                {!running && ` · ${formatDuration(job.duration)}`}
                {!running && job.language ? ` · ${job.language}` : ""}
              </div>
            </button>
            {job.status === "done" && (
              <button
                onClick={() => onDelete(job.id)}
                title="Delete"
                className="ml-2 shrink-0 rounded p-1 text-slate-500 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
              >
                ✕
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
