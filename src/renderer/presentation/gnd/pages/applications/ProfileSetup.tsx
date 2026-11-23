import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Upload } from 'lucide-react';
import { normalizeExperienceDate } from '../../../../../shared/contracts';
import { createExperience, updateProfile } from '../../../../api';
import { failureNotice } from '../../../../app/Notifications';
import { Button } from '../../../components/Button';
import { Overlay } from '../../components/Overlay';
import { Onboarding } from '../onboarding/Onboarding';
import { SkillPicker } from './ProfileParts';
import '../onboarding/Onboarding.css';
import '../settings/OllamaNudge.css';
import './ProfileSetup.css';

/**
 * Before someone has a CV in GND: upload one, or answer a few questions
 * instead. Applications and the jobs applied count wait until one is done.
 */
export function ProfileSetup({
  skills,
  onSkills,
  onDone,
}: {
  skills: string[];
  onSkills: (next: string[]) => void;
  onDone: () => void;
}) {
  const [flow, setFlow] = useState<'cv' | 'questions' | null>(null);

  return (
    <section className="gnd-setup" aria-labelledby="gnd-setup-title">
      <h2 id="gnd-setup-title" className="gnd-visually-hidden">
        Set up your profile
      </h2>
      <div className="gnd-setup-card is-upload">
        <Upload aria-hidden="true" className="gnd-setup-icon" />
        <h3>Upload your CV</h3>
        <p className="gnd-muted">No file added</p>
        <Button variant="outline" onClick={() => setFlow('cv')}>
          Choose a CV file
        </Button>
        <p className="gnd-setup-hint">
          On LinkedIn? Open your profile, choose More › Save to PDF, and upload
          that.
        </p>
      </div>
      <div className="gnd-setup-card">
        <CvIllustration />
        <h3>Don’t have a CV?</h3>
        <Button variant="outline" onClick={() => setFlow('questions')}>
          <Sparkles aria-hidden="true" /> Answer a few questions
        </Button>
      </div>

      {flow === 'cv' &&
        createPortal(
          <div className="gnd-setup-layer">
            <Onboarding
              startWithCv
              onClose={() => setFlow(null)}
              onComplete={() => {
                setFlow(null);
                onDone();
              }}
            />
          </div>,
          document.body,
        )}
      {flow === 'questions' && (
        <QuickProfile
          skills={skills}
          onSkills={onSkills}
          onClose={() => setFlow(null)}
          onDone={() => {
            setFlow(null);
            onDone();
          }}
        />
      )}
    </section>
  );
}

