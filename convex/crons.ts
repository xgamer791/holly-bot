import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily("sweep unclaimed uploads", { hourUTC: 9, minuteUTC: 17 }, internal.uploads.sweep, {});

export default crons;
