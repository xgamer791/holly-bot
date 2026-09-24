import Apple from "@auth/core/providers/apple";
import Google from "@auth/core/providers/google";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

/** The live app. Allowed whatever `SITE_URL` says, so a stray value there
 * (prod was once set to http://localhost:8080) can't break sign-in. */
export const LIVE_SITE = "https://xgamer791.github.io/holly-bot";

/**
 * Where Google and Apple may send someone back to: the live app, `SITE_URL`
 * (the same address), and local development on http://localhost.
 *
 * Everything else is refused, Holly Computer's tunnel and LAN addresses
 * included. Whoever starts a sign-in holds the verifier its one-time code is
 * redeemed with, so a sign-in that could finish on a site someone else
 * controls would hand them the account.
 */
export function isAllowedRedirect(redirectTo: string, siteUrl: string | undefined): boolean {
  for (const site of [LIVE_SITE, siteUrl?.trim().replace(/\/+$/, "")]) {
    if (site && redirectTo.startsWith(site) && /^([/?#]|$)/.test(redirectTo.slice(site.length))) return true;
  }
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(redirectTo);
}

/**
 * Apple shares the person's name only the first time they consent, in a `user`
 * field that is not part of the id token, and its own `profile` callback sets
 * `image: null`, which the `users` table rejects. So the callback is replaced.
 */
const AppleOAuth = Apple({
  profile: (apple) => {
    const name = [apple.user?.name?.firstName, apple.user?.name?.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 60);
    return { id: apple.sub, email: apple.email, ...(name ? { name } : null) };
  },
});

/**
 * Holly Computer signing in to the account it is being linked to. The app
 * made a one-time code for it (devices:createLink) and handed it over; the
 * code is checked against its stored hash and spent (convex/devices.ts).
 */
const DeviceLink = ConvexCredentials({
  id: "device",
  authorize: async (params, ctx) => {
    const code = typeof params.code === "string" ? params.code : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const codeHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const name = typeof params.name === "string" ? params.name : "";
    return await ctx.runMutation(internal.devices.redeem, { codeHash, name });
  },
});

/**
 * Sign-in providers: Apple and Google, both OAuth with PKCE, and the device
 * link above. The OAuth round trip runs on this deployment's site URL
 * (convex/http.ts), so no secret reaches the app:
 *   - Google: `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`. Authorised redirect URI
 *     `<CONVEX_SITE_URL>/api/auth/callback/google`.
 *   - Apple: `AUTH_APPLE_ID` (a Services ID) / `AUTH_APPLE_SECRET` (the client
 *     secret JWT). Return URL `<CONVEX_SITE_URL>/api/auth/callback/apple`.
 *
 * Sessions are JWTs signed with `JWT_PRIVATE_KEY` and checked against `JWKS`.
 * CONVEX.md lists every variable and where it comes from.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google, AppleOAuth, DeviceLink],
  callbacks: {
    async redirect({ redirectTo }) {
      if (isAllowedRedirect(redirectTo, process.env.SITE_URL)) return redirectTo;
      throw new Error(`Refusing to redirect to ${redirectTo}`);
    },
  },
});
