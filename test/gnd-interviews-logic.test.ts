import { describe, expect, it } from 'vitest';
import {
  interviewStages,
  rankFocus,
  repeatedSkills,
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
        focus: ['STAR method'],
        minutes: 20,
        deepLoop: true,
        note: ' Base it on Dojo ',
      }),
    ).toBe(
      'Focus on: STAR method. I have about 20 minutes, so pace the conversation to fit. Base it on Dojo',
    );
    expect(
      composeGuidance({ focus: [], minutes: 20, deepLoop: false, note: '' }),
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

  it('pulls skills repeated across job descriptions', () => {
    const skills = repeatedSkills([
      { matched: ['Figma', 'Prototyping'], missing: ['Design systems'] },
      { matched: ['figma'], missing: ['Prototyping', 'SQL'] },
      { matched: ['Figma', 'Design systems'], missing: [] },
    ]);
    expect(skills.map((s) => s.label)).toEqual([
      'Figma',
      'Design systems',
      'Prototyping',
    ]);
  });

  it('knows the usual stages for a role and ranks practice against them', () => {
    const stages = interviewStages('Staff Product Designer');
    expect(stages[0].label).toBe('Portfolio review');
    const ranked = rankFocus(
      stages.slice(0, 2),
      [{ id: 'figma', label: 'Figma' }],
      [
        { name: 'Design challenge', answered: 2, passed: 2, points: 40 },
        { name: 'portfolio review', answered: 2, passed: 1, points: 25 },
      ],
    );
    expect(ranked.map((r) => [r.label, r.score])).toEqual([
      ['Design challenge', 100],
      ['Portfolio review', 50],
      ['Figma', null],
    ]);
  });
});
