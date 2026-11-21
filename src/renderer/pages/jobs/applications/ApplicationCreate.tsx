import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  createApplicationInput,
  snapshotWithinLimit,
  type Application,
  type ImportPreview,
  type StageKind,
} from '../../../../shared/contracts/applications';
import {
  ApiError,
  createApplication,
  previewApplicationUrl,
} from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { Card } from '../../../presentation/components/Card';
import { initialStages } from './stages';

type Fields = {
  company: string;
  role: string;
  location: string;
  url: string;
  date: string;
  kind: StageKind;
  label: string;
};
const initial: Fields = {
  company: '',
  role: '',
  location: '',
  url: '',
  date: '',
  kind: 'saved',
  label: 'Pending',
};

const reasonText: Record<NonNullable<ImportPreview['reason']>, string> = {
  page_unavailable: 'The page could not be read.',
  page_incomplete: 'The page content was incomplete.',
  not_job_description: 'This page is not a complete job description.',
  identity_unconfirmed: 'The role and employer could not be confirmed.',
  model_unavailable:
    'Local AI is unavailable. You can still enter the details yourself.',
  extraction_failed: 'The job details could not be interpreted.',
  snapshot_too_large: 'The complete job description exceeds the storage limit.',
  snapshot_incomplete: 'A complete original job description is unavailable.',
};

