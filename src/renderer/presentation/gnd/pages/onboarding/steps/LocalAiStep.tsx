import React from 'react';
import { getInferenceSettings } from '../../../../../api';
import { StepHeading } from '../OnboardingFrame';
import { OllamaSetup } from '../OllamaSetup';

export { copyText } from '../OllamaSetup';

/** Is a local model selected and installed? (Reading a CV needs one.) */
export async function localAiReady(): Promise<boolean> {
  try {
    const { resolvedModel } = await getInferenceSettings();
    return Boolean(
      resolvedModel?.installed && resolvedModel.locality === 'local',
    );
  } catch {
    return false;
  }
}

export function LocalAiStep({
  onReady,
  onSkip,
}: {
  onReady: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="gnd-stack gnd-local-ai">
      <StepHeading
        title="Set up Ollama"
        lead={
          <>
            <p>
              To use our platform and get recommended job openings, you’ll need
              Ollama and its model on your computer, so your CV never leaves it.
            </p>
            <p>
              <em>It’s completely free and safe.</em>
            </p>
          </>
        }
      />
      <OllamaSetup onReady={onReady} onSkip={onSkip} />
    </div>
  );
}
