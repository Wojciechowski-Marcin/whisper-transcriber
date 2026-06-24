import { useRef, useState } from "react";

interface Props {
  disabled: boolean;
  diarize: boolean;
  onDiarizeChange: (value: boolean) => void;
  onSelect: (files: File[]) => void;
}

export default function Dropzone({ disabled, diarize, onDiarizeChange, onSelect }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    if (files && files.length > 0) onSelect(Array.from(files));
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
    </div>
  );
}
