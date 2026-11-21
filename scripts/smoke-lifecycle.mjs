import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function forgetProfileChildren(children, profile) {
  for (const [child, ownedProfile] of children) {
    if (ownedProfile === profile) {
      children.delete(child);
    }
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

async function processTable() {
  const { stdout } = await exec(
    'ps',
    ['-axo', 'pid=,ppid=,pgid=,stat=,command='],
    { timeout: 2000 },
  );

  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match || match[4].startsWith('Z')) return [];

    return [
      {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        command: match[5],
      },
    ];
  });
}

/** Resources belong to one smoke invocation, including partially launched apps. */
export class SmokeLifecycle {
  constructor(binary, { graceMs = 4000, killMs = 2000 } = {}) {
    this.binary = binary;
    this.graceMs = graceMs;
    this.killMs = killMs;
    this.controller = new AbortController();
    this.children = new Map();
    this.profiles = new Set();
    this.directories = new Set();
    this.connections = new Set();
    this.servers = new Set();
    this.stopping = new Map();
    this.cleanupErrors = [];
  }

  get signal() {
    return this.controller.signal;
  }

  check() {
    this.signal.throwIfAborted();
    if (this.cleaning) throw new Error('Smoke cleanup has started');
  }

  tempDirectory(prefix) {
    this.check();
    const directory = fs.mkdtempSync(prefix);
    this.directories.add(directory);

    return directory;
  }

  ownChild(child, profile) {
    this.check();
    this.ownProfile(profile);
    this.children.set(child, profile);
  }

  ownProfile(profile) {
    this.check();
    this.profiles.add(profile);
  }

  ownConnection(ws) {
    this.check();
    this.connections.add(ws);
    ws.addEventListener('close', () => this.connections.delete(ws), {
      once: true,
    });
  }

  ownServer(server) {
    this.check();
    this.servers.add(server);
  }

  async stopProfile(profile) {
    if (this.stopping.has(profile)) return this.stopping.get(profile);

    const stopping = this.terminateProfile(profile);
    this.stopping.set(profile, stopping);

    try {
      await stopping;
    } finally {
      this.stopping.delete(profile);
    }
  }

  async terminateProfile(profile) {
    const groups = new Set(
      [...this.children]
        .filter(([, ownedProfile]) => ownedProfile === profile)
        .map(([child]) => child.pid)
        .filter(Boolean),
    );
    const known = new Set();
    const started = Date.now();
    let emptySince;

    while (Date.now() - started < this.graceMs + this.killMs) {
      const table = await processTable();
      const owned = new Set(
        table
          .filter(
            (item) =>
              groups.has(item.group) ||
              known.has(item.pid) ||
              (item.command.startsWith(`${this.binary} `) &&
                (item.command.endsWith(`--user-data-dir=${profile}`) ||
                  item.command.includes(`--user-data-dir=${profile} `))),
          )
          .map((item) => item.pid),
      );

      // Include workers and browser children, even if they use a new group.
      let changed;

      do {
        changed = false;

        for (const item of table) {
          if (owned.has(item.parent) && !owned.has(item.pid)) {
            owned.add(item.pid);
            changed = true;
          }
        }
      } while (changed);

      if (owned.size === 0) {
        emptySince ??= Date.now();

        // app.relaunch() can briefly leave only its relaunch helper alive.
        if (Date.now() - emptySince >= 200) {
          forgetProfileChildren(this.children, profile);

          return;
        }
      } else {
        emptySince = undefined;
        const signal =
          Date.now() - started < this.graceMs ? 'SIGTERM' : 'SIGKILL';

        for (const pid of owned) {
          known.add(pid);
          signalProcess(pid, signal);
        }
      }

      await sleep(50);
    }

    throw new Error(`Smoke app did not exit for profile ${profile}`);
  }

  cleanup() {
    this.cleaning ??= this.cleanupResources();

    return this.cleaning;
  }

  async cleanupResources() {
    const attempt = async (operation) => {
      try {
        await operation();
      } catch (error) {
        this.cleanupErrors.push(error);
      }
    };
    const liveProfiles = new Set();

    for (const profile of this.profiles) {
      try {
        await this.stopProfile(profile);
      } catch (error) {
        liveProfiles.add(profile);
        this.cleanupErrors.push(error);
      }
    }

    for (const ws of this.connections) await attempt(() => ws.close());

    for (const server of this.servers) {
      await attempt(
        () =>
          new Promise((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      );
    }

    for (const directory of this.directories) {
      // Never remove a database while its app may still be using it.
      if (!liveProfiles.has(directory)) {
        await attempt(() =>
          fs.rmSync(directory, { recursive: true, force: true }),
        );
      }
    }

    if (this.cleanupErrors.length)
      throw new AggregateError(this.cleanupErrors, 'Smoke cleanup failed');
  }
}

/** Signals, assertions and ordinary exceptions all converge on the same cleanup. */
export async function runSmoke(lifecycle, workflow, report = console.error) {
  let interrupted;
  let rejectInterrupt;
  const interruption = new Promise((_, reject) => {
    rejectInterrupt = reject;
  });

  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    const error = new Error(`Smoke interrupted by ${signal}`);
    lifecycle.controller.abort(error);
    rejectInterrupt(error);
  };

  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  try {
    await Promise.race([Promise.resolve().then(workflow), interruption]);
  } catch (error) {
    report(`[smoke] FAIL: ${error?.stack || error}`);
    process.exitCode =
      interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
  } finally {
    try {
      await lifecycle.cleanup();
    } catch (error) {
      report(`[smoke] CLEANUP FAILED: ${error?.stack || error}`);
      for (const cause of error.errors ?? [])
        report(`[smoke] ${cause?.message || cause}`);
      process.exitCode ||= 1;
    }

    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}
