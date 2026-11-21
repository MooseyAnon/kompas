import React, { useState } from 'react';
import type {
  Experience,
  ExperiencesCreateInput,
  Profile,
  Target,
  TargetsCreateInput,
} from '../../../shared/contracts';
import {
  CAREER_STAGES,
  EXPERIENCE_CATEGORIES,
  experiencesCreateInputSchema,
  isExperienceDateRangeValid,
  normalizeExperienceDate,
  profilePatchSchema,
  targetsCreateInputSchema,
} from '../../../shared/contracts';
import {
  createExperience,
  createTarget,
  deleteExperience,
  deleteTarget,
  generateProfileSummary,
  updateExperience,
  updateProfile,
  updateTarget,
} from '../../api';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Please try again.';
export const optional = (value: string) => value.trim() || null;

export function ProfileEditor({
  profile,
  onSaved,
  onClose,
}: {
  profile: Profile;
  onSaved: (value: Profile) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile.displayName);
  const [stage, setStage] = useState(profile.currentStage ?? '');
  const [role, setRole] = useState(profile.currentRole ?? '');
  const [location, setLocation] = useState(profile.location ?? '');
  const [summary, setSummary] = useState(profile.summary ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const parsed = profilePatchSchema.safeParse({
      displayName: name,
      currentStage: stage || null,
      currentRole: optional(role),
      location: optional(location),
      summary: optional(summary),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    setError('');
    try {
      onSaved(await updateProfile(parsed.data));
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function generate() {
    setBusy(true);
    setError('');
    try {
      setSummary(await generateProfileSummary());
      setNotice('Draft ready. Review and save to confirm it.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <form className="profile-form" onSubmit={(e) => void save(e)}>
        <h2>Edit professional details</h2>
        <label>
          Name
          <input
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Career stage
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">Not specified</option>
            {CAREER_STAGES.map((item) => (
              <option key={item} value={item}>
                {item.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label>
          Current role
          <input
            value={role}
            maxLength={200}
            onChange={(e) => setRole(e.target.value)}
          />
        </label>
        <label>
          Location
          <input
            value={location}
            maxLength={200}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>
        <label>
          Summary
          <textarea
            value={summary}
            maxLength={10000}
            rows={4}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void generate()}
        >
          Suggest summary with local AI
        </Button>
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="profile-actions">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save details'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function ExperienceEditor({
  item,
  category,
  onSaved,
  onClose,
}: {
  item?: Experience;
  category: Experience['category'];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<ExperiencesCreateInput>({
    category: item?.category ?? category,
    roleTitle: item?.roleTitle ?? '',
    organisation: item?.organisation ?? null,
    startDate: item?.startDate ?? null,
    endDate: item?.endDate ?? null,
    description: item?.description ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const startDate = value.startDate?.trim()
      ? normalizeExperienceDate(value.startDate)
      : null;
    const endDate = value.endDate?.trim()
      ? normalizeExperienceDate(value.endDate)
      : null;
    if (
      (value.startDate?.trim() && !startDate) ||
      (value.endDate?.trim() && !endDate)
    ) {
      setError('Enter a valid year, month and year, or exact date.');
      return;
    }
    const parsed = experiencesCreateInputSchema.safeParse({
      ...value,
      startDate,
      endDate,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    if (
      !isExperienceDateRangeValid(parsed.data.startDate, parsed.data.endDate)
    ) {
      setError('End date must be after start date.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (item) await updateExperience(item.id, parsed.data);
      else await createExperience(parsed.data);
      onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <form className="profile-form" onSubmit={(e) => void save(e)}>
        <h3>
          {item ? 'Edit' : 'Add'}{' '}
          {category === 'education' ? 'education' : 'experience'}
        </h3>
        <label>
          Category
          <select
            value={value.category}
            onChange={(e) =>
              setValue({
                ...value,
                category: e.target.value as Experience['category'],
              })
            }
          >
            {EXPERIENCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role or title
          <input
            required
            maxLength={200}
            value={value.roleTitle}
            onChange={(e) => setValue({ ...value, roleTitle: e.target.value })}
          />
        </label>
        <label>
          Organisation
          <input
            maxLength={200}
            value={value.organisation ?? ''}
            onChange={(e) =>
              setValue({ ...value, organisation: optional(e.target.value) })
            }
          />
        </label>
        <div className="profile-grid">
          <label>
            Start date
            <input
              value={value.startDate ?? ''}
              placeholder="e.g. Sept 2023, 2023-09, or 2023"
              onChange={(e) =>
                setValue({ ...value, startDate: optional(e.target.value) })
              }
            />
          </label>
          <label>
            End date
            <input
              value={value.endDate ?? ''}
              placeholder="Leave blank if ongoing"
              onChange={(e) =>
                setValue({ ...value, endDate: optional(e.target.value) })
              }
            />
          </label>
        </div>
        <label>
          Description
          <textarea
            maxLength={10000}
            value={value.description}
            onChange={(e) =>
              setValue({ ...value, description: e.target.value })
            }
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="profile-actions">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save entry'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function TargetEditor({
  item,
  onSaved,
  onClose,
}: {
  item?: Target;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<TargetsCreateInput>({
    roleTitle: item?.roleTitle ?? '',
    targetLevel: item?.targetLevel ?? null,
    sector: item?.sector ?? null,
    location: item?.location ?? null,
    active: item?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const parsed = targetsCreateInputSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (item) await updateTarget(item.id, parsed.data);
      else await createTarget(parsed.data);
      onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <form className="profile-form" onSubmit={(e) => void save(e)}>
        <h3>{item ? 'Edit target' : 'Add target role'}</h3>
        <label>
          Target role
          <input
            required
            maxLength={200}
            value={value.roleTitle}
            onChange={(e) => setValue({ ...value, roleTitle: e.target.value })}
          />
        </label>
        {(['targetLevel', 'sector', 'location'] as const).map((field) => (
          <label key={field}>
            {field === 'targetLevel'
              ? 'Target level'
              : field === 'sector'
                ? 'Sector'
                : 'Location'}
            <input
              maxLength={200}
              value={value[field] ?? ''}
              onChange={(e) =>
                setValue({ ...value, [field]: optional(e.target.value) })
              }
            />
          </label>
        ))}
        <label className="profile-check">
          <input
            type="checkbox"
            checked={value.active}
            onChange={(e) => setValue({ ...value, active: e.target.checked })}
          />
          Active
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="profile-actions">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save target'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export async function removeExperience(item: Experience) {
  await deleteExperience(item.id);
}
export async function removeTarget(item: Target) {
  await deleteTarget(item.id);
}
