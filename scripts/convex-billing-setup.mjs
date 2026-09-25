// Sets up Stripe, and checks Vultr, for Holly Bot's subscriptions (CONVEX.md),
// from two keys: STRIPE_SECRET_KEY and VULTR_API_KEY. At Stripe it makes what
// the plans need, exactly as convex/lib/plans.ts says: a product per plan with
// its monthly and yearly prices, the webhook, and the billing portal. At Vultr
// it checks the key works and each plan's server size can be had in the
// region. Then it puts the ids, the webhook's signing secret and both keys in
// the deployment's variables, and none of them in the log. Run again, it keeps
// what's right (prices set by hand included) and only makes what's missing or
// wrong. The "Set up Stripe and Vultr" workflow runs it, with CONVEX_DEPLOY_KEY:
//
//   node --experimental-strip-types scripts/convex-billing-setup.mjs

import { spawnSync } from 'node:child_process';
import { PLANS, SERVERS, priceVariable } from '../convex/lib/plans.ts';
import { API_VERSION, call } from '../convex/lib/stripe.ts';

const SITE = 'https://xgamer791.github.io/holly-bot';
/** What convex/billing.ts handles (CONVEX.md, Subscriptions). */
const EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed'];
const INTERVALS = ['month', 'year'];

// ----- the deployment's variables ---------------------------------------------------

