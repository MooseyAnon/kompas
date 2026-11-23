import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GndApp } from './presentation/gnd/GndApp';
import { applyTheme, readTheme } from './presentation/theme';
import './shell.css';
import './presentation/gnd/theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

// Meadow is the default interface; GND is chosen in Settings › System.
const theme = readTheme();
applyTheme(theme);

createRoot(container).render(
  <React.StrictMode>{theme === 'gnd' ? <GndApp /> : <App />}</React.StrictMode>,
);
