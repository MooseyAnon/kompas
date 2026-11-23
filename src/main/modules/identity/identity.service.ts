import {
  applyImportInputSchema,
  isExperienceDateRangeValid,
  skillsReplaceInputSchema,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type {
  ApplyImportInput,
  ApplyImportOutput,
  Experience,
  ExperiencePatch,
  ExperiencesCreateInput,
  Profile,
  ProfilePatch,
  Target,
  TargetPatch,
  TargetsCreateInput,
} from '../../../shared/contracts';
import { emptyToNull, has, newId, now } from './identity.helpers';
import type {
  ExperienceChanges,
  IdentityRepository,
  ProfileChanges,
  TargetChanges,
} from './identity.repository';

/** Minimal view of a CV import that `applyImport` needs from its owner. */
interface ImportSource {
  draft: unknown;
  status: string;
  documentId: string | null;
}

type ImportLookup = (id: string) => ImportSource | null;

type ParsedApplyImport = ReturnType<typeof applyImportInputSchema.parse>;

type ExperienceChoice = ParsedApplyImport['experiences'][number];

/** Import statuses whose draft may be confirmed into canonical identity. */
const APPLICABLE_IMPORT_STATUSES = ['ready', 'partial'];

/**
 * In-process `identity` domain service. Normalises validated wire input into
 * resolved repository changes (trimming already done by Zod; empty strings for
 * nullable fields become explicit NULLs), mints ids and timestamps, and maps
 * repository results back to the wire shapes. All mutations are audited by the
 * repository within the same transaction.
 */
export class IdentityService {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly getImport?: ImportLookup,
  ) {}

  /**
   * Confirm user-reviewed CV import choices into canonical identity. Every
   * choice is validated before anything is written; the whole application is
   * idempotent per import id (see `IdentityRepository.applyImport`).
   */
  applyImport(input: ApplyImportInput): ApplyImportOutput {
    return this.repository.applyImport(input, () => {
      const source = this.requireApplicableImport(input.importId);
      const parsed = applyImportInputSchema.parse(input);
      const existing = this.listExperiences();

      assertValidExperienceChoices(parsed.experiences, existing);

      const profile = Object.keys(parsed.profile).length
        ? this.updateProfile(parsed.profile)
        : this.getProfile();

      const experiences = parsed.experiences.map((choice) =>
        this.applyExperienceChoice(choice, existing, source.documentId),
      );

      if (parsed.skills?.length) {
        this.replaceConfirmedSkills({
          names: [...this.listConfirmedSkills(), ...parsed.skills],
        });
      }

      return { profile, experiences };
    });
  }

  getProfile(): Profile {
    return this.repository.getProfile();
  }

  updateProfile(patch: ProfilePatch): Profile {
    const changes: ProfileChanges = {};

    if (has(patch, 'displayName')) {
      changes.displayName = patch.displayName ?? '';
    }

    if (has(patch, 'currentStage')) {
      changes.currentStage = patch.currentStage ?? null;
    }

    if (has(patch, 'currentRole')) {
      changes.currentRole = emptyToNull(patch.currentRole);
    }

    if (has(patch, 'location')) {
      changes.location = emptyToNull(patch.location);
    }

    if (has(patch, 'avatar')) {
      changes.avatar = patch.avatar ?? null;
    }
    if (has(patch, 'summary')) {
      changes.summary = emptyToNull(patch.summary);
    }

    return this.repository.updateProfile(changes, now());
  }

  listTargets(): Target[] {
    return this.repository.listTargets();
  }

  /**
   * Read-only resolution of a single career target by id (null if unknown).
   * Exposed as a typed in-process interface for other domain modules (e.g.
   * `interviews`) to snapshot approved target context without touching
   * identity-owned tables directly.
   */
  getTarget(id: string): Target | null {
    return this.repository.getTarget(id);
  }

  createTarget(input: TargetsCreateInput): Target {
    const changes: TargetChanges = {
      roleTitle: input.roleTitle,
      targetLevel: emptyToNull(input.targetLevel),
      sector: emptyToNull(input.sector),
      location: emptyToNull(input.location),
      active: input.active ?? true,
    };

    return this.repository.createTarget(newId(), changes, now());
  }

  updateTarget(id: string, patch: TargetPatch): Target {
    const changes: TargetChanges = {};

    if (has(patch, 'roleTitle')) {
      changes.roleTitle = patch.roleTitle;
    }

    if (has(patch, 'targetLevel')) {
      changes.targetLevel = emptyToNull(patch.targetLevel);
    }

    if (has(patch, 'sector')) {
      changes.sector = emptyToNull(patch.sector);
    }

    if (has(patch, 'location')) {
      changes.location = emptyToNull(patch.location);
    }

    if (has(patch, 'active')) {
      changes.active = patch.active;
    }

    return this.repository.updateTarget(id, changes, now());
  }

  deleteTarget(id: string): void {
    this.repository.deleteTarget(id, now());
  }

  listExperiences(): Experience[] {
    return this.repository.listExperiences();
  }

  /** Only explicitly approved skill names; no experience text or CV suggestions. */
  listConfirmedSkills(): string[] {
    return this.repository.listConfirmedSkills();
  }

  /**
   * Replace the confirmed skill set. Names are de-duplicated
   * case-insensitively, keeping the first spelling supplied.
   */
  replaceConfirmedSkills(raw: { names: string[] }): string[] {
    const { names } = skillsReplaceInputSchema.parse(raw);

    return this.repository.replaceConfirmedSkills(
      distinctIgnoringCase(names),
      now(),
    );
  }

  createExperience(
    input: ExperiencesCreateInput,
    sourceDocumentId: string | null = null,
  ): Experience {
    const changes: ExperienceChanges = {
      category: input.category,
      roleTitle: input.roleTitle,
      organisation: emptyToNull(input.organisation),
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      description: input.description ?? '',
    };

    return this.repository.createExperience(
      newId(),
      changes,
      now(),
      sourceDocumentId,
    );
  }

  updateExperience(id: string, patch: ExperiencePatch): Experience {
    const changes: ExperienceChanges = {};

    if (has(patch, 'category')) {
      changes.category = patch.category;
    }

    if (has(patch, 'roleTitle')) {
      changes.roleTitle = patch.roleTitle;
    }

    if (has(patch, 'organisation')) {
      changes.organisation = emptyToNull(patch.organisation);
    }

    if (has(patch, 'startDate')) {
      changes.startDate = patch.startDate ?? null;
    }

    if (has(patch, 'endDate')) {
      changes.endDate = patch.endDate ?? null;
    }

    if (has(patch, 'description')) {
      changes.description = patch.description;
    }

    return this.repository.updateExperience(id, changes, now());
  }

  deleteExperience(id: string): void {
    this.repository.deleteExperience(id, now());
  }

  // --- internals ------------------------------------------------------------

  private requireApplicableImport(importId: string): ImportSource {
    const source = this.getImport?.(importId);
    const isApplicable =
      !!source?.draft && APPLICABLE_IMPORT_STATUSES.includes(source.status);

    if (!source || !isApplicable) {
      throw new AppError(
        'CONFLICT',
        'The CV draft is unavailable ' + 'for confirmation.',
      );
    }

    return source;
  }

  private applyExperienceChoice(
    choice: ExperienceChoice,
    existing: Experience[],
    sourceDocumentId: string | null,
  ): Experience {
    switch (choice.decision) {
      case 'keep':
        // Presence was verified by assertValidExperienceChoices.
        return existing.find((item) => item.id === choice.id)!;
      case 'replace':
        return this.updateExperience(choice.id, choice.value);
      default:
        return this.createExperience(choice.value, sourceDocumentId);
    }
  }
}

