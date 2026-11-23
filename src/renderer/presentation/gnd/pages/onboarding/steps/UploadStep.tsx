import React, { useId, useState } from 'react';
import { Upload } from 'lucide-react';
import { importDocument, startCvImport } from '../../../../../api';
import type { CvImport, Document } from '../../../../../../shared/contracts';
import { failureNotice } from '../../../../../app/Notifications';
import { Button } from '../../../../components/Button';
import { StepHeading } from '../OnboardingFrame';

export function UploadStep({
  onStarted,
  onSkip,
}: {
  onStarted: (cvImport: CvImport) => void;
  onSkip: () => void;
}) {
  const consentId = useId();
  const [file, setFile] = useState<Document | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose() {
    setBusy(true);
    setError('');
    try {
      // The native picker runs in the main process; the renderer only
      // receives the stored document's metadata.
      const result = await importDocument('cv');
      if (!result.cancelled) setFile(result.item);
    } catch (e) {
      setError(
        failureNotice(e, 'Couldn’t add that file. Try a PDF or DOCX.').message,
      );
    } finally {
      setBusy(false);
    }
  }

  async function findRoles() {
    if (!file || !consent) return;
    setBusy(true);
    setError('');
    try {
      onStarted(await startCvImport(file.id));
    } catch (e) {
      setError(
        failureNotice(e, 'Couldn’t start reading your CV. Please try again.')
          .message,
      );
      setBusy(false);
    }
  }

  return (
    <div className="gnd-stack gnd-upload">
      <StepHeading
        title="Start with what you’ve done."
        lead={
          <p>
            Kompas reads your CV, searches the web for matching roles, and
            tailors each application — you download and apply externally.
          </p>
        }
      />

      <div className="gnd-dropzone">
        <span className="gnd-doc-icon" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <Upload className="gnd-upload-icon" aria-hidden="true" />
        <h2>Upload your CV</h2>
        <p className="gnd-dropzone-file" aria-live="polite">
          {file ? file.originalName : 'No file added'}
        </p>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void choose()}
        >
          {file ? 'Choose another file' : 'Choose file'}
        </Button>
      </div>

      <label className="gnd-consent" htmlFor={consentId}>
        <input
          id={consentId}
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <span>
          I agree to Kompas reading my CV to find relevant roles and prepare
          tailored CVs. Everything stays on this computer.
        </span>
      </label>

      {error && (
        <p className="gnd-message" role="alert">
          {error}
        </p>
      )}

      <div className="gnd-actions">
        <Button
          size="hero"
          disabled={!file || !consent || busy}
          onClick={() => void findRoles()}
        >
          Find me roles
        </Button>
        <button type="button" className="gnd-text-link" onClick={onSkip}>
          I don’t have a CV to hand
        </button>
      </div>
    </div>
  );
}
