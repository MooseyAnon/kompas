import { describe, expect, it, vi } from 'vitest';
import {
  jsonSchemaObjectSchema,
  type JsonValue,
  type GenerationResult,
} from '../src/shared/contracts';
import type { GenerationEntry } from '../src/main/modules/inference/generation-scheduler';
import {
  safeParseJson,
  validateAgainstJsonSchema,
} from '../src/main/modules/inference/json-schema';
import {
  CvModelError,
  fullCvSchema,
  interpretFullCv,
} from '../src/main/modules/cv-imports/full-cv';
import type { ExtractedDocument } from '../src/main/modules/documents/extraction';
import { openStorage } from '../src/main/core/storage';
import { CvImportsRepository } from '../src/main/modules/cv-imports/cv-imports.repository';
import { CvImportsService } from '../src/main/modules/cv-imports/cv-imports.service';
import { parseCv } from '../src/main/modules/cv-imports/parser';
import * as legacyParser from '../src/main/modules/cv-imports/parser';
import { FULL_CV_VERSION } from '../src/main/modules/cv-imports/full-cv';
import {
  MockProvider,
  MOCK_MODELS,
} from '../src/main/modules/inference/mock-provider';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const lines = [
  'Alex Morgan',
  'alex.morgan@example.org',
  '+44 7700 900123',
  'Cardiff, UK',
  'Engineering student interested in robotics and automation.',
  'Robotics Intern',
  'Example Robotics Laboratory',
  'Jun 2025',
  'Sep 2025',
  'Built prototype sensor integrations',
  'Data Analyst',
  'Example Analytics',
  '2022',
  '2024',
  'Cardiff University',
  '2026',
  'present',
  'BEng Mechanical Engineering',
  'University of Bristol',
  '2020',
  '2021',
  'BSc Mathematics',
  'Fusion 360',
  'CAD modelling and assemblies',
  'Sensor-driven robot arm',
  'Arduino',
];
const extracted: ExtractedDocument = {
  adapterId: 'fake',
  adapterVersion: '1',
  quality: 'usable',
  warnings: [],
  text: lines.join('\n'),
  blocks: lines.map((text) => ({ text, kind: 'line' })),
};
const output = {
  name: lines[0],
  email: lines[1],
  phoneNumber: lines[2],
  location: lines[3],
  summary: lines[4],
  experience: [
    {
      title: lines[5],
      companyName: lines[6],
      startDate: lines[7],
      endDate: lines[8],
      experienceDetail: [lines[9]],
    },
    {
      title: lines[10],
      companyName: lines[11],
      startDate: lines[12],
      endDate: lines[13],
      experienceDetail: [],
    },
  ],
  education: [
    {
      schoolName: lines[14],
      startDate: lines[15],
      endDate: lines[16],
      qualifications: [lines[17]],
    },
    {
      schoolName: lines[18],
      startDate: lines[19],
      endDate: lines[20],
      qualifications: [lines[21]],
    },
  ],
  skills: [{ skillName: lines[22], extraInformation: [lines[23]] }],
  projects: [{ name: lines[24], description: [], technologies: [lines[25]] }],
  inferences: [
    {
      field: 'currentStage',
      value: 'student',
      reason: 'Ongoing degree',
      evidence: 'Cardiff University',
    },
  ],
};
function section(pass: string): Record<string, JsonValue> {
  switch (pass) {
    case 'personal':
      return {
        name: output.name,
        email: output.email,
        phoneNumber: output.phoneNumber,
        location: output.location,
        summary: output.summary,
        inferences: output.inferences,
      };
    case 'employment':
      return { experience: output.experience };
    case 'education':
      return { education: output.education };
    case 'skills-projects':
      return { skills: output.skills, projects: output.projects };
    default:
      throw new Error(`Unexpected CV pass: ${pass}`);
  }
}
function client(result: unknown = section) {
  const generate = vi.fn(
    async (
      request: GenerationEntry,
      _controls?: { signal?: AbortSignal },
    ): Promise<GenerationResult> => ({
      requestId: crypto.randomUUID(),
      providerId: 'mock',
      modelId: 'mock-cv',
      status: 'completed' as const,
      output: (typeof result === 'function'
        ? result(request.messages[0].content.split('/')[1].split('.')[0])
        : result) as JsonValue,
      toolCalls: [],
      usage: null,
    }),
  );
  return {
    generate,
    getSettingsSnapshot: vi.fn(async () => ({
      settings: {
        providerId: 'mock',
        modelId: 'mock-cv',
        generationTimeoutMs: 5000,
        mode: 'local_only' as const,
        updatedAt: '',
      },
      resolvedModel: {
        providerId: 'mock',
        id: 'mock-cv',
        installed: true,
        locality: 'local' as const,
        displayName: 'Mock',
      },
      warnings: [],
    })),
  };
}

