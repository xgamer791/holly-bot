import { defineConfig } from "vitest/config";

// The Convex functions' tests (tests/convex), on convex-test's stand-in for
// the Convex backend. npm run test:convex. The app's own tests use Node's
// test runner instead (npm test).
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["tests/convex/**/*.test.ts"],
  },
});
