import { useRef, useState } from "react";

// Kept short on purpose — auto-detect handles the rest. Add codes here as
// the backend/Whisper coverage is validated for them.
const LANGUAGES: { code: string; label: string }[] = [
  { code: "", label: "Auto-detect" },
  { code: "pl", label: "Polish" },
  { code: "en", label: "English" },
];

interface Props {
  disabled: boolean;
  language: string;
  onLanguageChange: (value: string) => void;
  diarize: boolean;
  onDiarizeChange: (value: boolean) => void;
  minSpeakers: number | null;
  onMinSpeakersChange: (value: number | null) => void;
  maxSpeakers: number | null;
  onMaxSpeakersChange: (value: number | null) => void;
  onSelect: (files: File[]) => void;
}

export default function Dropzone({
  disabled,
  language,
  onLanguageChange,
  diarize,
  onDiarizeChange,
  minSpeakers,
  onMinSpeakersChange,
  maxSpeakers,
  onMaxSpeakersChange,
  onSelect,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    if (files && files.length > 0) onSelect(Array.from(files));
  }

  const MAX_SPEAKERS = 12;

  function parseCount(raw: string): number | null {
    if (!raw.trim()) return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(n, MAX_SPEAKERS);
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) handleFiles(e.dataTransfer.files);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        className={[
          "flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-sky-400",
          dragging ? "border-sky-400 bg-sky-400/10" : "border-slate-600 bg-slate-900/50",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <svg className="mb-3 h-10 w-10 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M3 16.5V18a2.25 2.25 0 002.25 2.25h13.5A2.25 2.25 0 0021 18v-1.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        <p className="font-medium">Drop audio or video files here</p>
        <p className="text-sm text-slate-400">
          or click to browse — mp3, m4a, wav, mp4, mkv, mov… (multiple files are queued and
          processed one at a time)
        </p>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          Language
          <select
            value={language}
            disabled={disabled}
            onChange={(e) => onLanguageChange(e.target.value)}
            className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-slate-500">
            — pick the spoken language to skip autodetect (more reliable on noisy audio)
          </span>
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-300 select-none">
          <input
            type="checkbox"
            checked={diarize}
            disabled={disabled}
            onChange={(e) => onDiarizeChange(e.target.checked)}
            className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-sky-500"
          />
          Detect speakers (diarize)
          <span className="text-xs text-slate-500">— requires a diarization-capable endpoint</span>
        </label>

        {diarize && (
          <div className="flex items-center gap-3 pl-6 text-sm text-slate-300">
            <label className="flex items-center gap-1.5">
              Speakers
              <input
                type="number"
                min={1}
                max={MAX_SPEAKERS}
                placeholder="min"
                value={minSpeakers ?? ""}
                disabled={disabled}
                onChange={(e) => onMinSpeakersChange(parseCount(e.target.value))}
                className="w-16 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
              />
            </label>
            <span className="text-slate-500">to</span>
            <input
              type="number"
              min={1}
              max={MAX_SPEAKERS}
              placeholder="max"
              value={maxSpeakers ?? ""}
              disabled={disabled}
              onChange={(e) => onMaxSpeakersChange(parseCount(e.target.value))}
              className="w-16 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
            />
            <span className="text-xs text-slate-500">
              optional — bounds clustering (max {MAX_SPEAKERS}), prevents over-detection on long/noisy audio
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
