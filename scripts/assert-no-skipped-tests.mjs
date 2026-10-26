// CI guard: fails when vitest skipped anything, so a missing TEST_DATABASE_URL / TEST_S3_*
// (which makes the Postgres and S3 suites skip) can't pass as green.
// Usage: node scripts/assert-no-skipped-tests.mjs vitest-results.json
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(process.argv[2] ?? "vitest-results.json", "utf8"));
const skipped = r.numPendingTests + r.numTodoTests;
console.log(`passed ${r.numPassedTests}, failed ${r.numFailedTests}, skipped ${skipped}`);
if (skipped > 0) {
  console.error("tests were skipped: are TEST_DATABASE_URL and TEST_S3_* wired up?");
  process.exit(1);
}
