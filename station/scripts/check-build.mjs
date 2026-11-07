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
execFileSync("npx", ["vercel", "build"], { stdio: "inherit" });

const functionsRoot = resolve(".vercel/output/functions");
function funcDirs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = resolve(dir, e.name);
    if (!e.isDirectory()) return [];
    return e.name.endsWith(".func") ? [full] : funcDirs(full);
  });
}
for (const dir of funcDirs(resolve(functionsRoot, "api"))) {
  const file = resolve(dir, `${dir.slice(functionsRoot.length + 1).replace(/\.func$/, "")}.js`);
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.default !== "function") throw new Error(`${file} has no default handler`);
  console.log(`OK loads: ${file}`);
}
process.exit(0); // db pool imports may keep handles open
