import type { StageKind } from '../../../../shared/contracts/applications';

export const lanes = [
  'Pending',
  'Applied',
  'Screening',
  'Interviewing',
  'Offer',
  'Closed',
] as const;
export type Lane = (typeof lanes)[number];

// Presentation grouping only. The latest recorded event's label remains authoritative.
// Legacy 'other' or missing kinds are no longer offered, so they fall back to Pending.
export function stageLane(kind: StageKind | null | string): Lane {
  switch (kind) {
    case 'saved':
      return 'Pending';
    case 'applied':
      return 'Applied';
    case 'screening':
      return 'Screening';
    case 'interview':
    case 'assessment':
      return 'Interviewing';
    case 'offer':
      return 'Offer';
    case 'rejected':
    case 'withdrawn':
      return 'Closed';
    default:
      return 'Pending';
  }
}

export const initialStages: { kind: StageKind; label: string }[] = [
  { kind: 'saved', label: 'Pending' },
  { kind: 'applied', label: 'Applied' },
  { kind: 'screening', label: 'Screening' },
  { kind: 'interview', label: 'Interview' },
  { kind: 'assessment', label: 'Assessment' },
  { kind: 'offer', label: 'Offer' },
  { kind: 'rejected', label: 'Rejected' },
  { kind: 'withdrawn', label: 'Withdrawn' },
];

export const selectableStageKinds = initialStages.map((stage) => stage.kind);

export function selectableStageKind(kind: StageKind | null): StageKind {
  return kind && kind !== 'other' ? kind : 'saved';
}
