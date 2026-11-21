import React from 'react';
import { destinations, type Destination } from '../app/destinations';
import { HomePage } from './home/HomePage';
import { InterviewsPage } from './interviews/InterviewsPage';
import { JobsPage } from './jobs/JobsPage';
import { ProfilePage } from './profile/ProfilePage';
import { SettingsPage } from './settings/SettingsPage';
import './Page.css';

export function Page({
  destination,
  onNavigate,
  shortcut,
}: {
  destination: Destination;
  onNavigate: (next: Destination) => void;
  shortcut: string;
}) {
  const label = destinations.find((item) => item.id === destination)!.label;

  if (destination === 'settings') return <SettingsPage />;
  if (destination === 'interviews')
    return <InterviewsPage onNavigate={onNavigate} />;
  if (destination === 'jobs') return <JobsPage onNavigate={onNavigate} />;
  if (destination === 'profile') return <ProfilePage onNavigate={onNavigate} />;
  if (destination === 'home')
    return <HomePage onNavigate={onNavigate} shortcut={shortcut} />;

  return (
    <section className="shell-page">
      <h1>{label}</h1>
      <p>This space is being prepared.</p>
    </section>
  );
}
