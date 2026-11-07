import { byMethod, router } from "../lib/ownerApi.ts";
import post from "../lib/routes/requests/post.ts";

// The single function behind every public /api/requests* URL (vercel.json rewrites sub-paths here; Hobby allows 12 functions).
// "" is POST /api/requests itself; the feed (GET) and listener search (#31) join this router.
export default router("requests", {
  "": byMethod({ POST: post }),
});
