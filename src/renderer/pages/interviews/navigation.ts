import { useCallback, useState } from 'react';
import { interviewSessionsGetInputSchema } from '../../../shared/contracts/interviews';

/**
 * In-memory navigation for the Interviews page. There is no URL router: the
 * Shell keeps the global destination and this page keeps its own location.
 *
 * - Prepare, History and Competencies are the only permanent tabs.
 * - A session view is entered by session id from a tab and remembers that tab;
 *   "Back" returns to it. A session is never a fourth tab.
 * - Navigating never calls the backend. Leaving the session view, or the
 *   Interviews page, does not pause, cancel or finish an interview.
 * - Leaving the Interviews destination discards this location; entering it
 *   again starts on Prepare.
 */
export const interviewTabIds = ['prepare', 'history', 'competencies'] as const;
export type InterviewsTab = (typeof interviewTabIds)[number];

export type InterviewsLocation =
  | { view: 'tab'; tab: InterviewsTab }
  | { view: 'session'; sessionId: string; returnTo: InterviewsTab };

export const initialInterviewsLocation: InterviewsLocation = {
  view: 'tab',
  tab: 'prepare',
};

export function isInterviewSessionId(value: string) {
  return interviewSessionsGetInputSchema.safeParse({ id: value }).success;
}

export function tabLocation(tab: InterviewsTab): InterviewsLocation {
  return { view: 'tab', tab };
}

/** Returns null for an id the backend contract would reject. */
export function sessionLocation(
  current: InterviewsLocation,
  sessionId: string,
): InterviewsLocation | null {
  if (!isInterviewSessionId(sessionId)) return null;

  const returnTo = current.view === 'tab' ? current.tab : current.returnTo;
  return { view: 'session', sessionId, returnTo };
}

export function backLocation(current: InterviewsLocation): InterviewsLocation {
  return current.view === 'session' ? tabLocation(current.returnTo) : current;
}

export function useInterviewsNavigation(
  initial: InterviewsLocation = initialInterviewsLocation,
) {
  const [location, setLocation] = useState<InterviewsLocation>(initial);

  const selectTab = useCallback(
    (tab: InterviewsTab) => setLocation(tabLocation(tab)),
    [],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      const next = sessionLocation(location, sessionId);
      if (next) setLocation(next);
      return next !== null;
    },
    [location],
  );

  const leaveSession = useCallback(
    () => setLocation((current) => backLocation(current)),
    [],
  );

  return { location, selectTab, openSession, leaveSession };
}
