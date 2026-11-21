import type {
  CvCandidate,
  CvDraft,
  CvDiagnostics,
} from '../../../shared/contracts';
import type { ExtractedDocument } from '../documents/extraction';

type Section =
  | 'employment'
  | 'education'
  | 'project'
  | 'skills'
  | 'summary'
  | 'contact';
type CvExperience = CvDraft['experiences'][number];
type CvProfile = CvDraft['profile'];
type ExperienceSection = Extract<Section, CvExperience['category']>;

const HEADINGS: Record<string, Section> = {
  experience: 'employment',
  'work experience': 'employment',
  employment: 'employment',
  'professional experience': 'employment',
  education: 'education',
  qualifications: 'education',
  projects: 'project',
  'personal projects': 'project',
  skills: 'skills',
  'technical skills': 'skills',
  profile: 'summary',
  summary: 'summary',
  'professional summary': 'summary',
  contact: 'contact',
};

const EXPERIENCE_SECTIONS: readonly ExperienceSection[] = [
  'employment',
  'education',
  'project',
];

const MAX_SKILLS = 50;
const MAX_EXPERIENCES = 40;

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const phonePattern =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{3,4}/;
const dateRange =
  /\b((?:19|20)\d{2}(?:-\d{2}(?:-\d{2})?)?)\s*(?:–|—|-|to)\s*((?:19|20)\d{2}(?:-\d{2}(?:-\d{2})?)?|present|current)\b/i;
const fullDate = /^\d{4}-\d{2}-\d{2}$/;

const missing = (): CvCandidate => ({
  value: null,
  status: 'missing',
  origin: null,
  evidence: null,
  blockIndex: null,
  reasons: ['not_present'],
});

function candidate(
  value: string | null,
  index: number,
  evidence: string,
  ambiguous = false,
  reason = 'structure_uncertain',
): CvCandidate {
  if (!value) return missing();

  return {
    value: value.slice(0, 1000),
    status: ambiguous ? 'ambiguous' : 'detected',
    origin: 'deterministic',
    evidence: evidence.slice(0, 500),
    blockIndex: index,
    reasons: ambiguous ? [reason] : [],
  };
}

/** A bare year or month is retained verbatim as ambiguous; never converted to January 1. */
function dateCandidate(
  value: string,
  index: number,
  line: string,
): CvCandidate {
  return candidate(
    value,
    index,
    line,
    !fullDate.test(value),
    'date_precision_unknown',
  );
}

function isExperienceSection(
  section: Section | null,
): section is ExperienceSection {
  return (EXPERIENCE_SECTIONS as readonly (Section | null)[]).includes(section);
}

