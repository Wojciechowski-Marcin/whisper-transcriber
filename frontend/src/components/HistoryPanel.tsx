import { Job } from "../lib/api";
import { formatDate, formatDuration } from "../lib/format";

interface Props {
  jobs: Job[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function HistoryPanel({ jobs, activeId, onSelect, onDelete }: Props) {
  if (jobs.length === 0) {
    return (
      <p className="text-sm text-slate-500">No transcriptions yet. Upload a file to begin.</p>
    );
  }

  return (
    <ul className="space-y-2">
      {jobs.map((job) => (
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
            <div className="truncate font-medium text-slate-200">{job.filename}</div>
            <div className="text-xs text-slate-500">
              {formatDate(job.created_at)} · {formatDuration(job.duration)}
              {job.language ? ` · ${job.language}` : ""}
            </div>
          </button>
          <button
            onClick={() => onDelete(job.id)}
            title="Delete"
            className="ml-2 shrink-0 rounded p-1 text-slate-500 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}
