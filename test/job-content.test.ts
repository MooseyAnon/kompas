import { expect, it } from 'vitest';
import { selectJobContent } from '../src/main/modules/job-discovery/job-content';
import { normalizePage } from '../src/main/modules/web/page-normalizer';
import type { PageReadResult } from '../src/shared/contracts';

const title = 'Software Engineer - Acme';
const description =
  'Responsibilities: build software. Requirements: TypeScript.';

function page(html: string, text = `${title}\n${description}`): PageReadResult {
  return {
    requestedUrl: 'https://acme.example/jobs/123',
    url: 'https://acme.example/jobs/123',
    title,
    status: 200,
    html,
    text,
    providerId: 'fixture',
    browserId: 'fixture',
    truncated: { text: false, html: false },
  };
}

it('isolates the full posting and drops page chrome, hidden content and related roles', () => {
  const job = `${description} Salary: £70,000. Remote. Full time.`;
  const html = `<nav>${'NAVIGATION '.repeat(4_000)}</nav>
    <main><article class="job-details"><h1>${title}</h1>
      <div class="job-description"><p>${job}</p></div>
      <div hidden>HIDDEN_CANARY</div>
      <div aria-hidden="true">ARIA_CANARY</div>
      <div style="display:none">STYLE_CANARY</div>
      <div class="related-jobs">OTHER_ROLE_CANARY</div>
      <form>APPLICATION_CANARY</form>
    </article></main><footer>FOOTER_CANARY</footer>`;
  const selected = selectJobContent(page(html, `${title}\n${job}`));

  expect(selected).toContain(job);
  expect(selected).toContain(title);
  expect(selected).not.toMatch(/CANARY|NAVIGATION/);
});

it('does not silently truncate long DOM paragraphs when structured blocks are capped', () => {
  const job = `${description} ${'Additional job detail. '.repeat(150)} END_OF_JOB`;
  const captured = page(`<main><h1>${title}</h1><p>${job}</p></main>`, job);
  captured.structured = normalizePage(captured);
  expect(captured.structured.truncated).toBe(true);
  expect(selectJobContent(captured).replace(/\s+/g, ' ')).toContain(
    job.replace(/\s+/g, ' '),
  );
});

it('uses identity-matched JobPosting metadata only when its full description is visible', () => {
  const posting = {
    '@type': 'JobPosting',
    title: 'Software Engineer',
    hiringOrganization: { name: 'Acme' },
    description: `<p>${description}</p>`,
  };
  const other = { ...posting, title: 'Accountant', description: 'OTHER_ROLE' };
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@graph': [other, posting],
  })}</script><div>${title}<p>${description}</p></div>`;

  const selected = selectJobContent(page(html));
  expect(selected).toContain(description);
  expect(selected).toContain('Acme');
  expect(selected).not.toContain('OTHER_ROLE');
  expect(() => selectJobContent(page(html, title))).toThrow(
    'JOB_CONTENT_UNAVAILABLE',
  );
});

it('falls back to a scoped DOM posting when JSON-LD is malformed or stale', () => {
  for (const data of [
    '{bad json',
    JSON.stringify({
      '@type': 'JobPosting',
      title: 'Software Engineer',
      description: 'STALE_DESCRIPTION',
    }),
  ]) {
    const selected = selectJobContent(
      page(
        `<script type="application/ld+json">${data}</script>` +
          `<main><h1>${title}</h1><p>${description}</p></main>`,
      ),
    );
    expect(selected).toContain(description);
    expect(selected).not.toContain('STALE_DESCRIPTION');
  }
});

it('preserves scoped job header metadata around a description without including other page text', () => {
  const html = `<nav>OTHER_COMPANY</nav><main><h1>${title}</h1>
    <div class="company-name">Acme</div>
    <div class="job-location">London</div>
    <div class="job-description"><p>${description}</p></div>
    <div itemprop="employmentType">Full time</div>
    <aside>UNRELATED</aside></main>`;
  const selected = selectJobContent(
    page(html, `${title}\nAcme\nLondon\n${description}\nFull time`),
  );
  expect(selected).toContain(`Acme\nLondon\n${description}\nFull time`);
  expect(selected).not.toMatch(/OTHER_COMPANY|UNRELATED/);
});

it('does not turn text hidden by external CSS into grounded job evidence', () => {
  const captured = page(`<main><h1>${title}</h1><p>${description}</p>
    <p class="css-hidden">INVISIBLE_SALARY</p></main>`);
  expect(() => selectJobContent(captured)).toThrow('JOB_CONTENT_UNAVAILABLE');
});

it('refuses ambiguous sibling postings, duplicate matching metadata and unscoped body text', () => {
  const posting = {
    '@type': 'JobPosting',
    title: 'Software Engineer',
    description,
  };
  const ambiguousPages = [
    `<main><article class="job-description">${description}</article>
      <article class="job-description">${description}</article></main>`,
    `<script type="application/ld+json">${JSON.stringify([
      posting,
      posting,
    ])}</script><div>${description}</div>`,
    `<body><h1>${title}</h1><p>${description}</p></body>`,
    `<main><h1>${title}</h1>
      <div class="job-description">${description}</div>
      <h1>Accountant</h1><p>Another role's details</p></main>`,
  ];
  for (const html of ambiguousPages) {
    expect(() => selectJobContent(page(html))).toThrow(
      'JOB_CONTENT_UNAVAILABLE',
    );
  }
});

it('refuses incomplete captures and DOM walks without returning partial job evidence', () => {
  const captured = page(`<main><h1>${title}</h1><p>${description}</p></main>`);
  for (const truncated of [
    { text: true, html: false },
    { text: false, html: true },
  ]) {
    expect(() => selectJobContent({ ...captured, truncated })).toThrow(
      'JOB_CONTENT_INCOMPLETE',
    );
  }
  expect(() =>
    selectJobContent(
      page(
        '<main>' +
          '<div>'.repeat(140) +
          description +
          '</div>'.repeat(140) +
          '</main>',
      ),
    ),
  ).toThrow('JOB_CONTENT_INCOMPLETE');
});
