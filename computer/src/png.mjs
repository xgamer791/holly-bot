// Tiny image helpers so Holly Bot Computer needs no image libraries: read PNG/JPEG
// sizes, and shrink a PNG screenshot (decode → area-average → encode).

import { inflateSync, deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** { width, height, mime } of a PNG or JPEG buffer, or null. */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 carry the frame size (C4 = DHT, C8 = JPG, CC = DAC are not frames).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), mime: 'image/jpeg' };
      }
      i += 2 + len;
    }
  }
  return null;
}

function unfilter(type, line, prev, cur, bpp) {
  const n = line.length;
  switch (type) {
    case 0:
      line.copy(cur);
      break;
    case 1:
      for (let i = 0; i < n; i++) cur[i] = (line[i] + (i >= bpp ? cur[i - bpp] : 0)) & 255;
      break;
    case 2:
      for (let i = 0; i < n; i++) cur[i] = (line[i] + prev[i]) & 255;
      break;
    case 3:
      for (let i = 0; i < n; i++) cur[i] = (line[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255;
      break;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      break;
    default:
      throw new Error(`Bad PNG filter ${type}`);
  }
}

/** Decode a non-interlaced 8/16-bit PNG into RGB (alpha is dropped: screenshots are opaque). */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let ctype = 2;
  let interlace = 0;
  let palette = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (interlace) throw new Error('Interlaced PNGs are not supported');
  if (depth !== 8 && depth !== 16) throw new Error(`PNG bit depth ${depth} is not supported`);
  const spp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!spp) throw new Error(`PNG color type ${ctype} is not supported`);
  const bps = depth / 8;
  const bpp = spp * bps;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    unfilter(raw[start], raw.subarray(start + 1, start + 1 + stride), prev, cur, bpp);
    let o = y * width * 3;
    for (let x = 0; x < width; x++, o += 3) {
      const i = x * bpp;
      const s0 = cur[i];
      if (ctype === 0 || ctype === 4) {
        out[o] = out[o + 1] = out[o + 2] = s0;
      } else if (ctype === 3) {
        const p = s0 * 3;
        out[o] = palette ? palette[p] : 0;
        out[o + 1] = palette ? palette[p + 1] : 0;
        out[o + 2] = palette ? palette[p + 2] : 0;
      } else {
        out[o] = s0;
        out[o + 1] = cur[i + bps];
        out[o + 2] = cur[i + 2 * bps];
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

/** Area-average downscale of an RGB image to targetWidth (never upscales). */
export function resizeRgb(img, targetWidth) {
  const { width, height, data } = img;
  if (!targetWidth || targetWidth >= width) return img;
  const tw = Math.max(1, Math.round(targetWidth));
  const th = Math.max(1, Math.round((height * tw) / width));
  const out = Buffer.alloc(tw * th * 3);
  const sx = width / tw;
  const sy = height / th;
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * sy);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((ty + 1) * sy)));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * sx);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((tx + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * 3;
        for (let x = x0; x < x1; x++, i += 3) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const o = (ty * tw + tx) * 3;
      out[o] = (r / n + 0.5) | 0;
      out[o + 1] = (g / n + 0.5) | 0;
      out[o + 2] = (b / n + 0.5) | 0;
    }
  }
  return { width: tw, height: th, data: out };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode RGB pixels as a PNG (Sub filter on every row — good for flat UI screenshots). */
export function encodePng({ width, height, data }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const s = y * stride;
    raw[o] = 1;
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (data[s + i] - (i >= 3 ? data[s + i - 3] : 0)) & 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Shrink a PNG to at most maxWidth wide. Returns { buffer, width, height, sourceWidth, sourceHeight }. */
export function shrinkPng(buf, maxWidth) {
  const size = imageSize(buf);
  if (!size || !maxWidth || size.width <= maxWidth) return { buffer: buf, width: size?.width, height: size?.height, sourceWidth: size?.width, sourceHeight: size?.height };
  const img = resizeRgb(decodePng(buf), maxWidth);
  return { buffer: encodePng(img), width: img.width, height: img.height, sourceWidth: size.width, sourceHeight: size.height };
}
