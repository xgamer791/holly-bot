import Apple from "@auth/core/providers/apple";
import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * Where Google and Apple may send someone back to: the live app (`SITE_URL`,
 * https://xgamer791.github.io/holly-bot) and local development on
 * http://localhost.
 *
 * Everything else is refused, Holly Computer's tunnel and LAN addresses
 * included. Whoever starts a sign-in holds the verifier its one-time code is
 * redeemed with, so a sign-in that could finish on a site someone else
 * controls would hand them the account.
 */
export function isAllowedRedirect(redirectTo: string, siteUrl: string | undefined): boolean {
  const site = siteUrl?.trim().replace(/\/+$/, "");
  if (site && redirectTo.startsWith(site) && /^([/?#]|$)/.test(redirectTo.slice(site.length))) {
    return true;
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
 * Sign-in providers, both OAuth with PKCE. The round trip runs on this
 * deployment's site URL (convex/http.ts), so no secret reaches the app:
 *   - Google: `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`. Authorised redirect URI
 *     `<CONVEX_SITE_URL>/api/auth/callback/google`.
 *   - Apple: `AUTH_APPLE_ID` (a Services ID) / `AUTH_APPLE_SECRET` (the client
 *     secret JWT). Return URL `<CONVEX_SITE_URL>/api/auth/callback/apple`.
 *
 * Sessions are JWTs signed with `JWT_PRIVATE_KEY` and checked against `JWKS`.
 * CONVEX.md lists every variable and where it comes from.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google, AppleOAuth],
  callbacks: {
    async redirect({ redirectTo }) {
      if (isAllowedRedirect(redirectTo, process.env.SITE_URL)) return redirectTo;
      throw new Error(`Refusing to redirect to ${redirectTo}`);
    },
  },
});
