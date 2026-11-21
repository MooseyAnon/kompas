import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SmokeLifecycle } from '../scripts/smoke-lifecycle.mjs';

const lifecycles: SmokeLifecycle[] = [];
const harnesses: ChildProcess[] = [];
const moduleUrl = new URL('../scripts/smoke-lifecycle.mjs', import.meta.url)
  .href;

function lifecycle() {
  const owner = new SmokeLifecycle(process.execPath, {
    graceMs: 200,
    killMs: 2000,
  });
  lifecycles.push(owner);
  return owner;
}

async function launch(owner: SmokeLifecycle, profile: string, body = '') {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `${body}; process.stdout.write('ready'); setInterval(() => {}, 1000);`,
      '--',
      `--user-data-dir=${profile}`,
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  owner.ownChild(child, profile);
  const exited = once(child, 'exit');
  await once(child.stdout!, 'data');
  return { child, exited };
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    if (harness.exitCode === null && harness.signalCode === null)
      harness.kill('SIGKILL');
  }
  for (const owner of lifecycles.splice(0)) await owner.cleanup();
});

it('cleans multiple apps before removing fixtures, and is safe to repeat', async () => {
  const owner = lifecycle();
  const profile = owner.tempDirectory(
    path.join(os.tmpdir(), 'cw-cleanup-profile-'),
  );
  const fixture = owner.tempDirectory(
    path.join(os.tmpdir(), 'cw-cleanup-fixture-'),
  );
  const first = await launch(owner, profile);
  const second = await launch(owner, fixture);
  const server = createServer((_, response) => response.end('fixture'));
  owner.ownServer(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  const url = `http://127.0.0.1:${address.port}`;
  expect((await fetch(url)).status).toBe(200);

  const cleanup = owner.cleanup();
  expect(owner.cleanup()).toBe(cleanup);
  await cleanup;
  await Promise.all([first.exited, second.exited]);
  expect(fs.existsSync(profile)).toBe(false);
  expect(fs.existsSync(fixture)).toBe(false);
  await expect(fetch(url)).rejects.toThrow();
  expect(() =>
    owner.tempDirectory(path.join(os.tmpdir(), 'cw-too-late-')),
  ).toThrow(/cleanup/);
});

it('escalates for an unresponsive app and verifies its exit', async () => {
  const owner = lifecycle();
  const profile = owner.tempDirectory(
    path.join(os.tmpdir(), 'cw-cleanup-stubborn-'),
  );
  const app = await launch(owner, profile, `process.on('SIGTERM', () => {})`);
  await owner.cleanup();
  expect(await app.exited).toEqual([null, 'SIGKILL']);
});

it('handles an already-exited app and finds a replacement without its child handle', async () => {
  const owner = lifecycle();
  const unrelated = lifecycle();
  const profile = owner.tempDirectory(
    path.join(os.tmpdir(), 'cw-cleanup-relaunch-'),
  );
  const otherProfile = unrelated.tempDirectory(
    path.join(os.tmpdir(), 'cw-cleanup-unrelated-'),
  );
  const original = await launch(owner, profile);
  original.child.kill('SIGTERM');
  await original.exited;
  await owner.stopProfile(profile);
  const replacement = await launch(unrelated, profile);
  const otherApp = await launch(unrelated, otherProfile);

  await owner.cleanup();
  expect(await replacement.exited).toEqual([null, 'SIGTERM']);
  expect(otherApp.child.exitCode).toBeNull();
  expect(otherApp.child.signalCode).toBeNull();
  expect(fs.existsSync(otherProfile)).toBe(true);
});

it('terminates helpers in the private process group after the parent exits', async () => {
  const owner = lifecycle();
  const profile = owner.tempDirectory(
    path.join(os.tmpdir(), 'cw-cleanup-helper-'),
  );
  const app = await launch(
    owner,
    profile,
    `
    const { spawn } = require('node:child_process');
    const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    process.on('SIGTERM', () => process.exit(0));
  `,
  );
  await owner.cleanup();
  await app.exited;
  expect(fs.existsSync(profile)).toBe(false);
});

async function harness(mode: string) {
  // A separate Node runner tests real exit codes and OS signals without
  // changing Vitest's own process handlers or exit status.
  const fallback = lifecycle();
  const profile = fallback.tempDirectory(
    path.join(os.tmpdir(), 'cw-cleanup-runner-'),
  );
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { createServer } from 'node:http';
    import { SmokeLifecycle, runSmoke } from ${JSON.stringify(moduleUrl)};
    const owner = new SmokeLifecycle(process.execPath, { graceMs: 200, killMs: 2000 });
    await runSmoke(owner, async () => {
      const dir = ${JSON.stringify(profile)};
      owner.directories.add(dir);
      const app = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)", '--', '--user-data-dir=' + dir], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      owner.ownChild(app, dir);
      await once(app.stdout, 'data');
      const server = createServer((_, res) => res.end('ok'));
      owner.ownServer(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      console.log(JSON.stringify({ dir, pid: app.pid, port: server.address().port }));
      if (${JSON.stringify(mode)} === 'failure-cleanup') {
        await new Promise(resolve => server.close(resolve));
        throw new Error('original assertion before cleanup failure');
      }
      if (${JSON.stringify(mode)} === 'failure') throw new Error('deliberate assertion failure');
      if (${JSON.stringify(mode)} === 'startup') throw new Error('startup failed before returning session');
      if (${JSON.stringify(mode)}.startsWith('SIG')) await new Promise(() => {});
    });
  `,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  fallback.ownChild(child, profile);
  harnesses.push(child);
  const exited = once(child, 'exit');
  let output = '';
  let errors = '';
  child.stderr!.on('data', (data) => {
    errors += data;
  });
  const info = await new Promise<{ dir: string; pid: number; port: number }>(
    (resolve) => {
      child.stdout!.on('data', (data) => {
        output += data;
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]));
      });
    },
  );
  if (mode.startsWith('SIG')) child.kill(mode as NodeJS.Signals);
  const [code] = await exited;
  return { ...info, code, errors };
}

it.each([
  ['success', 0],
  ['failure', 1],
  ['startup', 1],
  ['failure-cleanup', 1],
  ['SIGINT', 130],
  ['SIGTERM', 143],
])(
  'cleans the real runner on %s and preserves exit code %s',
  async (mode, code) => {
    const result = await harness(mode);
    expect(result.code, result.errors).toBe(code);
    expect(fs.existsSync(result.dir)).toBe(false);
    expect(() => process.kill(result.pid, 0)).toThrow();
    await expect(fetch(`http://127.0.0.1:${result.port}`)).rejects.toThrow();
    if (mode === 'failure')
      expect(result.errors).toContain('deliberate assertion failure');
    if (mode === 'startup')
      expect(result.errors).toContain(
        'startup failed before returning session',
      );
    if (mode === 'failure-cleanup') {
      expect(result.errors).toContain(
        'original assertion before cleanup failure',
      );
      expect(result.errors).toContain('CLEANUP FAILED');
    }
  },
);