function convex(args, input) {
  const r = spawnSync('npx', ['convex', ...args], { input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npx convex ${args[0]} ${args[1]} failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  return r.stdout;
}

function getVar(name) {
  try {
    return convex(['env', 'get', name]).trim();
  } catch {
    return '';
  }
}

/** Sets a variable, the value going in on stdin so it never shows. */
function setVar(name, value) {
  if (getVar(name) === value) return;
  convex(['env', 'set', name], value);
  console.log(`  ${name} set`);
}

// ----- Stripe -------------------------------------------------------------------------

/** A price that's exactly what the plan says (convex/billing.ts checks the same). */
function right(price, plan, every) {
  const recurring = price?.recurring;
  return !!price?.active && price.currency === 'usd' && price.unit_amount === plan.price[every]
    && recurring?.interval === every && (recurring.interval_count ?? 1) === 1 && recurring.usage_type !== 'metered';
}

const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** The plan's price for `every`: the one its variable names if that's right,
 * else the one made here before (by its lookup key), else a new one. */
async function price(key, plan, every, product) {
  const variable = priceVariable(plan.id, every);
  const set = getVar(variable);
  if (set) {
    const current = await call(key, 'GET', `/prices/${set}`).catch(() => null);
    if (right(current, plan, every)) return current;
  }
  const lookup = `holly_bot_${plan.id}_${every}`;
  const [found] = (await call(key, 'GET', '/prices', { lookup_keys: [lookup], active: true, limit: 1 })).data;
  let chosen = right(found, plan, every) ? found : null;
  if (!chosen) {
    // The plan's price changed since (or there's none yet): the new one takes the lookup key.
    chosen = await call(key, 'POST', '/prices', {
      product: product.id,
      currency: 'usd',
      unit_amount: plan.price[every],
      recurring: { interval: every },
      nickname: `${plan.name} ${every === 'year' ? 'yearly' : 'monthly'}`,
      lookup_key: lookup,
      transfer_lookup_key: true,
    });
    console.log(`  Made the price ${chosen.nickname}: ${dollars(plan.price[every])} every ${every}`);
  }
  setVar(variable, chosen.id);
  return chosen;
}

async function setUpStripe(key, deployment) {
  const mode = /_live_/.test(key) ? 'live' : 'test';
  console.log(`\nStripe (${mode} mode)`);

  // A product per plan, with its two prices.
  const products = (await call(key, 'GET', '/products', { active: true, limit: 100 })).data;
  const portalProducts = new Map(); // product id -> its price ids, for plan changes in the portal
  for (const plan of PLANS) {
    let product = products.find((p) => p.metadata?.holly_plan === plan.id);
    if (!product) {
      product = await call(key, 'POST', '/products', {
        name: `Holly Bot ${plan.name}`,
        description: `Holly Bot on a dedicated server with ${plan.cpu} CPU and ${plan.memoryGb} GB RAM.`,
        metadata: { holly_plan: plan.id },
      });
      console.log(`  Made the product ${product.name}`);
    }
    for (const every of INTERVALS) {
      const chosen = await price(key, plan, every, product);
      const productId = typeof chosen.product === 'string' ? chosen.product : chosen.product.id;
      portalProducts.set(productId, [...(portalProducts.get(productId) || []), chosen.id]);
    }
  }
  console.log(`  Prices: ${PLANS.map((p) => `${p.name} ${dollars(p.price.year)} a year or ${dollars(p.price.month)} a month`).join('; ')}`);

  // The webhook. Stripe shows an endpoint's signing secret only when it's
  // made, so one this can't match to the secret the deployment has is made again.
  const url = `https://${deployment}.convex.site/stripe/webhook`;
  const endpoints = (await call(key, 'GET', '/webhook_endpoints', { limit: 100 })).data.filter((e) => e.url === url);
  const known = getVar('STRIPE_WEBHOOK_ENDPOINT');
  const kept = getVar('STRIPE_WEBHOOK_SECRET') && endpoints.find((e) => e.id === known);
  if (kept) {
    await call(key, 'POST', `/webhook_endpoints/${kept.id}`, { enabled_events: EVENTS, disabled: false });
    console.log(`  Webhook: ${url}`);
  } else {
    for (const old of endpoints) await call(key, 'DELETE', `/webhook_endpoints/${old.id}`);
    const made = await call(key, 'POST', '/webhook_endpoints', {
      url,
      enabled_events: EVENTS,
      api_version: API_VERSION,
      description: 'Holly Bot subscriptions',
      metadata: { holly: 'webhook' },
    });
    console.log(`  Made the webhook: ${url}`);
    setVar('STRIPE_WEBHOOK_SECRET', made.secret);
    setVar('STRIPE_WEBHOOK_ENDPOINT', made.id);
  }

  // The billing portal: update the card, see invoices, cancel at the end of
  // the period (as the Terms say), and switch between the plans. Its id goes
  // with each portal session (convex/billing.ts), so it needs no saving in
  // Stripe's dashboard.
  const portal = {
    business_profile: { privacy_policy_url: `${SITE}/privacy.html`, terms_of_service_url: `${SITE}/terms.html` },
    features: {
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        products: [...portalProducts].map(([product, prices]) => ({ product, prices })),
      },
    },
    metadata: { holly: 'portal' },
  };
  const configurations = (await call(key, 'GET', '/billing_portal/configurations', { active: true, limit: 100 })).data;
  const existing = configurations.find((c) => c.metadata?.holly === 'portal');
  const configuration = existing
    ? await call(key, 'POST', `/billing_portal/configurations/${existing.id}`, portal)
    : await call(key, 'POST', '/billing_portal/configurations', portal);
  if (!existing) console.log('  Made the billing portal');
  setVar('STRIPE_PORTAL_CONFIGURATION', configuration.id);
  setVar('STRIPE_SECRET_KEY', key);
  return mode;
}

// ----- Vultr --------------------------------------------------------------------------

async function checkVultr(key) {
  console.log('\nVultr');
  const get = async (path) => {
    const res = await fetch(`https://api.vultr.com/v2${path}`, { headers: { Authorization: `Bearer ${key}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Vultr answered ${res.status}${data.error ? `: ${data.error}` : ''}`);
    return data;
  };
  try {
    await get('/account');
  } catch (err) {
    console.log(`  The key doesn't work: ${err.message}.`);
    console.log('  In Vultr: Account → API, turn the API on, and under Access Control allow all IPv4 and IPv6 addresses');
    console.log("  (Convex doesn't call from fixed ones). Then copy the key into VULTR_API_KEY again.");
    return false;
  }
  console.log('  The key works');
  const { available_plans: available = [] } = await get(`/regions/${SERVERS.region}/availability`);
  for (const plan of PLANS) {
    const ok = available.includes(plan.server);
    console.log(`  ${plan.name}'s server (${plan.server}) in ${SERVERS.region}: ${ok ? 'available' : 'NOT available right now'}`);
  }
  setVar('VULTR_API_KEY', key);
  return true;
}

// ----- run ------------------------------------------------------------------------------

async function main() {
  const deployment = (process.env.CONVEX_DEPLOY_KEY || '').split('|')[0].split(':').pop();
  if (!deployment) throw new Error('CONVEX_DEPLOY_KEY is not set');
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
  const vultrKey = process.env.VULTR_API_KEY?.trim();
  if (!stripeKey && !vultrKey) {
    console.log('Neither STRIPE_SECRET_KEY nor VULTR_API_KEY is a repository secret yet: add them (CONVEX.md, step 5) and run this again.');
    process.exitCode = 1;
    return;
  }
  let mode = null;
  if (stripeKey) mode = await setUpStripe(stripeKey, deployment);
  else console.log('\nStripe: STRIPE_SECRET_KEY is not a repository secret; skipped.');
  let vultrOk = null;
  if (vultrKey) vultrOk = await checkVultr(vultrKey);
  else console.log('\nVultr: VULTR_API_KEY is not a repository secret; skipped.');
  const dryRun = process.env.VULTR_DRY_RUN?.trim();
  if (dryRun) setVar('VULTR_DRY_RUN', dryRun);
  const dry = /^(1|true|yes)$/i.test(dryRun || getVar('VULTR_DRY_RUN'));
  console.log(`\nServers: ${dry ? 'dry run (none are made; VULTR_DRY_RUN is on)' : 'real Vultr servers are made for subscribers'}`);
  if (mode === 'test' && !dry && vultrOk) {
    console.log('  Careful: with a test key, test subscriptions make real (billed) Vultr servers. Add VULTR_DRY_RUN=true to try without.');
  }
  if (stripeKey) console.log('\nDone. Subscribe from Holly Bot with an account that needs a plan, and the test card 4242 4242 4242 4242 in test mode.');
  if (vultrOk === false) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
