# YouTube research (2026-11-07)

Sources (official Google only; fetched 2026-11-07):
- IFrame API: https://developers.google.com/youtube/iframe_api_reference
- Player params: https://developers.google.com/youtube/player_parameters
- Quota costs: https://developers.google.com/youtube/v3/determine_quota_cost
- Getting started: https://developers.google.com/youtube/v3/getting-started
- videos.list: https://developers.google.com/youtube/v3/docs/videos/list
- video resource: https://developers.google.com/youtube/v3/docs/videos
- search.list: https://developers.google.com/youtube/v3/docs/search/list
- Developer Policies: https://developers.google.com/youtube/terms/developer-policies
- API ToS: https://developers.google.com/youtube/terms/api-services-terms-of-service

Note: fetches were summarized by a small model, with quotes truncated. Re-read the policy sections before launch.

## 1. IFrame Player API

| Question | Finding | Status |
|---|---|---|
| Start at offset | `start` playerVar: "begin playing the video at the given number of seconds from the start of the video"; may land on an earlier keyframe. `loadVideoById` takes `startSeconds` (also closest keyframe). `seekTo(seconds, allowSeekAhead)`: paused stays paused, any other state plays. | verified |
| Precision | Keyframe snapping means start is approximate. Docs give no sync-accuracy guarantee. | open (test in browser) |
| Detect end | `onStateChange` with `0` / `YT.PlayerState.ENDED`. | verified |
| Muted autoplay | The docs never say muted autoplay is allowed. `mute()` exists and `autoplay=1` exists, but no policy text. | open (browser policy, not YouTube docs) |
| User gesture | Docs: `onAutoplayBlocked` event "fires any time the browser blocks autoplay or scripted video playback features", e.g. unmuted playback without user interaction. A first-click Play is consistent with the vision. | verified (consistent) |
| Background tabs | Not addressed in the docs. | open |
| Embed restrictions | Viewport at least 200x200 (480x270 recommended for 16:9). Error 101/150: owner disallows embedding. Error 153: missing Referer / client identification. Error 100: removed or private. `origin` param should be set with `enablejsapi=1`. | verified |
| View counts | A view counts only if started via the native play button. | verified (FYI) |

## 2. Data API v3

| Question | Finding | Status |
|---|---|---|
| duration / embeddable | `contentDetails.duration`: "ISO 8601 duration". `status.embeddable`: "whether the video can be embedded on another website". Caveat on embeddable: videos may still be blocked in embedded players even if the uploader allows embedding. Handle error 101/150 at play time as well. | verified, with caveat |
| videos.list cost | 1 unit. | verified |
| search.list cost | **Model changed.** `search.list` now has its own default quota of 100 calls/day, each costing 1. Not 100 units from the 10,000 pool. Other endpoints share 10,000 units/day. | assumption wording refuted; the ~100 searches/day conclusion holds |
| Default daily quota | 100 search.list calls, 100 videos.insert, 10,000 units for everything else. Resets midnight Pacific. Invalid requests cost at least 1. | verified |
| API key enough? | "Unauthorized requests only retrieve public data"; examples fetch a public video with a key alone. Writes need OAuth. | verified (public read) |
| Cheaper than search | Pasting a link and calling `videos.list` costs 1 unit from the 10,000 pool. Only typed search is capped at about 100/day. `videoEmbeddable=true` on search.list filters to embeddable (type=video required). | verified |

## 3. Terms of service (Developer Policies, Section III)

| Point | Finding | Risk |
|---|---|---|
| Synchronized / radio-style playback | No rule found in the policy text. | none found, low |
| Ad blocking | III.I.5: must not "modify, interfere with, replace, or block advertisements". Do nothing to ads. | OK, matches "ads out of our control" |
| Player modification | III.I.6: no modifying or blocking any portion of the player's functionality. III.F.1: changing YouTube UI needs approval. **Hiding or covering the player (audio-only look) may violate this.** | **medium: keep the player visible and unobstructed** |
| Background player | III.I.9: prohibits features that play content "from a background player". | **medium: do not build a hidden or offscreen player, or a Media Session or background-audio trick** |
| Separate audio from video | III.I.7: no separating or isolating audio or video components. | Same as above: an audio-only UX is risky. Keep the video element visible. |
| Gating embeds | III.F.3: don't charge users to watch in an embed. Don't require actions "other than clicking the play button". | OK. Logging in is only for adding songs. |
| Caching API data | Other authorized data up to 30 days; non-authorized API data up to 30 calendar days; no storing of the audiovisual content. | **Storing title, duration and embeddable in Postgres long-term needs a refresh at most every 30 days.** |
| Quota | ToS s.15: must not exceed or circumvent quotas. No quota extension process in the ToS text. | note |
| Autoplay | III.E.4.i: autoplay causes data collection on page load. Privacy notice implications. | low |

## Vision assumptions

| Assumption | Status |
|---|---|
| IFrame API can start at an offset and report end | verified (keyframe-approximate; sync accuracy open, test it) |
| duration + embeddable readable at add time via videos.list | verified (embeddable is not a guarantee; handle errors 101/150 live) |
| Typed search fits free quota | verified in effect: about 100 searches/day, now a separate bucket costing 1 each. Fix the wording in vision.md. |
| Known limit: click Play once per visit | consistent with docs; muted autoplay unproven |
| Known limit: phone stops on lock; desktop background tabs keep playing | open, undocumented |
| Hosting, cookie limit | out of scope here |

## Flags
1. III.I.9 / III.I.7 / III.I.6: a "radio" UX with the video hidden or minimized is a policy risk. Keep the player visible, at least 200x200.
2. 30-day cap on stored API metadata: needs a re-fetch job. Prefer storing only the video ID, plus metadata refreshed at most every 30 days.
3. Search is capped at about 100/day, shared across all adders.
