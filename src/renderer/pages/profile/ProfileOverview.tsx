import React from 'react';
import {
  BriefcaseBusiness,
  CalendarDays,
  ChevronRight,
  CircleCheck,
  Circle,
  CirclePlus,
  FileText,
  FileUp,
  Layers,
  MapPin,
  Pencil,
  Plus,
  Rocket,
  Target as TargetIcon,
  UserRound,
  Zap,
} from 'lucide-react';
import type { Experience, Profile, Target } from '../../../shared/contracts';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';
import { MeadowCardCorner } from '../../presentation/meadow/decorations/MeadowCardCorner';

type Props = {
  profile: Profile;
  experiences: Experience[];
  targets: Target[];
  skills: string[];
  onEditProfile: () => void;
  onAddExperience: () => void;
  onAddTarget: () => void;
  onShowTargets: () => void;
  onShowSkills: () => void;
  onShowDocuments: () => void;
};

export function ProfileOverview({
  profile,
  experiences,
  targets,
  skills,
  onEditProfile,
  onAddExperience,
  onAddTarget,
  onShowTargets,
  onShowSkills,
  onShowDocuments,
}: Props) {
  const education = experiences.filter((item) => item.category === 'education');
  const work = experiences.filter((item) => item.category !== 'education');
  const currentJob =
    work.find((item) => item.category === 'employment' && !item.endDate) ??
    null;
  const leadTarget = targets.find((item) => item.active) ?? targets[0] ?? null;

  const checklist = [
    {
      label: 'Basic details',
      done: Boolean(profile.displayName && profile.currentRole),
    },
    { label: `Experience (${work.length})`, done: work.length > 0 },
    { label: `Education (${education.length})`, done: education.length > 0 },
    { label: `Skills (${skills.length})`, done: skills.length > 0 },
    {
      label: targets.length
        ? `Career targets (${targets.length})`
        : 'Career targets (add one)',
      done: targets.length > 0,
    },
  ];
  const completeness = Math.round(
    (checklist.filter((item) => item.done).length / checklist.length) * 100,
  );

  return (
    <div className="profile-overview profile-grid">
      <aside className="profile-identity-column">
        <ProfileIdentityCard
          profile={profile}
          leadTarget={leadTarget}
          onShowTargets={onShowTargets}
          onEditProfile={onEditProfile}
        />

        <Card className="profile-completeness">
          <div className="profile-completeness-head">
            <h3 id="profile-completeness-label">Profile completeness</h3>
            <span>{completeness}%</span>
          </div>
          <div
            className="profile-progress"
            role="progressbar"
            aria-labelledby="profile-completeness-label"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={completeness}
          >
            <span style={{ width: `${completeness}%` }} />
          </div>
          <ul>
            {checklist.map((item) => (
              <li key={item.label} className={item.done ? 'is-done' : ''}>
                {item.done ? (
                  <CircleCheck size={20} aria-label="Complete" />
                ) : (
                  <Circle size={20} aria-label="Incomplete" />
                )}
                {item.label}
              </li>
            ))}
          </ul>
        </Card>
      </aside>

      <div className="profile-overview-main">
        <Card className="profile-panel profile-about profile-decorated">
          <MeadowCardCorner variant="subtle" />
          <header className="profile-panel-head">
            <FileText size={26} aria-hidden="true" />
            <h2>About me</h2>
            <Button
              variant="secondary"
              className="profile-small-button"
              leadingIcon={<Pencil size={15} aria-hidden="true" />}
              onClick={onEditProfile}
            >
              Edit
            </Button>
          </header>
          <p>{profile.summary || 'Add a summary in your own words.'}</p>
        </Card>

        <Card className="profile-panel profile-decorated">
          <MeadowCardCorner variant="subtle" />
          <header className="profile-panel-head">
            <BriefcaseBusiness size={26} aria-hidden="true" />
            <h2>Current role</h2>
          </header>
          <div className="profile-role">
            <span className="profile-role-badge" aria-hidden="true">
              <BriefcaseBusiness size={24} />
            </span>
            <div>
              <h3>
                {currentJob?.roleTitle ||
                  profile.currentRole ||
                  'Current role not added'}
              </h3>
              {currentJob?.organisation && (
                <p className="profile-role-org">{currentJob.organisation}</p>
              )}
              {currentJob?.startDate && (
                <p className="profile-role-dates">
                  <CalendarDays size={15} aria-hidden="true" />
                  {currentJob.startDate} – Present
                </p>
              )}
            </div>
          </div>
        </Card>

        <Card className="profile-panel">
          <header className="profile-panel-head">
            <TargetIcon size={26} aria-hidden="true" />
            <h2>Career targets</h2>
            <Button
              variant="secondary"
              className="profile-small-button"
              leadingIcon={<Plus size={15} aria-hidden="true" />}
              onClick={onAddTarget}
            >
              Add target
            </Button>
          </header>
          {targets.length ? (
            <ul className="profile-targets">
              {targets.slice(0, 3).map((item) => (
                <li key={item.id}>
                  <span className="profile-target-badge" aria-hidden="true">
                    <Rocket size={22} />
                  </span>
                  <div>
                    <h3>{item.roleTitle}</h3>
                    <p>
                      {[item.targetLevel, item.sector, item.location]
                        .filter(Boolean)
                        .join(' · ') || 'No additional details'}
                    </p>
                  </div>
                  <span
                    className={`profile-status${item.active ? ' is-active' : ''}`}
                  >
                    {item.active ? 'Active' : 'Inactive'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No target roles yet. Your current role can be different.</p>
          )}
        </Card>

        <Card className="profile-panel">
          <header className="profile-panel-head">
            <Layers size={26} aria-hidden="true" />
            <h2>Skills</h2>
            <span className="profile-count">
              {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
            </span>
          </header>
          {!skills.length && <p>No confirmed skills yet.</p>}
          <ul className="profile-chips">
            {skills.map((name) => (
              <li key={name}>{name}</li>
            ))}
            <li>
              <button
                type="button"
                className="profile-chip-add"
                aria-label="Add a skill"
                onClick={onShowSkills}
              >
                <Plus size={15} aria-hidden="true" />
                Add
              </button>
            </li>
          </ul>
        </Card>

        <section
          className="profile-quick"
          aria-labelledby="profile-quick-title"
        >
          <header className="profile-panel-head">
            <Zap size={26} aria-hidden="true" />
            <h2 id="profile-quick-title">Quick actions</h2>
          </header>
          <div className="profile-quick-grid">
            <button
              type="button"
              className="profile-quick-tile is-green"
              onClick={onShowDocuments}
            >
              <FileUp size={28} aria-hidden="true" />
              <strong>Import CV</strong>
              <span>Update your profile from a CV</span>
            </button>
            <button
              type="button"
              className="profile-quick-tile is-peach"
              onClick={onAddExperience}
            >
              <CirclePlus size={28} aria-hidden="true" />
              <strong>Add experience</strong>
              <span>Work, projects or other experience</span>
            </button>
            <button
              type="button"
              className="profile-quick-tile is-lilac"
              onClick={onAddTarget}
            >
              <TargetIcon size={28} aria-hidden="true" />
              <strong>Add a target</strong>
              <span>Define your next career move</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

export function ProfileIdentityCard({
  profile,
  leadTarget,
  onShowTargets,
  onEditProfile,
}: {
  profile: Profile;
  leadTarget: Target | null;
  onShowTargets: () => void;
  onEditProfile?: () => void;
}) {
  return (
    <Card className="profile-identity profile-decorated">
      <MeadowCardCorner variant="floral" />
      <span className="profile-avatar" aria-hidden="true">
        <UserRound size={52} strokeWidth={1.6} />
      </span>
      <h2>{profile.displayName || 'Name not added'}</h2>
      <p>
        {profile.currentRole || 'Current role not added'}
        {profile.currentStage && ` · ${profile.currentStage.replace('_', ' ')}`}
      </p>
      <p className="profile-location">
        <MapPin size={16} aria-hidden="true" />
        {profile.location || 'Location not added'}
      </p>
      {leadTarget && (
        <button
          type="button"
          className="profile-towards"
          onClick={onShowTargets}
        >
          <TargetIcon size={28} aria-hidden="true" />
          <span>
            Building towards
            <strong>{leadTarget.roleTitle}</strong>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      )}
      {onEditProfile && (
        <Button
          variant="secondary"
          leadingIcon={<Pencil size={16} aria-hidden="true" />}
          onClick={onEditProfile}
        >
          Edit details
        </Button>
      )}
    </Card>
  );
}
