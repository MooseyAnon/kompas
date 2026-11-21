import {
  jobSnapshotSchema,
  snapshotWithinLimit,
  type DiscoveryCandidate,
  type DiscoveryCapture,
  type JobSnapshot,
} from '../../../shared/contracts';

const MAX_TITLE_CHARS = 200;
const MAX_SNAPSHOT_BYTES = 48 * 1024;

export type SnapshotAssessment =
  | { status: 'available'; snapshot: JobSnapshot }
  | { status: 'no_verified_jd' | 'incomplete' | 'too_large' };

/** Map the original verified ReadPage, never the model's paraphrase. */
export function assessSnapshot(
  candidate: DiscoveryCandidate,
  capture: DiscoveryCapture | null,
  extracted: boolean,
): SnapshotAssessment {
  if (!candidate.canonicalUrl || !capture || !extracted)
    return { status: 'no_verified_jd' };

  const page = capture.rawReadPage;
  const isIncompletePage =
    page.url !== candidate.canonicalUrl ||
    page.truncated.text ||
    page.structured?.truncated ||
    !page.text.trim() ||
    candidate.title.length > MAX_TITLE_CHARS;
  if (isIncompletePage) return { status: 'incomplete' };

  const blocks = page.structured?.content.blocks ?? [];
  // Pack 012 has no link/table block shape. Refuse rather than silently drop
  // evidence.
  if (blocks.some((block) => block.type === 'link' || block.type === 'table'))
    return { status: 'incomplete' };

  const mapped = blocks
    .filter((block) => block.type !== 'link' && block.type !== 'table')
    .map((block) => ({
      type: block.type,
      text:
        block.type === 'list'
          ? block.items.map((item) => item.text).join('\n')
          : block.text,
    }));

  const raw = {
    schemaVersion: 1,
    source: 'web',
    sourceUrl: candidate.canonicalUrl,
    capturedAt: capture.capturedAt,
    title: candidate.title,
    company: candidate.company,
    location: candidate.location,
    descriptionText: page.text,
    contentBlocks: mapped,
  };
  const rawBytes = new TextEncoder().encode(JSON.stringify(raw)).length;
  if (rawBytes > MAX_SNAPSHOT_BYTES) return { status: 'too_large' };

  const parsed = jobSnapshotSchema.safeParse(raw);
  if (!parsed.success) return { status: 'incomplete' };
  if (!snapshotWithinLimit(parsed.data)) return { status: 'too_large' };

  return { status: 'available', snapshot: parsed.data };
}
