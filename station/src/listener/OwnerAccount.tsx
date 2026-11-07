import { useState } from "react";
import { call, messageOf, NETWORK_MESSAGE } from "./ownerFetch.ts";

type Phase = "idle" | "confirm" | "busy";

/** Export link + "Sign out everywhere" with an in-page confirm. Success reloads into the signed-out state. */
export function OwnerAccount() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

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
        <a className="btn small ghost" href="/api/owner/export" download>
          Export library
        </a>
        {phase === "idle" && (
          <button type="button" className="btn small ghost" onClick={() => setPhase("confirm")}>
            Sign out everywhere
          </button>
        )}
      </div>
      {phase !== "idle" && (
        <div className="owner-confirm" role="alert">
          <p>Sign out on every device, including this one? You'll need to sign in with GitHub again.</p>
          <div className="owner-actions">
            <button type="button" className="btn small" disabled={phase === "busy"} onClick={() => void signOutEverywhere()}>
              {phase === "busy" ? "Signing out…" : "Yes, sign out everywhere"}
            </button>
            <button type="button" className="btn small ghost" disabled={phase === "busy"} onClick={() => setPhase("idle")}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="owner-error" role="alert">{error}</p>}
    </div>
  );
}
