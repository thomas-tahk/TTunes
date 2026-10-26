# Chief state
Vision: docs/superpowers/specs/2026-06-30-ttunes-design.md (confirmed 2026-10-25, done-gate in header)
Plan: docs/chief/plan.html (approved 2026-10-25) — https://claude.ai/artifact/6ucGXnDA4SqcMJm2mtC9ak
Phase: Build — M1 "On my phone, from the cloud" (branch m1-cloud-phone, GitHub milestone 1, issues #4–#10)
Order: #4 test harness → (#5 Postgres, #6 S3/R2, #9 password in parallel) → #7 station state → #8 player; #10 container/CI after #5 #6 #9
Next action: build #4, then fan out
Waiting on him: nothing until #10 needs his accounts (R2, Neon, host) — hand him a wizard then
Decisions: gate read as "one tap, music within a second" (browser autoplay rule); host ~$5/mo is a STARTING point — owner wants to move TTunes to a home-lab server later, so keep the container portable and host-agnostic; single owner password, no accounts
Updated: 2026-10-25
