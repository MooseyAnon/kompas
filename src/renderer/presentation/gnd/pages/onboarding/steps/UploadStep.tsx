import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, Trash2, Upload } from 'lucide-react';
import {
  importDocument,
  removeDocument,
  startCvImport,
} from '../../../../../api';
import type { CvImport, Document } from '../../../../../../shared/contracts';
import { failureNotice } from '../../../../../app/Notifications';
import { Button } from '../../../../components/Button';
import { CvIllustration } from '../../applications/ProfileSetup';
import { StepHeading } from '../OnboardingFrame';
import '../../applications/ProfileSetup.css';

/** "2.4 MB", "320 KB". */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Upload a CV, or answer a few questions instead. A chosen file shows as a
 * card you can remove. Continuing starts reading the CV in the background
 * while the rest of onboarding carries on.
 */
export function UploadStep({
  onStarted,
  onSkip,
}: {
  onStarted: (cvImport: CvImport) => void;
  onSkip: () => void;
}) {
  const [file, setFile] = useState<Document | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
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
        setError('Couldn’t add the dropped file. Try Choose a CV file.');
      if (!result.cancelled && result.item) setFile(result.item);
    } catch (e) {
      setError(
        failureNotice(e, 'That file couldn’t be added. Try a PDF or DOCX.')
          .message,
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!file) return;
    const removed = file;
    setFile(null);
    setError('');
    // The stored copy is removed too; a failure here only leaves an unused file.
    await removeDocument(removed.id).catch(() => undefined);
  }

  async function carryOn() {
    if (!file) return;
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
      <StepHeading title="Upload your CV" />

      {dragging && (
        <div className="gnd-drop-overlay" aria-hidden="true">
          <span>Drop your CV anywhere</span>
        </div>
      )}

      <div className="gnd-setup gnd-upload-cards">
        <div
          className={`gnd-setup-card is-upload${dragging ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
          data-testid="gnd-upload-card"
        >
          <Upload aria-hidden="true" className="gnd-setup-icon" />
          <h3>Upload your CV</h3>
          {file ? (
            <div className="gnd-file-card" data-testid="gnd-file-card">
              <span className="gnd-file-type" aria-hidden="true">
                {/\.docx$/i.test(file.originalName) ? 'DOCX' : 'PDF'}
              </span>
              <span className="gnd-file-text">
                <span className="gnd-file-name">{file.originalName}</span>
                <span className="gnd-file-size">
                  {fileSize(file.sizeBytes)}
                </span>
              </span>
              <button
                type="button"
                className="gnd-file-remove"
                aria-label={`Remove ${file.originalName}`}
                disabled={busy}
                onClick={() => void remove()}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          ) : (
            <>
              <p className="gnd-muted">No file added</p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void choose()}
              >
                Choose a CV file
              </Button>
            </>
          )}
        </div>
        <div className="gnd-setup-card">
          <CvIllustration />
          <h3>Don’t have a CV?</h3>
          <Button variant="outline" disabled={busy} onClick={onSkip}>
            <Sparkles aria-hidden="true" /> Answer a few questions
          </Button>
        </div>
      </div>

      {error && (
        <p className="gnd-message" role="alert">
          {error}
        </p>
      )}

      {file && (
        <div className="gnd-actions gnd-upload-next">
          <Button
            size="hero"
            disabled={busy}
            data-testid="gnd-upload-continue"
            onClick={() => void carryOn()}
          >
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}
