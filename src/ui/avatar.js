import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { THINKING_KEYS } from '../core/constants.js';

// Bot avatars: a colored shape with a two-stroke face whose "eyes" glide between
// expressions. All geometry lives in a 100×100 viewBox. While a bot's AI is
// thinking or writing it plays its own thinking animation (body motion + eyes
// + little extras); while it's doing a task (tools: searching, code, the
// computer, other bots) it plays the working animation, the same for every
// bot: a busy rock, eyes on the task and a spinning gear. A `live` one idles:
// it glances around and bobs gently. All of them blink every few seconds.
// With Reduce Motion on, a busy bot fades gently instead of moving and an idle
// one holds still (styles.css); both still blink.

export const SHAPES = {
  circle: { label: 'Circle', d: 'M50 4a46 46 0 1 1 0 92a46 46 0 1 1 0-92Z', face: [50, 52], lim: [1, 1, 1] },
  blob: {
    label: 'Blob',
    d: 'M53 13C81 12 97 30 96 53C95 76 75 89 49 88C23 87 4 75 4 52C5 29 25 14 53 13Z',
    face: [50, 52],
    lim: [1, 0.85, 1],
  },
  squircle: {
    label: 'Squircle',
    d: 'M50 5C83 5 95 17 95 50C95 83 83 95 50 95C17 95 5 83 5 50C5 17 17 5 50 5Z',
    face: [50, 52],
    lim: [1, 1, 1],
  },
  pill: { label: 'Pill', d: 'M28 25H72A25 25 0 0 1 72 75H28A25 25 0 0 1 28 25Z', face: [50, 50], lim: [1, 0.4, 0.75] },
  triangle: {
    label: 'Triangle',
    d: 'M42.2 13.4Q50 1 57.8 13.4L93 75Q99 88 84 88H16Q1 88 7 75Z',
    face: [50, 63],
    lim: [0.7, 0.6, 0.85],
  },
  hexagon: {
    label: 'Hexagon',
    d: 'M44 6.5Q50 3 56 6.5L86 23.8Q92 27.3 92 34.2V65.8Q92 72.7 86 76.2L56 93.5Q50 97 44 93.5L14 76.2Q8 72.7 8 65.8V34.2Q8 27.3 14 23.8Z',
    face: [50, 52],
    lim: [1, 1, 1],
  },
  cloud: {
    label: 'Cloud',
    d: 'M27 82C14 82 5 74 5 63C5 53 12 46 22 45C22 32 33 22 46 23C53 15 67 14 75 23C85 25 92 33 91 43C97 47 99 54 97 62C95 74 86 82 74 82C68 88 58 89 50 84C43 88 33 88 27 82Z',
    face: [51, 56],
    lim: [1, 0.75, 1],
  },
  drop: {
    label: 'Drop',
    d: 'M53 5C60 17 83 40 83 62C83 81 69 95 50 95C31 95 17 81 17 62C17 42 42 20 53 5Z',
    face: [50, 64],
    lim: [0.8, 0.75, 0.9],
  },
};

export const SHAPE_KEYS = Object.keys(SHAPES);

export const COLORS = {
  white: '#FFFFFF',
  brown: '#98673C',
  red: '#FF2D42',
  vermilion: '#FF6308',
  orange: '#FF9A00',
  green: '#00C972',
  teal: '#00BBA8',
  blue: '#1482FF',
  purple: '#8F57FF',
  pink: '#FF36A6',
  gray: '#7B7B7B',
};

export const COLOR_KEYS = Object.keys(COLORS);

export function colorHex(key) {
  return COLORS[key] || (typeof key === 'string' && key.startsWith('#') ? key : COLORS.green);
}

