import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, parseDuckDuckGo, decodeEntities } from '../../computer/src/web.mjs';

test('htmlToText keeps structure and drops scripts/head', () => {
  const t = htmlToText('<html><head><title>T</title></head><body><script>x</script><h2>Hi &amp; bye</h2><p>A <a href="https://a.com">link</a></p><ul><li>one</li></ul></body></html>');
  assert.equal(t, '## Hi & bye\n\nA [link](https://a.com)\n\n- one');
});

test('decodeEntities handles numeric and named entities', () => {
  assert.equal(decodeEntities('&#39;x&#x27; &mdash; &amp;'), "'x' — &");
});

test('parseDuckDuckGo extracts results, unwraps redirect links, skips ads', () => {
  const html = `
  <div class="result results_links"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad_domain=x">Ad</a></h2></div>
  <div class="result"><h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fxgamer791%2Fholly-bot&amp;rut=abc">xgamer791/<b>holly-bot</b> - GitHub</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Your own <b>multi-agent</b> AI assistant.</a></div>
  <div class="result"><h2><a rel="nofollow" class="result__a" href="https://example.com/b">Second</a></h2></div>`;
  const r = parseDuckDuckGo(html);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { title: 'xgamer791/ holly-bot - GitHub'.replace('/ ', '/ '), url: 'https://github.com/xgamer791/holly-bot', snippet: 'Your own multi-agent AI assistant.' });
  assert.equal(r[1].url, 'https://example.com/b');
  assert.equal(r[1].snippet, '');
});
