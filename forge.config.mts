import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // playwright-core must be loaded from real files on disk, not from inside
      // the ASAR: its in-process launcher resolves internal module paths at
      // launch time and silently loses its wiring when packed. The
      // AutoUnpackNatives plugin appends its own `*.node` glob to this value.
      unpack: '**/node_modules/playwright-core/**',
    },
    name: 'Career Workspace',
    appBundleId: 'com.careerworkspace.app',
    // macOS microphone permission (TCC) usage string. Shown when the renderer
    // first calls getUserMedia on the user's Record action. Merged into the
    // packaged app's Info.plist; no microphone access happens before this.
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Career Workspace records microphone audio only when you choose to record a voice sample. Recordings are stored locally on this device and are never uploaded.',
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
      if (file.startsWith('/node_modules/better-sqlite3')) {
        return false;
      }
      // Ship playwright-core (pure JS + its own Node driver). No browser binary
      // is bundled; the adapter launches an installed Chrome/Edge by channel.
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
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
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
