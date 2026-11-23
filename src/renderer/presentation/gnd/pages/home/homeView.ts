// Home decisions, kept pure so they can be tested without rendering.
import type { Application } from '../../../../../shared/contracts';

export interface ForYou {
  title: string;
  body: string;
  action: string;
  /** Jobs tab to open; none opens the For you list. */
  tab?: 'discover' | 'filters';
}

/**
 * The blue "For you" card. The design's "Two CVs ready to review" needs CV
 * tailoring, which the back end doesn't have yet, so the card points at the
 * most useful next step it can support today.
 */
export function forYou(
  newRoles: number,
  running: boolean,
  hasSearch: boolean,
): ForYou {
  if (newRoles > 0)
    return {
      title:
        newRoles === 1
          ? 'One new role to review'
          : `${newRoles} new roles to review`,
      body: 'See how well each matches your skills, then save or apply.',
      action: 'Review roles',
    };
  if (running)
    return {
      title: 'Finding roles for you',
      body: 'Your search is running. New roles will appear here as they’re found.',
      action: 'See progress',
      tab: 'discover',
    };
  if (!hasSearch)
    return {
      title: 'Tell us what you’re after',
      body: 'Add the roles you want, and Kompas will search for them.',
      action: 'Set up a search',
      tab: 'filters',
    };
  return {
    title: 'You’re all caught up',
    body: 'Run your search again to look for new roles.',
    action: 'Search again',
    tab: 'filters',
  };
}

/**
 * The interview to show: the soonest one still ahead, otherwise the most
 * recent one recorded. Only applications whose current stage is an interview.
 */
export function nextInterview(
  applications: Application[],
  now: Date,
): Application | null {
  const interviews = applications.filter(
    (item) => item.currentStage.stageKind === 'interview' && !item.archivedAt,
  );
  const time = (item: Application) => Date.parse(item.currentStage.occurredAt);
  const ahead = interviews
    .filter((item) => time(item) >= now.getTime())
    .sort((a, b) => time(a) - time(b));
  if (ahead.length) return ahead[0];
  return interviews.sort((a, b) => time(b) - time(a))[0] ?? null;
}
