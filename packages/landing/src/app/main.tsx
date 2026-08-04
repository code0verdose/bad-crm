import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.component.js';
import './global.css';

const root = document.querySelector('#root');

if (!root) {
  throw new Error('The #root element is missing from index.html.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
