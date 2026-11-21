import React from 'react';
import { ArrowRight, Mic } from 'lucide-react';
import { systemPing } from '../../api';
import { failureNotice, useNotify } from '../../app/Notifications';
import type { Destination } from '../../app/destinations';
import { CommandSurface } from '../../presentation/CommandPalette';
import { Button } from '../../presentation/components/Button';
import './HomePage.css';

export function HomePage({
  onNavigate,
  shortcut,
}: {
  onNavigate: (next: Destination) => void;
  shortcut: string;
}) {
  const notify = useNotify();

  async function checkStatus() {
    try {
      const status = await systemPing();
      notify(
        status.storageReady
          ? { kind: 'info', message: 'Local workspace is ready.' }
          : {
              kind: 'error',
              message:
                'Local storage is unavailable. Please restart the workspace.',
            },
      );
    } catch (error) {
      notify(
        failureNotice(
          error,
          'Could not check the local workspace. Please try again.',
        ),
      );
    }
  }

  return (
    <section className="home-page" aria-label="Home">
      <div className="home-copy">
        <h1>Your next chapter.</h1>
        <span className="home-flourish" aria-hidden="true" />
        <p>
          Find opportunities, prepare for interviews and build the career you
          actually want.
        </p>
        <div className="shell-links home-actions">
          <Button
            leadingIcon={<ArrowRight aria-hidden="true" />}
            onClick={() => onNavigate('jobs')}
          >
            Find opportunities
          </Button>
          <Button
            variant="secondary"
            leadingIcon={<Mic aria-hidden="true" />}
            onClick={() => onNavigate('interviews')}
          >
            Practise an interview
          </Button>
        </div>
        <Button
          variant="ghost"
          className="shell-status-action"
          onClick={() => void checkStatus()}
        >
          Check local status
        </Button>
      </div>
      <CommandSurface
        active="home"
        onChoose={onNavigate}
        mode="embedded"
        shortcut={shortcut}
      />
    </section>
  );
}
