import { httpRouter } from "convex/server";
import { chat, preflight } from "./ai";
import { auth } from "./auth";
import { webhook } from "./billing";
import { callback } from "./connectors";
import { ready } from "./servers";

const http = httpRouter();

// /api/auth/signin/* and /api/auth/callback/*: the Google and Apple round trip
// runs here, on the deployment's site URL, so the app never holds a secret.
auth.addHttpRoutes(http);

// /connectors/<service>/callback: where Gmail, Outlook and GitHub send people
// back to after they approve a connection (convex/connectors.ts).
http.route({ pathPrefix: "/connectors/", method: "GET", handler: callback });

// /stripe/webhook: Stripe's news of every subscription change (convex/billing.ts).
http.route({ path: "/stripe/webhook", method: "POST", handler: webhook });

// /servers/ready: a subscriber's server reporting that Holli Bot is running on it,
// or what went wrong (convex/servers.ts, convex/lib/cloudinit.ts).
http.route({ path: "/servers/ready", method: "POST", handler: ready });

// /ai/chat/completions: bots' requests to Holli Bot's AI, DeepSeek on Holli
// Bot's key, charged to the account's monthly credits (convex/ai.ts).
http.route({ path: "/ai/chat/completions", method: "POST", handler: chat });
http.route({ path: "/ai/chat/completions", method: "OPTIONS", handler: preflight });

export default http;
