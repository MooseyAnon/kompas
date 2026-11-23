import type { SqliteDatabase } from '../../core/db/connection';
import { LOCAL_PROFILE_ID } from '../../core/db/database';
import { AppError } from '../../ipc/errors';
import { isExperienceDateRangeValid } from '../../../shared/contracts';
import type {
  ApplyImportInput,
  ApplyImportOutput,
  CareerStage,
  ExperienceCategory,
  Experience,
  Profile,
  Target,
} from '../../../shared/contracts';
import { pick } from './identity.helpers';

/** Resolved profile column changes (only present keys are written). */
export interface ProfileChanges {
  displayName?: string;
  currentStage?: CareerStage | null;
  currentRole?: string | null;
  location?: string | null;
  summary?: string | null;
  avatar?: string | null;
}

/** Resolved target column changes for create/update. */
export interface TargetChanges {
  roleTitle?: string;
  targetLevel?: string | null;
  sector?: string | null;
  location?: string | null;
  active?: boolean;
}

/** Resolved experience column changes for create/update. */
export interface ExperienceChanges {
  category?: ExperienceCategory;
  roleTitle?: string;
  organisation?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  description?: string;
}

interface ProfileRow {
  id: string;
  display_name: string;
  current_stage: string | null;
  current_role: string | null;
  location: string | null;
  summary: string | null;
  avatar: string | null;
  created_at: string;
  updated_at: string;
}

interface TargetRow {
  id: string;
  profile_id: string;
  role_title: string;
  target_level: string | null;
  sector: string | null;
  location: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

interface ExperienceRow {
  id: string;
  profile_id: string;
  category: ExperienceCategory;
  organisation: string | null;
  role_title: string;
  start_date: string | null;
  end_date: string | null;
  description: string;
  verification_status: 'user_confirmed' | 'unconfirmed';
  source_document_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ImportReceiptRow {
  request_json: string;
  result_json: string;
}

type ImportResult = Omit<ApplyImportOutput, 'alreadyApplied'>;

type AuditEntity = 'profile' | 'career_target' | 'experience';
type AuditAction = 'create' | 'update' | 'delete';

const PROFILE_NOT_FOUND = 'The local profile is not available.';
const TARGET_NOT_FOUND = 'That target could not be found.';
const EXPERIENCE_NOT_FOUND = 'That experience could not be found.';

/** Entity id used in audit rows for profile-level skill changes. */
const SKILLS_AUDIT_ENTITY_ID = 'local';

/**
 * Identity-owned repository for `profiles`, `career_targets` and
 * `experiences`. Every mutation writes a `profile_changes` audit snapshot in
 * the same transaction. All SQL is parameterised; no raw database handle is
 * exposed outside this module. Canonical facts change only through these
 * explicit, user-initiated operations.
 */
export class IdentityRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Idempotently apply a CV import. A stored receipt with an identical request
   * replays the original result; a differing request is a conflict. `apply`
   * runs inside the same transaction as the receipt write.
   */
  applyImport(
    input: ApplyImportInput,
    apply: () => ImportResult,
  ): ApplyImportOutput {
    return this.db.transaction((): ApplyImportOutput => {
      const request = JSON.stringify(input);
      const receipt = this.findImportReceipt(input.importId);

      if (receipt) {
        return replayImportReceipt(receipt, request);
      }

      const result = apply();
      this.saveImportReceipt(input.importId, request, result);

      return { ...result, alreadyApplied: false };
    })();
  }

  // --- profile --------------------------------------------------------------

  /** True once the single local profile row has been seeded. */
  hasLocalProfile(): boolean {
    return this.findProfileRow() !== undefined;
  }

  getProfile(): Profile {
    return mapProfile(this.requireProfileRow());
  }

  updateProfile(changes: ProfileChanges, now: string): Profile {
    const apply = this.db.transaction((): Profile => {
      const existing = this.requireProfileRow();
      const next = mergeProfileRow(existing, changes, now);

      this.db
        .prepare(
          `UPDATE profiles
             SET display_name = @display_name,
                 current_stage = @current_stage,
                 current_role = @current_role,
                 location = @location,
                 summary = @summary,
                 avatar = @avatar,
                 updated_at = @updated_at
           WHERE id = @id`,
        )
        .run(next);

      const before = mapProfile(existing);
      const after = mapProfile(next);
      this.recordChange('profile', after.id, 'update', before, after, now);

      return after;
    });

    return apply();
  }

  // --- targets --------------------------------------------------------------

