import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** The signed-in user, from the verified session, or a thrown error. Every
 * function that touches an account's data starts here: the id never comes
 * from the client, so nobody can name another account's rows. The session
 * must still exist, so a token stops working the moment its session ends
 * (signed out, or the account deleted) instead of when it expires, and it
 * must be that user's own: sign-in tokens are signed by this deployment, so
 * they can't pair one account with another's session, but this doesn't
 * count on it. */
export async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await signedInUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
  return userId;
}

/** requireUserId's check, with null for nobody signed in instead of an error. */
export async function signedInUserId(ctx: QueryCtx | MutationCtx): Promise<Id<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  const sessionId = await getAuthSessionId(ctx);
  const session = sessionId ? await ctx.db.get(sessionId) : null;
  return userId && session && session.userId === userId ? userId : null;
}
