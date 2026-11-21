import { z } from 'zod';
import {
  opportunityDecideInput,
  opportunityIdInput,
  opportunityListInput,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import { OpportunitiesRepository } from './opportunities.repository';

const cursorSchema = z.strictObject({
  decision: opportunityListInput.shape.decision,
  at: z.iso.datetime(),
  id: z.uuid(),
});

export class OpportunitiesService {
  constructor(
    private readonly repo: OpportunitiesRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  list(raw: z.input<typeof opportunityListInput>) {
    const { decision, limit, cursor } = opportunityListInput.parse(raw);

    let before: { at: string; id: string } | undefined;
    if (cursor) {
      try {
        const decoded = cursorSchema.parse(
          JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
        );
        if (decoded.decision !== decision) throw new Error('Filter mismatch');
        before = decoded;
      } catch {
        throw new AppError('INVALID_INPUT', 'Invalid opportunity page cursor.');
      }
    }

    const page = this.repo.list(decision, limit, before);
    const last = page.items.at(-1);
    const nextCursor =
      page.hasMore && last
        ? Buffer.from(
            JSON.stringify({
              decision,
              at: last.createdAt,
              id: last.opportunityId,
            }),
          ).toString('base64url')
        : null;

    return { items: page.items, nextCursor };
  }

  get(raw: z.input<typeof opportunityIdInput>) {
    return this.repo.get(opportunityIdInput.parse(raw).opportunityId);
  }

  decide(raw: z.input<typeof opportunityDecideInput>) {
    const { opportunityId, decision } = opportunityDecideInput.parse(raw);
    return this.repo.decide(
      opportunityId,
      decision,
      this.clock().toISOString(),
    );
  }
}
