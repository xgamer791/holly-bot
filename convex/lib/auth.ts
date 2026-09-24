import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** The signed-in user, from the verified session, or a thrown error. Every
 * function that touches an account's data starts here: the id never comes
 * from the client, so nobody can name another account's rows. The session
 * must still exist, so a token stops working the moment its session ends
 * (signed out, or the account deleted) instead of when it expires. */
export async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  const sessionId = await getAuthSessionId(ctx);
  if (!userId || !sessionId || !(await ctx.db.get(sessionId))) throw new ConvexError("Not signed in");
  return userId;
}
