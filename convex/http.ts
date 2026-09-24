import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();

// /api/auth/signin/* and /api/auth/callback/*: the Google and Apple round trip
// runs here, on the deployment's site URL, so the app never holds a secret.
auth.addHttpRoutes(http);

export default http;