describe('bounded recursive inference schema', () => {
  it('validates nested CV output and old scalar/array shapes', () => {
    expect(jsonSchemaObjectSchema.safeParse(fullCvSchema).success).toBe(true);
    expect(validateAgainstJsonSchema(output, fullCvSchema).ok).toBe(true);
    const old = jsonSchemaObjectSchema.parse({
      type: 'object',
      properties: {
        count: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['count'],
    });
    expect(validateAgainstJsonSchema({ count: 2, tags: ['ok'] }, old).ok).toBe(
      true,
    );
    expect(validateAgainstJsonSchema({ count: 2.5 }, old).ok).toBe(false);
  });
  it('rejects forbidden/deep/unknown/oversized and malformed values and schemas', () => {
    expect(
      validateAgainstJsonSchema({ ...output, extra: 1 }, fullCvSchema).ok,
    ).toBe(false);
    expect(
      validateAgainstJsonSchema(
        {
          ...output,
          education: [{ ...output.education[0], qualifications: [3] }],
        },
        fullCvSchema,
      ).ok,
    ).toBe(false);
    expect(
      validateAgainstJsonSchema(
        {
          ...output,
          inferences: [{ ...output.inferences[0], field: 'targetRole' }],
        },
        fullCvSchema,
      ).ok,
    ).toBe(false);
    expect(
      validateAgainstJsonSchema(
        { ...output, summary: 'x'.repeat(5001) },
        fullCvSchema,
      ).ok,
    ).toBe(false);
    expect(
      validateAgainstJsonSchema(
        {
          ...output,
          projects: [
            {
              ...output.projects[0],
              technologies: [JSON.parse('{"__proto__":1}')],
            },
          ],
        },
        fullCvSchema,
      ).ok,
    ).toBe(false);
    expect(safeParseJson('{"a":{"constructor":{}}}')).toBeUndefined();
    expect(safeParseJson('x'.repeat(200001))).toBeUndefined();
    expect(
      jsonSchemaObjectSchema.safeParse({
        type: 'object',
        properties: { bad: { type: 'string', pattern: '.*' } },
      }).success,
    ).toBe(false);
    let deep: unknown = { type: 'string' };
    for (let i = 0; i < 12; i++) deep = { type: 'array', items: deep };
    expect(
      jsonSchemaObjectSchema.safeParse({ type: 'object', properties: { deep } })
        .success,
    ).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`p${i}`, { type: 'string' }]),
    );
    expect(
      jsonSchemaObjectSchema.safeParse({ type: 'object', properties: many })
        .success,
    ).toBe(false);
  });
});

