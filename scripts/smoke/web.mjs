import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { call, request } from './harness.mjs';

const STATIC_PAGE =
  '<!doctype html><html><head><title>Static Fixture</title></head><body><main><h1>Static heading</h1><p>STATIC_MARKER</p></main></body></html>';
const SCRIPTED_PAGE =
  '<!doctype html><html><head><title>Scripted Fixture</title><script>/* INLINE_SCRIPT_CANARY */</script><style>/* INLINE_STYLE_CANARY */</style></head><body><nav>Navigation noise</nav><main><h1>Rendered heading</h1><p id="out">Loading</p><ul><li>Alpha</li><li>Beta</li></ul><table><tr><th>Key</th><th>Value</th></tr><tr><td>A</td><td>B</td></tr></table><a href="/next">Next</a></main><script>document.getElementById("out").textContent="JS_RENDERED_MARKER";</script></body></html>';

async function fixtureServer(lifecycle) {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/static' ? STATIC_PAGE : SCRIPTED_PAGE);
  });
  lifecycle.ownServer(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return `http://127.0.0.1:${server.address().port}`;
}

export async function webSmoke(harness, ordinarySession) {
  const base = await fixtureServer(harness.lifecycle);
  const denied = await request(ordinarySession.page, 'web', 'readPage', {
    url: `${base}/static`,
  });
  assert.equal(denied.ok, false, 'Ordinary reader accepted loopback');
  const inventory = await call(ordinarySession.page, 'web', 'browsers.list');

  if (
    !inventory.browsers.some((browser) => browser.detected && browser.supported)
  ) {
    console.log(
      '[smoke] Browser reading SKIPPED: no supported installed browser',
    );

    return;
  }

  const fixture = await harness.launch({
    env: { CW_ALLOW_LOOPBACK_FIXTURES: '1' },
  });
  const staticPage = await call(fixture.page, 'web', 'readPage', {
    url: `${base}/static`,
  });
  assert.ok(staticPage.text.includes('STATIC_MARKER'));
  const scripted = await call(fixture.page, 'web', 'readPage', {
    url: `${base}/scripted`,
  });
  assert.ok(
    scripted.text.includes('JS_RENDERED_MARKER'),
    'Reader did not execute fixture JavaScript',
  );
  assert.ok(scripted.structured, 'Structured page missing');
  const blocks = scripted.structured.content.blocks;
  assert.ok(
    blocks.some(
      (block) => block.type === 'heading' && block.text === 'Rendered heading',
    ),
  );
  assert.ok(
    blocks.some((block) => block.type === 'table' && block.rows[1][1] === 'B'),
  );
  assert.equal(
    /INLINE_SCRIPT_CANARY|INLINE_STYLE_CANARY/.test(
      JSON.stringify(scripted.structured),
    ),
    false,
    'Structured content included inline executable/style text',
  );
}
