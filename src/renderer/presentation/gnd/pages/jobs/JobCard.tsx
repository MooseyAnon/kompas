import React from 'react';
import { missingNote, type JobView } from './jobView';

/** A GND job card: title + match, company, place, salary, gap note. */
export function JobCard({
  job,
  onOpen,
  layout = 'home',
}: {
  job: JobView;
  onOpen: (id: string) => void;
  /** Home puts the match top-right; the Jobs list puts it after the company. */
  layout?: 'home' | 'list';
}) {
  const note = missingNote(job);
  const badge =
    job.matchPercent === null ? null : (
      <span className="gnd-badge">{job.matchPercent}% match</span>
    );

  return (
    <button
      type="button"
      className={`gnd-job-card gnd-job-card-${layout}`}
      onClick={() => onOpen(job.id)}
      data-testid="job-card"
    >
      <span className="gnd-job-card-head">
        <span className="gnd-job-card-title">{job.title}</span>
        {layout === 'home' && badge}
      </span>
      <span className="gnd-job-card-company">
        {job.company}
        {layout === 'list' && badge}
      </span>
      {job.place && <span className="gnd-job-card-meta">{job.place}</span>}
      <span className="gnd-job-card-meta">
        {job.salary ?? 'Salary not published'}
      </span>
      {note && <span className="gnd-note gnd-job-card-note">{note}</span>}
    </button>
  );
}
