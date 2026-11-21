// Packaged macOS journeys run against disposable user data, never a developer profile.
import { runSmoke } from './smoke-lifecycle.mjs';
import { createHarness } from './smoke/harness.mjs';
import { coreSmoke } from './smoke/core.mjs';
import { discoverySmoke, jobsSmoke } from './smoke/jobs.mjs';
import { applicationsSmoke } from './smoke/applications.mjs';
import { onboardingSmoke, profileSmoke } from './smoke/profile.mjs';
import { interviewsSmoke } from './smoke/interviews.mjs';
import { settingsSmoke, shellSmoke } from './smoke/shell.mjs';
import { resetSmoke } from './smoke/reset.mjs';

const journeys = {
  core: coreSmoke,
  discovery: discoverySmoke,
  jobs: jobsSmoke,
  'review-apply': (harness) => jobsSmoke(harness, true),
  applications: applicationsSmoke,
  shell: shellSmoke,
  profile: profileSmoke,
  onboarding: onboardingSmoke,
  settings: settingsSmoke,
  interviews: interviewsSmoke,
  reset: resetSmoke,
};

const phase = process.argv[2];
const harness = createHarness(phase);

await runSmoke(harness.lifecycle, async () => {
  if (process.argv.length !== 3 || !Object.hasOwn(journeys, phase)) {
    throw new Error(
      `Usage: node scripts/packaged-smoke.mjs ${Object.keys(journeys).join('|')}`,
    );
  }

  try {
    await journeys[phase](harness);
    console.log(`[smoke] ${phase.toUpperCase()} PASSED`);
  } catch (error) {
    try {
      await harness.captureFailure();
    } catch {
      console.error('[smoke] Failure artifacts unavailable');
    }

    throw error;
  } finally {
    await harness.close();
  }
});
