# Chief state
Vision: docs/chief/vision.md (hosted shared station; Mac app = Part 1, done)
Phase: Build — M2 hosted station (branch m2-hosted-station; GitHub milestone "M2 — Hosted station", issues #20–#27)
His ask (2026-11-07): build M2 → M3 → M4 through to ready-for-check without stopping
Done: #20 schedule, #21 listener, #22 sign-in, #23 add by link, #24 search API (server half), #26 upkeep
In fix: #25 controls API rebase + review fixes + fold owner/auth endpoints into one function each (Hobby 12-function limit)
Next action: re-review #25 → owner UI for search + controls (one frontend task) → #27 go-live (needs #28)
Branching: one branch per milestone, chained (m3 off m2, m4 off m3); M3/M4 PRs into main open only after the previous one merges — no stacked PRs
Waiting on him: one-time setup https://github.com/thomas-tahk/TTunes/issues/28 (needed only for #27 go-live)
Open questions: docs/questions/M2.md
M3 planned: docs/chief/m3-plan.md, milestone "M3 — Requests", issues #29–#33 (branch m3-requests off m2 once M2 is built)
Updated: 2026-11-07
