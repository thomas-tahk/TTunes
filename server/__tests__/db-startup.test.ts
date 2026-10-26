import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { dbErrorMessage } from "../db/pool.ts";
import { runServer } from "./s3-test-env.ts";

const SECRET = "PW-SHOULD-NOT-LEAK";
// owner auth on, so the dev "auth is OFF" warning does not share stderr with the failure line
const AUTH = { OWNER_PASSWORD: "owner-pw", SESSION_SECRET: "s" };

/** A local port with nothing listening on it (bound, then released). */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** The startup failure contract: exit 1, exactly one stderr line, no stack, no password. */
function expectOneLineDbFailure(r: { code: number | null; stdout: string; stderr: string }, detail: RegExp) {
  expect(r.code).toBe(1);
  const lines = r.stderr.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^TTunes: database unreachable: /);
  expect(lines[0]).toMatch(detail);
  expect(r.stderr).not.toMatch(/\n\s+at /);
  expect(r.stderr + r.stdout).not.toContain(SECRET);
}

describe("server startup with a bad DATABASE_URL", () => {
  it("exits 1 with one line when nothing listens on the database port", async () => {
    const port = await closedPort();
    const r = await runServer({ ...AUTH, DATABASE_URL: `postgres://ttunes:${SECRET}@127.0.0.1:${port}/ttunes` }, 15_000);
    expectOneLineDbFailure(r, /ECONNREFUSED/);
  }, 20_000);

  it("exits 1 within the connect timeout when the database host never answers", async () => {
    const started = Date.now();
    // non-routable: the SYN goes nowhere (or the network says unreachable straight away)
    const r = await runServer({ ...AUTH, DATABASE_URL: `postgres://ttunes:${SECRET}@10.255.255.1:5432/ttunes` }, 20_000);
    expectOneLineDbFailure(r, /timeout|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i);
    expect(Date.now() - started).toBeLessThan(16_000);
  }, 25_000);

  it.skipIf(!process.env.TEST_DATABASE_URL)("exits 1 with one line when the database does not exist", async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = "/ttunes_tsf_does_not_exist";
    const r = await runServer({ ...AUTH, DATABASE_URL: url.toString() }, 15_000);
    expectOneLineDbFailure(r, /database "ttunes_tsf_does_not_exist" does not exist/);
    // real credentials here, so check the credential part of the URL never shows up
    expect(r.stderr + r.stdout).not.toContain(`${url.username}:${url.password}@`);
  }, 20_000);
});

describe("dbErrorMessage", () => {
  it("redacts the URL's password and falls back to the error code or inner errors", () => {
    const url = `postgres://u:${SECRET}@h:5432/d`;
    expect(dbErrorMessage(new Error(`could not connect to ${url}`), url)).toBe("could not connect to postgres://u:***@h:5432/d");
    expect(dbErrorMessage(Object.assign(new Error(""), { code: "ECONNREFUSED" }), url)).toBe("ECONNREFUSED");
    const agg = new AggregateError([new Error("connect ECONNREFUSED ::1:1"), new Error("connect ECONNREFUSED 127.0.0.1:1")], "");
    expect(dbErrorMessage(agg, url)).toBe("connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1");
    expect(dbErrorMessage(new Error("line one\n  line two"), url)).toBe("line one line two");
    expect(dbErrorMessage(new Error(`bad ${SECRET}`), url)).toBe("bad ***");
    // a short password is only redacted inside a URL, so it can't eat ordinary words
    expect(dbErrorMessage(new Error('database "ttunes_x" at postgres://ttunes:ttunes@h/d'), "postgres://ttunes:ttunes@h/d")).toBe(
      'database "ttunes_x" at postgres://ttunes:***@h/d',
    );
  });
});