/**
 * Each keep/replace choice must reference a distinct existing experience, and
 * every supplied (non-keep) date range must be ordered.
 */
function assertValidExperienceChoices(
  choices: ExperienceChoice[],
  existing: Experience[],
): void {
  const referencedIds = new Set<string>();

  for (const choice of choices) {
    if (choice.decision !== 'add') {
      const isDuplicate = referencedIds.has(choice.id);
      const isUnknown = !existing.some((item) => item.id === choice.id);

      if (isDuplicate || isUnknown) {
        throw new AppError(
          'INVALID_INPUT',
          'Choose each existing experience ' + 'at most once.',
        );
      }

      referencedIds.add(choice.id);
    }

    if (choice.decision !== 'keep' && hasInvalidDateRange(choice.value)) {
      throw new AppError(
        'INVALID_INPUT',
        'The end date cannot be before ' + 'the start date.',
      );
    }
  }
}

function hasInvalidDateRange(value: {
  startDate?: string | null;
  endDate?: string | null;
}): boolean {
  if (!value.startDate || !value.endDate) {
    return false;
  }

  return !isExperienceDateRangeValid(value.startDate, value.endDate);
}

function distinctIgnoringCase(names: string[]): string[] {
  const distinct = new Map<string, string>();

  for (const name of names) {
    const key = name.toLocaleLowerCase();
    if (!distinct.has(key)) {
      distinct.set(key, name);
    }
  }

  return [...distinct.values()];
}
