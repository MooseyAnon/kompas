import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/shell.css';
import { CardsFixture } from './cards-fixture';
import './cards-preview.css';

createRoot(document.getElementById('root')!).render(<CardsFixture />);