describe('LLM-first CV projection', () => {
  it('drafts a personal summary and retains named project technologies as deduplicated skills', async () => {
    const source = {
      ...extracted,
      blocks: [
        {
          text: 'ROS 2 and NVIDIA Isaac research-lab exposure; Fusion 360 CAD modelling.',
          kind: 'line' as const,
        },
        {
          text: 'Temperature monitoring: Arduino, DS18B20, AMG8833, LCD and LED.',
          kind: 'line' as const,
        },
      ],
    };
    const inference = client((pass: string) => {
      if (pass === 'personal')
        return {
          ...section(pass),
          summary:
            'Robotics-focused engineer with hands-on project experience.',
          inferences: [],
        };
      if (pass === 'skills-projects')
        return {
          ...section(pass),
          skills: [
            { skillName: 'ROS 2', extraInformation: [] },
            { skillName: 'NVIDIA Isaac', extraInformation: [] },
            { skillName: 'Fusion 360', extraInformation: [] },
            { skillName: 'Arduino', extraInformation: [] },
          ],
          projects: [
            {
              name: 'Temperature monitoring',
              description: [],
              technologies: ['Arduino', 'DS18B20', 'AMG8833', 'LCD', 'LED'],
            },
          ],
        };
      return section(pass);
    });
    const { draft } = await interpretFullCv(
      source,
      inference,
      new AbortController().signal,
    );
    expect(draft.profile.summary).toMatchObject({
      status: 'needs_review',
      reasons: ['model_generated_summary'],
      evidence: null,
    });
    expect(draft.extras.skills.map((skill) => skill.value)).toEqual([
      'ROS 2',
      'NVIDIA Isaac',
      'Fusion 360',
      'Arduino',
      'DS18B20',
      'AMG8833',
      'LCD',
      'LED',
    ]);
    expect(draft.details?.projects[0].technologies).toEqual([
      'Arduino',
      'DS18B20',
      'AMG8833',
      'LCD',
      'LED',
    ]);
    expect(
      draft.extras.skills.find((skill) => skill.value === 'DS18B20')?.status,
    ).toBe('detected');
    expect(
      draft.extras.skills.find((skill) => skill.value === 'ROS 2')?.status,
    ).toBe('detected');
  });

  it('rejects a failing later pass instead of returning a partial assembled draft', async () => {
    const inference = client((pass: string) =>
      pass === 'education' ? { invalid: true } : section(pass),
    );
    await expect(
      interpretFullCv(extracted, inference, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(inference.generate).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['personal', { ...section('personal'), unexpected: 'extra' }, 1],
    ['employment', {}, 2],
    [
      'education',
      { education: [{ ...output.education[0], qualifications: [3] }] },
      3,
    ],
    [
      'skills-projects',
      {
        skills: Array.from({ length: 51 }, () => output.skills[0]),
        projects: [],
      },
      4,
    ],
  ])(
    'rejects an invalid %s section immediately',
    async (pass, invalid, calls) => {
      const inference = client((name: string) =>
        name === pass ? invalid : section(name),
      );
      await expect(
        interpretFullCv(extracted, inference, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(inference.generate).toHaveBeenCalledTimes(calls);
      const request = inference.generate.mock.calls[calls - 1][0];
      if (request.responseFormat?.type !== 'json_schema')
        throw new Error('Missing section schema');
      expect(
        validateAgainstJsonSchema(invalid, request.responseFormat.schema).ok,
      ).toBe(false);
    },
  );

  it('merges only each pass’s owned fields and combines duplicate skill context', async () => {
    const inference = client((pass: string) =>
      pass === 'skills-projects'
        ? {
            skills: [
              { skillName: 'Arduino', extraInformation: ['embedded work'] },
              { skillName: ' arduino ', extraInformation: ['project work'] },
            ],
            projects: output.projects,
          }
        : section(pass),
    );
    const { draft } = await interpretFullCv(
      extracted,
      inference,
      new AbortController().signal,
    );
    expect(draft.profile.displayName.value).toBe('Alex Morgan');
    expect(
      draft.experiences.map((entry) => entry.roleTitle.value),
    ).not.toContain('Unrelated job');
    expect(
      draft.experiences.map((entry) => entry.organisation.value),
    ).not.toContain('Unrelated school');
    expect(draft.extras.skills.map((skill) => skill.value)).toEqual([
      'Arduino',
    ]);
    expect(draft.details?.skills).toEqual([['embedded work', 'project work']]);
    expect(draft.details?.projects).toEqual([
      { description: [], technologies: ['Arduino'] },
    ]);
  });

  it('uses four focused requests and all source blocks, preserving dates and details', async () => {
    const inference = client();
    const { draft, diagnostics } = await interpretFullCv(
      extracted,
      inference,
      new AbortController().signal,
    );
    expect(inference.generate).toHaveBeenCalledTimes(4);
    const request = inference.generate.mock.calls[0][0];
    for (const [index, pass] of [
      'personal',
      'employment',
      'education',
      'skills-projects',
    ].entries()) {
      const call = inference.generate.mock.calls[index][0];
      expect(call.messages[0].content).toContain(`${FULL_CV_VERSION}/${pass}`);
      expect(call.messages[1].content).toContain(lines[25]);
      if (call.responseFormat?.type !== 'json_schema')
        throw new Error('Missing section schema');
      const schema = call.responseFormat.schema;
      expect(jsonSchemaObjectSchema.safeParse(schema).success).toBe(true);
      expect(Object.keys(schema.properties)).toEqual(
        [
          ['name', 'email', 'phoneNumber', 'location', 'summary', 'inferences'],
          ['experience'],
          ['education'],
          ['skills', 'projects'],
        ][index],
      );
      expect(validateAgainstJsonSchema(section(pass), schema).ok).toBe(true);
      expect(validateAgainstJsonSchema(output, schema).ok).toBe(false);
    }
    expect(request.toolNames).toEqual([]);
    expect(request.thinking).toBe(false);
    expect(
      request.responseFormat?.type === 'json_schema' &&
        request.responseFormat.schema,
    ).not.toEqual(fullCvSchema);
    expect(draft.parserVersion).toBe(FULL_CV_VERSION);
    expect(draft.profile.summary.value).toBe(lines[4]);
    expect(draft.profile.summary).toMatchObject({
      status: 'needs_review',
      reasons: ['model_generated_summary'],
      evidence: null,
    });
    expect(draft.experiences.map((e) => e.startDate.value)).toEqual([
      'Jun 2025',
      '2022',
      '2026',
      '2020',
      null,
    ]);
    expect(draft.experiences[3].organisation.value).toBe(
      'University of Bristol',
    );
    expect(draft.experiences[3].startDate.status).toBe('needs_review');
    expect(draft.details?.education[1]).toEqual(['BSc Mathematics']);
    expect(draft.details?.projects[0].technologies).toEqual(['Arduino']);
    expect(draft.extras.skills.map((skill) => skill.value)).toEqual([
      'Fusion 360',
      'Arduino',
    ]);
    expect(draft.details?.inferences[0].field).toBe('currentStage');
    expect(draft.profile.currentStage.value).toBeNull();
    expect(diagnostics.modelStatus).toBe('succeeded');
  });
  it('keeps the offline CV provider compatible with all four section schemas', async () => {
    const inference = client();
    await interpretFullCv(extracted, inference, new AbortController().signal);
    const provider = new MockProvider();
    for (const [request] of inference.generate.mock.calls) {
      const result = await provider.generate(
        { ...request, modelId: MOCK_MODELS.cv },
        { signal: new AbortController().signal, onDelta: () => {} },
      );
      expect(result.status).toBe('completed');
      if (
        result.status !== 'completed' ||
        request.responseFormat?.type !== 'json_schema'
      )
        continue;
      expect(
        validateAgainstJsonSchema(
          result.output as JsonValue,
          request.responseFormat.schema,
        ).ok,
      ).toBe(true);
    }
  });
  it('matches quotes across split ligatures and odd apostrophes', async () => {
    const source: ExtractedDocument = {
      ...extracted,
      blocks: [
        {
          kind: 'paragraph',
          paragraph: 1,
          text: 'fi nancial crime checks for Dojo ʼ s merchants',
        },
        ...extracted.blocks,
      ],
    };
    const evidence = "financial crime checks for Dojo's merchants";
    const { draft } = await interpretFullCv(
      source,
      client((pass: string) =>
        pass === 'personal'
          ? {
              ...section(pass),
              inferences: [{ ...output.inferences[0], evidence }],
            }
          : section(pass),
      ),
      new AbortController().signal,
    );
    expect(draft.details?.inferences[0].evidence).toBe(evidence);
  });
  it('asks the model for a context window big enough for the CV', async () => {
    const inference = {
      ...client(),
      getModelDetails: vi.fn(async () => ({
        maxContextTokens: 32_768,
        configuredContextTokens: null,
        supportsContextOverride: true,
      })),
    };
    await interpretFullCv(extracted, inference, new AbortController().signal);
    const request = inference.generate.mock.calls[0][0];
    expect(request.limits?.contextTokens).toBeGreaterThanOrEqual(8_192);
    expect(request.limits?.contextTokens).toBeLessThanOrEqual(32_768);
  });
  it.each([
    ['"[paragraph 1] Mechanical & Electrical Engineering Student"', true],
    ['[paragraph 1] Mechanical & Electrical Engineering Student', true],
    ['“[paragraph 1] Mechanical & Electrical Engineering Student”', true],
    ['"[paragraph 1]"', false],
    ['[paragraph 1]', false],
    ['"[paragraph 1] Invented qualification"', false],
  ])(
    'checks inference evidence against serialized CV text: %s',
    async (evidence, valid) => {
      const source: ExtractedDocument = {
        ...extracted,
        blocks: [
          {
            kind: 'paragraph',
            paragraph: 1,
            text: 'Mechanical & Electrical Engineering Student',
          },
          ...extracted.blocks,
        ],
      };
      const inference = client((pass: string) =>
        pass === 'personal'
          ? {
              ...section(pass),
              inferences: [{ ...output.inferences[0], evidence }],
            }
          : section(pass),
      );
      const run = interpretFullCv(
        source,
        inference,
        new AbortController().signal,
      );
      if (valid) {
        const { draft } = await run;
        expect(draft.details?.inferences[0].evidence).toBe(evidence);
        expect(inference.generate).toHaveBeenCalledTimes(4);
      } else {
        // An ungrounded suggestion is dropped; the rest of the CV still reads.
        const { draft } = await run;
        expect(draft.details?.inferences ?? []).toHaveLength(0);
        expect(inference.generate).toHaveBeenCalledTimes(4);
      }
    },
  );
  it('fails visibly on unavailable model, unsupported values, cancelled and oversize; drops unquoted suggestions', async () => {
    await expect(
      interpretFullCv(extracted, undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    const dropped = await interpretFullCv(
      extracted,
      client((pass: string) =>
        pass === 'personal'
          ? {
              ...section(pass),
              inferences: [
                { ...output.inferences[0], evidence: 'invented quote' },
              ],
            }
          : section(pass),
      ),
      new AbortController().signal,
    );
    expect(dropped.draft.details?.inferences ?? []).toHaveLength(0);
    await expect(
      interpretFullCv(
        extracted,
        client((pass: string) =>
          pass === 'personal'
            ? { ...section(pass), email: 'invalid' }
            : section(pass),
        ),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      interpretFullCv(extracted, client(), aborted.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(
      interpretFullCv(
        { ...extracted, blocks: [{ text: 'x'.repeat(20000), kind: 'line' }] },
        client(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(CvModelError).toBeDefined();
  });
  it('stops before another pass when the shared deadline has expired', async () => {
    const inference = client();
    await expect(
      interpretFullCv(
        extracted,
        inference,
        new AbortController().signal,
        Date.now() - 1,
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(inference.generate).not.toHaveBeenCalled();
  });

  it('cancels the full operation during a later pass', async () => {
    const controller = new AbortController();
    const inference = client();
    const generate = inference.generate.getMockImplementation()!;
    inference.generate.mockImplementation(async (request) => {
      const result = await generate(request);
      if (request.messages[0].content.includes('/employment.'))
        controller.abort();
      return result;
    });
    await expect(
      interpretFullCv(extracted, inference, controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(inference.generate).toHaveBeenCalledTimes(2);
  });

  it('times out a CV parse after 180 seconds', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-llm-timeout-'));
    try {
      const storage = openStorage(dir);
      try {
        const documentId = crypto.randomUUID();
        storage.db
          .prepare(
            'INSERT INTO documents (id, profile_id, category, original_name, media_type, relative_path, sha256, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            documentId,
            'local',
            'cv',
            'fixture.pdf',
            'application/pdf',
            `originals/${documentId}.pdf`,
            'a'.repeat(64),
            42,
            new Date().toISOString(),
          );
        const inference = client();
        inference.generate.mockImplementation(
          async (request) =>
            new Promise((resolve) => {
              request.execution.signal?.addEventListener(
                'abort',
                () =>
                  resolve({
                    requestId: crypto.randomUUID(),
                    providerId: 'mock',
                    modelId: 'mock-cv',
                    status: 'cancelled',
                    output: null,
                    toolCalls: [],
                    usage: null,
                  }),
                { once: true },
              );
            }),
        );
        const repo = new CvImportsRepository(storage.db);
        const service = new CvImportsService(
          repo,
          {
            getCv: () => ({ sha256: 'a'.repeat(64) }) as never,
            extract: async () => extracted,
          },
          inference,
        );
        const item = service.start(documentId);
        await vi.advanceTimersByTimeAsync(0);
        expect(inference.generate).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(179_999);
        expect(service.get(item.id).status).toBe('processing');
        await vi.advanceTimersByTimeAsync(1);
        expect(service.get(item.id)).toMatchObject({
          status: 'failed',
          diagnostics: { errorCode: 'TIMEOUT' },
        });
      } finally {
        storage.close();
      }
    } finally {
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('keeps legacy draft through failed reparse, duplicate start, cancellation and restart; only successful retry replaces it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-llm-first-'));
    try {
      let storage = openStorage(dir);
      const documentId = crypto.randomUUID();
      storage.db
        .prepare(
          'INSERT INTO documents (id, profile_id, category, original_name, media_type, relative_path, sha256, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          documentId,
          'local',
          'cv',
          'fixture.pdf',
          'application/pdf',
          `originals/${documentId}.pdf`,
          'a'.repeat(64),
          42,
          new Date().toISOString(),
        );
      const original = { id: documentId, sha256: 'a'.repeat(64) };
      const reader = {
        getCv: (id: string) => (id === documentId ? (original as never) : null),
        extract: vi.fn(async () => extracted),
      };
      const legacySpy = vi.spyOn(legacyParser, 'parseCv');
      let inference = client((pass: string) =>
        pass === 'personal'
          ? {
              ...section(pass),
              email: 'not an email',
            }
          : section(pass),
      );
      let repo = new CvImportsRepository(storage.db);
      let service = new CvImportsService(repo, reader, inference);
      const first = service.start(documentId);
      expect(service.start(documentId).id).toBe(first.id);
      const settled = async () => {
        for (let i = 0; i < 100; i++) {
          const item = service.get(first.id);
          if (item.status !== 'processing') return item;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('CV operation did not settle');
      };
      expect((await settled()).diagnostics.errorCode).toBe('INVALID_RESPONSE');
      expect(legacySpy).not.toHaveBeenCalled();
      const legacy = parseCv(extracted).draft;
      legacySpy.mockClear();
      repo.update({ ...service.get(first.id), draft: legacy, status: 'ready' });
      service.retry(first.id);
      expect((await settled()).draft?.parserVersion).toBe('cv-v1');
      expect(service.get(first.id).status).toBe('failed');
      storage.close();
      storage = openStorage(dir);
      repo = new CvImportsRepository(storage.db);
      inference = client();
      service = new CvImportsService(repo, reader, inference);
      expect(service.get(first.id).draft?.parserVersion).toBe('cv-v1');
      service.retry(first.id);
      const fresh = await settled();
      expect(fresh.draft?.parserVersion).toBe(FULL_CV_VERSION);
      expect(fresh.draft?.modelProvenance?.providerId).toBe('mock');
      expect(reader.extract).toHaveBeenCalledTimes(3);
      expect(legacySpy).not.toHaveBeenCalled();
      legacySpy.mockRestore();
      storage.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
