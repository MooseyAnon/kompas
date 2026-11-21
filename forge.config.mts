import type { ForgeConfig } from '@electron-forge/shared-types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { notarize } from '@electron/notarize';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { signingConfig, verifyAppleArtifact } from './scripts/macos-packaging';
import packageJSON from './package.json';

const signing = signingConfig();
const release = process.env.KOMPAS_RELEASE === '1';
let verifiedReleasePackage = false;

const config: ForgeConfig = {
  packagerConfig: {
    ...signing,
    asar: {
      // playwright-core must be loaded from real files on disk, not from inside
      // the ASAR: its in-process launcher resolves internal module paths at
      // launch time and silently loses its wiring when packed. The
      // AutoUnpackNatives plugin appends its own `*.node` glob to this value.
      unpack: '**/node_modules/playwright-core/**',
    },
    name: 'Kompas',
    appBundleId: 'com.kompas.kompas',
    icon: 'assets/branding/Kompas.icns',
    // macOS microphone permission (TCC) usage string. Shown when the renderer
    // first calls getUserMedia on the user's Record action. Merged into the
    // packaged app's Info.plist; no microphone access happens before this.
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Kompas records microphone audio only when you choose to record. Recordings are stored locally on this device and are never uploaded.',
    },
    // Stage 008.2: ship the provisioned offline speech-to-text engine resources
    // (pinned `whisper-cli` + `ggml-base.bin` + manifest) OUTSIDE the ASAR, in
    // `Contents/Resources/whisper`, so the executable can be spawned and the
    // model memory-mapped at runtime. These are produced by
    // `scripts/provision-whisper.mjs` and are not committed to Git; packaging
    // fails truthfully (missing resource) if provisioning has not been run.
    extraResource: ['resources/whisper'],
    // The Forge Vite plugin would otherwise ignore everything except `/.vite`,
    // which drops the externalised native SQLite driver. Keep `/.vite` and ship
    // better-sqlite3 (its N-API binary is ABI-stable across Node and Electron).
    ignore: (file: string): boolean => {
      if (!file) {
        return false;
      }
      if (file.startsWith('/.vite')) {
        return false;
      }
      if (file === '/package.json') {
        return false;
      }
      if (file === '/node_modules') {
        return false;
      }
      const sqlite = '/node_modules/better-sqlite3';
      if (file === sqlite || file.startsWith(`${sqlite}/`)) {
        return (
          ![
            sqlite,
            `${sqlite}/package.json`,
            `${sqlite}/LICENSE`,
            `${sqlite}/prebuilds`,
            `${sqlite}/prebuilds/darwin-arm64.node`,
          ].includes(file) && !file.startsWith(`${sqlite}/lib`)
        );
      }
      // Ship playwright-core (pure JS + its own Node driver). No browser binary
      // is bundled; the adapter launches an installed Chrome/Edge by channel.
      if (file.startsWith('/node_modules/playwright-core/lib/tools/skills')) {
        return true;
      }
      if (file.startsWith('/node_modules/playwright-core')) {
        return false;
      }
      if (file.startsWith('/node_modules/pdfjs-dist')) {
        return false;
      }
      return true;
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG(
      (arch) => ({
        name: `Kompas-${packageJSON.version}-mac-${arch}`,
        format: 'ULFO',
        overwrite: true,
      }),
      ['darwin'],
    ),
    new MakerZIP({}, ['darwin']),
  ],
  hooks: {
    prePackage: async (_config, platform, arch) => {
      if (platform !== 'darwin' || arch !== 'arm64') {
        throw new Error('Kompas distribution supports darwin-arm64 only');
      }
      execFileSync(
        process.execPath,
        ['scripts/provision-whisper.mjs', '--verify'],
        {
          stdio: 'pipe',
        },
      );
    },
    postPackage: async (_config, result) => {
      if (release) {
        for (const output of result.outputPaths) {
          verifyAppleArtifact(path.join(output, 'Kompas.app'), 'app');
        }
        verifiedReleasePackage = true;
      }
    },
    preMake: async () => {
      if (release && !verifiedReleasePackage) {
        throw new Error(
          'Signed make requires packaging and Apple verification in this run',
        );
      }
    },
    postMake: async (_config, results) => {
      for (const result of results) {
        for (let index = 0; index < result.artifacts.length; index++) {
          let artifact = result.artifacts[index];
          if (artifact.endsWith('.zip')) {
            const renamed = path.join(
              path.dirname(artifact),
              `Kompas-${result.packageJSON.version}-mac-arm64.zip`,
            );
            await fs.rename(artifact, renamed);
            result.artifacts[index] = artifact = renamed;
          }
          if (release && artifact.endsWith('.dmg')) {
            try {
              execFileSync(
                'codesign',
                [
                  '--force',
                  '--timestamp',
                  '--sign',
                  process.env.KOMPAS_SIGN_IDENTITY!,
                  ...(process.env.KOMPAS_SIGN_KEYCHAIN
                    ? ['--keychain', process.env.KOMPAS_SIGN_KEYCHAIN]
                    : []),
                  artifact,
                ],
                { stdio: 'pipe' },
              );
            } catch {
              throw new Error('DMG signing failed');
            }
            if (!signing.osxNotarize) {
              throw new Error(
                'Signed release requires notarisation configuration',
              );
            }
            await notarize({ appPath: artifact, ...signing.osxNotarize });
            verifyAppleArtifact(artifact, 'dmg');
          }
        }
      }
      return results;
    },
  },
  plugins: [
    // Unpack native modules (better-sqlite3's .node) from the ASAR so the
    // SQLite driver loads correctly in the packaged app.
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
        {
          // Inference utility-process worker. Emitted as a sibling of the main
          // bundle (`.vite/build/inference-worker.cjs`) and forked at runtime.
          entry: 'src/main/inference-worker/inference-worker.ts',
          config: 'vite.worker.config.mts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
