import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query } from "./_generated/server";

/** The signed-in person as the app shows them, or null when signed out. The
 * name comes from Apple or Google and is capped like any user-supplied text. */
export const viewer = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("users"),
      name: v.optional(v.string()),
      email: v.optional(v.string()),
      image: v.optional(v.string()),
      providers: v.array(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .collect();
    return {
      id: userId,
      name: user.name?.trim().slice(0, 60) || undefined,
      email: user.email,
      image: user.image,
      providers: [...new Set(accounts.map((a) => a.provider))],
    };
  },
});

/** Which sign-in buttons can work on this deployment right now. It reports
 * only whether each provider's variables are set, never their values, so the
 * sign-in screen can say what is missing instead of opening an error page. */
export const signInOptions = query({
  args: {},
  returns: v.object({ apple: v.boolean(), google: v.boolean() }),
  handler: async () => {
    const has = (...names: string[]) => names.every((name) => !!process.env[name]);
    const sessions = has("SITE_URL", "JWT_PRIVATE_KEY", "JWKS");
    return {
      apple: sessions && has("AUTH_APPLE_ID", "AUTH_APPLE_SECRET"),
      google: sessions && has("AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"),
    };
  },
});
