import { z } from 'zod';
import {
  savedSearchCreateInput,
  savedSearchUpdateInput,
  savedSearchIdInput,
  savedSearchActiveInput,
  savedSearchListInput,
  type SavedSearch,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { SavedSearchesRepository } from './saved-searches.repository';

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new AppError(
      'INVALID_INPUT',
      'Please check the saved-search configuration and limits.',
    );

  return result.data;
}

export class SavedSearchesService {
  constructor(private readonly repo: SavedSearchesRepository) {}

  create(raw: z.input<typeof savedSearchCreateInput>): SavedSearch {
    const { config } = parse(savedSearchCreateInput, raw);
    const id = crypto.randomUUID();
    this.repo.insert(id, config, new Date().toISOString());

    return this.get({ id });
  }

  get(raw: z.input<typeof savedSearchIdInput>): SavedSearch {
    const { id } = parse(savedSearchIdInput, raw);
    const item = this.repo.get(id);
    if (!item) throw new AppError('NOT_FOUND', 'Saved search not found.');

    return item;
  }

  list(raw: z.input<typeof savedSearchListInput> = {}) {
    const { limit, cursor } = parse(savedSearchListInput, raw);
    return this.repo.list(limit, cursor);
  }

  update(raw: z.input<typeof savedSearchUpdateInput>): SavedSearch {
    const { id, config } = parse(savedSearchUpdateInput, raw);
    this.get({ id });
    this.repo.replace(id, config, new Date().toISOString());

    return this.get({ id });
  }

  setActive(raw: z.input<typeof savedSearchActiveInput>): SavedSearch {
    const { id, active } = parse(savedSearchActiveInput, raw);
    const item = this.get({ id });

    return this.update({ id, config: { ...item.config, active } });
  }

  /**
   * Run preview/start use this guard; disabling a search does not cancel old
   * runs.
   */
  requireActive(id: string): SavedSearch {
    const item = this.get({ id });
    if (!item.config.active)
      throw new AppError(
        'CONFLICT',
        'Activate this saved search before running it.',
      );

    return item;
  }
}
