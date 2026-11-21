import { describe, expect, it } from 'vitest';
import {
  buildSearchUrl,
  normalizeSearchItems,
  SEARCH_ENGINE_ID,
} from '../src/main/modules/web/adapters/playwright/search-strategy';

describe('DuckDuckGo search strategy', () => {
  it('builds a DuckDuckGo web-results URL mirroring a real browser query', () => {
    const url = new URL(buildSearchUrl('hello world'));
    expect(url.hostname).toBe('duckduckgo.com');
    expect(url.searchParams.get('q')).toBe('hello world');
    expect(url.searchParams.get('ia')).toBe('web');
    expect(url.searchParams.get('t')).toBe('ffab');
    expect(SEARCH_ENGINE_ID).toBe('duckduckgo');
  });

  it('normalizes items: dense rank, snippet optional, html/whitespace cleaned', () => {
    const results = normalizeSearchItems([
      {
        title: '  GPU <b>Engineer</b>  ',
        url: 'https://jobs.example/gpu',
        snippet: 'Great   role',
      },
      { title: 'No snippet', url: 'https://example.org/x' },
    ]);
    expect(results).toEqual([
      {
        title: 'GPU Engineer',
        url: 'https://jobs.example/gpu',
        snippet: 'Great role',
        rank: 1,
      },
      { title: 'No snippet', url: 'https://example.org/x', rank: 2 },
    ]);
  });

  it('unwraps DuckDuckGo l/?uddg= redirector links to the real target', () => {
    const target = 'https://real.example/career/role?a=1';
    const results = normalizeSearchItems([
      {
        title: 'Role',
        url: `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`,
      },
    ]);
    expect(results[0].url).toBe(target);
  });

  it('drops non-http(s), over-length and duplicate URLs', () => {
    const results = normalizeSearchItems([
      { title: 'js', url: 'javascript:alert(1)' },
      { title: 'dup1', url: 'https://example.org/same' },
      { title: 'dup2', url: 'https://example.org/same' },
      { title: 'long', url: `https://example.org/${'a'.repeat(3000)}` },
    ]);
    expect(results).toEqual([
      { title: 'dup1', url: 'https://example.org/same', rank: 1 },
    ]);
  });

  it('drops entries with an empty title', () => {
    const results = normalizeSearchItems([
      { title: '   ', url: 'https://example.org/a' },
      { title: 'ok', url: 'https://example.org/b' },
    ]);
    expect(results).toEqual([
      { title: 'ok', url: 'https://example.org/b', rank: 1 },
    ]);
  });
});
