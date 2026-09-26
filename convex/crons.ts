import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily("sweep unclaimed uploads", { hourUTC: 9, minuteUTC: 17 }, internal.uploads.sweep, {});
crons.hourly("sweep unfinished connections", { minuteUTC: 41 }, internal.connectors.sweep, {});
crons.hourly("sweep expired credit holds", { minuteUTC: 23 }, internal.credits.sweepHolds, {});
// Subscribers' servers against Vultr's list (convex/servers.ts), at night in the US.
crons.daily("reconcile servers", { hourUTC: 8, minuteUTC: 7 }, internal.servers.reconcile, {});
crons.daily("sweep handled Stripe events", { hourUTC: 9, minuteUTC: 37 }, internal.billing.sweepEvents, {});

export default crons;