  listTargets(): Target[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM career_targets
         WHERE profile_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(LOCAL_PROFILE_ID) as TargetRow[];

    return rows.map(mapTarget);
  }

  /** Read a single target by id, or null when it does not exist. */
  getTarget(id: string): Target | null {
    const row = this.findTargetRow(id);

    return row ? mapTarget(row) : null;
  }

  createTarget(id: string, changes: TargetChanges, now: string): Target {
    const apply = this.db.transaction((): Target => {
      const row = newTargetRow(id, changes, now);

      this.db
        .prepare(
          `INSERT INTO career_targets
             (id, profile_id, role_title, target_level, sector, location,
              active, created_at, updated_at)
           VALUES
             (@id, @profile_id, @role_title, @target_level, @sector, @location,
              @active, @created_at, @updated_at)`,
        )
        .run(row);

      const after = mapTarget(row);
      this.recordChange('career_target', after.id, 'create', null, after, now);

      return after;
    });

    return apply();
  }

  updateTarget(id: string, changes: TargetChanges, now: string): Target {
    const apply = this.db.transaction((): Target => {
      const existing = this.requireTargetRow(id);
      const next = mergeTargetRow(existing, changes, now);

      this.db
        .prepare(
          `UPDATE career_targets
             SET role_title = @role_title,
                 target_level = @target_level,
                 sector = @sector,
                 location = @location,
                 active = @active,
                 updated_at = @updated_at
           WHERE id = @id AND profile_id = @profile_id`,
        )
        .run(next);

      const before = mapTarget(existing);
      const after = mapTarget(next);
      this.recordChange(
        'career_target',
        after.id,
        'update',
        before,
        after,
        now,
      );

      return after;
    });

    return apply();
  }

  deleteTarget(id: string, now: string): void {
    const apply = this.db.transaction((): void => {
      const before = mapTarget(this.requireTargetRow(id));

      this.db
        .prepare('DELETE FROM career_targets WHERE id = ? AND profile_id = ?')
        .run(id, LOCAL_PROFILE_ID);

      this.recordChange('career_target', id, 'delete', before, null, now);
    });

    apply();
  }

  // --- skills ---------------------------------------------------------------

  listConfirmedSkills(): string[] {
    if (!this.hasLocalProfile()) {
      throw new AppError('NOT_FOUND', PROFILE_NOT_FOUND);
    }

    const rows = this.db
      .prepare(
        'SELECT name FROM identity_skills WHERE profile_id = ? ORDER BY name',
      )
      .all(LOCAL_PROFILE_ID) as { name: string }[];

    return rows.map((row) => row.name);
  }

  replaceConfirmedSkills(names: string[], at: string): string[] {
    return this.db.transaction((): string[] => {
      const before = this.listConfirmedSkills();

      this.db
        .prepare('DELETE FROM identity_skills WHERE profile_id = ?')
        .run(LOCAL_PROFILE_ID);

      const insert = this.db.prepare(
        'INSERT INTO identity_skills (profile_id, name) VALUES (?, ?)',
      );
      for (const name of names) {
        insert.run(LOCAL_PROFILE_ID, name);
      }

      const after = this.listConfirmedSkills();
      this.recordChange(
        'profile',
        SKILLS_AUDIT_ENTITY_ID,
        'update',
        { skills: before },
        { skills: after },
        at,
      );

      return after;
    })();
  }

  // --- experiences ----------------------------------------------------------

