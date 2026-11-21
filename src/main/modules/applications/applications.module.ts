import { z } from 'zod';
import {
  APPLICATIONS_API_VERSION,
  APPLICATIONS_MODULE_ID,
  manualCreateApplicationInput,
  updateApplicationInput,
  listApplicationsInput,
  applicationIdInput,
  manualCaptureInput,
  transitionInput,
  createNoteInput,
  updateNoteInput,
  removeNoteInput,
  linkDocumentInput,
  unlinkDocumentInput,
  applicationOutput,
  detailOutput,
  listOutput,
  stageOutput,
  noteOutput,
  documentOutput,
  snapshotOutput,
  doneOutput,
  importPreviewInput,
  importPreviewOutput,
} from '../../../shared/contracts';
import { defineCommand, type ModuleManifest } from '../../ipc/dispatcher';
import type { ApplicationsService } from './applications.service';
import type { ImportPreviewService } from './import-preview.service';

type Commands = ModuleManifest['commands'];

/** IPC manifest for Applications; `imports.preview` is only registered when a preview service is supplied. */
export function createApplicationsModule(
  service: ApplicationsService,
  preview?: ImportPreviewService,
): ModuleManifest {
  return {
    id: APPLICATIONS_MODULE_ID,
    apiMajor: APPLICATIONS_API_VERSION,
    commands: {
      ...(preview ? previewCommands(preview) : {}),
      ...applicationCommands(service),
      ...stageCommands(service),
      ...noteCommands(service),
      ...documentCommands(service),
    },
  };
}

function previewCommands(preview: ImportPreviewService): Commands {
  return {
    'imports.preview': defineCommand({
      input: importPreviewInput,
      output: importPreviewOutput,
      handle: (input) => preview.preview(input),
    }),
  };
}

function applicationCommands(service: ApplicationsService): Commands {
  return {
    create: defineCommand({
      input: manualCreateApplicationInput,
      output: detailOutput,
      handle: (input) => ({ item: service.create(input) }),
    }),
    update: defineCommand({
      input: updateApplicationInput,
      output: applicationOutput,
      handle: (input) => ({ item: service.update(input) }),
    }),
    list: defineCommand({
      input: listApplicationsInput,
      output: listOutput,
      handle: (input) => service.list(input),
    }),
    get: defineCommand({
      input: applicationIdInput,
      output: detailOutput,
      handle: ({ id }) => ({ item: service.get(id) }),
    }),
    archive: defineCommand({
      input: applicationIdInput,
      output: applicationOutput,
      handle: ({ id }) => ({ item: service.archive(id, true) }),
    }),
    restore: defineCommand({
      input: applicationIdInput,
      output: applicationOutput,
      handle: ({ id }) => ({ item: service.archive(id, false) }),
    }),
    'snapshot.capture': defineCommand({
      input: manualCaptureInput,
      output: snapshotOutput,
      handle: ({ id, snapshot }) => ({
        snapshot: service.capture(id, snapshot),
      }),
    }),
  };
}

function stageCommands(service: ApplicationsService): Commands {
  return {
    'stages.record': defineCommand({
      input: transitionInput,
      output: stageOutput,
      handle: (input) => ({ item: service.record(input) }),
    }),
    'stages.correct': defineCommand({
      input: transitionInput,
      output: stageOutput,
      handle: (input) => ({ item: service.correct(input) }),
    }),
    'stages.list': defineCommand({
      input: applicationIdInput,
      output: z.object({ items: z.array(stageOutput.shape.item) }),
      handle: ({ id }) => ({ items: service.get(id).stages }),
    }),
  };
}

function noteCommands(service: ApplicationsService): Commands {
  return {
    'notes.create': defineCommand({
      input: createNoteInput,
      output: noteOutput,
      handle: (input) => ({ item: service.createNote(input) }),
    }),
    'notes.update': defineCommand({
      input: updateNoteInput,
      output: noteOutput,
      handle: (input) => ({ item: service.updateNote(input) }),
    }),
    'notes.remove': defineCommand({
      input: removeNoteInput,
      output: doneOutput,
      handle: ({ applicationId, id }) => {
        service.removeNote(applicationId, id);
        return { done: true as const };
      },
    }),
  };
}

function documentCommands(service: ApplicationsService): Commands {
  return {
    'documents.link': defineCommand({
      input: linkDocumentInput,
      output: documentOutput,
      handle: (input) => ({ item: service.link(input) }),
    }),
    'documents.unlink': defineCommand({
      input: unlinkDocumentInput,
      output: doneOutput,
      handle: (input) => {
        service.unlink(input);
        return { done: true as const };
      },
    }),
  };
}
