import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createAppDispatcher } from '../src/main/core/registry';
import type { Dispatcher } from '../src/main/ipc/dispatcher';
import type { ResponseEnvelope } from '../src/shared/contracts';

let workDir: string;
let storage: Storage;
let dispatcher: Dispatcher;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-identity-'));
  storage = openStorage(workDir);
  dispatcher = buildDispatcher(storage);
});

afterEach(() => {
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function buildDispatcher(active: Storage): Dispatcher {
  return createAppDispatcher({
    getAppVersion: () => '1.0.0',
    isStorageReady: () => true,
    storage: { db: active.db, fileStore: active.fileStore },
  });
}

async function send<T = unknown>(
  action: string,
  payload: unknown,
): Promise<ResponseEnvelope<T>> {
  return dispatcher.dispatch({
    requestId: crypto.randomUUID(),
    module: 'identity',
    version: 1,
    action,
    payload,
  }) as Promise<ResponseEnvelope<T>>;
}

function ok<T>(response: ResponseEnvelope<T>): T {
  if (!response.ok) {
    throw new Error(`expected ok, got ${response.error.code}`);
  }
  return response.data;
}

interface CountRow {
  count: number;
}

function auditCount(entity: string, action?: string): number {
  const sql = action
    ? `SELECT COUNT(*) AS count FROM profile_changes WHERE entity_type = ? AND action = ?`
    : `SELECT COUNT(*) AS count FROM profile_changes WHERE entity_type = ?`;
  const stmt = storage.db.prepare(sql);
  const row = (
    action ? stmt.get(entity, action) : stmt.get(entity)
  ) as CountRow;
  return row.count;
}

describe('identity profile', () => {
  it('returns the seeded local profile with empty fields', async () => {
    const data = await send<{ profile: { id: string; displayName: string } }>(
      'profile.get',
      {},
    );
    const { profile } = ok(data);
    expect(profile.id).toBe('local');
    expect(profile.displayName).toBe('');
  });

  it('updates profile fields, audits the change and persists across restart', async () => {
    const updated = ok(
      await send<{ profile: { displayName: string; currentStage: string } }>(
        'profile.update',
        {
          patch: {
            displayName: '  Ada Lovelace  ',
            currentStage: 'employed',
            currentRole: 'Data Analyst',
            location: 'London',
            summary: 'Analyst moving into data science.',
          },
        },
      ),
    ).profile;
    expect(updated.displayName).toBe('Ada Lovelace');
    expect(updated.currentStage).toBe('employed');
    expect(auditCount('profile', 'update')).toBe(1);

    // Reopen the database (simulated restart) and confirm durability.
    storage.close();
    storage = openStorage(workDir);
    dispatcher = buildDispatcher(storage);
    const reopened = ok(
      await send<{ profile: { displayName: string; currentRole: string } }>(
        'profile.get',
        {},
      ),
    ).profile;
    expect(reopened.displayName).toBe('Ada Lovelace');
    expect(reopened.currentRole).toBe('Data Analyst');
  });

  it('clears a nullable field with explicit null', async () => {
    await send('profile.update', { patch: { currentRole: 'Analyst' } });
    const cleared = ok(
      await send<{ profile: { currentRole: string | null } }>(
        'profile.update',
        { patch: { currentRole: null } },
      ),
    ).profile;
    expect(cleared.currentRole).toBeNull();
  });

  it('rejects an unknown career stage with INVALID_INPUT', async () => {
    const response = await send('profile.update', {
      patch: { currentStage: 'astronaut' },
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });
});

describe('identity targets', () => {
  it('represents a career change as current role plus a distinct target', async () => {
    await send('profile.update', { patch: { currentRole: 'Data Analyst' } });
    const target = ok(
      await send<{ item: { roleTitle: string } }>('targets.create', {
        roleTitle: 'Data Scientist',
      }),
    ).item;
    const profile = ok(
      await send<{ profile: { currentRole: string } }>('profile.get', {}),
    ).profile;
    expect(profile.currentRole).toBe('Data Analyst');
    expect(target.roleTitle).toBe('Data Scientist');
    expect(profile.currentRole).not.toBe(target.roleTitle);
  });

  it('creates, deactivates, deletes targets and records audit events', async () => {
    const first = ok(
      await send<{ item: { id: string } }>('targets.create', {
        roleTitle: 'Data Scientist',
        active: true,
      }),
    ).item;
    const second = ok(
      await send<{ item: { id: string } }>('targets.create', {
        roleTitle: 'ML Engineer',
      }),
    ).item;

    const deactivated = ok(
      await send<{ item: { active: boolean } }>('targets.update', {
        id: first.id,
        patch: { active: false },
      }),
    ).item;
    expect(deactivated.active).toBe(false);

    const deleted = ok(
      await send<{ deleted: true }>('targets.delete', { id: second.id }),
    );
    expect(deleted.deleted).toBe(true);

    const items = ok(
      await send<{ items: Array<{ id: string }> }>('targets.list', {}),
    ).items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(first.id);

    expect(auditCount('career_target', 'create')).toBe(2);
    expect(auditCount('career_target', 'update')).toBe(1);
    expect(auditCount('career_target', 'delete')).toBe(1);
  });

  it('rejects a blank role title with INVALID_INPUT', async () => {
    const response = await send('targets.create', { roleTitle: '   ' });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('returns NOT_FOUND for a nonexistent target id', async () => {
    const response = await send('targets.update', {
      id: crypto.randomUUID(),
      patch: { roleTitle: 'Nope' },
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns INVALID_INPUT for a malformed id', async () => {
    const response = await send('targets.delete', { id: 'not-a-uuid' });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });
});

describe('identity experiences', () => {
  it('creates, updates and deletes an experience with audit snapshots', async () => {
    const created = ok(
      await send<{ item: { id: string; roleTitle: string } }>(
        'experiences.create',
        {
          category: 'employment',
          roleTitle: 'Analyst',
          organisation: 'Acme',
          startDate: '2020-01-01',
          endDate: '2022-06-30',
          description: 'Reporting and dashboards.',
        },
      ),
    ).item;

    const updated = ok(
      await send<{ item: { roleTitle: string } }>('experiences.update', {
        id: created.id,
        patch: { roleTitle: 'Senior Analyst' },
      }),
    ).item;
    expect(updated.roleTitle).toBe('Senior Analyst');

    ok(await send<{ deleted: true }>('experiences.delete', { id: created.id }));
    const items = ok(
      await send<{ items: unknown[] }>('experiences.list', {}),
    ).items;
    expect(items).toHaveLength(0);

    expect(auditCount('experience', 'create')).toBe(1);
    expect(auditCount('experience', 'update')).toBe(1);
    expect(auditCount('experience', 'delete')).toBe(1);
  });

  it('defaults UI-created experiences to user_confirmed', async () => {
    const created = ok(
      await send<{ item: { verificationStatus: string } }>(
        'experiences.create',
        { category: 'project', roleTitle: 'Side project' },
      ),
    ).item;
    expect(created.verificationStatus).toBe('user_confirmed');
  });

  it('rejects an end date before the start date on create', async () => {
    const response = await send('experiences.create', {
      category: 'employment',
      roleTitle: 'Analyst',
      startDate: '2022-01-01',
      endDate: '2020-01-01',
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects an invalid date format', async () => {
    const response = await send('experiences.create', {
      category: 'employment',
      roleTitle: 'Analyst',
      startDate: '2022-13-40',
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects an end date before start when updating only the end date', async () => {
    const created = ok(
      await send<{ item: { id: string } }>('experiences.create', {
        category: 'employment',
        roleTitle: 'Analyst',
        startDate: '2021-01-01',
      }),
    ).item;
    const response = await send('experiences.update', {
      id: created.id,
      patch: { endDate: '2019-01-01' },
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('persists month and year precision across restart and permits overlapping ranges', async () => {
    const created = ok(
      await send<{ item: { id: string; startDate: string; endDate: string } }>(
        'experiences.create',
        {
          category: 'employment',
          roleTitle: 'Analyst',
          startDate: '2021-05-20',
          endDate: '2021-05',
        },
      ),
    ).item;
    expect(created.endDate).toBe('2021-05');
    storage.close();
    storage = openStorage(workDir);
    dispatcher = buildDispatcher(storage);
    const saved = ok(
      await send<{ items: Array<{ id: string; endDate: string }> }>(
        'experiences.list',
        {},
      ),
    ).items;
    expect(saved.find((item) => item.id === created.id)?.endDate).toBe(
      '2021-05',
    );
    const updated = ok(
      await send<{ item: { startDate: string } }>('experiences.update', {
        id: created.id,
        patch: { startDate: '2021' },
      }),
    ).item;
    expect(updated.startDate).toBe('2021');
    const reversed = await send('experiences.update', {
      id: created.id,
      patch: { endDate: '2020-12' },
    });
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.error.code).toBe('INVALID_INPUT');
  });
});
