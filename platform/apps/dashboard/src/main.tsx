import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/screens.css';
import './styles/admin.css';

import { render } from 'preact';
import { config } from 'zod';

import { App } from './App.js';

// CSP `script-src 'self'` has no 'unsafe-eval': zod must never try `new Function` (ADR-M54 §2.3).
config({ jitless: true });

const root = document.getElementById('app');
if (root) render(<App />, root);
