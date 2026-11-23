// Your applications: grouping and profile-card copy. Pure, no I/O.
import type {
  Application,
  Experience,
  Profile,
  StageEvent,
  StageKind,
} from '../../../../../shared/contracts';

export type Filter = 'applied' | 'interviews' | 'saved' | 'archived';

export interface Groups {
  /** Sent and still open. */
  applied: Application[];
  interviews: Application[];
  /** Listing opened (tracked) but not sent yet. */
  openings: Application[];
  /** Closed (not successful, withdrawn) or put away by the user. */
  archived: Application[];
  /** Every application the user has sent, closed or not. */
  sentCount: number;
}

const CLOSED: readonly (StageKind | null)[] = ['rejected', 'withdrawn'];

export function isClosed(item: Application): boolean {
  return CLOSED.includes(item.currentStage.stageKind);
}

/**
 * Applied means the user told us they sent their application. A tracked role
 * still at the "saved" stage (they only opened the listing) is an opening.
 * Closed and archived applications live under Archived.
 */
export function groupApplications(
  items: Application[],
  archivedItems: Application[] = [],
): Groups {
  const isOpening = (item: Application) =>
    item.currentStage.stageKind === 'saved';
  const active = items.filter((item) => !item.archivedAt);
  const open = active.filter((item) => !isClosed(item));
  const archived = [
    ...active.filter(isClosed),
    ...archivedItems.filter((item) => item.archivedAt),
  ];
  return {
    applied: open.filter((item) => !isOpening(item)),
    interviews: open.filter(
      (item) => item.currentStage.stageKind === 'interview',
    ),
    openings: open.filter(isOpening),
    archived,
    sentCount:
      open.filter((item) => !isOpening(item)).length +
      archived.filter((item) => !isOpening(item)).length,
  };
}

/** Why an application is under Archived. */
export function archivedReason(item: Application): string {
  if (item.currentStage.stageKind === 'rejected') return 'Not successful';
  if (item.currentStage.stageKind === 'withdrawn') return 'You withdrew';
  return 'Archived by you';
}

// --- Stages ----------------------------------------------------------------

export const TRACKER_STEPS = [
  { kind: 'saved', label: 'Listing opened' },
  { kind: 'applied', label: 'Applied' },
  { kind: 'screening', label: 'Screening' },
  { kind: 'interview', label: 'Interview' },
  { kind: 'offer', label: 'Offer' },
] as const;

const STEP_OF: Partial<Record<StageKind, number>> = {
  saved: 0,
  applied: 1,
  screening: 2,
  interview: 3,
  assessment: 3,
  offer: 4,
};

/** Stage events that still stand: anything later corrected is dropped. */
export function standingStages(stages: StageEvent[]): StageEvent[] {
  const corrected = new Set(
    stages.map((stage) => stage.correctsEventId).filter(Boolean),
  );
  return stages.filter((stage) => !corrected.has(stage.id));
}

export type TrackerStep = {
  label: string;
  state: 'done' | 'now' | 'future';
  date: string | null;
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * The five-step tracker. The current step is the furthest stage reached; a
 * closed application stops at the last open step it reached.
 */
export function trackerFor(stages: StageEvent[]): {
  steps: TrackerStep[];
  closed: boolean;
} {
  const standing = [...standingStages(stages)].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
  );
  const last = standing[standing.length - 1];
  const closed = !!last && CLOSED.includes(last.stageKind);
  let reached = 0;
  for (const stage of standing) {
    const step = stage.stageKind ? STEP_OF[stage.stageKind] : undefined;
    if (step !== undefined) reached = Math.max(reached, step);
  }
  const steps = TRACKER_STEPS.map((step, index) => {
    const event = standing.find(
      (stage) => stage.stageKind && STEP_OF[stage.stageKind] === index,
    );
    const state: TrackerStep['state'] =
      index < reached || (closed && index === reached)
        ? 'done'
        : index === reached
          ? 'now'
          : 'future';
    return {
      label: step.label,
      state,
      date: event
        ? shortDate(event.occurredAt)
        : state === 'done'
          ? 'Skipped'
          : null,
    };
  });
  return { steps, closed };
}

/** The pill for the current stage, e.g. "Interview · Portfolio review". */
export function stageName(stage: Pick<StageEvent, 'stageKind' | 'stageLabel'>) {
  const generic: Partial<Record<StageKind, string>> = {
    saved: 'Listing opened',
    applied: 'Applied',
    screening: 'Screening call',
    interview: 'Interview',
    assessment: 'Task or assessment',
    offer: 'Offer',
    rejected: 'Not successful',
    withdrawn: 'You withdrew',
  };
  const base = stage.stageKind ? generic[stage.stageKind] : undefined;
  if (!base) return stage.stageLabel;
  const label = stage.stageLabel.trim();
  if (
    stage.stageKind === 'interview' &&
    label &&
    label.toLowerCase() !== 'interview'
  )
    return `Interview · ${label}`;
  return base;
}

export type HistoryItem = {
  id: string;
  title: string;
  detail: string;
  date: string;
  corrected: boolean;
};

