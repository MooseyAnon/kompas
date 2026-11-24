import { describe, expect, it } from 'vitest';
import {
  feedUrl,
  matchingJobs,
  parseFeed,
  slugsFor,
  titleOverlap,
} from '../src/main/modules/job-discovery/ats-lookup';

describe('company job-board lookup', () => {
  it('guesses board names from a company name', () => {
    expect(slugsFor('Chromeis')).toEqual(['chromeis']);
    expect(slugsFor('Acme Labs Ltd')).toEqual(['acmelabs', 'acme-labs']);
    expect(slugsFor('Café & Co')).toContain('cafeand');
  });

  it('builds each provider’s public feed URL', () => {
    expect(feedUrl('greenhouse', 'acme')).toBe(
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
    );
    expect(feedUrl('lever', 'acme')).toBe(
      'https://api.lever.co/v0/postings/acme?mode=json',
    );
    expect(feedUrl('ashby', 'acme')).toBe(
      'https://api.ashbyhq.com/posting-api/job-board/acme',
    );
  });

  it('reads Greenhouse, Lever and Ashby feeds, ignoring junk', () => {
    expect(
      parseFeed(
        'greenhouse',
        JSON.stringify({
          jobs: [
            {
              title: 'Product Designer',
              absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
              location: { name: 'London' },
            },
            { title: 'No link' },
          ],
        }),
      ),
    ).toEqual([
      {
        title: 'Product Designer',
        url: 'https://boards.greenhouse.io/acme/jobs/1',
        location: 'London',
      },
    ]);
    expect(
      parseFeed(
        'lever',
        JSON.stringify([
          {
            text: 'Designer',
            hostedUrl: 'https://jobs.lever.co/acme/x',
            categories: { location: 'Remote' },
          },
        ]),
      ),
    ).toHaveLength(1);
    expect(
      parseFeed(
        'ashby',
        JSON.stringify({
          jobs: [
            { title: 'Designer', jobUrl: 'https://jobs.ashbyhq.com/acme/y' },
          ],
        }),
      ),
    ).toHaveLength(1);
    expect(parseFeed('greenhouse', '<html>not found</html>')).toEqual([]);
    expect(
      parseFeed(
        'lever',
        JSON.stringify([{ text: 'X', hostedUrl: 'http://insecure' }]),
      ),
    ).toEqual([]);
  });

  it('picks the postings that are this role, preferring the location', () => {
    expect(
      titleOverlap('Senior Product Designer', 'Product Designer, Payments'),
    ).toBeCloseTo(2 / 3);
    const jobs = [
      { title: 'Product Designer', url: 'https://a/1', location: 'New York' },
      { title: 'Product Designer', url: 'https://a/2', location: 'London, UK' },
      { title: 'Data Engineer', url: 'https://a/3', location: 'London' },
    ];
    expect(
      matchingJobs('Product Designer', 'London', jobs).map((j) => j.url),
    ).toEqual(['https://a/2', 'https://a/1']);
    expect(matchingJobs('Product Designer', null, [jobs[2]])).toEqual([]);
  });
});
