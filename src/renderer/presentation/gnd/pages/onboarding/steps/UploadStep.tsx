import React, { useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, Upload } from 'lucide-react';
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
  const [dragging, setDragging] = useState(false);
  const [linkedIn, setLinkedIn] = useState(false);
  const depth = useRef(0);

  // Drop a CV anywhere on the window. The file's path goes from the preload
  // straight to the main process; the page only asks it to import the drop.
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const name = event.dataTransfer?.files?.[0]?.name ?? '';
      if (!/\.(pdf|docx)$/i.test(name)) {
        setError('Drop a PDF or DOCX file.');
        return;
      }
      void choose('drop');
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function choose(source: 'picker' | 'drop' = 'picker') {
    setBusy(true);
    setError('');
    try {
      // The native picker runs in the main process; the renderer only
      // receives the stored document's metadata.
      const result = await importDocument('cv', source);
      if (result.cancelled && source === 'drop')
        setError('Couldn’t add the dropped file. Try Choose file instead.');
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

      {dragging && (
        <div className="gnd-drop-overlay" aria-hidden="true">
          <span>Drop your CV anywhere</span>
        </div>
      )}
      <div className={`gnd-dropzone${dragging ? ' is-dragging' : ''}`}>
        <span className="gnd-doc-icon" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <Upload className="gnd-upload-icon" aria-hidden="true" />
        <h2>Upload your CV</h2>
        <p className="gnd-dropzone-hint">or drop a PDF or DOCX anywhere</p>
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

      {linkedIn && (
        <section className="gnd-linkedin" aria-labelledby="gnd-linkedin-title">
          <h2 id="gnd-linkedin-title">Use your LinkedIn profile</h2>
          <p>
            LinkedIn can save your profile, with your experience, education and
            skills, as a PDF. Kompas reads it just like a CV.
          </p>
          <ol>
            <li>
              Open{' '}
              <a
                href="https://www.linkedin.com/in/me/"
                target="_blank"
                rel="noreferrer"
              >
                your LinkedIn profile
                <ExternalLink aria-hidden="true" />
              </a>
            </li>
            <li>
              Click <strong>Resources</strong> (or <strong>More</strong>), then{' '}
              <strong>Save to PDF</strong>
            </li>
            <li>Drop the downloaded file here, or press Choose file</li>
          </ol>
        </section>
      )}

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
        {!linkedIn && (
          <button
            type="button"
            className="gnd-text-link"
            data-testid="gnd-linkedin-open"
            onClick={() => setLinkedIn(true)}
          >
            No CV? Use your LinkedIn profile
          </button>
        )}
        <button type="button" className="gnd-text-link" onClick={onSkip}>
          Add my roles myself
        </button>
      </div>
    </div>
  );
}
