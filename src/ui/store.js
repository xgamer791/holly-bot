import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { useApp, useUi, useTopics } from './hooks.js';
import { Sheet, Spinner, Toggle } from './components.js';
import { Markdown } from './markdown.js';
import { Avatar, COLORS } from './avatar.js';
import { Icon } from './icons.js';
import { LookPicker } from './create-bot.js';
import { money } from './subscribe.js';
import { account, signInWorksHere, SITE } from '../account/account.js';
import { STORE_CHARS, STORE_WORDS, wordCount } from '../core/brief.js';
import { dateText, mark, number, tr, trn } from './i18n.js';

// The Bot Store (Settings → Bot Store): pre-trained bots, bought once, in the
// manner of Apple's App Store: a large title, the featured bots on big cards,
// the rest by kind, and each on a page of its own. Tapping a price turns it
// into Buy, and Buy goes to Stripe Checkout (convex/store.ts checkout), where
// a saved card, Apple Pay or Google Pay pays in a tap. Back here, the
// purchase is claimed and the bot joins the user's bots straight away, its
// chat open (install). A bought bot shows Open, or Get when it isn't among
// their bots any more (it comes back as it was, free). Its pre-trained
// memory is kept apart, on Holli Bot's server (src/core/brief.js); its rules
// come with it, and its Bot Memory is the user's to fill, 10,000 words of it.
// None of that is on the store's pages, which say what a bot does for you:
// its page is an article, the owner's text in Markdown (BotPage).
// The store's owner adds, changes and hides bots here too (Manage).

const CATEGORIES = {
  productivity: { name: mark('Productivity'), icon: Icon.zap },
  business: { name: mark('Business'), icon: Icon.briefcase },
  money: { name: mark('Money'), icon: Icon.dollar },
  health: { name: mark('Health & Fitness'), icon: Icon.heart },
  food: { name: mark('Food & Drink'), icon: Icon.utensils },
  travel: { name: mark('Travel'), icon: Icon.plane },
  learning: { name: mark('Education'), icon: Icon.brain },
  creative: { name: mark('Writing & Creative'), icon: Icon.edit },
  developer: { name: mark('Developer Tools'), icon: Icon.code },
  home: { name: mark('Home & Family'), icon: Icon.home },
};
const categoryName = (id) => (CATEGORIES[id] ? tr(CATEGORIES[id].name) : id);

/** How long a bot's about can be: words, and characters (convex/lib/store.ts
 * LIMITS.aboutWords and aboutChars). */
const ABOUT_WORDS = 8000;
const ABOUT_CHARS = 80000;

/** How long a price stays turned into Buy, untouched. */
const ARMED_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server's message for a call it turned down, or `fallback`. */
function serverSays(err, fallback) {
  if (typeof err?.data === 'string') return tr(err.data);
  if (err?.name === 'TypeError') return tr("Couldn't reach Holli Bot's server. Check your connection and try again.");
  return fallback;
}

/** Where Stripe sends people back to: this page, which the server checks
 * against the places Holli Bot may return to (convex/auth.ts). */
const here = () => `${location.origin}${location.pathname}`;

/** `hex` blended toward `to` by `t` (0 to 1), as rgb(). */
function mix(hex, to, t) {
  const a = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}

/** A bot's color as the store's backgrounds: a gradient that a white bot
 * stands out on (`deep`: darker, for the big cards). A white bot's is graphite. */
function tint(color, deep = false) {
  if (color === 'white' || !COLORS[color]) return deep ? 'linear-gradient(150deg,#55555c 0%,#2a2a2e 60%,#141416 100%)' : 'linear-gradient(160deg,#5a5a60 0%,#38383c 55%,#1f1f22 100%)';
  const c = COLORS[color];
  return deep
    ? `linear-gradient(150deg,${mix(c, '#ffffff', 0.1)} 0%,${mix(c, '#000000', 0.2)} 58%,${mix(c, '#000000', 0.45)} 100%)`
    : `linear-gradient(160deg,${mix(c, '#ffffff', 0.24)} 0%,${c} 52%,${mix(c, '#000000', 0.26)} 100%)`;
}

/** A bot as an app icon: a white bot on its color, in a rounded square. */
export function BotTile({ bot, size = 64, live = false }) {
  return html`<span class="sb-tile" style=${`width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.225)}px;background:${tint(bot.color)}`}>
    <${Avatar} shape=${bot.shape} color="white" size=${Math.round(size * 0.64)} live=${live} anim=${bot.thinking || 'hop'} />
  </span>`;
}

