import { describe, expect, it } from 'vitest';
import {
  agendaFor,
  groupApplications,
  historyFor,
  stageName,
  trackerFor,
} from '../src/renderer/presentation/gnd/pages/applications/applicationsView';
import {
  addEntry,
  filterCount,
  progressFor,
  stoppedShort,
  suggestedRoles,
} from '../src/renderer/presentation/gnd/pages/jobs/searchFilterRules';
import { newJobDiscoveryConfiguration } from '../src/shared/contracts';

const ev = (
  id: string,
  kind: string | null,
  label: string,
  at: string,
  corrects: string | null = null,
) =>
  ({
    id,
    applicationId: 'a',
    stageLabel: label,
    stageKind: kind,
    stageSubtype: null,
    occurredAt: at,
    recordedAt: at,
    source: 'user',
    sourceRef: null,
    sourceEvidence: null,
    correctsEventId: corrects,
  }) as never;
const app = (id: string, kind: string, archivedAt: string | null = null) =>
  ({
    id,
    companyName: 'Plaid',
    roleTitle: 'Designer',
    location: 'London',
    archivedAt,
    currentStage: ev(`s-${id}`, kind, kind, '2026-11-05T09:00:00.000Z'),
  }) as never;

describe('application stages', () => {
  it('tracks the furthest stage, marks skipped steps, and stops at a close', () => {
    const open = trackerFor([
      ev('1', 'saved', 'Pending', '2026-11-03T00:00:00.000Z'),
      ev('2', 'applied', 'Applied', '2026-11-05T00:00:00.000Z'),
      ev('3', 'interview', 'Portfolio review', '2026-11-25T14:00:00.000Z'),
    ]);
    expect(open.steps.map((s) => s.state)).toEqual([
      'done',
      'done',
      'done',
      'now',
      'future',
    ]);
    expect(open.steps[2].date).toBe('Skipped');
    const closed = trackerFor([
      ev('1', 'applied', 'Applied', '2026-11-05T00:00:00.000Z'),
      ev('2', 'rejected', 'Not successful', '2026-11-10T00:00:00.000Z'),
    ]);
    expect(closed.closed).toBe(true);
    expect(closed.steps[1].state).toBe('done');
  });

  it('keeps corrected entries in history, marked, and ignores them for the tracker', () => {
    const stages = [
      ev('1', 'applied', 'Applied', '2026-11-05T00:00:00.000Z'),
      ev('2', 'interview', 'Portfolio review', '2026-11-06T00:00:00.000Z'),
      ev('3', 'screening', 'Screening call', '2026-11-07T00:00:00.000Z', '2'),
    ];
    const history = historyFor(stages);
    expect(history.find((h) => h.id === '2')).toMatchObject({
      corrected: true,
      detail: 'Corrected',
    });
    expect(history.find((h) => h.id === '3')?.detail).toBe('Fixed by you');
    expect(trackerFor(stages).steps[3].state).toBe('future');
  });

  it('names interview stages by their round', () => {
    expect(
      stageName({ stageKind: 'interview', stageLabel: 'Portfolio review' }),
    ).toBe('Interview · Portfolio review');
    expect(stageName({ stageKind: 'rejected', stageLabel: 'x' })).toBe(
      'Not successful',
    );
  });
});

describe('your applications groups', () => {
  it('puts closed and archived applications under Archived and counts every sent one', () => {
    const groups = groupApplications(
      [app('a', 'applied'), app('o', 'saved'), app('r', 'rejected')],
      [app('x', 'applied', '2026-11-09T00:00:00.000Z')],
    );
    expect(groups.applied.map((a) => (a as { id: string }).id)).toEqual(['a']);
    expect(groups.archived.map((a) => (a as { id: string }).id)).toEqual([
      'r',
      'x',
    ]);
    expect(groups.sentCount).toBe(3);
  });

  it('builds an agenda by day, titled by round and company, upcoming first', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const agenda = agendaFor(
      [
        {
          application: app('a', 'interview'),
          stages: [
            ev(
              'i1',
              'interview',
              'Portfolio review',
              '2026-11-25T14:00:00.000Z',
            ),
            ev('i0', 'interview', 'First round', '2026-11-12T11:00:00.000Z'),
          ],
        },
      ],
      now,
    );
    expect(agenda.upcoming).toHaveLength(1);
    expect(agenda.upcoming[0].events[0].title).toBe('Portfolio review – Plaid');
    expect(agenda.earlier[0].events[0].title).toBe('First round – Plaid');
  });
});

describe('search filters', () => {
  it('adds entries unless blank, duplicate or full', () => {
    expect(addEntry(['A'], ' b ', 5)).toEqual({
      list: ['A', 'b'],
      problem: null,
    });
    expect(addEntry(['A'], 'a', 5).problem).toBe('duplicate');
    expect(addEntry(['A'], '  ', 5).problem).toBe('blank');
    expect(addEntry(['A', 'B'], 'C', 2).problem).toBe('full');
  });

  it('counts the filters that are set', () => {
    const config = newJobDiscoveryConfiguration();
    config.intent.targetRoles = ['Designer', 'Lead'];
    config.intent.location = 'London';
    config.intent.workArrangement = 'hybrid';
    expect(filterCount(config)).toBe(4);
    expect(filterCount(null)).toBe(0);
  });

  it('suggests target roles first, then recent job titles', () => {
    expect(
      suggestedRoles([{ roleTitle: 'Design Lead', active: true }], [
        { roleTitle: 'Senior Product Designer', category: 'employment' },
        { roleTitle: 'BA Design', category: 'education' },
      ] as never),
    ).toEqual(['Design Lead', 'Senior Product Designer']);
  });

  it('turns workflow state into steps, a counter and a finish', () => {
    const base = {
      id: 'r',
      status: 'running',
      workActive: true,
      discovery: { planned: 6, submitted: 6, settled: 3, search: {} },
      activeSteps: [],
      counts: { admitted: 4, verified: 0, jdReady: 0, matched: 0, failed: 0 },
      milestones: {},
      diagnostics: [],
      candidates: [],
    } as never;
    const searching = progressFor(base);
    expect(searching.steps).toHaveLength(1);
    expect(searching.found).toBe(4);
    const done = progressFor({
      ...(base as object),
      status: 'completed',
      workActive: false,
      discovery: { planned: 6, submitted: 6, settled: 6, search: {} },
      counts: { admitted: 4, verified: 4, jdReady: 4, matched: 4, failed: 0 },
    } as never);
    expect(done.finished).toBe(true);
    expect(done.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(done.percent).toBe(100);
  });

  it('explains a search that stopped short', () => {
    expect(
      stoppedShort({
        status: 'partial',
        diagnostics: [{ code: 'WEB_RATE_LIMITED', at: '' }],
      } as never),
    ).toMatch(/job board stopped/u);
    expect(
      stoppedShort({ status: 'completed', diagnostics: [] } as never),
    ).toBe(null);
  });
});
