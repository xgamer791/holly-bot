/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as ai from "../ai.js";
import type * as auth from "../auth.js";
import type * as billing from "../billing.js";
import type * as connectors from "../connectors.js";
import type * as credits from "../credits.js";
import type * as crons from "../crons.js";
import type * as data from "../data.js";
import type * as devices from "../devices.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_cloudinit from "../lib/cloudinit.js";
import type * as lib_credits from "../lib/credits.js";
import type * as lib_github from "../lib/github.js";
import type * as lib_mail from "../lib/mail.js";
import type * as lib_oauth from "../lib/oauth.js";
import type * as lib_plans from "../lib/plans.js";
import type * as lib_records from "../lib/records.js";
import type * as lib_seal from "../lib/seal.js";
import type * as lib_stripe from "../lib/stripe.js";
import type * as lib_subscription from "../lib/subscription.js";
import type * as lib_vultr from "../lib/vultr.js";
import type * as servers from "../servers.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  ai: typeof ai;
  auth: typeof auth;
  billing: typeof billing;
  connectors: typeof connectors;
  credits: typeof credits;
  crons: typeof crons;
  data: typeof data;
  devices: typeof devices;
  health: typeof health;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  "lib/cloudinit": typeof lib_cloudinit;
  "lib/credits": typeof lib_credits;
  "lib/github": typeof lib_github;
  "lib/mail": typeof lib_mail;
  "lib/oauth": typeof lib_oauth;
  "lib/plans": typeof lib_plans;
  "lib/records": typeof lib_records;
  "lib/seal": typeof lib_seal;
  "lib/stripe": typeof lib_stripe;
  "lib/subscription": typeof lib_subscription;
  "lib/vultr": typeof lib_vultr;
  servers: typeof servers;
  uploads: typeof uploads;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
