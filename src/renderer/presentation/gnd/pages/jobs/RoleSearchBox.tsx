import React, { useState } from 'react';
import { failureNotice } from '../../../../app/Notifications';
import { searchForRole } from './roleSearch';

/**
 * "Search more roles that we missed": Enter adds the role to the saved search
 * and starts a run; `onStarted` then shows its progress.
 */
export function RoleSearchBox({
  onStarted,
  className = '',
}: {
  onStarted: (runId: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await searchForRole(value);
      if (result.status === 'started') {
        setValue('');
        onStarted(result.runId);
      } else if (result.status === 'full') {
        setMessage(
          'You already search for five roles. Remove one in Filters first.',
        );
      }
    } catch (error) {
      setMessage(
        failureNotice(error, 'Couldn’t start that search. Please try again.')
          .message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`gnd-role-search ${className}`} onSubmit={submit}>
      <label className="gnd-visually-hidden" htmlFor="gnd-role-search-box">
        Search for a role
      </label>
      <input
        id="gnd-role-search-box"
        className="gnd-input"
        placeholder={
          busy ? 'Starting your search…' : 'Search more roles that we missed'
        }
        value={value}
        maxLength={200}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
      />
      {message && (
        <p className="gnd-role-search-message" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
