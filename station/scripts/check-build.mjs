// Builds with the Vercel CLI and imports each built function with plain node, proving the
// output loads (no .ts specifiers, shared code bundled). `vercel build` needs project settings;
// without a linked project this writes throwaway local ones (.vercel/ is gitignored).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

if (!existsSync(".vercel/project.json")) {
  mkdirSync(".vercel", { recursive: true });
  const settings = { framework: "vite", buildCommand: null, outputDirectory: null, installCommand: null, devCommand: null, nodeVersion: "22.x", rootDirectory: null };
  writeFileSync(".vercel/project.json", JSON.stringify({ projectId: "prj_local000000000000000000000000", orgId: "team_local00000000000000000", settings }));
}
// Local `vercel build` sets VERCEL=1 but not VERCEL_ENV; say "preview" so the build never migrates anything.
execFileSync("npx", ["vercel", "build"], { stdio: "inherit", env: { ...process.env, VERCEL_ENV: "preview" } });

const functionsRoot = resolve(".vercel/output/functions");
function funcDirs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = resolve(dir, e.name);
    if (!e.isDirectory()) return [];
    return e.name.endsWith(".func") ? [full] : funcDirs(full);
  });
}
const MAX_FUNCTIONS = 12; // Vercel Hobby: 12 functions per deployment, one per file in api/
const dirs = funcDirs(resolve(functionsRoot, "api"));
if (dirs.length > MAX_FUNCTIONS) {
  console.error(`FAIL: ${dirs.length} functions built, Vercel Hobby allows ${MAX_FUNCTIONS}. Fold endpoints into a router (api/owner.ts).`);
  process.exit(1);
}
console.log(`function count: ${dirs.length} (limit ${MAX_FUNCTIONS})`);
for (const dir of dirs) {
  const file = resolve(dir, `${dir.slice(functionsRoot.length + 1).replace(/\.func$/, "")}.js`);
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== "function") throw new Error(`${file} has no default handler`);
  console.log(`OK loads: ${file}`);
}
process.exit(0); // db pool imports may keep handles open