/** Three quick questions that stand in for a CV: role, where, since when, skills. */
export function QuickProfile({
  skills,
  onSkills,
  onClose,
  onDone,
}: {
  skills: string[];
  onSkills: (next: string[]) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [role, setRole] = useState('');
  const [company, setCompany] = useState('');
  const [since, setSince] = useState('');
  const [studying, setStudying] = useState(false);
  const [error, setError] = useState<{ field: string; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!role.trim()) {
      setError({
        field: 'role',
        text: studying
          ? 'Add what you’re studying, e.g. BSc Computer Science.'
          : 'Add your job title, e.g. Product Designer.',
      });
      return;
    }
    const startDate = since.trim() ? normalizeExperienceDate(since) : null;
    if (since.trim() && !startDate) {
      setError({ field: 'since', text: 'Enter a year, like 2022.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createExperience({
        category: studying ? 'education' : 'employment',
        roleTitle: role.trim(),
        organisation: company.trim() || null,
        startDate,
        endDate: null,
        description: '',
      });
      if (!studying) await updateProfile({ currentRole: role.trim() });
      onDone();
    } catch (e) {
      setError({
        field: 'form',
        text: failureNotice(e, 'Couldn’t save that. Please try again.').message,
      });
      setBusy(false);
    }
  }

  const fieldError = (field: string) =>
    error?.field === field ? (
      <p className="gnd-form-error" role="alert">
        {error.text}
      </p>
    ) : null;

  return (
    <Overlay
      title="A few questions"
      subtitle="We’ll use these instead of a CV to find roles that fit. You can add more later."
      onClose={onClose}
    >
      <form className="gnd-quick-profile" onSubmit={(e) => void save(e)}>
        <div className="gnd-seg" role="group" aria-label="Right now I’m">
          <button
            type="button"
            className="gnd-seg-option"
            aria-pressed={!studying}
            onClick={() => setStudying(false)}
          >
            Working
          </button>
          <button
            type="button"
            className="gnd-seg-option"
            aria-pressed={studying}
            onClick={() => setStudying(true)}
          >
            Studying
          </button>
        </div>
        <div className="gnd-form-field">
          <label className="gnd-label" htmlFor="gnd-q-role">
            {studying ? 'What are you studying?' : 'What’s your job title?'}
          </label>
          <input
            id="gnd-q-role"
            className="gnd-input"
            value={role}
            maxLength={200}
            placeholder={
              studying ? 'e.g. BSc Computer Science' : 'e.g. Product Designer'
            }
            data-autofocus
            onChange={(e) => setRole(e.target.value)}
          />
          {fieldError('role')}
        </div>
        <div className="gnd-form-two">
          <div className="gnd-form-field">
            <label className="gnd-label" htmlFor="gnd-q-company">
              {studying ? 'Where?' : 'Company'}
            </label>
            <input
              id="gnd-q-company"
              className="gnd-input"
              value={company}
              maxLength={200}
              placeholder={studying ? 'e.g. University of Leeds' : 'e.g. Monzo'}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
          <div className="gnd-form-field">
            <label className="gnd-label" htmlFor="gnd-q-since">
              Since
            </label>
            <input
              id="gnd-q-since"
              className="gnd-input"
              value={since}
              inputMode="numeric"
              maxLength={20}
              placeholder="e.g. 2022"
              onChange={(e) => setSince(e.target.value)}
            />
            {fieldError('since')}
          </div>
        </div>
        <div className="gnd-form-field">
          <span className="gnd-label">Your skills</span>
          <SkillPicker skills={skills} onChange={onSkills} autoOpen={false} />
        </div>
        {fieldError('form')}
        <div className="gnd-quick-actions">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Overlay>
  );
}

/** A CV with a pencil and a tick, in GND's soft palette. */
function CvIllustration() {
  return (
    <svg
      className="gnd-setup-art"
      viewBox="0 0 220 170"
      aria-hidden="true"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 96 l10 12 l18 -26" stroke="#e07a6a" strokeWidth="7" />
      <g transform="rotate(-6 100 85)">
        <path
          d="M58 14 h78 l18 18 v118 a4 4 0 0 1 -4 4 h-92 a4 4 0 0 1 -4 -4 v-132 a4 4 0 0 1 4 -4z"
          fill="#f7f0de"
          stroke="#33352f"
          strokeWidth="2.5"
        />
        <path
          d="M136 14 v18 h18"
          fill="#e8dfc6"
          stroke="#33352f"
          strokeWidth="2.5"
        />
        <circle cx="80" cy="44" r="13" fill="#d7e6e2" />
        <circle cx="80" cy="40" r="4.5" fill="#2f5d6b" />
        <path d="M71 51 a9 7 0 0 1 18 0z" fill="#2f5d6b" />
        <path
          d="M102 38 h22 M102 48 h28 M70 76 h66 M70 88 h58 M70 100 h62 M70 128 h30"
          stroke="#33352f"
          strokeWidth="3"
        />
      </g>
      <g transform="rotate(38 160 90)">
        <rect
          x="150"
          y="24"
          width="18"
          height="104"
          rx="3"
          fill="#2f6f8f"
          stroke="#33352f"
          strokeWidth="2.5"
        />
        <rect
          x="150"
          y="16"
          width="18"
          height="14"
          rx="4"
          fill="#e58a7a"
          stroke="#33352f"
          strokeWidth="2.5"
        />
        <path
          d="M150 128 l9 20 l9 -20z"
          fill="#f2d7a7"
          stroke="#33352f"
          strokeWidth="2.5"
        />
        <path d="M156 141 l3 7 l3 -7z" fill="#33352f" />
      </g>
    </svg>
  );
}