/** Records labelled contact and profile fields; the first match for each field wins. */
function detectProfileFields(
  line: string,
  index: number,
  profile: CvProfile,
  extras: CvDraft['extras'],
): void {
  const email = line.match(emailPattern)?.[0];
  if (email && extras.email.status === 'missing')
    extras.email = candidate(email, index, line);

  const labelledPhone = line.match(/(?:phone|mobile|tel)\s*:\s*(.+)/i)?.[1];
  const phone = labelledPhone?.match(phonePattern)?.[0];
  if (phone && extras.phone.status === 'missing')
    extras.phone = candidate(phone, index, line);

  const location = line.match(/^(?:location|based in)\s*:\s*(.+)/i)?.[1];
  if (location && profile.location.status === 'missing')
    profile.location = candidate(location, index, line);

  const role = line.match(/^(?:current role|title)\s*:\s*(.+)/i)?.[1];
  if (role && profile.currentRole.status === 'missing')
    profile.currentRole = candidate(role, index, line);

  const name = line.match(/^name\s*:\s*(.+)/i)?.[1];
  if (name && profile.displayName.status === 'missing')
    profile.displayName = candidate(name, index, line);

  // An unlabelled first line that looks like a name is only an ambiguous guess.
  const looksLikeName =
    /^[\p{L}][\p{L}' .-]{2,100}$/u.test(line) && line.split(/\s+/).length <= 4;
  if (index === 0 && profile.displayName.status === 'missing' && looksLikeName)
    profile.displayName = candidate(line, index, line, true, 'unlabelled_name');
}

function collectSkills(
  line: string,
  index: number,
  skills: CvCandidate[],
): void {
  const names = line
    .replace(/^skills\s*:\s*/i, '')
    .split(/[,;•]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SKILLS - skills.length);

  for (const name of names) skills.push(candidate(name, index, line));
}

/**
 * Starts a new entry for "Role at Organisation" lines (or the first line of a
 * section) and attaches any date range to the current entry. Returns the
 * entry that subsequent lines should update.
 */
function collectExperience(
  line: string,
  index: number,
  category: ExperienceSection,
  current: CvExperience | null,
  experiences: CvExperience[],
): CvExperience {
  let entry = current;

  const labelled = line.match(/^(.{2,100}?)\s+(?:at|@|\|)\s+(.{2,100})$/i);
  if (labelled || !entry) {
    entry = {
      category,
      roleTitle: labelled
        ? candidate(labelled[1], index, line)
        : candidate(line.slice(0, 200), index, line, true),
      organisation: labelled ? candidate(labelled[2], index, line) : missing(),
      startDate: missing(),
      endDate: missing(),
      description: missing(),
    };
    experiences.push(entry);
  }

  const range = line.match(dateRange);
  if (range) {
    entry.startDate = dateCandidate(range[1], index, line);
    entry.endDate = dateCandidate(range[2], index, line);
  }

  return entry;
}

function diagnosticsFor(
  draft: CvDraft,
  extracted: ExtractedDocument,
): CvDiagnostics {
  const { profile, extras, experiences } = draft;
  const fields = [
    ...Object.values(profile),
    extras.email,
    extras.phone,
    ...extras.skills,
    ...experiences.flatMap((e) => [
      e.roleTitle,
      e.organisation,
      e.startDate,
      e.endDate,
      e.description,
    ]),
  ];

  const count = (status: CvCandidate['status']) =>
    fields.filter((c) => c.status === status).length;

  return {
    detected: count('detected'),
    ambiguous: count('ambiguous'),
    missing: count('missing'),
    modelAttempted: false,
    modelResolved: 0,
    modelStatus: 'not_needed',
    warnings: extracted.warnings,
    errorCode: null,
    durationMs: 0,
  };
}

/** Legacy deterministic, heading-driven CV parser (`cv-v1`). */
export function parseCv(extracted: ExtractedDocument): {
  draft: CvDraft;
  diagnostics: CvDiagnostics;
} {
  const profile: CvProfile = {
    displayName: missing(),
    currentRole: missing(),
    location: missing(),
    currentStage: missing(),
    summary: missing(),
  };
  const extras: CvDraft['extras'] = {
    email: missing(),
    phone: missing(),
    skills: [],
  };
  const experiences: CvExperience[] = [];

  let section: Section | null = null;
  let entry: CvExperience | null = null;

  for (const [index, block] of extracted.blocks.entries()) {
    const line = block.text.trim();
    if (!line) continue;

    const heading = HEADINGS[line.toLowerCase().replace(/:$/, '')];
    if (heading) {
      section = heading;
      entry = null;
      continue;
    }

    detectProfileFields(line, index, profile, extras);

    if (section === 'skills') collectSkills(line, index, extras.skills);

    if (section === 'summary' && profile.summary.status === 'missing')
      profile.summary = candidate(line, index, line);

    if (isExperienceSection(section) && experiences.length < MAX_EXPERIENCES)
      entry = collectExperience(line, index, section, entry, experiences);
  }

  const draft: CvDraft = {
    parserVersion: 'cv-v1',
    adapterId: extracted.adapterId,
    adapterVersion: extracted.adapterVersion,
    profile,
    experiences,
    extras,
  };

  return { draft, diagnostics: diagnosticsFor(draft, extracted) };
}
