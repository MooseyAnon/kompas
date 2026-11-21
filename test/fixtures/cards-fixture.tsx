import React, { useState } from 'react';
import { Cpu } from 'lucide-react';
import {
  Card,
  CardButton,
} from '../../src/renderer/presentation/components/Card';
import { Disclosure } from '../../src/renderer/presentation/components/Disclosure';
import { Button } from '../../src/renderer/presentation/components/Button';

/** Isolated example for component tests and visual inspection; not an app route. */
export function CardsFixture() {
  const [selected, setSelected] = useState(false);
  return (
    <main className="cards-fixture">
      <Card
        data-testid="main-card"
        header={
          <>
            <strong className="cards-fixture-title">
              <Cpu aria-hidden="true" /> Local runtime
            </strong>
            <span className="cards-fixture-status">Ready</span>
          </>
        }
      >
        <p>Private, on-device tools for your workspace.</p>
        <Card variant="subtle" padding="compact" data-testid="nested-card">
          <strong>Installed models</strong>
          <p>Choose a model when you’re ready.</p>
          <CardButton
            selected={selected}
            data-testid="model-card"
            onClick={() => setSelected((value) => !value)}
          >
            Model 4B · {selected ? 'Selected' : 'Select'}
          </CardButton>
        </Card>
        <Disclosure label="Technical details" data-testid="technical-details">
          <p>Only local models are listed here.</p>
          <Button variant="secondary">Check status</Button>
        </Disclosure>
      </Card>
      <Card padding="compact" data-testid="summary-card">
        <strong>Browsers</strong>
        <p>Available on this device</p>
      </Card>
    </main>
  );
}
