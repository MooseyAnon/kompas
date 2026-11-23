import {
  ADDITIONAL_GUIDANCE_MAX,
  QUICK_FIRE_MAX_COUNT,
  QUICK_FIRE_MIN_COUNT,
  type InsightsProgress,
  type InsightsQuestion,
} from '../../../../../shared/contracts';

/** How long someone has, instead of picking a number of questions. */
export const TIME_OPTIONS = [10, 15, 20, 30, 45] as const;
export type Minutes = (typeof TIME_OPTIONS)[number];
export const DEFAULT_MINUTES: Minutes = 15;

/** About three minutes a quick-fire question, kept within what the backend allows. */
export function questionsFor(minutes: number) {
  return Math.min(
    QUICK_FIRE_MAX_COUNT,
    Math.max(QUICK_FIRE_MIN_COUNT, Math.round(minutes / 3)),
  );
}

/** A focus to practise: a skill from job descriptions or an interview stage. */
export type Focus = { id: string; label: string };

const focusId = (label: string) => label.trim().toLowerCase();

/**
 * Skills that keep coming up in the job descriptions for your role, most
 * repeated first. A skill seen in only one listing counts once there are few.
 */
export function repeatedSkills(
  jobs: readonly { matched: readonly string[]; missing: readonly string[] }[],
  limit = 8,
): Focus[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const job of jobs) {
    const seen = new Set<string>();
    for (const skill of [...job.matched, ...job.missing]) {
      const id = focusId(skill);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const entry = counts.get(id) ?? { label: skill.trim(), count: 0 };
      entry.count += 1;
      counts.set(id, entry);
    }
  }
  const all = [...counts.entries()].sort(
    (a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label),
  );
  const repeated = all.filter(([, entry]) => entry.count > 1);
  return (repeated.length >= 3 ? repeated : all)
    .slice(0, limit)
    .map(([id, entry]) => ({ id, label: entry.label }));
}

/** The interview stages a role usually goes through. */
const STAGES: { match: RegExp; stages: string[] }[] = [
  {
    match: /design|ux|ui\b/i,
    stages: [
      'Portfolio review',
      'Design challenge',
      'App critique',
      'Collaboration',
      'Behavioural (STAR)',
    ],
  },
  {
    match: /engineer|developer|software|frontend|backend/i,
    stages: ['Coding', 'System design', 'Architecture', 'Behavioural (STAR)'],
  },
  {
    match: /product manager|product owner|\bpm\b/i,
    stages: ['Product sense', 'Execution', 'Metrics', 'Behavioural (STAR)'],
  },
  {
    match: /data|analyst|scientist/i,
    stages: [
      'SQL and analysis',
      'Case study',
      'Statistics',
      'Behavioural (STAR)',
    ],
  },
];
const DEFAULT_STAGES = ['Role fit', 'Problem solving', 'Behavioural (STAR)'];

export function interviewStages(role: string | null): Focus[] {
  const found = role ? STAGES.find((entry) => entry.match.test(role)) : null;
  return (found?.stages ?? DEFAULT_STAGES).map((label) => ({
    id: focusId(label),
    label,
  }));
}

/** What the focus badges ask the model for. */
export function focusText(labels: readonly string[]) {
  return labels.length ? `Focus on: ${labels.join(', ')}.` : '';
}

/** The guidance sent to the model: chosen focus, the time, then anything typed. */
export function composeGuidance({
  focus,
  minutes,
  deepLoop,
  note,
}: {
  focus: readonly string[];
  minutes: number;
  deepLoop: boolean;
  note: string;
}) {
  const parts: string[] = [];
  const asked = focusText(focus);
  if (asked) parts.push(asked);
  if (deepLoop)
    parts.push(
      `I have about ${minutes} minutes, so pace the conversation to fit.`,
    );
  const typed = note.trim();
  if (typed) parts.push(typed);
  return parts.join(' ').slice(0, ADDITIONAL_GUIDANCE_MAX);
}

/** Points for practising: turning up, answering and passing all count. */
export function competencyPoints(progress: InsightsProgress) {
  return (
    progress.sessions * 10 + progress.scoredRounds * 5 + progress.pass * 15
  );
}

export const POINTS_PER_LEVEL = 100;
export function levelOf(points: number) {
  return {
    level: Math.floor(points / POINTS_PER_LEVEL) + 1,
    intoLevel: points % POINTS_PER_LEVEL,
  };
}

export type CompetencyTally = {
  name: string;
  answered: number;
  passed: number;
  points: number;
};

/** Questions grouped by competency, strongest first. */
export function tallyCompetencies(
  questions: readonly InsightsQuestion[],
): CompetencyTally[] {
  const byName = new Map<string, CompetencyTally>();
  for (const question of questions) {
    const name = question.competency?.trim();
    if (!name) continue;
    const tally = byName.get(name) ?? {
      name,
      answered: 0,
      passed: 0,
      points: 0,
    };
    tally.answered += 1;
    tally.points += 5;
    if (question.decision === 'pass') {
      tally.passed += 1;
      tally.points += 15;
    }
    byName.set(name, tally);
  }
  return [...byName.values()].sort(
    (a, b) => b.points - a.points || a.name.localeCompare(b.name),
  );
}

export type RankedFocus = Focus & {
  kind: 'stage' | 'skill';
  answered: number;
  passed: number;
  /** 0–100 share passed, or null before any answer. */
  score: number | null;
};

/** Your role's stages and skills, ranked by how practice has gone. */
export function rankFocus(
  stages: readonly Focus[],
  skills: readonly Focus[],
  tallies: readonly CompetencyTally[],
): RankedFocus[] {
  const byName = new Map(tallies.map((t) => [focusId(t.name), t]));
  const rows = [
    ...stages.map((f) => ({ ...f, kind: 'stage' as const })),
    ...skills.map((f) => ({ ...f, kind: 'skill' as const })),
  ].map((focus) => {
    const tally = byName.get(focus.id);
    return {
      ...focus,
      answered: tally?.answered ?? 0,
      passed: tally?.passed ?? 0,
      score: tally?.answered
        ? Math.round((tally.passed / tally.answered) * 100)
        : null,
    };
  });
  return rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
