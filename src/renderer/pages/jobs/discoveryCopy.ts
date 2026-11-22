import type { ResolutionDiagnostics } from '../../../shared/contracts/job-discovery';

/** The export contains only fields from the candidate-scoped diagnostic read. */
export function resolutionCopy(history: ResolutionDiagnostics): string {
  const lines = [
    `Source: ${history.source.provider} — ${history.source.discoveredUrl}`,
    `Attempts recorded: ${history.attempts.length} of ${history.totalAttempts}`,
  ];
  if (history.totalAttempts > history.attempts.length)
    lines.push('Detailed history not recorded for earlier attempt(s).');
  for (const attempt of history.attempts) {
    lines.push(
      `Attempt ${attempt.sequence} (${attempt.status}) — ${attempt.reason ?? 'reason unavailable'}`,
      `Source: ${attempt.provider} — ${attempt.discoveredUrl}`,
    );
    for (const search of attempt.searches) {
      lines.push(
        `  Query ${search.ordinal}: ${search.query}`,
        `  Search: ${search.status}${search.errorCode ? ` (${search.errorCode})` : ''}`,
      );
      for (const result of search.results)
        lines.push(
          `    ${result.ordinal}. ${result.url} — ${result.disposition}${result.reason ? ` (${result.reason})` : ''}`,
        );
    }
  }
  return lines.join('\n');
}

export function reasonText(code: string): string {
  const descriptions: Record<string, string> = {
    verified: 'Canonical page verified.',
    identity_mismatch: 'Page does not verify the listing identity.',
    not_job_description: 'Page is not an individual job description.',
    page_unavailable: 'Page could not be verified.',
    page_truncated: 'Page was truncated before verification.',
    capture_too_large: 'Page exceeds the capture limit.',
    missing_company: 'Employer information is missing.',
    query_too_long: 'Targeted search query is too long.',
    no_match: 'No verified canonical page was found.',
    search_budget_zero: 'No targeted searches were allowed by this run.',
    deadline_reached: 'The run deadline was reached.',
    DEADLINE_REACHED: 'The operation deadline was reached.',
    cancelled: 'Work was cancelled; saved evidence remains.',
    CANCELLED: 'Work was cancelled; saved evidence remains.',
    INTERRUPTED:
      'Work was interrupted. Start a new run to rediscover unfinished work.',
    MODEL_UNAVAILABLE: 'Local model unavailable. Check Local AI settings.',
    MODEL_FAILED: 'Local model failed. Check Local AI settings.',
    RESOURCE_LIMIT: 'Page exceeds the model resource limit.',
    JOB_CONTENT_UNAVAILABLE:
      'A single job description could not be isolated from this page.',
    JOB_CONTENT_INCOMPLETE:
      'The captured job content is incomplete or exceeds processing limits.',
    JOB_CONTENT_TOO_LARGE: 'The job description exceeds the processing limit.',
    MODEL_CONTEXT_UNAVAILABLE:
      'The model adapter could not report a usable context capacity.',
    JOB_CONTEXT_EXCEEDED:
      'The job description and response budget exceed the model context.',
    INVALID_SCHEMA: 'The model response could not be validated.',
    NOT_JOB_DESCRIPTION: 'The model did not find a job description.',
    WEB_RATE_LIMITED: 'Search provider rate limited this run.',
    WEB_CHALLENGE: 'A site challenge blocked access.',
    WEB_UNAVAILABLE: 'Web search is unavailable.',
    WEB_FAILED: 'Web search failed.',
    PAGE_BLOCKED: 'A page was blocked or challenged.',
    EXECUTION_FAILED: 'The discovery workflow failed.',
    INTERRUPTED_ON_RESTART: 'The app restarted during this run.',
    NO_REQUIRED_SKILLS: 'No supported required skills were extracted.',
    NO_CONFIRMED_SKILLS: 'No user-confirmed skills are recorded.',
    PROFILE_UNAVAILABLE: 'Confirmed skills could not be read.',
    NO_EXTRACTION: 'No current verified extraction is available.',
    MATCH_NOT_CURRENT: 'No current skill match is available.',
  };
  return descriptions[code] ?? code.replaceAll('_', ' ').toLowerCase();
}