export function ApplicationCreate({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (item: Application) => void;
}) {
  const [mode, setMode] = useState<'url' | 'manual'>('url');
  const [fields, setFields] = useState<Fields>(initial);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [includeSnapshot, setIncludeSnapshot] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pending = useRef(false);
  const previewing = useRef(false);
  const revision = useRef(0);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    return () => {
      revision.current++;
    };
  }, []);

  function edit(patch: Partial<Fields>) {
    setFields((current) => ({ ...current, ...patch }));
    setError('');
    setErrors({});
    if ('url' in patch) {
      revision.current++;
      setPreview(null);
      setIncludeSnapshot(false);
    }
  }

  function enterManual() {
    revision.current++;
    setMode('manual');
    if (!pending.current) setBusy(null);
  }

  async function runPreview() {
    if (previewing.current || pending.current) return;
    const url = fields.url.trim();
    if (
      !URL.canParse(url) ||
      !['http:', 'https:'].includes(new URL(url).protocol)
    ) {
      setError(
        'Enter a valid public http(s) job URL, or enter details manually.',
      );
      return;
    }
    previewing.current = true;
    const id = ++revision.current;
    setBusy('preview');
    setError('');
    setPreview(null);
    try {
      const result = await previewApplicationUrl(url);
      if (id !== revision.current) return;
      setPreview(result);
      setIncludeSnapshot(false);
      setFields((current) => ({
        ...current,
        company: current.company || result.companyName || '',
        role: current.role || result.roleTitle || '',
        location: current.location || result.location || '',
      }));
    } catch (failure) {
      if (id === revision.current)
        setError(
          failure instanceof ApiError
            ? failure.message
            : 'The preview failed. Enter details manually or retry.',
        );
    } finally {
      previewing.current = false;
      if (!pending.current) setBusy(null);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const data = {
      companyName: fields.company,
      roleTitle: fields.role,
      location: fields.location.trim() || null,
      jobUrl: fields.url.trim() || null,
      appliedAt: fields.date || null,
      initialStage: { stageKind: fields.kind, stageLabel: fields.label },
      ...(includeSnapshot && preview?.snapshot
        ? { snapshot: preview.snapshot }
        : {}),
    };
    const validated = createApplicationInput.safeParse(data);
    if (
      !validated.success ||
      (data.snapshot && !snapshotWithinLimit(data.snapshot))
    ) {
      const issues: Record<string, string> = {};
      if (!validated.success)
        for (const issue of validated.error.issues)
          issues[String(issue.path[0])] = issue.message;
      if (data.snapshot && !snapshotWithinLimit(data.snapshot))
        issues.snapshot =
          'The complete job description exceeds the storage limit.';
      setErrors(issues);
      setError('Check the highlighted details before saving.');
      return;
    }
    pending.current = true;
    setBusy('create');
    setError('');
    try {
      const result = await createApplication(validated.data);
      onCreated(result.application);
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'Save failed. Check your applications before retrying.',
      );
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  return (
    <div className="ats-create" data-testid="application-create">
      <Button
        variant="ghost"
        leadingIcon={<ArrowLeft size={16} />}
        onClick={onCancel}
        disabled={busy === 'create'}
      >
        Back to Applications
      </Button>
      <h2>Add application</h2>
      <p>Keep your own record of a job, at its current stage.</p>
      <div className="ats-switches">
        <Button
          variant={mode === 'url' ? 'primary' : 'secondary'}
          onClick={() => setMode('url')}
        >
          Import from URL
        </Button>
        <Button
          variant={mode === 'manual' ? 'primary' : 'secondary'}
          onClick={enterManual}
        >
          Enter manually
        </Button>
      </div>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <Card padding="compact">
          <label className="jobs-field">
            Job URL (optional for manual entry)
            <input
              ref={first}
              type="url"
              maxLength={2048}
              value={fields.url}
              aria-invalid={!!errors.jobUrl}
              onChange={(event) => edit({ url: event.target.value })}
            />
          </label>
          {errors.jobUrl && <p className="jobs-error">{errors.jobUrl}</p>}
          {mode === 'url' && (
            <>
              <Button
                variant="secondary"
                disabled={!!busy || !fields.url.trim()}
                onClick={() => void runPreview()}
              >
                {busy === 'preview' ? 'Reading page…' : 'Preview job URL'}
              </Button>
              {busy === 'preview' && (
                <p role="status">
                  Reading the page and checking the job description…
                </p>
              )}
              {preview && (
                <div className="ats-preview" role="status">
                  <p>
                    {preview.readSucceeded
                      ? 'Page read.'
                      : 'Page not available.'}{' '}
                    {preview.extractionSucceeded
                      ? 'Suggested details are ready for review.'
                      : 'No verified suggestions.'}
                  </p>
                  {preview.reason && (
                    <p>
                      {reasonText[preview.reason]}{' '}
                      {preview.webError ? `Reader: ${preview.webError}.` : ''}
                    </p>
                  )}
                  {preview.snapshotAvailable && preview.snapshot ? (
                    <label className="jobs-check">
                      <input
                        type="checkbox"
                        checked={includeSnapshot}
                        onChange={(event) =>
                          setIncludeSnapshot(event.target.checked)
                        }
                      />
                      Save this complete original job description as a
                      user-confirmed copy
                    </label>
                  ) : (
                    <p>
                      No complete JD snapshot can be saved from this preview.
                    </p>
                  )}
                  {preview.snapshot && (
                    <details>
                      <summary>Review original job description</summary>
                      <div className="ats-snapshot">
                        {preview.snapshot.descriptionText}
                      </div>
                    </details>
                  )}
                  <p>
                    Check and correct the fields below before saving. Preview
                    alone saves nothing.
                  </p>
                </div>
              )}
              <Button variant="ghost" onClick={enterManual}>
                Enter manually
              </Button>
            </>
          )}
        </Card>
        <div className="ats-fields">
          <label className="jobs-field">
            Company *
            <input
              value={fields.company}
              maxLength={200}
              aria-invalid={!!errors.companyName}
              onChange={(event) => edit({ company: event.target.value })}
            />
            {errors.companyName && (
              <span className="jobs-error">{errors.companyName}</span>
            )}
          </label>
          <label className="jobs-field">
            Role *
            <input
              value={fields.role}
              maxLength={200}
              aria-invalid={!!errors.roleTitle}
              onChange={(event) => edit({ role: event.target.value })}
            />
            {errors.roleTitle && (
              <span className="jobs-error">{errors.roleTitle}</span>
            )}
          </label>
          <label className="jobs-field">
            Location (optional)
            <input
              value={fields.location}
              maxLength={200}
              onChange={(event) => edit({ location: event.target.value })}
            />
          </label>
          <label className="jobs-field">
            Applied date (optional)
            <input
              type="date"
              value={fields.date}
              onChange={(event) => edit({ date: event.target.value })}
            />
            {errors.appliedAt && (
              <span className="jobs-error">{errors.appliedAt}</span>
            )}
          </label>
          <label className="jobs-field">
            Current category
            <select
              value={fields.kind}
              onChange={(event) => {
                const kind = event.target.value as StageKind;
                edit({
                  kind,
                  label: initialStages.find((stage) => stage.kind === kind)!
                    .label,
                });
              }}
            >
              {initialStages.map((stage) => (
                <option key={stage.kind} value={stage.kind}>
                  {stage.label}
                </option>
              ))}
            </select>
          </label>
          <label className="jobs-field">
            Specific stage label *
            <input
              value={fields.label}
              maxLength={200}
              aria-invalid={!!errors.initialStage}
              onChange={(event) => edit({ label: event.target.value })}
              placeholder="e.g. Technical Interview Round 2"
            />
            {errors.initialStage && (
              <span className="jobs-error">{errors.initialStage}</span>
            )}
          </label>
        </div>
        {errors.snapshot && <p className="jobs-error">{errors.snapshot}</p>}
        {error && (
          <p role="alert" className="jobs-error">
            {error}
          </p>
        )}
        <div className="jobs-actions">
          <Button type="submit" disabled={!!busy}>
            {busy === 'create' ? 'Saving…' : 'Save application'}
          </Button>
          <Button
            variant="ghost"
            disabled={busy === 'create'}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
