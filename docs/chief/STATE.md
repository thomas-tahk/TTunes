# Chief state
Vision: docs/superpowers/specs/2026-06-30-ttunes-design.md (confirmed 2026-10-25, done-gate in header)
Plan: docs/chief/plan.html (approved 2026-10-25) — https://claude.ai/artifact/6ucGXnDA4SqcMJm2mtC9ak
Phase: Review — SHELVED 2026-10-28 by owner until hosting is settled (PR #11 comment). M1 "On my phone, from the cloud" built (branch m1-cloud-phone, issues #4–#10 all merged + closed, 0 stuck)
Report: docs/milestones/M1.md · PR https://github.com/thomas-tahk/TTunes/pull/11 (m1-cloud-phone → main)
Next action: none until he reopens it. When he does: settle hosting first (options he listed: as built Fly+R2+Neon ~$3–4/mo; Fly+Tigris+SQLite on a volume — one account, small code change; Render $7 flat; home server later). Open: library size unknown (starts at zero, grows), no always-on home machine yet, Neon free-tier cold start on first open unmeasured. Then, when he answers, write answers into issues/vision, then plan M2 (Shape/Plan need him at his Mac)
Waiting on him: create R2 + Neon + Fly accounts and deploy (docs/deploy.md), play it on his phone, answer the 7 decisions in docs/milestones/M1.md, merge the PR
Open questions: docs/questions/M1.md
Known: iPhone Safari untested (only Chromium iPhone emulation); Next-while-offline undone on reconnect; deleted tracks linger on other devices' lists; some VBR MP3 durations wrong; malformed-WAV crash in music-metadata
Decisions: gate read as "one tap, music within a second"; host Fly.io (~$3–4/mo, portable image, home lab later via docker compose); single owner password, no accounts
Updated: 2026-10-28
