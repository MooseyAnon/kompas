import React from 'react';
import { Button } from '../../../components/Button';
import './OllamaNudge.css';

/**
 * Shown at the top of Settings while Ollama or its model isn't ready, for
 * example when onboarding was skipped. Local AI shows the setup steps.
 */
export function OllamaNudge({ onSetUp }: { onSetUp?: () => void }) {
  return (
    <div className="gnd-nudge" role="alert" data-testid="ollama-nudge">
      <p>
        It looks like you haven’t installed Ollama yet. Kompas needs it to read
        your CV and find roles for you. If you get stuck, message 07728990467.
      </p>
      {onSetUp && <Button onClick={onSetUp}>Set up Ollama</Button>}
    </div>
  );
}
