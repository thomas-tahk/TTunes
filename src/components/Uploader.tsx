import { useState } from "react";
import { uploadTrack } from "../api.ts";
import type { AddChoice } from "../addChoice.ts";
import { useWindowDrop } from "../useWindowDrop.ts";
import { BatchChoice } from "./BatchChoice.tsx";

interface UploaderProps {
  onAdded: () => Promise<void>;
  onChoose: (ids: string[], choice: AddChoice) => void;
}

// Uploads sequentially so the returned ids stay in drop order.
async function uploadAll(files: File[], onProgress: (msg: string) => void) {
  const ids: string[] = [];
  const errors: string[] = [];
  for (const [i, file] of files.entries()) {
    onProgress(`Adding ${file.name} (${i + 1}/${files.length})…`);
    try {
      ids.push((await uploadTrack(file)).id);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `Couldn't add ${file.name}`);
    }
  }
  return { ids, errors };
}

export function Uploader({ onAdded, onChoose }: UploaderProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [addedIds, setAddedIds] = useState<string[]>([]);

  async function handleFiles(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setAddedIds([]);
    const result = await uploadAll(files, setStatus);
    try {
      await onAdded();
    } finally {
      setBusy(false);
      setStatus(null);
      setErrors(result.errors);
      setAddedIds(result.ids);
    }
  }

  const dragging = useWindowDrop((files) => void handleFiles(files));

  function choose(choice: AddChoice) {
    onChoose(addedIds, choice);
    setAddedIds([]);
  }

  return (
    <>
      <label className={`uploader ${busy ? "uploader--busy" : ""} ${dragging ? "uploader--drag" : ""}`}>
        <input
          type="file"
          accept="audio/*,video/*"
          multiple
          disabled={busy}
          onChange={(e) => {
            void handleFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <span>{status ?? "＋ Add music — drop audio or video files anywhere"}</span>
      </label>
      {errors.map((msg) => (
        <p key={msg} className="uploader__error" role="alert">
          {msg}
        </p>
      ))}
      {addedIds.length > 0 && <BatchChoice count={addedIds.length} onChoose={choose} />}
    </>
  );
}
