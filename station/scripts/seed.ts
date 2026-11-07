import { pathToFileURL } from "node:url";
import { createDb, type Db } from "../lib/db.ts";

// Real, short, embeddable YouTube videos (checked with yt-dlp playable_in_embed on 2026-11-07).
const SEED_SONGS = [
  { videoId: "jNQXAC9IVRw", title: "Me at the zoo", durationSec: 19 },
  { videoId: "dmzID8hbMIE", title: "Cool Intro - Stings - Kevin MacLeod", durationSec: 17 },
  { videoId: "APVeRctVWBM", title: 'Kevin MacLeod "Taps"', durationSec: 55 },
  { videoId: "ViGb-oiEYS0", title: "Kevin MacLeod Royalty Free Music", durationSec: 102 },
];

// Demo songs only. Run `npm run db:migrate` first.
export async function seedSongs(db: Db): Promise<number> {
  for (const song of SEED_SONGS) {
    await db.query(
      "insert into songs (video_id, title, duration_sec) values ($1, $2, $3) on conflict (video_id) do update set title = $2, duration_sec = $3",
      [song.videoId, song.title, song.durationSec],
    );
  }
  return SEED_SONGS.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const db = createDb();
  try {
    console.log(`Seeded ${await seedSongs(db)} songs`);
  } finally {
    await db.end();
  }
}
