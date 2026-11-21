import React, { useRef, useState } from 'react';
import type { OpportunityApplyPreview } from '../../../../shared/contracts/job-discovery';
import {
  ApiError,
  applyReviewOpportunity,
  previewReviewApply,
} from '../../../api';
import { Button } from '../../../presentation/components/Button';

const snapshotReasons = {
  no_verified_jd: 'No current verified job description is available.',
  incomplete:
    'The verified job description is incomplete or cannot be represented intact.',
  too_large:
    'The verified job description exceeds the application snapshot limit.',
};

export function ApplyOpportunity({
  opportunityId,
  applicationId,
  dismissed,
  onOpen,
}: {
  opportunityId: string;
  applicationId: string | null;
  dismissed: boolean;
  onOpen: (id: string) => void;
}) {
  const [preview, setPreview] = useState<OpportunityApplyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const currentId = preview?.applicationId ?? applicationId;

  async function prepare() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await previewReviewApply(opportunityId);
      if (result.applicationId) onOpen(result.applicationId);
      else setPreview(result);
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'Could not check this opportunity. Try again.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function confirm() {
    if (inFlight.current || !preview) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const id = await applyReviewOpportunity(opportunityId, {
        confirmUnverified: preview.unverified,
        withoutSnapshot: preview.snapshot !== 'available',
        allowDuplicate: !!preview.manualMatchId,
      });
      onOpen(id);
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'Could not create the application. Try again.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="jobs-review-apply">
      {currentId ? (
        <Button disabled={busy} onClick={() => onOpen(currentId)}>
          Open application
        </Button>
      ) : !dismissed && !preview ? (
        <Button disabled={busy} onClick={() => void prepare()}>
          Apply
        </Button>
      ) : null}
      {preview && !preview.dismissed && (
        <div
          role="group"
          aria-label="Confirm application handoff"
          className="jobs-review-confirm"
        >
          <p>
            Start tracking this opportunity in Applications as Pending. This
            does not submit an application.
          </p>
          {preview.unverified && (
            <p>
              The original source URL is unverified. Confirm that you want to
              keep it as the job URL.
            </p>
          )}
          {preview.snapshot !== 'available' && (
            <p>
              {snapshotReasons[preview.snapshot]} Continue without a saved JD
              snapshot?
            </p>
          )}
          {preview.manualMatchId && (
            <p>
              An existing manual application has the same exact job reference.
              Open it or explicitly create a separate application; no records
              will be merged.
            </p>
          )}
          <div className="jobs-review-decision-actions">
            {preview.manualMatchId && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => onOpen(preview.manualMatchId!)}
              >
                Open existing
              </Button>
            )}
            <Button disabled={busy} onClick={() => void confirm()}>
              {preview.manualMatchId
                ? 'Create separate Pending application'
                : 'Confirm Pending application'}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {busy && <p role="status">Checking application…</p>}
      {error && (
        <p role="alert" className="jobs-error">
          {error}
        </p>
      )}
    </div>
  );
}
