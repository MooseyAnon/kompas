import { describe, expect, it } from 'vitest';
import { normalizePage } from '../src/main/modules/web/page-normalizer';
import {
  pageReadResultSchema,
  structuredPageSchema,
  WEB_LIMITS,
} from '../src/shared/contracts/web';

const snapshot = (html: string) => ({
  url: 'https://example.org/page',
  title: 'Fixture',
  html,
});

describe('adapter-neutral page normalizer', () => {
  it('preserves reading order, ownership, links, original IDs, entities and table cells', () => {
    const result = normalizePage(
      snapshot(`<!doctype html><html><head><script src="/app.js"></script><script>INLINE_JS_CANARY</script><style>INLINE_CSS_CANARY</style><link rel="alternate stylesheet" href="/site.css"></head><body>
      <nav>Navigation</nav><main><h1 id="same">A &amp; B</h1><p>Before <a href="/guide">guide</a> after.</p><h2>Second</h2><ul><li><p>First <a href="/one">one</a></p><ul><li>Nested</li></ul></li><li>Last</li></ul><h6 id="same">End</h6><table><thead><tr><th colspan="2">Label</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table><a href="/home">Home</a></main><footer>Footer</footer></body></html>`),
    );
    expect(result.content.blocks).toEqual([
      { type: 'heading', level: 1, id: 'same', text: 'A & B' },
      {
        type: 'paragraph',
        text: 'Before guide after.',
        links: [{ text: 'guide', href: '/guide' }],
      },
      { type: 'heading', level: 2, text: 'Second' },
      {
        type: 'list',
        ordered: false,
        items: [{ text: 'First one', links: [{ text: 'one', href: '/one' }] }],
      },
      { type: 'list', ordered: false, items: [{ text: 'Nested' }] },
      { type: 'list', ordered: false, items: [{ text: 'Last' }] },
      { type: 'heading', level: 6, id: 'same', text: 'End' },
      {
        type: 'table',
        rows: [
          ['Label', 'Value'],
          ['A', 'B'],
        ],
      },
      { type: 'link', text: 'Home', href: '/home' },
    ]);
    expect(result.scripts).toEqual(['/app.js']);
    expect(result.stylesheets).toEqual(['/site.css']);
    expect(JSON.stringify(result)).not.toMatch(
      /INLINE_JS_CANARY|INLINE_CSS_CANARY|Navigation|Footer/,
    );
    expect(structuredPageSchema.parse(result)).toEqual(result);
  });

  it('repairs malformed HTML, skips hidden and semantic chrome but keeps generic containers', () => {
    const result = normalizePage(
      snapshot(
        '<body><header>noise</header><div class="navigation-looking"><h3>Visible&nbsp;heading</h3><p>Keep <b>this</b></p></div><p hidden>hidden</p><p aria-hidden="true">hidden</p><div style="color:red; display: none">hidden</div><form>noise</form><ol><li>one<li>two</ol>',
      ),
    );
    expect(result.content.blocks).toEqual([
      { type: 'heading', level: 3, text: 'Visible heading' },
      { type: 'paragraph', text: 'Keep this' },
      {
        type: 'list',
        ordered: true,
        items: [{ text: 'one' }, { text: 'two' }],
      },
    ]);
  });

  it('bounds text, rows, items, blocks, refs and serialized size with honest truncation', () => {
    const result = normalizePage(
      snapshot(
        `<body>${Array.from({ length: 50 }, (_, i) => `<script src="/s${i}.js"></script>`).join('')}<main><p>${'x'.repeat(6000)}</p>${'<h2>heading</h2>'.repeat(500)}<table>${'<tr><td>c</td></tr>'.repeat(100)}</table></main></body>`,
      ),
    );
    expect(result.truncated).toBe(true);
    expect(result.scripts).toHaveLength(WEB_LIMITS.maxStructuredRefs);
    expect(result.content.blocks.length).toBeLessThanOrEqual(
      WEB_LIMITS.maxStructuredBlocks,
    );
    expect(result.content.blocks[0]).toEqual({
      type: 'paragraph',
      text: 'x'.repeat(WEB_LIMITS.maxStructuredTextChars),
    });
    expect(
      new TextEncoder().encode(JSON.stringify(result)).length,
    ).toBeLessThanOrEqual(WEB_LIMITS.maxStructuredBytes);
    expect(structuredPageSchema.safeParse(result).success).toBe(true);
  });

  it('caps individual large tables and lists without duplicating their text', () => {
    const result = normalizePage(
      snapshot(
        `<body><main><ol>${'<li>item</li>'.repeat(75)}</ol><table>${'<tr><td>A</td><td>B</td></tr>'.repeat(75)}</table></main></body>`,
      ),
    );
    expect(result.truncated).toBe(true);
    expect(result.content.blocks.map((b) => b.type)).toEqual(['list', 'table']);
    expect(result.content.blocks[0]).toMatchObject({
      items: Array(WEB_LIMITS.maxStructuredItems).fill({ text: 'item' }),
    });
    expect(result.content.blocks[1]).toMatchObject({
      rows: Array(WEB_LIMITS.maxStructuredRows).fill(['A', 'B']),
    });
  });

  it('limits pathological DOM nesting and refuses an empty snapshot', () => {
    const result = normalizePage(
      snapshot(
        `<body>${'<div>'.repeat(150)}Deep${'</div>'.repeat(150)}</body>`,
      ),
    );
    expect(result.truncated).toBe(true);
    expect(() => normalizePage(snapshot(''))).toThrow();
  });

  it('accepts additive structured result without changing raw contract', () => {
    const raw = {
      requestedUrl: 'https://example.org/page',
      url: 'https://example.org/page',
      title: 'Fixture',
      status: 200,
      html: '<p>hi</p>',
      text: 'hi',
      providerId: 'other-reader',
      browserId: 'chrome',
      truncated: { html: false, text: false },
    };
    expect(pageReadResultSchema.safeParse(raw).success).toBe(true);
    expect(
      pageReadResultSchema.safeParse({
        ...raw,
        structured: normalizePage(snapshot(raw.html)),
      }).success,
    ).toBe(true);
    expect(
      pageReadResultSchema.safeParse({
        ...raw,
        structureError: 'EXTRACTION_FAILED',
      }).success,
    ).toBe(true);
  });
});
