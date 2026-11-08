import { router } from "../lib/ownerApi.ts";
import callback from "../lib/routes/auth/callback.ts";
import login from "../lib/routes/auth/login.ts";
import me from "../lib/routes/auth/me.ts";
import signoutAll from "../lib/routes/auth/signoutAll.ts";

// The single function behind every /api/auth/* URL. The GitHub callback URL stays /api/auth/github/callback.
export default router("auth", {
  "github/login": login,
  "github/callback": callback,
  me,
  "signout-all": signoutAll,
});
