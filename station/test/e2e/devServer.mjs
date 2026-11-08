// Shared by the e2e scripts: a free port per run, and a Vite start that fails loudly instead of driving someone else's app.
import { spawn } from "node:child_process";
import { createServer } from "node:net";

/** Ask the OS for a free port: listen on 0, read it, close. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** True only for a Vite dev server: /@vite/client is Vite's own file, so a foreign app on the port does not pass. */
async function isVite(port) {
  const res = await fetch(`http://127.0.0.1:${port}/@vite/client`).catch(() => null);
  return res !== null && res.ok && (await res.text()).includes("vite");
}

/** Start `vite --port <port> --strictPort`; resolves once it answers, rejects if the child exits first or never answers. */
export async function startDevServer(port, env = process.env) {
  // Bound to 127.0.0.1, the same address freePort probed. Own process group, so the kill on exit reaches vite under npx.
  const server = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { env, stdio: "ignore", detached: true });
  process.once("exit", () => { try { process.kill(-server.pid); } catch {} }); // a script that throws mid-setup no longer leaves vite running
  let exitCode = null;
  server.once("exit", (code) => { exitCode = code ?? "signal"; });
  for (let i = 0; i < 120; i++) {
    if (exitCode !== null) throw new Error(`vite exited (${exitCode}) before it was ready on port ${port}`);
    if (await isVite(port)) return server;
    await new Promise((r) => setTimeout(r, 500));
  }
  try { process.kill(-server.pid); } catch {}
  throw new Error(`dev server did not start on port ${port}`);
}
