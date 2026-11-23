// Pure decisions for the GND onboarding: what to suggest from a CV draft, what
// the profile card shows, and what is written when the person approves it.
// No I/O here; Onboarding.tsx calls the API with these values.
import {
  CAREER_STAGES,
  applyImportInputSchema,
  newJobDiscoveryConfiguration,
  type ApplyImportInput,
  type CareerStage,
  type CvCandidate,
  type CvDraft,
  type JobDiscoveryConfigurationV1,
  type WorkArrangement,
} from '../../../../../shared/contracts';

/** A saved search accepts at most five distinct target roles. */
export const MAX_ROLES = 5;

export const WORK_ARRANGEMENT_OPTIONS: ReadonlyArray<{
  value: WorkArrangement;
  label: string;
  summary: string;
}> = [
  {
    value: 'any',
    label: 'Open to all',
    summary: 'Open to hybrid, remote & in person',
  },
  { value: 'remote', label: 'Remote', summary: 'Remote' },
  { value: 'hybrid', label: 'Hybrid', summary: 'Hybrid' },
  { value: 'on_site', label: 'In person', summary: 'In person' },
];

/** Only values the parser marked as detected are offered without review. */
export function detected(candidate: CvCandidate | undefined): string {
  return candidate?.status === 'detected' ? (candidate.value ?? '').trim() : '';
}

const SENIORITY =
  /^(senior|snr|sr\.?|junior|jnr|jr\.?|lead|staff|principal|head of|associate|graduate|chief)\s+/iu;

/** "Senior Product Designer" and "Product Designer" are one direction. */
function directionOf(title: string): string {
  let result = title.replace(/\s+/gu, ' ').trim();
  while (SENIORITY.test(result)) result = result.replace(SENIORITY, '');
  return result;
}

/**
 * Role directions from the CV itself: the current role first, then job and
 * project titles, newest first as the parser lists them. Deduplicated,
 * seniority removed, capped at the saved-search limit.
 */
export function suggestRoles(draft: CvDraft | null): string[] {
  if (!draft) return [];
  const titles = [
    detected(draft.profile.currentRole),
    ...(draft.details?.inferences ?? [])
      .filter((inference) => inference.field === 'currentRole')
      .map((inference) => inference.value),
    ...draft.experiences
      .filter((entry) => entry.category !== 'education')
      .map((entry) => detected(entry.roleTitle)),
  ];
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const title of titles) {
    const role = directionOf(title);
    const key = role.toLowerCase();
    if (!role || role.length > 200 || seen.has(key)) continue;
    seen.add(key);
    roles.push(role);
    if (roles.length === MAX_ROLES) break;
  }
  return roles;
}

/** Add a typed role unless it is blank, a duplicate, or over the limit. */
export function addRole(roles: string[], typed: string): string[] {
  const role = typed.replace(/\s+/gu, ' ').trim().slice(0, 200);
  if (!role || roles.length >= MAX_ROLES) return roles;
  if (roles.some((existing) => existing.toLowerCase() === role.toLowerCase()))
    return roles;
  return [...roles, role];
}

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value);

/**
 * The facts the profile card shows, written only when the person confirms
 * the card ("Looks right"). Undetected or invalid values are left out rather
 * than guessed, matching the Profile review rules.
 */
export function profileImportFrom(
  importId: string,
  draft: CvDraft,
): ApplyImportInput | null {
  const stage = detected(draft.profile.currentStage);
  const profile: ApplyImportInput['profile'] = {};
  const displayName = detected(draft.profile.displayName);
  const currentRole = detected(draft.profile.currentRole);
  const location = detected(draft.profile.location);
  const summary = detected(draft.profile.summary);
  if (displayName) profile.displayName = displayName;
  if (currentRole) profile.currentRole = currentRole;
  if (location) profile.location = location;
  if (summary) profile.summary = summary;
  if ((CAREER_STAGES as readonly string[]).includes(stage))
    profile.currentStage = stage as CareerStage;

  const experiences: ApplyImportInput['experiences'] = [];
  for (const entry of draft.experiences) {
    const roleTitle = detected(entry.roleTitle);
    if (!roleTitle) continue;
    const start = detected(entry.startDate);
    const end = detected(entry.endDate);
    const candidate: ApplyImportInput['experiences'][number] = {
      decision: 'add',
      value: {
        category: entry.category,
        roleTitle,
        organisation: detected(entry.organisation) || null,
        startDate: isIsoDate(start) ? start : null,
        endDate: isIsoDate(end) ? end : null,
        description: detected(entry.description),
      },
    };
    // Drop a single invalid entry instead of failing the whole confirmation.
    const single = applyImportInputSchema.safeParse({
      importId,
      profile: {},
      experiences: [candidate],
    });
    if (single.success) experiences.push(candidate);
  }

  const parsed = applyImportInputSchema.safeParse({
    importId,
    profile,
    experiences,
  });
  return parsed.success ? parsed.data : null;
}

export function skillsFrom(draft: CvDraft | null): string[] {
  if (!draft) return [];
  return [
    ...new Set(draft.extras.skills.map((skill) => detected(skill))),
  ].filter(Boolean);
}

export interface ProfileCard {
  name: string;
  details: string[];
  lookingFor: string;
  arrangement: string;
}

/** Card copy in the design's shape: "Bristol · BSc Computer Science". */
export function profileCard(
  draft: CvDraft | null,
  roles: string[],
  location: string,
  arrangement: WorkArrangement,
): ProfileCard {
  const name = detected(draft?.profile.displayName) || 'Your profile';
  const currentRole = detected(draft?.profile.currentRole);
  const education = draft?.experiences.find(
    (entry) => entry.category === 'education' && detected(entry.roleTitle),
  );
  const cvLocation = detected(draft?.profile.location);
  const details: string[] = [];
  const first = [cvLocation, currentRole || detected(education?.roleTitle)]
    .filter(Boolean)
    .join(' · ');
  if (first) details.push(first);
  if (education && currentRole) {
    const years = [
      detected(education.startDate).slice(0, 4),
      detected(education.endDate).slice(0, 4),
    ]
      .filter(Boolean)
      .join('–');
    const line = [detected(education.organisation), years]
      .filter(Boolean)
      .join(' · ');
    if (line) details.push(line);
  }
  const option =
    WORK_ARRANGEMENT_OPTIONS.find((item) => item.value === arrangement) ??
    WORK_ARRANGEMENT_OPTIONS[0];
  return {
    name,
    details,
    lookingFor: roles.join(' · '),
    arrangement: [location.trim(), option.summary].filter(Boolean).join(' · '),
  };
}

export function searchConfigFor(
  roles: string[],
  location: string,
  arrangement: WorkArrangement,
): JobDiscoveryConfigurationV1 {
  const base = newJobDiscoveryConfiguration();
  const targetRoles = roles.slice(0, MAX_ROLES);
  return {
    ...base,
    name: `${targetRoles[0] ?? 'My'} roles`.slice(0, 120),
    intent: {
      ...base.intent,
      targetRoles,
      location: location.trim().slice(0, 200) || null,
      workArrangement: arrangement,
    },
  };
}
