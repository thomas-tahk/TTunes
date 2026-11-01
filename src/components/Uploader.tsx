import { useEffect, useState } from "react";
import { uploadTrack } from "../api.ts";
import type { AddChoice } from "../addChoice.ts";
import { AddChoiceButtons } from "./AddChoiceButtons.tsx";

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
  const [dragging, setDragging] = useState(false);

  async function handleFiles(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    setAddedIds([]);
    const result = await uploadAll(files, setStatus);
    await onAdded();
    setBusy(false);
    setStatus(null);
    setErrors(result.errors);
    setAddedIds(result.ids);
  }

  // Whole page is the drop zone.
  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void handleFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  });

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
      {addedIds.length > 0 && (
        <div className="uploader__choice">
          <span>
            Added {addedIds.length} {addedIds.length === 1 ? "track" : "tracks"}
          </span>
          <AddChoiceButtons busy={false} onChoose={choose} />
        </div>
      )}
    </>
  );
}
