// Realistic sample records for the design preview, written through the same
// validated module actions the renderer uses.
import type {
  JobDiscoveryConfigurationV1,
  ResponseEnvelope,
} from '../../src/shared/contracts';

type Send = (
  module: string,
  action: string,
  payload?: unknown,
) => Promise<ResponseEnvelope>;

async function must<T>(
  send: Send,
  module: string,
  action: string,
  payload?: unknown,
): Promise<T> {
  const response = await send(module, action, payload);
  if (!response.ok) {
    throw new Error(
      `Preview seed ${module}.${action} failed: ${response.error.code} ${response.error.message}`,
    );
  }
  return response.data as T;
}

/** Best-effort steps: a failing optional step leaves that screen empty. */
async function attempt(label: string, step: () => Promise<unknown>) {
  try {
    await step();
  } catch (error) {
    console.warn(
      `[design-preview] skipped ${label}:`,
      (error as Error).message,
    );
  }
}

export async function seedPreviewData(
  send: Send,
  baseConfig: JobDiscoveryConfigurationV1,
) {
  await must(send, 'identity', 'profile.update', {
    patch: {
      displayName: 'Alex Morgan',
      currentStage: 'employed',
      currentRole: 'Senior Product Designer',
      location: 'London, UK',
      summary:
        'Product designer with eight years across fintech and payments, focused on merchant tools, design systems and research-led product decisions.',
    },
  });

  const target = await must<{ item: { id: string } }>(
    send,
    'identity',
    'targets.create',
    {
      roleTitle: 'Principal Product Designer',
      targetLevel: 'Principal',
      sector: 'Fintech',
      location: 'Remote',
      active: true,
    },
  );
  await must(send, 'identity', 'targets.create', {
    roleTitle: 'Design Lead',
    targetLevel: 'Lead',
    sector: 'Consumer apps',
    location: 'London, UK',
    active: true,
  });

  for (const experience of [
    {
      category: 'employment',
      roleTitle: 'Lead Product Designer',
      organisation: 'Northwind Payments',
      startDate: '2024-03-01',
      endDate: null,
      description:
        'Leading design for merchant onboarding and the card terminal companion app. Built the team’s design system and research practice.',
    },
    {
      category: 'employment',
      roleTitle: 'Senior Product Designer',
      organisation: 'Contoso Finance',
      startDate: '2021-06-01',
      endDate: '2024-02-28',
      description:
        'Owned the payouts and reporting experience; shipped a dashboard redesign used by 40,000 merchants.',
    },
    {
      category: 'education',
      roleTitle: 'BA Product Design',
      organisation: 'University of the Arts',
      startDate: '2015-09-01',
      endDate: '2018-06-30',
      description: '',
    },
    {
      category: 'project',
      roleTitle: 'Community events app',
      organisation: 'Side project',
      startDate: '2025-01-01',
      endDate: null,
      description: 'Designed and shipped a small app for local meetups.',
    },
  ]) {
    await must(send, 'identity', 'experiences.create', experience);
  }

  await must(send, 'identity', 'skills.replace', {
    names: [
      'Product design',
      'Design systems',
      'User research',
      'Prototyping',
      'Figma',
      'Payments',
      'Stakeholder management',
    ],
  });

  // Applications across board columns.
  const applications = [
    ['Monzo', 'Principal Product Designer', 'interview', 'Final round'],
    ['Stripe', 'Staff Product Designer', 'applied', 'Applied'],
    ['Wise', 'Design Lead', 'screening', 'Recruiter screen'],
    ['Revolut', 'Lead Product Designer', 'offer', 'Offer received'],
    ['Plaid', 'Senior Product Designer', 'saved', 'Saved'],
    ['Checkout.com', 'Product Design Lead', 'rejected', 'Rejected'],
  ] as const;
  for (const [companyName, roleTitle, stageKind, stageLabel] of applications) {
    await attempt(`application ${companyName}`, () =>
      must(send, 'applications', 'create', {
        companyName,
        roleTitle,
        location: 'London, UK',
        jobUrl: `https://careers.example.com/${companyName.toLowerCase().replace(/\W/g, '')}`,
        initialStage: { stageLabel, stageKind },
      }),
    );
  }

  // A saved search, then a fixture-backed discovery run so Review has items.
  const search = await must<{ item: { id: string } }>(
    send,
    'jobDiscovery',
    'savedSearches.create',
    {
      config: {
        ...baseConfig,
        name: 'Principal design roles',
        intent: {
          ...baseConfig.intent,
          targetRoles: ['Principal Product Designer', 'Staff Product Designer'],
          seniority: 'Principal',
          field: 'Product design',
          location: 'London',
          keywords: ['fintech', 'design systems'],
        },
      },
    },
  );
  await attempt('discovery run', async () => {
    const run = await must<{ item: { id: string } }>(
      send,
      'jobDiscovery',
      'runs.start',
      { savedSearchId: search.item.id },
    );
    await must(send, 'jobDiscovery', 'runs.execute', { id: run.item.id });
  });

  // Interview sessions: one draft of each method.
  await attempt('interview sessions', async () => {
    await must(send, 'interviews', 'sessions.create', {
      method: 'quick_fire',
      subject: 'Design leadership',
      careerTargetId: target.item.id,
    });
    await must(send, 'interviews', 'sessions.create', {
      method: 'deep_loop',
      subject: 'Portfolio deep dive',
      careerTargetId: target.item.id,
    });
  });
}
