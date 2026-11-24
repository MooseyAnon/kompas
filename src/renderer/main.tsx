import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GndApp } from './presentation/gnd/GndApp';
import { applyTheme, readTheme } from './presentation/theme';
import { applyMotion } from './presentation/motion';
import './shell.css';
import './presentation/gnd/theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

// Kompas is the default interface; Meadow is chosen in Settings › System.
const theme = readTheme();
applyTheme(theme);
applyMotion();

createRoot(container).render(
  <React.StrictMode>
    {theme === 'kompas' ? <GndApp /> : <App />}
  </React.StrictMode>,
);
