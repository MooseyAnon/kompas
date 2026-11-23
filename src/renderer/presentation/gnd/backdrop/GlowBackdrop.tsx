import React from 'react';
import './GlowBackdrop.css';

export type BackdropDensity = 'full' | 'subtle' | 'none';

// Soft colour fields that drift slowly behind the page. Pure decoration:
// no route, app or domain dependencies, and motion stops when the user asks
// for reduced motion (global rule in shell.css).
const glows = ['mint-high', 'mint-low', 'lavender', 'butter', 'peach', 'blush'];

export function GlowBackdrop({ density }: { density: BackdropDensity }) {
  if (density === 'none') return null;

  return (
    <div
      className={`glow-backdrop glow-backdrop-${density}`}
      aria-hidden="true"
      data-testid="app-backdrop"
    >
      {glows.map((name) => (
        <span key={name} className={`glow glow-${name}`} />
      ))}
    </div>
  );
}
