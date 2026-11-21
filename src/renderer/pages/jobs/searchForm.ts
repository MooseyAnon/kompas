import {
  jobDiscoveryConfigurationV1Schema,
  newJobDiscoveryConfiguration,
  type JobDiscoveryConfigurationV1,
} from '../../../shared/contracts/job-discovery';

export type SearchForm = {
  config: JobDiscoveryConfigurationV1;
  roles: string;
  companies: string;
  keywords: string;
  year: string;
};

export function searchForm(
  config = newJobDiscoveryConfiguration(),
): SearchForm {
  return {
    config,
    roles: config.intent.targetRoles.join('\n'),
    companies: config.intent.companies.join('\n'),
    keywords: config.intent.keywords.join('\n'),
    year: config.intent.targetYear?.toString() ?? '',
  };
}

function lines(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function validateSearch(form: SearchForm): {
  config?: JobDiscoveryConfigurationV1;
  errors: Record<string, string>;
} {
  const { config, year } = form;
  const parsed = jobDiscoveryConfigurationV1Schema.safeParse({
    ...config,
    intent: {
      ...config.intent,
      targetRoles: lines(form.roles),
      companies: lines(form.companies),
      keywords: lines(form.keywords),
      targetYear: year.trim() === '' ? null : Number(year.trim()),
    },
  });
  if (parsed.success) return { config: parsed.data, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.').replace(/\.\d+$/, '');
    errors[path] ??= issue.message;
  }
  return { errors };
}
