import {
  applyImportInputSchema,
  applyImportOutputSchema,
  summaryGenerateInputSchema,
  summaryGenerateOutputSchema,
  IDENTITY_API_VERSION,
  IDENTITY_MODULE_ID,
  experienceItemOutputSchema,
  experiencesCreateInputSchema,
  experiencesDeleteInputSchema,
  experiencesListInputSchema,
  experiencesListOutputSchema,
  experiencesUpdateInputSchema,
  deletedOutputSchema,
  profileGetInputSchema,
  profileGetOutputSchema,
  profileUpdateInputSchema,
  profileUpdateOutputSchema,
  targetItemOutputSchema,
  targetsCreateInputSchema,
  targetsDeleteInputSchema,
  targetsListInputSchema,
  targetsListOutputSchema,
  targetsUpdateInputSchema,
  skillsReplaceInputSchema,
  skillsOutputSchema,
} from '../../../shared/contracts';
import { defineCommand, type ModuleManifest } from '../../ipc/dispatcher';
import type { IdentityService } from './identity.service';
import {
  generateProfileSummary,
  type SummaryInference,
} from './identity.summary';

/** Build the statically-registered `identity` module manifest (API major v1). */
export function createIdentityModule(
  service: IdentityService,
  inference?: SummaryInference,
): ModuleManifest {
  return {
    id: IDENTITY_MODULE_ID,
    apiMajor: IDENTITY_API_VERSION,
    commands: {
      ...profileCommands(service, inference),
      ...targetCommands(service),
      ...experienceCommands(service),
    },
  };
}

/** Profile, confirmed skills, summary drafting and CV import confirmation. */
function profileCommands(
  service: IdentityService,
  inference?: SummaryInference,
): ModuleManifest['commands'] {
  return {
    'skills.list': defineCommand({
      input: profileGetInputSchema,
      output: skillsOutputSchema,
      handle: () => ({ names: service.listConfirmedSkills() }),
    }),
    'skills.replace': defineCommand({
      input: skillsReplaceInputSchema,
      output: skillsOutputSchema,
      handle: (input) => ({ names: service.replaceConfirmedSkills(input) }),
    }),
    'summary.generate': defineCommand({
      input: summaryGenerateInputSchema,
      output: summaryGenerateOutputSchema,
      handle: () => generateProfileSummary(service, inference),
    }),
    'profile.applyImport': defineCommand({
      input: applyImportInputSchema,
      output: applyImportOutputSchema,
      handle: (input) => service.applyImport(input),
    }),
    'profile.get': defineCommand({
      input: profileGetInputSchema,
      output: profileGetOutputSchema,
      handle: () => ({ profile: service.getProfile() }),
    }),
    'profile.update': defineCommand({
      input: profileUpdateInputSchema,
      output: profileUpdateOutputSchema,
      handle: (input) => ({ profile: service.updateProfile(input.patch) }),
    }),
  };
}

/** Career target CRUD. */
function targetCommands(service: IdentityService): ModuleManifest['commands'] {
  return {
    'targets.list': defineCommand({
      input: targetsListInputSchema,
      output: targetsListOutputSchema,
      handle: () => ({ items: service.listTargets() }),
    }),
    'targets.create': defineCommand({
      input: targetsCreateInputSchema,
      output: targetItemOutputSchema,
      handle: (input) => ({ item: service.createTarget(input) }),
    }),
    'targets.update': defineCommand({
      input: targetsUpdateInputSchema,
      output: targetItemOutputSchema,
      handle: (input) => ({
        item: service.updateTarget(input.id, input.patch),
      }),
    }),
    'targets.delete': defineCommand({
      input: targetsDeleteInputSchema,
      output: deletedOutputSchema,
      handle: (input) => {
        service.deleteTarget(input.id);

        return deleted();
      },
    }),
  };
}

/** Experience CRUD. */
function experienceCommands(
  service: IdentityService,
): ModuleManifest['commands'] {
  return {
    'experiences.list': defineCommand({
      input: experiencesListInputSchema,
      output: experiencesListOutputSchema,
      handle: () => ({ items: service.listExperiences() }),
    }),
    'experiences.create': defineCommand({
      input: experiencesCreateInputSchema,
      output: experienceItemOutputSchema,
      handle: (input) => ({ item: service.createExperience(input) }),
    }),
    'experiences.update': defineCommand({
      input: experiencesUpdateInputSchema,
      output: experienceItemOutputSchema,
      handle: (input) => ({
        item: service.updateExperience(input.id, input.patch),
      }),
    }),
    'experiences.delete': defineCommand({
      input: experiencesDeleteInputSchema,
      output: deletedOutputSchema,
      handle: (input) => {
        service.deleteExperience(input.id);

        return deleted();
      },
    }),
  };
}

function deleted(): { deleted: true } {
  return { deleted: true };
}
