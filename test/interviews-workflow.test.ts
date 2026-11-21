import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REASSESSMENT_CAP,
  QUICK_FIRE_ALLOWS_COACHING,
  QUICK_FIRE_ALLOWS_FOLLOW_UP,
  deepLoopNextTransition,
  deepLoopReviewedChoices,
  isQuickFireCountValid,
  quickFireReadyForReview,
  quickFireReadyToStart,
  reassessmentChainHasCycle,
  type DeepLoopRoundState,
} from '../src/main/modules/interviews/interviews.workflow';

describe('quick-fire workflow rules', () => {
  it('accepts counts 5..10 and rejects 4 and 11', () => {
    expect(isQuickFireCountValid(5)).toBe(true);
    expect(isQuickFireCountValid(10)).toBe(true);
    expect(isQuickFireCountValid(4)).toBe(false);
    expect(isQuickFireCountValid(11)).toBe(false);
    expect(isQuickFireCountValid(7.5)).toBe(false);
  });

  it('is ready to start only when exactly N primary rounds exist', () => {
    expect(
      quickFireReadyToStart({
        questionCount: 5,
        roundsCreated: 4,
        answersCollected: 0,
      }),
    ).toBe(false);
    expect(
      quickFireReadyToStart({
        questionCount: 5,
        roundsCreated: 5,
        answersCollected: 0,
      }),
    ).toBe(true);
  });

  it('defers review until every configured answer is collected', () => {
    expect(
      quickFireReadyForReview({
        questionCount: 6,
        roundsCreated: 6,
        answersCollected: 5,
      }),
    ).toBe(false);
    expect(
      quickFireReadyForReview({
        questionCount: 6,
        roundsCreated: 6,
        answersCollected: 6,
      }),
    ).toBe(true);
  });

  it('never allows follow-ups or coaching', () => {
    expect(QUICK_FIRE_ALLOWS_FOLLOW_UP).toBe(false);
    expect(QUICK_FIRE_ALLOWS_COACHING).toBe(false);
  });
});

describe('deep-loop workflow transitions', () => {
  function state(partial: Partial<DeepLoopRoundState>): DeepLoopRoundState {
    return {
      decision: null,
      coached: false,
      consecutiveReassessments: 0,
      ...partial,
    };
  }

  it('awaits review while there is no decision', () => {
    expect(deepLoopNextTransition(state({ decision: null }))).toBe(
      'await_review',
    );
  });

  it('treats unscored as not-yet-assessed', () => {
    expect(deepLoopNextTransition(state({ decision: 'unscored' }))).toBe(
      'await_review',
    );
  });

  it('advances on a pass', () => {
    expect(deepLoopNextTransition(state({ decision: 'pass' }))).toBe('advance');
  });

  it('routes a fail to coaching, then to a linked reassessment', () => {
    expect(
      deepLoopNextTransition(state({ decision: 'fail', coached: false })),
    ).toBe('coach');
    expect(
      deepLoopNextTransition(
        state({ decision: 'fail', coached: true, consecutiveReassessments: 0 }),
      ),
    ).toBe('reassess');
  });

  it('halts and recommends learning once the reassessment cap is reached', () => {
    expect(
      deepLoopNextTransition(
        state({
          decision: 'fail',
          coached: true,
          consecutiveReassessments: DEFAULT_REASSESSMENT_CAP,
        }),
      ),
    ).toBe('halt_recommend_learning');
  });

  it('honours a custom cap', () => {
    expect(
      deepLoopNextTransition(
        state({
          decision: 'fail',
          coached: true,
          consecutiveReassessments: 1,
        }),
        1,
      ),
    ).toBe('halt_recommend_learning');
  });
});

describe('deep-loop reviewed choices', () => {
  it('offers onward choices only after a pass or unscored review', () => {
    for (const decision of ['pass', 'unscored'] as const) {
      expect(
        deepLoopReviewedChoices({
          decision,
          coached: false,
          reassessmentDepth: 0,
        }),
      ).toEqual(['continue', 'request_results']);
    }
  });

  it('lets the user choose coaching, then a linked reassessment, after a fail', () => {
    expect(
      deepLoopReviewedChoices({
        decision: 'fail',
        coached: false,
        reassessmentDepth: 0,
      }),
    ).toEqual(['request_coaching', 'continue', 'request_results']);
    expect(
      deepLoopReviewedChoices({
        decision: 'fail',
        coached: true,
        reassessmentDepth: DEFAULT_REASSESSMENT_CAP - 1,
      }),
    ).toEqual(['request_reassessment', 'continue', 'request_results']);
  });

  it('halts the loop at the reassessment cap while still allowing coaching', () => {
    const atCap = DEFAULT_REASSESSMENT_CAP;
    expect(
      deepLoopReviewedChoices({
        decision: 'fail',
        coached: false,
        reassessmentDepth: atCap,
      }),
    ).toEqual(['request_coaching', 'request_results']);
    expect(
      deepLoopReviewedChoices({
        decision: 'fail',
        coached: true,
        reassessmentDepth: atCap,
      }),
    ).toEqual(['request_results']);
  });
});

describe('reassessment cycle detection', () => {
  it('detects a cycle in the reassessment chain', () => {
    const parents: Record<string, string | null> = { a: 'b', b: 'c', c: 'a' };
    expect(reassessmentChainHasCycle('a', (id) => parents[id] ?? null)).toBe(
      true,
    );
  });

  it('accepts an acyclic chain', () => {
    const parents: Record<string, string | null> = { a: 'b', b: 'c', c: null };
    expect(reassessmentChainHasCycle('a', (id) => parents[id] ?? null)).toBe(
      false,
    );
  });
});