// Each eye: offset (dx, dy) from the face center, rotation in degrees (0 = vertical),
// and length scale. Left eye first.
export const EXPRESSIONS = {
  neutral: [{ dx: -10, dy: 0, r: 0, s: 1 }, { dx: 10, dy: 0, r: 0, s: 1 }],
  downLeft: [{ dx: -22, dy: 13, r: -18, s: 1 }, { dx: 2, dy: 8, r: -18, s: 1 }],
  upRight: [{ dx: -5, dy: 1, r: 16, s: 1 }, { dx: 18, dy: -2, r: -43, s: 0.95 }],
  // downLeft turned 180°: the same glance, up and to the right.
  lookUpRight: [{ dx: -2, dy: -8, r: -18, s: 1 }, { dx: 22, dy: -13, r: -18, s: 1 }],
  left: [{ dx: -20, dy: 2, r: -8, s: 1 }, { dx: 0, dy: 2, r: -8, s: 1 }],
  right: [{ dx: 0, dy: 2, r: 8, s: 1 }, { dx: 20, dy: 2, r: 8, s: 1 }],
  up: [{ dx: -10, dy: -10, r: 0, s: 0.95 }, { dx: 10, dy: -10, r: 0, s: 0.95 }],
  down: [{ dx: -10, dy: 9, r: 0, s: 0.9 }, { dx: 10, dy: 9, r: 0, s: 0.9 }],
  happy: [{ dx: -11, dy: -2, r: 38, s: 0.8 }, { dx: 11, dy: -2, r: -38, s: 0.8 }],
  focused: [{ dx: -11, dy: 2, r: -28, s: 0.85 }, { dx: 11, dy: 2, r: 28, s: 0.85 }],
  curious: [{ dx: -9, dy: 0, r: -12, s: 1 }, { dx: 12, dy: -4, r: 0, s: 1.15 }],
  sleepy: [{ dx: -11, dy: 4, r: 90, s: 0.7 }, { dx: 11, dy: 4, r: 90, s: 0.7 }],
  surprised: [{ dx: -11, dy: -3, r: 0, s: 1.25 }, { dx: 11, dy: -3, r: 0, s: 1.25 }],
  wink: [{ dx: -10, dy: 0, r: 0, s: 1 }, { dx: 11, dy: 2, r: 90, s: 0.6 }],
};

const IDLE_CYCLE = ['downLeft', 'neutral', 'upRight', 'curious', 'left', 'happy', 'right', 'neutral'];
const EYE_HALF = 8.5;

// Thinking styles: `eyes(t)` picks the expression t ms into the animation (so the
// eyes stay in step with the CSS body motion in styles.css → .think-*).
const cycle = (list, ms) => (t) => list[Math.floor(t / ms) % list.length];
export const THINKING = {
  ponder: { label: 'Ponder', eyes: cycle(['upRight', 'upRight', 'curious', 'up'], 1100) },
  hop: { label: 'Hop', eyes: cycle(['happy', 'focused'], 450) },
  jelly: { label: 'Jelly', eyes: cycle(['surprised', 'curious', 'happy'], 650) },
  orbit: { label: 'Orbit', eyes: (t) => ['up', 'right', 'down', 'left'][Math.floor(((t % 2400) + 300) / 600) % 4] },
  scan: { label: 'Scan', eyes: cycle(['left', 'right'], 420) },
  sparkle: { label: 'Sparkle', eyes: cycle(['happy', 'up', 'wink', 'happy'], 800) },
  float: { label: 'Float', eyes: cycle(['up', 'neutral', 'upRight', 'neutral'], 1000) },
  nod: { label: 'Nod', eyes: cycle(['focused', 'down'], 400) },
  twirl: { label: 'Twirl', eyes: (t) => (t % 2200 < 800 ? 'surprised' : 'happy') },
};

/** Doing a task: eyes on the work, now and then checking around. */
const WORKING_EYES = cycle(['focused', 'down', 'focused', 'right', 'focused', 'left'], 480);

/** A small eight-toothed gear centered on 0,0. */
const GEAR = (() => {
  const teeth = 8;
  const step = (Math.PI * 2) / teeth;
  const at = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    d += `${i ? 'L' : 'M'}${at(7.4, a - step * 0.3)}L${at(10.5, a - step * 0.16)}L${at(10.5, a + step * 0.16)}L${at(7.4, a + step * 0.3)}`;
  }
  return `${d}Z`;
})();

/**
 * What `agent` is doing right now, for its face: 'thinking' (its AI is
 * thinking or writing), 'working' (doing a task: tools, the computer, another
 * bot), or null. Its run in `threadId` counts first.
 */
export function botActivity(app, agent, threadId) {
  if (!agent) return null;
  const runs = app.runtime.activeRuns().filter((r) => r.agentId === agent.id);
  const run = runs.find((r) => r.threadId === threadId) || runs[0];
  if (!run) return null;
  return run.phase === 'working' ? 'working' : 'thinking';
}

