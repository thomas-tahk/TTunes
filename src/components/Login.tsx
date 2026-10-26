import { useState, type FormEvent } from "react";
import { login } from "../api.ts";

const MESSAGES = {
  wrong: "Wrong password.",
  locked: "Too many attempts. Try again in a few minutes.",
  error: "Couldn't reach the server.",
} as const;

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<keyof typeof MESSAGES | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await login(password);
      if (result === "ok") {
        onSuccess();
        return;
      }
      setError(result);
      setPassword("");
    } catch {
      setError("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__form" onSubmit={submit}>
        <h1 className="brand">
          <span className="brand__dot" /> TTunes
        </h1>
        <input
          className="login__input"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          aria-label="Password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="ctrl ctrl--primary" type="submit" disabled={busy || !password}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        {error && (
          <p className="login__error" role="alert">
            {MESSAGES[error]}
          </p>
        )}
      </form>
    </div>
  );
}
