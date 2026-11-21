import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { IdentityRepository } from '../src/main/modules/identity/identity.repository';
import { IdentityService } from '../src/main/modules/identity/identity.service';
import { generateProfileSummary } from '../src/main/modules/identity/identity.summary';
import type {
  ApplyImportInput,
  GenerationRequestInput,
} from '../src/shared/contracts';

let dir: string;
let storage: Storage;
let identity: IdentityService;
const importId = 'b2295d16-430f-490b-a3b1-4a447db4ddde';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-apply-'));
  storage = openStorage(dir);
  identity = new IdentityService(new IdentityRepository(storage.db), () => ({
    status: 'ready',
    draft: {},
    documentId: null,
  }));
});
afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function count(table: string): number {
  return (
    storage.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}
function input(): ApplyImportInput {
  return {
    importId,
    profile: { displayName: 'Edited Name', currentStage: 'career_change' },
    experiences: [
      {
        decision: 'add',
        value: {
          category: 'employment',
          roleTitle: 'Approved role',
          organisation: 'Edited company',
          startDate: '2020-01-01',
        },
      },
    ],
  };
}

it('commits only approved values with audit, survives restart and ignores repeat apply', () => {
  const approved = input();
  expect(count('profile_changes')).toBe(0);
  expect(identity.getProfile().displayName).toBe('');
  const first = identity.applyImport(approved);
  expect(first.alreadyApplied).toBe(false);
  expect(first.experiences[0].organisation).toBe('Edited company');
  expect(count('profile_changes')).toBe(2);
  storage.close();
  storage = openStorage(dir);
  identity = new IdentityService(
    new IdentityRepository(storage.db),
    () => null,
  );
  expect(identity.applyImport(approved).alreadyApplied).toBe(true);
  expect(count('profile_changes')).toBe(2);
  expect(count('experiences')).toBe(1);
  expect(() =>
    identity.applyImport({
      ...approved,
      profile: { displayName: 'Different' },
    }),
  ).toThrow();
});

it('rolls back profile and audit when an experience cannot be inserted', () => {
  const bad = input();
  bad.experiences.push({
    decision: 'add',
    value: {
      category: 'project',
      roleTitle: 'Bad range',
      startDate: '2025-01-01',
      endDate: '2020-01-01',
    },
  });
  expect(() => identity.applyImport(bad)).toThrow();
  expect(identity.getProfile().displayName).toBe('');
  expect(count('experiences')).toBe(0);
  expect(count('profile_changes')).toBe(0);
  expect(count('identity_import_receipts')).toBe(0);
});

it('adds approved skills with the profile and experiences atomically and only once', () => {
  identity.replaceConfirmedSkills({ names: ['SQL'] });
  const approved = { ...input(), skills: ['sql', 'TypeScript'] };
  const before = count('profile_changes');
  expect(identity.applyImport(approved).alreadyApplied).toBe(false);
  expect(identity.listConfirmedSkills()).toEqual(['SQL', 'TypeScript']);
  expect(count('profile_changes')).toBe(before + 3);
  expect(identity.applyImport(approved).alreadyApplied).toBe(true);
  expect(count('profile_changes')).toBe(before + 3);
  expect(count('identity_skills')).toBe(2);
});

it('rolls back profile and experience if the combined skills exceed the limit', () => {
  const existing = Array.from({ length: 99 }, (_, index) => `Skill ${index}`);
  identity.replaceConfirmedSkills({ names: existing });
  const before = count('profile_changes');
  expect(() =>
    identity.applyImport({ ...input(), skills: ['TypeScript', 'Rust'] }),
  ).toThrow();
  expect(identity.listConfirmedSkills()).toEqual([...existing].sort());
  expect(identity.getProfile().displayName).toBe('');
  expect(count('experiences')).toBe(0);
  expect(count('profile_changes')).toBe(before);
  expect(count('identity_import_receipts')).toBe(0);
});

it('keeps existing profile fields and explicitly keeps or replaces a matching experience', () => {
  identity.updateProfile({ displayName: 'Original', currentRole: 'Architect' });
  const original = identity.createExperience({
    category: 'employment',
    roleTitle: 'Researcher',
    organisation: 'Old employer',
  });
  const before = count('profile_changes');
  const applied = identity.applyImport({
    importId,
    profile: { location: 'Edited location' },
    experiences: [{ decision: 'keep', id: original.id }],
  });
  expect(applied.profile.displayName).toBe('Original');
  expect(applied.profile.currentRole).toBe('Architect');
  expect(count('experiences')).toBe(1);
  expect(count('profile_changes')).toBe(before + 1);
  expect(applied.experiences[0].id).toBe(original.id);
});

it('rejects unreviewed or invalid stage and preserves canonical state', () => {
  identity = new IdentityService(
    new IdentityRepository(storage.db),
    () => null,
  );
  expect(() => identity.applyImport(input())).toThrow();
  expect(count('profile_changes')).toBe(0);
  expect(() =>
    identity.applyImport({
      ...input(),
      profile: { currentStage: 'unrecognised' as 'other' },
    }),
  ).toThrow();
  expect(count('profile_changes')).toBe(0);
});

it('generates from confirmed context only and never saves the suggestion', async () => {
  identity.updateProfile({ currentRole: 'Analyst' });
  identity.createTarget({ roleTitle: 'Scientist' });
  const generate = vi.fn(async (_request: GenerationRequestInput) => ({
    requestId: crypto.randomUUID(),
    providerId: 'mock',
    modelId: 'local',
    status: 'completed' as const,
    output: { summary: 'Editable draft' },
    toolCalls: [],
    usage: null,
  }));
  const inference = {
    getSettingsSnapshot: async () => ({
      settings: {
        providerId: 'mock',
        modelId: 'local',
        mode: 'local_only' as const,
        generationTimeoutMs: 10000,
        updatedAt: '',
      },
      resolvedModel: {
        providerId: 'mock',
        id: 'local',
        displayName: 'Local',
        locality: 'local' as const,
        installed: true,
      },
      warnings: [],
    }),
    generate,
  };
  expect((await generateProfileSummary(identity, inference)).draft).toBe(
    'Editable draft',
  );
  expect(identity.getProfile().summary).toBeNull();
  const request = generate.mock.calls[0][0];
  expect(request.toolNames).toEqual([]);
  expect(request.messages[1].content).toContain('Scientist');
  expect(request.messages[1].content).not.toContain('Editable draft');
});
