import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, fakeYtDlp, makeTestApp } from "./helpers.ts";

// Dev-only: real app on temp dirs with a fake yt-dlp, for driving the UI without network.
const info = JSON.parse(readFileSync(join(FIXTURES, "ytdlp-info-topic.json"), "utf8"));
const port = Number(process.env.PORT) || 8787;
makeTestApp(fakeYtDlp(info)).app.listen(port, () => console.log(`e2e server on ${port}`));
