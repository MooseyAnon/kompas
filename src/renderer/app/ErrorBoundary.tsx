import React from 'react';
import './Feedback.css';

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main
          className="shell-fallback"
          role="alert"
          data-testid="shell-fallback"
        >
          <h1>Something went wrong</h1>
          <p>This page could not be displayed.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload workspace
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
