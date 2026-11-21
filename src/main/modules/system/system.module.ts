import {
  SYSTEM_API_VERSION,
  SYSTEM_MODULE_ID,
  systemPingInputSchema,
  systemPingOutputSchema,
  onboardingStatusInputSchema,
  onboardingStatusOutputSchema,
} from '../../../shared/contracts';
import type { ModuleManifest } from '../../ipc/dispatcher';
import { SystemService } from './system.service';

/** Build the statically-registered `system` module manifest (API major v1). */
export function createSystemModule(service: SystemService): ModuleManifest {
  return {
    id: SYSTEM_MODULE_ID,
    apiMajor: SYSTEM_API_VERSION,
    commands: {
      ping: {
        input: systemPingInputSchema,
        output: systemPingOutputSchema,
        handle: () => service.ping(),
      },
      'onboarding.status.get': {
        input: onboardingStatusInputSchema,
        output: onboardingStatusOutputSchema,
        handle: () => service.onboardingStatus(),
      },
      'onboarding.complete': {
        input: onboardingStatusInputSchema,
        output: onboardingStatusOutputSchema,
        handle: () => service.completeOnboarding(),
      },
    },
  };
}
