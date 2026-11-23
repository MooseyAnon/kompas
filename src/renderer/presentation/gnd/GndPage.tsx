import React from 'react';
import { type Destination } from './destinations';
import { ApplicationsPage } from './pages/applications/ApplicationsPage';
import { HomePage } from './pages/home/HomePage';
import { InterviewsPage } from '../../pages/interviews/InterviewsPage';
import { JobsPage } from './pages/jobs/JobsPage';
import { GndSettingsPage } from './pages/settings/GndSettingsPage';
import '../../pages/Page.css';

import type { PracticePreset } from '../../pages/interviews/prepare/preset';
export type { PracticePreset };

/**
 * Where a page opens: Jobs on a job or a searches tab, Profile on a tab,
 * Interviews with a practice session filled in.
 */
export type JobsEntry = {
  opportunityId?: string;
  tab?: 'saved' | 'discover' | 'review';
  profileTab?: 'overview' | 'experience' | 'skills' | 'targets' | 'documents';
  practice?: PracticePreset;
  /** Jobs: open Search filters. */
  filters?: boolean;
  /** Jobs: follow this search run on the Finding your roles screen. */
  runId?: string;
};
export type Navigate = (next: Destination, entry?: JobsEntry) => void;

export function Page({
  destination,
  onNavigate,
  jobs,
}: {
  destination: Destination;
  onNavigate: Navigate;
  jobs?: JobsEntry;
}) {
  switch (destination) {
    case 'home':
      return <HomePage onNavigate={onNavigate} />;
    case 'jobs':
      return (
        <JobsPage
          onNavigate={onNavigate}
          initialTab={jobs?.tab}
          initialFilters={jobs?.filters}
          initialRunId={jobs?.runId}
          initialOpportunityId={jobs?.opportunityId}
        />
      );
    case 'interviews':
      return <InterviewsPage onNavigate={onNavigate} preset={jobs?.practice} />;
    // Profile and Your applications are one page.
    case 'applications':
    case 'profile':
      return (
        <ApplicationsPage
          onNavigate={onNavigate}
          focusSkills={jobs?.profileTab === 'skills'}
        />
      );
    case 'settings':
      return <GndSettingsPage />;
  }
}
