import { byMethod, router } from "../lib/ownerApi.ts";
import { feed, mine } from "../lib/routes/requests/read.ts";
import post from "../lib/routes/requests/post.ts";
import search from "../lib/routes/requests/search.ts";

// The single function behind every public /api/requests* URL (vercel.json rewrites sub-paths here; Hobby allows 12 functions).
// "" is POST /api/requests itself.
export default router("requests", {
  "": byMethod({ POST: post }),
  feed: byMethod({ GET: feed }),
  mine: byMethod({ GET: mine }),
  search: byMethod({ GET: search }),
});
