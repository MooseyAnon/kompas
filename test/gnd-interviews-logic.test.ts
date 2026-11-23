import { describe, expect, it } from 'vitest';
import {
  competencyPoints,
  composeGuidance,
  levelOf,
  questionsFor,
  tallyCompetencies,
} from '../src/renderer/presentation/gnd/pages/interviews/interviewView';

describe('Kompas interviews', () => {
  it('maps the time available to a number of quick-fire questions', () => {
    expect(questionsFor(10)).toBe(5);
    expect(questionsFor(20)).toBe(7);
    expect(questionsFor(30)).toBe(10);
    expect(questionsFor(45)).toBe(10);
  });

  it('turns badges, time and a note into guidance', () => {
    expect(
      composeGuidance({
        badges: ['star'],
        minutes: 20,
        deepLoop: true,
        note: ' Base it on Dojo ',
      }),
    ).toBe(
      'Ask questions to answer with the STAR method. I have about 20 minutes, so pace the conversation to fit. Base it on Dojo',
    );
    expect(
      composeGuidance({ badges: [], minutes: 20, deepLoop: false, note: '' }),
    ).toBe('');
  });

  it('scores points and levels', () => {
    const points = competencyPoints({
      sessions: 2,
      scoredRounds: 6,
      pass: 4,
    } as never);
    expect(points).toBe(110);
    expect(levelOf(points)).toEqual({ level: 2, intoLevel: 10 });
  });

  it('groups questions by competency, strongest first', () => {
    const tallies = tallyCompetencies([
      { competency: 'Craft', decision: 'pass' },
      { competency: 'Craft', decision: 'fail' },
      { competency: 'Strategy', decision: 'fail' },
      { competency: null, decision: 'pass' },
    ] as never);
    expect(
      tallies.map((t) => [t.name, t.answered, t.passed, t.points]),
    ).toEqual([
      ['Craft', 2, 1, 25],
      ['Strategy', 1, 0, 5],
    ]);
  });
});
