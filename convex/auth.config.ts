// Tells Convex to accept the session tokens Convex Auth issues. Their issuer
// is this deployment's own site URL.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
