import { html, useEffect, useRef, useState } from '../../vendor/preact.js';

// Bot avatars: a colored shape with a two-stroke face whose "eyes" glide between
// expressions. All geometry lives in a 100×100 viewBox.

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
  left: [{ dx: -20, dy: 2, r: -8, s: 1 }, { dx: 0, dy: 2, r: -8, s: 1 }],
  right: [{ dx: 0, dy: 2, r: 8, s: 1 }, { dx: 20, dy: 2, r: 8, s: 1 }],
  up: [{ dx: -10, dy: -10, r: 0, s: 0.95 }, { dx: 10, dy: -10, r: 0, s: 0.95 }],
  happy: [{ dx: -11, dy: -2, r: 38, s: 0.8 }, { dx: 11, dy: -2, r: -38, s: 0.8 }],
  focused: [{ dx: -11, dy: 2, r: -28, s: 0.85 }, { dx: 11, dy: 2, r: 28, s: 0.85 }],
  curious: [{ dx: -9, dy: 0, r: -12, s: 1 }, { dx: 12, dy: -4, r: 0, s: 1.15 }],
  sleepy: [{ dx: -11, dy: 4, r: 90, s: 0.7 }, { dx: 11, dy: 4, r: 90, s: 0.7 }],
  surprised: [{ dx: -11, dy: -3, r: 0, s: 1.25 }, { dx: 11, dy: -3, r: 0, s: 1.25 }],
  wink: [{ dx: -10, dy: 0, r: 0, s: 1 }, { dx: 11, dy: 2, r: 90, s: 0.6 }],
};

const IDLE_CYCLE = ['downLeft', 'neutral', 'upRight', 'curious', 'left', 'happy', 'right', 'neutral'];
const WORK_CYCLE = ['left', 'up', 'right', 'focused', 'upRight', 'downLeft'];
const EYE_HALF = 8.5;

function placeEye(def, eye) {
  const [cx, cy] = def.face;
  const [rx, ry, es] = def.lim || [1, 1, 1];
  return { x: cx + eye.dx * rx, y: cy + eye.dy * ry, r: eye.r, s: eye.s * es };
}

function eyeTransform(def, eye, blink) {
  const p = placeEye(def, eye);
  return `translate(${p.x}px, ${p.y}px) rotate(${p.r}deg) scaleY(${blink ? 0.12 : p.s})`;
}

/**
 * <Avatar shape color size expression live working status />
 * - live: slowly cycles expressions and blinks (use for big / focused avatars)
 * - working: scans around quickly (bot is thinking or using tools)
 * - status: 'online' | 'working' | 'error' | undefined — draws the status dot
 */
export function Avatar({
  shape = 'squircle', color = 'green', size = 40, expression, live = false, working = false,
  status, className = '', title, onClick,
}) {
  const [expr, setExpr] = useState(expression || 'downLeft');
  const [blink, setBlink] = useState(false);
  const idx = useRef(0);

  useEffect(() => {
    if (expression) setExpr(expression);
  }, [expression]);

  useEffect(() => {
    if (!live && !working) return undefined;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const cycle = working ? WORK_CYCLE : IDLE_CYCLE;
    let timer;
    const tick = () => {
      idx.current = (idx.current + 1) % cycle.length;
      if (!expression) setExpr(cycle[idx.current]);
      if (Math.random() < 0.35) {
        setBlink(true);
        setTimeout(() => setBlink(false), 140);
      }
      timer = setTimeout(tick, working ? 650 + Math.random() * 500 : 1700 + Math.random() * 1900);
    };
    timer = setTimeout(tick, working ? 400 : 900);
    return () => clearTimeout(timer);
  }, [live, working, expression]);

  const def = SHAPES[shape] || SHAPES.squircle;
  const eyes = EXPRESSIONS[expr] || EXPRESSIONS.neutral;
  const fill = colorHex(color);
  const dotSize = Math.max(8, Math.round(size * 0.3));

  return html`
    <span class=${`avatar ${working ? 'is-working' : ''} ${className}`} style=${`width:${size}px;height:${size}px`}
      title=${title} onClick=${onClick} role=${onClick ? 'button' : undefined}>
      <svg viewBox="0 0 100 100" width=${size} height=${size} aria-hidden="true">
        <path d=${def.d} fill=${fill} />
        ${eyes.map((eye, i) => html`
          <g key=${i} class="avatar-eye" style=${`transform:${eyeTransform(def, eye, blink)}`}>
            <line x1="0" y1=${-EYE_HALF} x2="0" y2=${EYE_HALF} stroke="#121212" stroke-width="7.2" stroke-linecap="round" />
          </g>`)}
      </svg>
      ${status ? html`<span class=${`avatar-dot dot-${status}`} style=${`width:${dotSize}px;height:${dotSize}px`}></span>` : null}
    </span>`;
}

/** Stacked mini-avatars for group chats. */
export function AvatarStack({ agents, size = 40 }) {
  const shown = agents.slice(0, 3);
  const inner = Math.round(size * (shown.length > 1 ? 0.62 : 1));
  return html`
    <span class="avatar-stack" style=${`width:${size}px;height:${size}px`}>
      ${shown.map((a, i) => html`
        <span key=${a.id} class="avatar-stack-item" style=${stackPos(i, shown.length, size, inner)}>
          <${Avatar} shape=${a.shape} color=${a.color} size=${inner} />
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