/** The bot's thinking style (older bots get a stable one from their id). */
export function thinkingOf(agent) {
  if (agent?.thinking && THINKING[agent.thinking]) return agent.thinking;
  let h = 0;
  for (const ch of String(agent?.id || agent?.name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return THINKING_KEYS[h % THINKING_KEYS.length];
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function placeEye(def, eye) {
  const [cx, cy] = def.face;
  const [rx, ry, es] = def.lim || [1, 1, 1];
  return { x: cx + eye.dx * rx, y: cy + eye.dy * ry, r: eye.r, s: eye.s * es };
}

function eyeTransform(def, eye, blink) {
  const p = placeEye(def, eye);
  return `translate(${p.x}px, ${p.y}px) rotate(${p.r}deg) scaleY(${blink ? 0.12 : p.s})`;
}

// A four-point sparkle centered on 0,0.
const STAR = 'M0-9C1.4-2.6 2.6-1.4 9 0C2.6 1.4 1.4 2.6 0 9C-1.4 2.6-2.6 1.4-9 0C-2.6-1.4-1.4-2.6 0-9Z';
let clipSeq = 0;

function Extras({ anim, def, clipId }) {
  switch (anim) {
    case 'working':
      return html`<g transform="translate(86 13)"><g class="av-gear">
        <path d=${GEAR} fill="#FFD60A" stroke="#121212" stroke-width="1.8" stroke-linejoin="round" />
        <circle r="2.9" fill="#121212" /></g></g>`;
    case 'ponder':
      return html`<g class="av-extra" fill="#fff" stroke="#121212" stroke-width="2.4">
        <circle class="av-thought" cx="77" cy="16" r="4.2" />
        <circle class="av-thought t2" cx="89" cy="4" r="6" />
        <circle class="av-thought t3" cx="104" cy="-11" r="8.5" /></g>`;
    case 'orbit':
      return html`<g class="av-orbit"><path d=${STAR} transform="translate(50 -8) scale(1.3)" fill="#FFD60A" stroke="#121212" stroke-width="1.6" /></g>`;
    case 'sparkle':
      return html`<g fill="#FFD60A" stroke="#121212" stroke-width="1.4">
        <g transform="translate(4 12) scale(1.35)"><path class="av-star" d=${STAR} /></g>
        <g transform="translate(99 36) scale(1.05)"><path class="av-star s2" d=${STAR} /></g>
        <g transform="translate(88 96) scale(1.2)"><path class="av-star s3" d=${STAR} /></g></g>`;
    case 'float':
      return html`<ellipse class="av-shadow" cx="50" cy="103" rx="27" ry="3.6" />`;
    case 'scan':
      return html`<defs><clipPath id=${clipId}><path d=${def.d} /></clipPath></defs>`;
    default:
      return null;
  }
}

/**
 * <Avatar shape color size expression rest live activity working anim status />
 * - rest: the expression it settles on when it isn't animating (default 'downLeft')
 * - live: idles when not busy: glances around, bobs gently and blinks
 *   (use for big / focused avatars, and the bot above a chat)
 * - activity: 'thinking' plays the bot's thinking animation `anim` (see
 *   THINKING); 'working' plays the working animation (see botActivity)
 * - working: the same as activity="thinking" (for previews of a style)
 * - status: 'online' | 'working' | 'error' | undefined — draws the status dot
 * - eyeColor: for the Holly cloud's white eyes
 */
export function Avatar({
  shape = 'squircle', color = 'green', size = 40, expression, rest = 'downLeft', live = false, working = false,
  activity = null, anim = 'hop', status, className = '', title, onClick, eyeColor = '#121212',
}) {
  const mode = activity === 'working' || activity === 'thinking' ? activity : working ? 'thinking' : null;
  const [expr, setExpr] = useState(expression || rest);
  const [blink, setBlink] = useState(0); // 0 open · 1 shut · 2 opening again
  const idx = useRef(0);
  const clipId = useRef(null);
  const style = THINKING[anim] ? anim : 'hop';
  clipId.current ||= `av-clip-${++clipSeq}`;

  useEffect(() => {
    if (expression) setExpr(expression);
  }, [expression]);

  // Where the eyes look: a slow glance around (live), the bot's thinking
  // style (thinking), or on the task (working). With Reduce Motion they hold
  // still: a thinking or working look while busy, the resting one otherwise.
  useEffect(() => {
    if ((!live && !mode) || expression) {
      if (!expression) setExpr(rest);
      return undefined;
    }
    const busyEyes = mode === 'working' ? WORKING_EYES : mode === 'thinking' ? THINKING[style].eyes : null;
    if (reducedMotion()) {
      setExpr(busyEyes ? busyEyes(0) : rest);
      return undefined;
    }
    let timer;
    if (busyEyes) {
      const start = performance.now();
      const eyes = busyEyes;
      let last = '';
      const tick = () => {
        const next = eyes(performance.now() - start);
        if (next !== last) {
          last = next;
          setExpr(next);
        }
        timer = setTimeout(tick, 90);
      };
      tick();
    } else {
      const tick = () => {
        idx.current = (idx.current + 1) % IDLE_CYCLE.length;
        setExpr(IDLE_CYCLE[idx.current]);
        timer = setTimeout(tick, 1700 + Math.random() * 1900);
      };
      timer = setTimeout(tick, 900);
    }
    return () => clearTimeout(timer);
  }, [live, mode, expression, style, rest]);

  // Blinking, while animated: every two to five and a half seconds, now and
  // then twice. The eyes shut and open quickly (the .blinking class), then
  // go back to gliding.
  useEffect(() => {
    if ((!live && !mode) || expression) return undefined;
    let timer;
    const at = (ms, fn) => {
      timer = setTimeout(fn, ms);
    };
    const blinkThen = (next) => {
      setBlink(1);
      at(110, () => {
        setBlink(2);
        at(120, () => {
          setBlink(0);
          next();
        });
      });
    };
    const wait = () => at(2000 + Math.random() * 3500, () => blinkThen(() => (Math.random() < 0.2 ? at(90, () => blinkThen(wait)) : wait())));
    wait();
    return () => {
      clearTimeout(timer);
      setBlink(0);
    };
  }, [live, mode, expression]);

  const def = SHAPES[shape] || SHAPES.squircle;
  const eyes = EXPRESSIONS[expr] || EXPRESSIONS.neutral;
  const shut = blink === 1 && expr !== 'wink' && expr !== 'sleepy';
  const fill = colorHex(color);
  const dotSize = Math.max(8, Math.round(size * 0.3));
  const idle = live && !mode && !expression;
  const busyClass = mode === 'thinking' ? `is-thinking think-${style}` : mode === 'working' ? 'is-working' : '';
  const cls = `avatar ${busyClass} ${idle ? 'is-live' : ''} ${blink ? 'blinking' : ''} ${className}`;

  return html`
    <span class=${cls} style=${`width:${size}px;height:${size}px`}
      title=${title} onClick=${onClick} role=${onClick ? 'button' : undefined}>
      <svg viewBox="0 0 100 100" width=${size} height=${size} aria-hidden="true">
        <g class="av-body">
          <path d=${def.d} fill=${fill} />
          ${mode === 'thinking' && style === 'scan' && html`<g clip-path=${`url(#${clipId.current})`}><rect class="av-shine" x="0" y="-20" width="26" height="140" fill="#fff" opacity=".38" /></g>`}
          ${eyes.map((eye, i) => html`
            <g key=${i} class="avatar-eye" style=${`transform:${eyeTransform(def, eye, shut)}`}>
              <line x1="0" y1=${-EYE_HALF} x2="0" y2=${EYE_HALF} stroke=${eyeColor} stroke-width="7.2" stroke-linecap="round" />
            </g>`)}
        </g>
        ${mode && html`<${Extras} anim=${mode === 'working' ? 'working' : style} def=${def} clipId=${clipId.current} />`}
      </svg>
      ${status ? html`<span class=${`avatar-dot dot-${status}`} style=${`width:${dotSize}px;height:${dotSize}px`}></span>` : null}
    </span>`;
}

/** Stacked mini-avatars for group chats; `activityOf(agent)` animates the
 * busy ones (see botActivity), and `live` makes the rest idle (see Avatar). */
export function AvatarStack({ agents, size = 40, rest, activityOf, live = false }) {
  const shown = agents.slice(0, 3);
  const inner = Math.round(size * (shown.length > 1 ? 0.62 : 1));
  return html`
    <span class="avatar-stack" style=${`width:${size}px;height:${size}px`}>
      ${shown.map((a, i) => html`
        <span key=${a.id} class="avatar-stack-item" style=${stackPos(i, shown.length, size, inner)}>
          <${Avatar} shape=${a.shape} color=${a.color} size=${inner} rest=${rest} live=${live} activity=${activityOf?.(a) || null} anim=${thinkingOf(a)} />
        </span>`)}
    </span>`;
}

function stackPos(i, n, size, inner) {
  if (n === 1) return 'left:0;top:0';
  if (n === 2) return i === 0 ? 'left:0;top:0' : `left:${size - inner}px;top:${size - inner}px`;
  const pos = [[0, size - inner], [(size - inner) / 2, 0], [size - inner, size - inner]][i];
  return `left:${pos[0]}px;top:${pos[1]}px`;
}

/** Static SVG markup (string) for favicons / notifications. */
export function avatarSvgString({ shape = 'squircle', color = 'green', expression = 'downLeft' } = {}) {
  const def = SHAPES[shape] || SHAPES.squircle;
  const eyes = (EXPRESSIONS[expression] || EXPRESSIONS.neutral).map((raw) => {
    const e = placeEye(def, raw);
    const rad = (e.r * Math.PI) / 180;
    const hx = Math.sin(rad) * EYE_HALF * e.s;
    const hy = Math.cos(rad) * EYE_HALF * e.s;
    const { x, y } = e;
    return `<line x1="${(x - hx).toFixed(2)}" y1="${(y + hy).toFixed(2)}" x2="${(x + hx).toFixed(2)}" y2="${(y - hy).toFixed(2)}" stroke="#121212" stroke-width="7.2" stroke-linecap="round"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${def.d}" fill="${colorHex(color)}"/>${eyes}</svg>`;
}
