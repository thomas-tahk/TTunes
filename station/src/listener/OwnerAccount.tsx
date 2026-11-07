import { useEffect, useRef, useState } from "react";
import { call, messageOf, NETWORK_MESSAGE } from "./ownerFetch.ts";

type Phase = "idle" | "confirm" | "busy";

/** Fetches the export first, so a lapsed session shows an error instead of saving an error body as a file. */
async function downloadExport(): Promise<string | null> {
  const res = await fetch("/api/owner/export");
  if (!res.ok) return messageOf((await res.json().catch(() => ({}))) as Record<string, unknown>);
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "ttunes-library.json";
  const url = URL.createObjectURL(await res.blob());
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  URL.revokeObjectURL(url);
  return null;
}

/** Export button + "Sign out everywhere" with an in-page confirm. Success reloads into the signed-out state. */
export function OwnerAccount() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (phase === "confirm") confirmButton.current?.focus();
    if (phase === "idle" && cancelled.current) trigger.current?.focus();
    cancelled.current = false;
  }, [phase]);

  async function exportLibrary() {
    setError(null);
    try {
      setError(await downloadExport());
    } catch {
      setError(NETWORK_MESSAGE);
    }
  }

  async function signOutEverywhere() {
    setPhase("busy");
    setError(null);
    try {
      const { status, body } = await call("POST", "/api/auth/signout-all");
      if (status !== 200) throw new Error(messageOf(body));
      window.location.reload(); // /api/auth/me now says not owner
    } catch (e) {
      setError(e instanceof TypeError ? NETWORK_MESSAGE : (e as Error).message);
      setPhase("confirm");
    }
  }

  return (
    <div className="owner-account">
      <h2 id="account-heading">Account</h2>
      <div className="owner-actions">
        <button type="button" className="btn small ghost" onClick={() => void exportLibrary()}>
          Export library
        </button>
        {phase === "idle" && (
          <button ref={trigger} type="button" className="btn small ghost" onClick={() => setPhase("confirm")}>
            Sign out everywhere
          </button>
        )}
      </div>
      {phase !== "idle" && (
        <div className="owner-confirm" role="alert">
          <p>Sign out on every device, including this one? You'll need to sign in with GitHub again.</p>
          <div className="owner-actions">
            <button ref={confirmButton} type="button" className="btn small" disabled={phase === "busy"} onClick={() => void signOutEverywhere()}>
              {phase === "busy" ? "Signing out…" : "Yes, sign out everywhere"}
            </button>
            <button type="button" className="btn small ghost" disabled={phase === "busy"} onClick={() => { cancelled.current = true; setPhase("idle"); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="owner-error" role="alert">{error}</p>}
    </div>
  );
}