/** History, newest first; corrected entries stay, marked as corrected. */
export function historyFor(stages: StageEvent[]): HistoryItem[] {
  const corrected = new Set(
    stages.map((stage) => stage.correctsEventId).filter(Boolean),
  );
  return [...stages]
    .sort(
      (a, b) =>
        Date.parse(b.recordedAt) - Date.parse(a.recordedAt) ||
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
    )
    .map((stage) => ({
      id: stage.id,
      title: stageName(stage),
      detail: corrected.has(stage.id)
        ? 'Corrected'
        : stage.correctsEventId
          ? 'Fixed by you'
          : stage.source === 'user'
            ? 'By you'
            : 'Added automatically',
      date: whenText(stage.occurredAt),
      corrected: corrected.has(stage.id),
    }));
}

/** "5 Nov 2026", or "Tue 25 Nov 2026, 14:00" when a time was given. */
export function whenText(iso: string): string {
  const date = new Date(iso);
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
  const day = date.toLocaleDateString('en-GB', {
    ...(hasTime ? { weekday: 'short' } : {}),
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return hasTime
    ? `${day}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : day;
}

// --- Interviews agenda -------------------------------------------------------

export type AgendaEvent = {
  id: string;
  applicationId: string;
  title: string;
  role: string;
  time: string | null;
  at: number;
  past: boolean;
};

export type AgendaDay = {
  key: string;
  weekday: string;
  day: string;
  month: string;
  past: boolean;
  events: AgendaEvent[];
};

/** Interview events across applications, grouped by day: upcoming first. */
export function agendaFor(
  details: { application: Application; stages: StageEvent[] }[],
  now: Date,
): { upcoming: AgendaDay[]; earlier: AgendaDay[] } {
  const events: AgendaEvent[] = [];
  for (const { application, stages } of details) {
    for (const stage of standingStages(stages)) {
      if (stage.stageKind !== 'interview') continue;
      const at = Date.parse(stage.occurredAt);
      const date = new Date(at);
      const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
      const label = stage.stageLabel.trim() || 'Interview';
      events.push({
        id: stage.id,
        applicationId: application.id,
        title: `${label} – ${application.companyName}`,
        role: application.roleTitle,
        time: hasTime
          ? date.toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : null,
        at,
        past: at < now.getTime() - 60 * 60 * 1000,
      });
    }
  }
  const byDay = (list: AgendaEvent[], past: boolean) => {
    const days = new Map<string, AgendaDay>();
    for (const event of list) {
      const date = new Date(event.at);
      const key = date.toDateString();
      if (!days.has(key))
        days.set(key, {
          key,
          weekday: date.toLocaleDateString('en-GB', { weekday: 'short' }),
          day: String(date.getDate()),
          month: date.toLocaleDateString('en-GB', { month: 'short' }),
          past,
          events: [],
        });
      days.get(key)!.events.push(event);
    }
    return [...days.values()];
  };
  const upcoming = events
    .filter((event) => !event.past)
    .sort((a, b) => a.at - b.at);
  const earlier = events
    .filter((event) => event.past)
    .sort((a, b) => b.at - a.at);
  return { upcoming: byDay(upcoming, false), earlier: byDay(earlier, true) };
}

/** Upcoming interviews first (soonest first), then past ones (latest first). */
export function sortInterviews(items: Application[], now: Date): Application[] {
  const time = (item: Application) => Date.parse(item.currentStage.occurredAt);
  const ahead = items
    .filter((item) => time(item) >= now.getTime())
    .sort((a, b) => time(a) - time(b));
  const past = items
    .filter((item) => time(item) < now.getTime())
    .sort((a, b) => time(b) - time(a));
  return [...ahead, ...past];
}

/** "Tue 25 Nov 2026, 14:00" for an interview, or the date alone at midnight. */
export function interviewWhen(item: Application): string {
  const date = new Date(item.currentStage.occurredAt);
  const day = date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
  return hasTime
    ? `${day}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : day;
}

/** Interview practice set up for one role. */
export function practiceFor(
  item: Pick<Application, 'roleTitle' | 'companyName'>,
  method: 'quick_fire' | 'deep_loop',
) {
  const role = `${item.roleTitle} at ${item.companyName}`;
  return {
    method,
    subject: role,
    guidance:
      method === 'deep_loop'
        ? `A mock interview for the ${item.roleTitle} role at ${item.companyName}.`
        : `Questions for the ${item.roleTitle} role at ${item.companyName}.`,
  };
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** "Bristol · BSc Computer Science · Example University · 2023–2026". */
export function profileLine(
  profile: Profile,
  experiences: Experience[],
): string {
  const education = experiences
    .filter((item) => item.category === 'education')
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
  const years = education
    ? [education.startDate?.slice(0, 4), education.endDate?.slice(0, 4)]
        .filter(Boolean)
        .join('–')
    : '';
  return [
    profile.location,
    education ? null : profile.currentRole,
    education?.roleTitle,
    education?.organisation,
    years,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Marked as applied by you · 5 Nov 2026". */
export function appliedLine(item: Application): string {
  const when = item.appliedAt ?? item.currentStage.occurredAt;
  const date = new Date(when).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const who = item.currentStage.source === 'user' ? 'by you' : '';
  return [`Marked as ${item.currentStage.stageLabel.toLowerCase()}`, who]
    .filter(Boolean)
    .join(' ')
    .concat(` · ${date}`);
}
