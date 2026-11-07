// Copies ../shared into station/shared so the Vercel function build can compile it (it only sees files under station/).
import { cpSync, rmSync } from "node:fs";
rmSync("shared", { recursive: true, force: true });
cpSync("../shared", "shared", { recursive: true, filter: (p) => !p.endsWith(".test.ts") });
