import { useState } from "react";
import { uploadTrack } from "../api.ts";

export function Uploader({ onAdded }: { onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || !files.length) return;
    setBusy(true);
    const list = Array.from(files);
    let done = 0;
    for (const file of list) {
      setStatus(`Adding ${file.name} (${++done}/${list.length})…`);
      try {
        await uploadTrack(file);
      } catch {
        setStatus(`Couldn't add ${file.name}`);
      }
    }
    setBusy(false);
    setStatus(null);
    onAdded();
  }

  return (
    <label className={`uploader ${busy ? "uploader--busy" : ""}`}>
      <input
        type="file"
        accept="audio/*"
        multiple
        disabled={busy}
        onChange={(e) => handleFiles(e.target.files)}
      />
      <span>{status ?? "＋ Add music — drop in audio files"}</span>
    </label>
  );
}
