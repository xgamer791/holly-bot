import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { webhook } from "./billing";
import { callback } from "./connectors";

const http = httpRouter();

// /api/auth/signin/* and /api/auth/callback/*: the Google and Apple round trip
// runs here, on the deployment's site URL, so the app never holds a secret.
auth.addHttpRoutes(http);

// /connectors/<service>/callback: where Gmail, Outlook and GitHub send people
// back to after they approve a connection (convex/connectors.ts).
http.route({ pathPrefix: "/connectors/", method: "GET", handler: callback });

// /stripe/webhook: Stripe's news of every subscription change (convex/billing.ts).
http.route({ path: "/stripe/webhook", method: "POST", handler: webhook });

export default http;