/** A name for the new bot that none of the user's bots has: `name`, or `name 2`… */
function freeName(app, name) {
  const taken = new Set(app.listAgents().map((a) => a.name.trim().toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const next = `${name.slice(0, 40 - String(n).length - 1)} ${n}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

/**
 * The Bot Store. `purchase`: back from Stripe Checkout ({ bot, session,
 * cancelled }, src/main.js takeStoreReturn): it opens on that bot and, when
 * it's paid for, adds it to the user's bots.
 */
export function StoreSheet({ onClose, purchase }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['agents']);
  const signedIn = signInWorksHere() && account.signedIn;
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(null);
  const [stack, setStack] = useState(() => (purchase?.bot ? [{ page: 'bot', id: purchase.bot }] : []));
  const [busy, setBusy] = useState(null);
  const [armed, setArmed] = useState(null);
  const armTimer = useRef(0);
  const top = stack[stack.length - 1];
  const go = (page, extra = {}) => {
    setArmed(null);
    setStack((s) => [...s, { page, ...extra }]);
  };
  const back = () => {
    setArmed(null);
    setStack((s) => s.slice(0, -1));
  };

  const load = async () => {
    try {
      setData(await account.authed('query', 'store:catalog'));
      setFailed(null);
    } catch (err) {
      console.warn('store', err);
      setFailed(serverSays(err, tr("Couldn't open the Bot Store. Please try again.")));
    }
  };
  useEffect(() => {
    if (!signedIn) return undefined;
    load();
    if (purchase?.session) finishPurchase(purchase);
    // The back button can bring this page back just as it was left for Stripe.
    const onShow = (e) => e.persisted && setBusy(null);
    addEventListener('pageshow', onShow);
    return () => {
      removeEventListener('pageshow', onShow);
      clearTimeout(armTimer.current);
    };
  }, []);

  /** The user's bot made from store bot `id`, if they have it. */
  const installed = (id) => app.listAgents().find((a) => a.store?.id === id) || null;
  const owned = (id) => !!data?.owned?.includes(id);

  const openChat = (agent) => {
    ui.closeAll();
    ui.navigate(`#/chat/dm_${agent.id}`);
  };

  /** Adds bought bot `id` to the user's bots (its look and rules; its
   * pre-trained memory stays on the server), and opens its chat. */
  const install = async (id) => {
    const have = installed(id);
    if (have) return openChat(have);
    setBusy(id);
    try {
      const bot = await account.authed('query', 'store:install', { bot: id });
      const tag = { id: bot.id, name: bot.name, tagline: bot.tagline };
      let agent = await app.createAgent({ name: freeName(app, bot.name), shape: bot.shape, color: bot.color, thinking: bot.thinking, rules: bot.rules, store: tag });
      // An older Holli Bot Computer makes it without its tag: it gets it now.
      if (agent?.id && !agent.store) agent = (await app.updateAgent(agent.id, { store: tag })) || agent;
      ui.toast(tr('{name} is ready.', { name: agent.name }));
      openChat(agent);
    } catch (err) {
      console.warn('store install', err);
      ui.toast(serverSays(err, tr("Couldn't add that bot. Please try again.")), { error: true });
    } finally {
      setBusy(null);
    }
    return null;
  };

  /** Back from paying: Stripe's word can take a moment, so it's asked a few times. */
  const finishPurchase = async ({ session, bot }) => {
    setBusy(bot || true);
    for (let attempt = 0; ; attempt++) {
      try {
        const done = await account.authed('action', 'store:claim', { session });
        await load();
        await install(done.bot);
        return;
      } catch (err) {
        if (attempt >= 3) {
          setBusy(null);
          ui.toast(serverSays(err, tr("Couldn't finish your purchase. If you paid, your bot is waiting in the Bot Store.")), { error: true });
          load();
          return;
        }
        await sleep(2500);
      }
    }
  };

  /** A price, tapped: first it turns into Buy, and Buy goes to Stripe Checkout. */
  const buy = async (bot) => {
    if (busy) return;
    clearTimeout(armTimer.current);
    if (armed !== bot.id) {
      setArmed(bot.id);
      armTimer.current = setTimeout(() => setArmed(null), ARMED_MS);
      return;
    }
    setArmed(null);
    setBusy(bot.id);
    try {
      const res = await account.authed('action', 'store:checkout', { bot: bot.id, returnTo: here() });
      if (res.url) return location.assign(res.url);
      await load();
      setBusy(null);
      return install(bot.id);
    } catch (err) {
      console.warn('store checkout', err);
      setBusy(null);
      ui.toast(serverSays(err, tr("Couldn't start checkout. Please try again.")), { error: true });
    }
    return null;
  };

  /** What a bot's button does: open it, get it again, or buy it. */
  const act = (bot) => {
    const have = installed(bot.id);
    if (have) return openChat(have);
    if (owned(bot.id)) return install(bot.id);
    return buy(bot);
  };

  const store = { data, busy, armed, installed, owned, act, go, back, install, reload: load };
  const pages = { bot: BotPage, manage: ManagePage, edit: EditPage };
  const Page = (top && pages[top.page]) || StoreHome;
  const backButton = html`<button class="circle-btn" aria-label=${tr('Back')} onClick=${back}><${Icon.back} /></button>`;
  const manage = !top && data?.admin && html`<button class="sb-head-link" onClick=${() => go('manage')}>${tr('Manage')}</button>`;
  const titles = { manage: tr('Manage Bots'), edit: top?.id ? tr('Edit Bot') : tr('New Bot') };

  let body;
  if (!signedIn) {
    body = html`<div class="sb-empty"><${BotTile} bot=${{ shape: 'cloud', color: 'blue' }} size=${76} />
      <p>${tr('Sign in to Holli Bot at {site} to use the Bot Store.', { site: SITE.replace(/^https:\/\//, '') })}</p></div>`;
  } else if (failed && !data) {
    body = html`<div class="sb-empty"><p>${failed}</p><button class="btn" onClick=${load}>${tr('Try Again')}</button></div>`;
  } else if (!data) {
    body = html`<div class="sb-empty"><${Spinner} /></div>`;
  } else {
    body = html`<${Page} store=${store} ...${top || {}} />`;
  }
  return html`<${Sheet} className="store" title=${titles[top?.page] || ''} left=${top ? backButton : null} right=${manage} onClose=${onClose}>
    ${body}
  <//>`;
}

/** A bot's button, as in the App Store: its price (which turns into Buy),
 * Get (bought, not among the user's bots now) or Open. */
function GetButton({ store, bot, big = false, onCard = false }) {
  const have = store.installed(bot.id);
  const mine = store.owned(bot.id);
  const busy = store.busy === bot.id;
  const armed = store.armed === bot.id && !have && !mine;
  const cls = `sb-get${big ? ' big' : ''}${armed ? ' buy' : ''}${onCard ? ' on-card' : ''}`;
  const label = have ? tr('Open') : mine ? tr('Get') : armed ? tr('Buy') : money(bot.price);
  const aria = have ? tr('Open {name}', { name: bot.name })
    : mine ? tr('Get {name} again', { name: bot.name })
      : armed ? tr('Buy {name} for {price}', { name: bot.name, price: money(bot.price) })
        : tr('{name}, {price}', { name: bot.name, price: money(bot.price) });
  return html`<button class=${cls} aria-label=${aria} disabled=${!!store.busy && !busy} onClick=${(e) => {
    e.stopPropagation();
    if (!busy) store.act(bot);
  }}>${busy ? html`<span class="spinner"></span>` : mine && !have ? html`<${Icon.download} size="17" sw="2.4" />` : label}</button>`;
}

/** The store's front page: the featured bots on big cards, then every bot, by kind. */
function StoreHome({ store }) {
  const { data } = store;
  const [kind, setKind] = useState('');
  const featured = data.bots.filter((b) => b.featured);
  const kinds = data.categories.filter((c) => data.bots.some((b) => b.category === c));
  const shown = data.bots.filter((b) => !kind || b.category === kind);
  const today = dateText(Date.now(), { weekday: 'long', month: 'long', day: 'numeric' });
  return html`
    <div class="sb-top">
      <div class="sb-date">${today}</div>
      <h1 class="sb-title">${tr('Bot Store')}</h1>
      <p class="sb-lead">${tr('Bots that already know their job, ready to help from your first chat.')}</p>
    </div>
    ${featured.length > 0 && html`<div class="sb-cards" role="list">
      ${featured.map((bot) => html`
        <div key=${bot.id} role="listitem" class="sb-card" style=${`background:${tint(bot.color, true)}`} onClick=${() => store.go('bot', { id: bot.id })}>
          <div class="sb-card-text">
            <div class="sb-eyebrow">${categoryName(bot.category)}</div>
            <div class="sb-card-name">${bot.name}</div>
            <div class="sb-card-tag">${bot.tagline}</div>
          </div>
          <div class="sb-card-art"><${Avatar} shape=${bot.shape} color="white" size=${118} live anim=${bot.thinking || 'hop'} /></div>
          <div class="sb-card-foot">
            <span>${tr('Pre-trained · One-time purchase')}</span>
            <${GetButton} store=${store} bot=${bot} onCard />
          </div>
        </div>`)}
    </div>`}
    ${kinds.length > 1 && html`<div class="sb-chips" role="tablist">
      <button role="tab" aria-selected=${!kind} class=${`sb-chip ${!kind ? 'on' : ''}`} onClick=${() => setKind('')}>${tr('All')}</button>
      ${kinds.map((c) => html`<button key=${c} role="tab" aria-selected=${kind === c} class=${`sb-chip ${kind === c ? 'on' : ''}`} onClick=${() => setKind(c)}>${categoryName(c)}</button>`)}
    </div>`}
    <h2 class="sb-h2">${kind ? categoryName(kind) : tr('All Bots')}</h2>
    <div class="sb-list">
      ${shown.map((bot) => html`
        <div key=${bot.id} class="sb-row" onClick=${() => store.go('bot', { id: bot.id })}>
          <${BotTile} bot=${bot} size=${64} />
          <div class="meta">
            <div class="n">${bot.name}</div>
            <div class="d">${bot.tagline}</div>
            <div class="c">${categoryName(bot.category)}</div>
          </div>
          <${GetButton} store=${store} bot=${bot} />
        </div>`)}
    </div>
    <p class="sb-foot">${tr('Bots from the Bot Store are yours to keep: buy one once, and get it again free on any device you sign in on. Chatting with it uses your plan\'s AI credits, like any bot.')}</p>`;
}

/** A bot's color for the accents of its page: its dots, and (`deep`) the
 * fills with white on them, its steps and the messages you'd send it. */
function accents(color) {
  const dot = color === 'white' || !COLORS[color] ? '#8e8e93' : COLORS[color];
  return `--bot:${dot};--bot-deep:${tint(color, true)}`;
}

/** A bot's page, as in the App Store: its icon and price, a strip of facts
 * and what it can do at a glance, then its story: the owner's text (about),
 * in Markdown, as an article in the bot's own color. Its first paragraph
 * leads, `##` starts a section, `-` lists, `1.` steps, and each `>` line is
 * something to say to it, drawn as a message you'd send. */
function BotPage({ store, id }) {
  const { data } = store;
  const bot = data.bots.find((b) => b.id === id);
  if (!bot) {
    return html`<div class="sb-empty"><p>${tr("That bot isn't in the Bot Store any more.")}</p>
      ${store.owned(id) && html`<button class="btn primary" onClick=${() => store.install(id)}>${tr('Get')}</button>`}</div>`;
  }
  const Kind = CATEGORIES[bot.category]?.icon || Icon.bot;
  const have = store.installed(bot.id);
  return html`
    <div class="sb-hero">
      <${BotTile} bot=${bot} size=${118} live />
      <div class="sb-hero-text">
        <h1>${bot.name}</h1>
        <p>${bot.tagline}</p>
        <div class="sb-hero-buy">
          <${GetButton} store=${store} bot=${bot} big />
          ${!have && !store.owned(bot.id) && html`<span class="sb-once">${tr('One-time purchase')}</span>`}
        </div>
      </div>
    </div>
    <div class="sb-facts">
      <div class="sb-fact"><span class="k">${tr('Category')}</span><span class="v"><${Kind} size="22" /></span><span class="s">${categoryName(bot.category)}</span></div>
      <div class="sb-fact"><span class="k">${tr('Price')}</span><span class="v">${money(bot.price)}</span><span class="s">${tr('one time')}</span></div>
      <div class="sb-fact"><span class="k">${tr('Seller')}</span><span class="v"><${Icon.bot} size="22" /></span><span class="s">Holli Bot</span></div>
      <div class="sb-fact"><span class="k">${tr('Works with')}</span><span class="v"><${Icon.users} size="22" /></span><span class="s">${tr('your bots')}</span></div>
    </div>
    ${bot.highlights.length > 0 && html`
      <h2 class="sb-h2">${tr('What it can do')}</h2>
      <ul class="sb-checks">${bot.highlights.map((h) => html`<li key=${h}><${Icon.check} size="18" sw="2.6" /><span>${h}</span></li>`)}</ul>`}
    ${bot.about && html`<article class="sb-story" style=${accents(bot.color)}><${Markdown} text=${bot.about} className="sb-article" /></article>`}
    <h2 class="sb-h2">${tr('Information')}</h2>
    <dl class="sb-info">
      <div><dt>${tr('Seller')}</dt><dd>Holli Bot</dd></div>
      <div><dt>${tr('Category')}</dt><dd>${categoryName(bot.category)}</dd></div>
      <div><dt>${tr('Price')}</dt><dd>${tr('{price}, one time', { price: money(bot.price) })}</dd></div>
    </dl>
    ${data.admin && !have && !store.owned(bot.id) && html`
      <button class="btn block sb-owner" disabled=${!!store.busy} onClick=${() => store.install(bot.id)}>${tr('Add to my bots free (owner)')}</button>`}`;
}

/** For the store's owner: their bots, listed or hidden, with what each has sold. */
function ManagePage({ store }) {
  const ui = useUi();
  const [list, setList] = useState(null);
  useEffect(() => {
    account.authed('query', 'store:manage').then(setList).catch((err) => {
      ui.toast(serverSays(err, tr("Couldn't load the store's bots.")), { error: true });
      setList({ bots: [], categories: [] });
    });
  }, []);
  if (!list) return html`<div class="sb-empty"><${Spinner} /></div>`;
  return html`
    <button class="btn primary block" style="margin:6px 0 4px" onClick=${() => store.go('edit', { list })}><${Icon.plus} size="18" /> ${tr('New Bot')}</button>
    ${store.data.samples && html`<p class="sb-note">${tr('The sample bots are in the store until you list a bot of your own. Keep new bots hidden until you\'re ready: listing the first one takes the samples down.')}</p>`}
    ${list.bots.length > 0 ? html`<div class="sb-list small">
      ${list.bots.map((bot) => html`
        <div key=${bot.id} class="sb-row" onClick=${() => store.go('edit', { id: bot.id, list })}>
          <${BotTile} bot=${bot} size=${48} />
          <div class="meta">
            <div class="n">${bot.name}</div>
            <div class="d">${[bot.listed ? tr('Listed') : tr('Hidden'), bot.featured && tr('Featured'), money(bot.price), trn(bot.sold, '{n} sold', '{n} sold')].filter(Boolean).join(' · ')}</div>
          </div>
          <${Icon.chevron} class="chev" />
        </div>`)}
    </div>` : html`<p class="sb-note">${tr('You haven\'t added a bot yet.')}</p>`}`;
}

const BLANK = { name: '', tagline: '', about: '', category: 'productivity', shape: 'squircle', color: 'blue', thinking: 'hop', price: 1000, highlights: [], memory: '', rules: '', featured: false, listed: false };

/** For the store's owner: a bot, all of it, to add or change. */
function EditPage({ store, id, list }) {
  const ui = useUi();
  const found = id && list?.bots.find((b) => b.id === id);
  const [bot, setBot] = useState(() => ({ ...BLANK, ...(found || {}) }));
  const [dollars, setDollars] = useState(() => String((found?.price || BLANK.price) / 100));
  const [lines, setLines] = useState(() => (found?.highlights || []).join('\n'));
  const [saving, setSaving] = useState(false);
  const set = (patch) => setBot((b) => ({ ...b, ...patch }));
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const { id: _id, sold, ...rest } = bot;
    const input = { ...rest, price: Math.round(Number(dollars) * 100), highlights: lines.split('\n').map((l) => l.trim()).filter(Boolean) };
    try {
      await account.authed('mutation', 'store:save', { ...(id ? { id } : {}), bot: input });
      ui.toast(bot.listed ? tr('{name} is in the Bot Store.', { name: bot.name.trim() }) : tr('{name} is saved, hidden from the store.', { name: bot.name.trim() }));
      await store.reload();
      store.back();
    } catch (err) {
      ui.toast(serverSays(err, tr("Couldn't save that bot. Please try again.")), { error: true });
      setSaving(false);
    }
  };
  const count = (text, max = STORE_WORDS) => {
    const words = wordCount(text);
    return html`<span class=${`sb-count ${words > max ? 'full' : ''}`}>${tr('{count} / {max} words', { count: number(words), max: number(max) })}</span>`;
  };
  return html`
    <div class="sb-edit-preview"><${BotTile} bot=${bot} size=${96} live /></div>
    <${LookPicker} shape=${bot.shape} color=${bot.color} thinking=${bot.thinking} onShape=${(shape) => set({ shape })} onColor=${(color) => set({ color })} onThinking=${(thinking) => set({ thinking })} />
    <div class="field"><label>${tr('Name')}</label>
      <input class="input" maxlength="40" value=${bot.name} placeholder=${tr('e.g. Chef Remy')} onInput=${(e) => set({ name: e.currentTarget.value })} /></div>
    <div class="field"><label>${tr('Tagline')}</label>
      <input class="input" maxlength="80" value=${bot.tagline} placeholder=${tr('What it does, in a line')} onInput=${(e) => set({ tagline: e.currentTarget.value })} /></div>
    <div class="field"><label>${tr('Category')}</label>
      <select class="select" value=${bot.category} onChange=${(e) => set({ category: e.currentTarget.value })}>
        ${(list?.categories || Object.keys(CATEGORIES)).map((c) => html`<option key=${c} value=${c}>${categoryName(c)}</option>`)}
      </select></div>
    <div class="field"><label>${tr('Price (US dollars)')}</label>
      <input class="input" type="number" inputmode="decimal" min="10" step="1" value=${dollars} onInput=${(e) => setDollars(e.currentTarget.value)} />
      <div class="hint">${tr('At least $10. Buyers pay once.')}</div></div>
    <div class="field"><label>${tr('About')}</label>
      <textarea class="textarea sb-long" maxlength=${ABOUT_CHARS} value=${bot.about} placeholder=${tr('What it does for people and how, for its page in the store: about 1,000 words works well')} onInput=${(e) => set({ about: e.currentTarget.value })}></textarea>
      <div class="hint sb-hint-row"><span>${tr('Its page shows it as an article. The first paragraph leads; ## starts a section, - a list, 1. a step, > something to say to it, and **bold** is bold.')}</span>${count(bot.about, ABOUT_WORDS)}</div></div>
    <div class="field"><label>${tr('What it can do')}</label>
      <textarea class="textarea" value=${lines} placeholder=${tr('One a line, up to 6')} onInput=${(e) => setLines(e.currentTarget.value)}></textarea></div>
    <div class="field"><label>${tr('Pre-trained memory')}</label>
      <textarea class="textarea sb-long" maxlength=${STORE_CHARS} value=${bot.memory} placeholder=${tr('What it knows and does, written to it: its job, how it works, what it should know')} onInput=${(e) => set({ memory: e.currentTarget.value })}></textarea>
      <div class="hint sb-hint-row"><span>${tr('Private, and kept apart from its Bot Memory: buyers never see it, and can\'t change it.')}</span>${count(bot.memory)}</div></div>
    <div class="field"><label>${tr('Rules')}</label>
      <textarea class="textarea" maxlength=${STORE_CHARS} value=${bot.rules} placeholder=${tr('Hard rules it comes with (optional), one a line')} onInput=${(e) => set({ rules: e.currentTarget.value })}></textarea>
      <div class="hint sb-hint-row"><span>${tr('Buyers get these, and can change them.')}</span>${count(bot.rules)}</div></div>
    <div class="group">
      <div class="row"><div class="label"><div class="t">${tr('In the store')}</div><div class="s">${tr('Off: hidden. Buyers keep it either way.')}</div></div>
        <${Toggle} on=${bot.listed} onChange=${(listed) => set({ listed })} label=${tr('In the store')} /></div>
      <div class="row"><div class="label"><div class="t">${tr('Featured')}</div><div class="s">${tr('On a big card at the top of the store.')}</div></div>
        <${Toggle} on=${bot.featured} onChange=${(featured) => set({ featured })} label=${tr('Featured')} /></div>
    </div>
    <button class="btn primary block big" disabled=${saving} onClick=${save}>${saving ? html`<span class="spinner"></span>` : tr('Save')}</button>`;
}
