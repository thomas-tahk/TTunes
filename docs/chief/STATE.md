# Chief state
Vision: docs/chief/vision.md (hosted shared station; Mac app = Part 1, done)
Phase: Review — M2 (PR #37 to main, needs-you) and M3 (report docs/milestones/M3.md; PR opens after M2 merges); Build — M4 on branch m4-portfolio
His ask (2026-11-07): build M2 → M3 → M4 through to ready-for-review without stopping
M2: built + QA'd locally; report docs/milestones/M2.md; go-live #27 waits on #28
M3: built, whole-diff reviewed, QA done-gate passed locally (head fb62783); go-live #33 waits on #28
M4: #34 README + #35 one preview image (no person names) — builder on branch m4-build → merge into m4-portfolio
Branching: one branch per milestone, chained (m3-requests off m2, m4-portfolio off m3); next PR opens only after the previous merges — no stacked PRs
Waiting on him: M2 PR https://github.com/thomas-tahk/TTunes/pull/37 (merge + decisions); one-time setup https://github.com/thomas-tahk/TTunes/issues/28 (only for go-live)
Open questions: docs/questions/M2.md, docs/questions/M3.md
Updated: 2026-11-07
