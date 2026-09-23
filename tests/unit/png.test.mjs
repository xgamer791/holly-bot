import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { encodePng, decodePng, resizeRgb, shrinkPng, imageSize } from '../../computer/src/png.mjs';

function gradient(width, height) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      data[o] = x % 256;
      data[o + 1] = y % 256;
      data[o + 2] = (x + y) % 256;
    }
  }
  return { width, height, data };
}

test('PNG encode/decode round trip', () => {
  const img = gradient(37, 19);
  const png = encodePng(img);
  assert.deepEqual(imageSize(png), { width: 37, height: 19, mime: 'image/png' });
  const back = decodePng(png);
  assert.equal(back.width, 37);
  assert.ok(back.data.equals(img.data));
});

test('shrinks screenshots by area averaging', () => {
  const img = { width: 4, height: 2, data: Buffer.from([0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255]) };
  const half = resizeRgb(img, 2);
  assert.equal(half.width, 2);
  assert.equal(half.height, 1);
  assert.deepEqual([...half.data], [128, 128, 128, 128, 128, 128]);
  const small = shrinkPng(encodePng(gradient(400, 300)), 100);
  assert.equal(small.width, 100);
  assert.equal(small.height, 75);
  assert.equal(small.sourceWidth, 400);
  assert.deepEqual(imageSize(small.buffer), { width: 100, height: 75, mime: 'image/png' });
});

test('reads JPEG sizes', (t) => {
  let jpeg;
  try {
    jpeg = execFileSync('convert', ['-size', '321x123', 'xc:red', 'jpeg:-']);
  } catch {
    t.skip('ImageMagick not installed');
    return;
  }
  assert.deepEqual(imageSize(jpeg), { width: 321, height: 123, mime: 'image/jpeg' });
});
