import { byMethod, router } from "../lib/ownerApi.ts";
import { library, log, queue, queueMove, skip, songRestore, songTrash, trash } from "../lib/routes/owner/controls.ts";
import ownerExport from "../lib/routes/owner/export.ts";
import preview from "../lib/routes/owner/preview.ts";
import { requestMode, requestModerate, requestsList } from "../lib/routes/owner/requests.ts";
import search from "../lib/routes/owner/search.ts";
import songAdd from "../lib/routes/owner/songAdd.ts";

// The single function behind every /api/owner/* URL (vercel.json rewrites them here; Hobby allows 12 functions).
export default router("owner", {
  preview,
  search,
  export: ownerExport,
  songs: byMethod({ POST: songAdd, DELETE: songTrash }),
  "songs/restore": songRestore,
  skip,
  queue,
  "queue/move": queueMove,
  trash,
  library,
  requests: requestsList,
  "requests/moderate": requestModerate,
  "requests/mode": requestMode,
  log,
});
