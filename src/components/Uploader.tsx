import { useState, type ChangeEvent } from "react";
import { UnauthorizedError, UploadError, uploadTrack } from "../api.ts";

interface Failure {
  name: string;
  reason: string | null;
}

/** "Couldn't add a.mp3: not a playable audio file" / "Couldn't add 2 of 5: a.mp3 (…), b.txt". */
function failureMessage(failures: Failure[], total: number): string {
  if (total === 1) {
    const [f] = failures;
    return f.reason ? `Couldn't add ${f.name}: ${f.reason}` : `Couldn't add ${f.name}`;
  }
  const names = failures.map((f) => (f.reason ? `${f.name} (${f.reason})` : f.name)).join(", ");
  return `Couldn't add ${failures.length} of ${total}: ${names}`;
}

export function Uploader({ onAdded }: { onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** The last upload's failures; stays until the next upload or it's dismissed. */
  const [failed, setFailed] = useState<string | null>(null);

  async function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const list = Array.from(input.files ?? []);
    input.value = ""; // so picking the same file again (after fixing it) fires change
    if (!list.length) return;
    setBusy(true);
    setFailed(null);
    const failures: Failure[] = [];
    let done = 0;
    for (const file of list) {
      setStatus(`Adding ${file.name} (${++done}/${list.length})…`);
      try {
        await uploadTrack(file);
      } catch (err) {
        if (err instanceof UnauthorizedError) break; // the gate is already showing the login screen
        failures.push({ name: file.name, reason: err instanceof UploadError ? err.reason : null });
      }
    }
    setBusy(false);
    setStatus(null);
    if (failures.length) setFailed(failureMessage(failures, list.length));
    if (failures.length < list.length) onAdded();
  }

  return (
    <>
      <label className={`uploader ${busy ? "uploader--busy" : ""}`}>
        <input type="file" accept="audio/*" multiple disabled={busy} onChange={handleFiles} />
        <span>{status ?? "＋ Add music — drop in audio files"}</span>
      </label>
      {failed && (
        <div className="upload-error" role="alert">
          <span className="upload-error__text">{failed}</span>
          <button className="icon-btn" onClick={() => setFailed(null)} aria-label="Dismiss" title="Dismiss">
            ✕
          </button>
        </div>
      )}
    </>
  );
}
