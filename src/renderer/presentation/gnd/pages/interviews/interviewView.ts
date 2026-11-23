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

/** Common kinds of guidance people pick, as badges. */
export const GUIDANCE_BADGES = [
  {
    id: 'star',
    label: 'STAR method',
    text: 'Ask questions to answer with the STAR method.',
  },
  { id: 'technical', label: 'Technical', text: 'Include technical questions.' },
  {
    id: 'architecture',
    label: 'Architecture design',
    text: 'Include architecture and system design questions.',
  },
  {
    id: 'prototyping',
    label: 'Prototyping',
    text: 'Include questions about prototyping and testing ideas.',
  },
  {
    id: 'behavioural',
    label: 'Behavioural',
    text: 'Include behavioural questions.',
  },
  {
    id: 'product',
    label: 'Product sense',
    text: 'Include product sense questions.',
  },
  {
    id: 'leadership',
    label: 'Leadership',
    text: 'Include questions about leading people and projects.',
  },
] as const;
export type BadgeId = (typeof GUIDANCE_BADGES)[number]['id'];

/** The guidance sent to the model: chosen badges, the time, then anything typed. */
export function composeGuidance({
  badges,
  minutes,
  deepLoop,
  note,
}: {
  badges: readonly BadgeId[];
  minutes: number;
  deepLoop: boolean;
  note: string;
}) {
  const parts: string[] = GUIDANCE_BADGES.filter((badge) =>
    badges.includes(badge.id),
  ).map((badge) => badge.text);
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