  listExperiences(): Experience[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM experiences
         WHERE profile_id = ?
         ORDER BY COALESCE(start_date, '') DESC, created_at ASC, rowid ASC`,
      )
      .all(LOCAL_PROFILE_ID) as ExperienceRow[];

    return rows.map(mapExperience);
  }

  createExperience(
    id: string,
    changes: ExperienceChanges,
    now: string,
    sourceDocumentId: string | null = null,
  ): Experience {
    const apply = this.db.transaction((): Experience => {
      const row = newExperienceRow(id, changes, now, sourceDocumentId);
      assertValidDateRange(row.start_date, row.end_date);

      this.db
        .prepare(
          `INSERT INTO experiences
             (id, profile_id, category, organisation, role_title, start_date,
              end_date, description, verification_status, source_document_id,
              created_at, updated_at)
           VALUES
             (@id, @profile_id, @category, @organisation, @role_title,
              @start_date, @end_date, @description, @verification_status,
              @source_document_id, @created_at, @updated_at)`,
        )
        .run(row);

      const after = mapExperience(row);
      this.recordChange('experience', after.id, 'create', null, after, now);

      return after;
    });

    return apply();
  }

  updateExperience(
    id: string,
    changes: ExperienceChanges,
    now: string,
  ): Experience {
    const apply = this.db.transaction((): Experience => {
      const existing = this.requireExperienceRow(id);
      const next = mergeExperienceRow(existing, changes, now);
      assertValidDateRange(next.start_date, next.end_date);

      this.db
        .prepare(
          `UPDATE experiences
             SET category = @category,
                 organisation = @organisation,
                 role_title = @role_title,
                 start_date = @start_date,
                 end_date = @end_date,
                 description = @description,
                 updated_at = @updated_at
           WHERE id = @id AND profile_id = @profile_id`,
        )
        .run(next);

      const before = mapExperience(existing);
      const after = mapExperience(next);
      this.recordChange('experience', after.id, 'update', before, after, now);

      return after;
    });

    return apply();
  }

  deleteExperience(id: string, now: string): void {
    const apply = this.db.transaction((): void => {
      const before = mapExperience(this.requireExperienceRow(id));

      this.db
        .prepare('DELETE FROM experiences WHERE id = ? AND profile_id = ?')
        .run(id, LOCAL_PROFILE_ID);

      this.recordChange('experience', id, 'delete', before, null, now);
    });

    apply();
  }

  // --- internals ------------------------------------------------------------

  private findImportReceipt(importId: string): ImportReceiptRow | undefined {
    return this.db
      .prepare(
        `SELECT request_json, result_json
           FROM identity_import_receipts
          WHERE import_id = ?`,
      )
      .get(importId) as ImportReceiptRow | undefined;
  }

  private saveImportReceipt(
    importId: string,
    request: string,
    result: ImportResult,
  ): void {
    this.db
      .prepare(
        `INSERT INTO identity_import_receipts
           (import_id, request_json, result_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(importId, request, JSON.stringify(result), new Date().toISOString());
  }

  private findProfileRow(): ProfileRow | undefined {
    return this.db
      .prepare('SELECT * FROM profiles WHERE id = ?')
      .get(LOCAL_PROFILE_ID) as ProfileRow | undefined;
  }

  private requireProfileRow(): ProfileRow {
    const row = this.findProfileRow();
    if (!row) {
      throw new AppError('NOT_FOUND', PROFILE_NOT_FOUND);
    }

    return row;
  }

  private findTargetRow(id: string): TargetRow | undefined {
    return this.db
      .prepare('SELECT * FROM career_targets WHERE id = ? AND profile_id = ?')
      .get(id, LOCAL_PROFILE_ID) as TargetRow | undefined;
  }

  private requireTargetRow(id: string): TargetRow {
    const row = this.findTargetRow(id);
    if (!row) {
      throw new AppError('NOT_FOUND', TARGET_NOT_FOUND);
    }

    return row;
  }

  private findExperienceRow(id: string): ExperienceRow | undefined {
    return this.db
      .prepare('SELECT * FROM experiences WHERE id = ? AND profile_id = ?')
      .get(id, LOCAL_PROFILE_ID) as ExperienceRow | undefined;
  }

  private requireExperienceRow(id: string): ExperienceRow {
    const row = this.findExperienceRow(id);
    if (!row) {
      throw new AppError('NOT_FOUND', EXPERIENCE_NOT_FOUND);
    }

    return row;
  }

  private recordChange(
    entity: AuditEntity,
    entityId: string,
    action: AuditAction,
    before: unknown,
    after: unknown,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO profile_changes
           (id, profile_id, entity_type, entity_id, action, before_json,
            after_json, origin, created_at)
         VALUES
           (@id, @profile_id, @entity_type, @entity_id, @action, @before_json,
            @after_json, 'user', @created_at)`,
      )
      .run({
        id: globalThis.crypto.randomUUID(),
        profile_id: LOCAL_PROFILE_ID,
        entity_type: entity,
        entity_id: entityId,
        action,
        before_json: before === null ? null : JSON.stringify(before),
        after_json: after === null ? null : JSON.stringify(after),
        created_at: now,
      });
  }
}

// --- import receipts ---------------------------------------------------------

function replayImportReceipt(
  receipt: ImportReceiptRow,
  request: string,
): ApplyImportOutput {
  if (receipt.request_json !== request) {
    throw new AppError(
      'CONFLICT',
      'This CV was already confirmed ' + 'with different choices.',
    );
  }

  const result = JSON.parse(receipt.result_json) as ImportResult;

  return { ...result, alreadyApplied: true };
}

// --- row builders ------------------------------------------------------------

/**
 * Present-key values are trusted as supplied: the service only sets these
 * keys with a defined value, so no runtime coercion is applied here.
 */
function required<V>(value: V | undefined): V {
  return value as V;
}

function orNull<V>(value: V | null | undefined): V | null {
  return value ?? null;
}

function mergeProfileRow(
  existing: ProfileRow,
  changes: ProfileChanges,
  now: string,
): ProfileRow {
  return {
    ...existing,
    display_name: pick(changes, 'displayName', required, existing.display_name),
    current_stage: pick(
      changes,
      'currentStage',
      orNull,
      existing.current_stage,
    ),
    current_role: pick(changes, 'currentRole', orNull, existing.current_role),
    location: pick(changes, 'location', orNull, existing.location),
    summary: pick(changes, 'summary', orNull, existing.summary),
    avatar: pick(changes, 'avatar', orNull, existing.avatar ?? null),
    updated_at: now,
  };
}

function newTargetRow(
  id: string,
  changes: TargetChanges,
  now: string,
): TargetRow {
  return {
    id,
    profile_id: LOCAL_PROFILE_ID,
    role_title: changes.roleTitle ?? '',
    target_level: changes.targetLevel ?? null,
    sector: changes.sector ?? null,
    location: changes.location ?? null,
    active: changes.active === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
}

function mergeTargetRow(
  existing: TargetRow,
  changes: TargetChanges,
  now: string,
): TargetRow {
  return {
    ...existing,
    role_title: pick(changes, 'roleTitle', required, existing.role_title),
    target_level: pick(changes, 'targetLevel', orNull, existing.target_level),
    sector: pick(changes, 'sector', orNull, existing.sector),
    location: pick(changes, 'location', orNull, existing.location),
    active: pick(changes, 'active', toActiveFlag, existing.active),
    updated_at: now,
  };
}

/** SQLite stores booleans as 0/1; any falsy patch value deactivates. */
function toActiveFlag(active: boolean | undefined): number {
  return active ? 1 : 0;
}

function newExperienceRow(
  id: string,
  changes: ExperienceChanges,
  now: string,
  sourceDocumentId: string | null,
): ExperienceRow {
  return {
    id,
    profile_id: LOCAL_PROFILE_ID,
    category: changes.category ?? 'other',
    organisation: changes.organisation ?? null,
    role_title: changes.roleTitle ?? '',
    start_date: changes.startDate ?? null,
    end_date: changes.endDate ?? null,
    description: changes.description ?? '',
    verification_status: 'user_confirmed',
    source_document_id: sourceDocumentId,
    created_at: now,
    updated_at: now,
  };
}

function mergeExperienceRow(
  existing: ExperienceRow,
  changes: ExperienceChanges,
  now: string,
): ExperienceRow {
  return {
    ...existing,
    category: pick(changes, 'category', required, existing.category),
    organisation: pick(changes, 'organisation', orNull, existing.organisation),
    role_title: pick(changes, 'roleTitle', required, existing.role_title),
    start_date: pick(changes, 'startDate', orNull, existing.start_date),
    end_date: pick(changes, 'endDate', orNull, existing.end_date),
    description: pick(changes, 'description', required, existing.description),
    updated_at: now,
  };
}

/** Reject an end date that precedes a known start date (matches the DB CHECK). */
function assertValidDateRange(start: string | null, end: string | null): void {
  if (!isExperienceDateRangeValid(start, end)) {
    throw new AppError(
      'INVALID_INPUT',
      'The end date cannot be before ' + 'the start date.',
    );
  }
}

// --- row mappers -------------------------------------------------------------

function mapProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    displayName: row.display_name,
    currentStage: (row.current_stage as CareerStage | null) ?? null,
    currentRole: row.current_role,
    location: row.location,
    summary: row.summary,
    avatar: row.avatar ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTarget(row: TargetRow): Target {
  return {
    id: row.id,
    profileId: row.profile_id,
    roleTitle: row.role_title,
    targetLevel: row.target_level,
    sector: row.sector,
    location: row.location,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExperience(row: ExperienceRow): Experience {
  return {
    id: row.id,
    profileId: row.profile_id,
    category: row.category,
    organisation: row.organisation,
    roleTitle: row.role_title,
    startDate: row.start_date,
    endDate: row.end_date,
    description: row.description,
    verificationStatus: row.verification_status,
    sourceDocumentId: row.source_document_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
