import React from 'react';
import './Wordmark.css';

/** The Kompas wordmark in this theme: bold Space Grotesk in the accent blue. */
export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span
      className="gnd-wordmark"
      style={{ fontSize: size }}
      aria-hidden="true"
    >
      Kompas
    </span>
  );
}
