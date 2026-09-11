import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { httpLayoutAssistant } from './aiLayoutAssistant.js';
import { desktopProjectFileSystem } from './desktopFiles.js';
import { browserProjectFileSystem } from './projectFiles.js';
import { isDesktop } from './shell.js';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

// The single place the desktop-vs-browser choice is made. Everything below
// takes a `ProjectFileSystem` and never asks which one it got, which is what
// keeps the shell out of the app.
const fileSystem = isDesktop() ? desktopProjectFileSystem : browserProjectFileSystem;

// No desktop-vs-browser split here — `api.ts`'s own `base()` already picks
// the right service URL on either platform. Wired explicitly anyway, so this
// file stays the one place every injected dependency the app depends on is
// visible in one look.
const layoutAssistant = httpLayoutAssistant();

createRoot(container).render(
  <StrictMode>
    <App fileSystem={fileSystem} layoutAssistant={layoutAssistant} />
  </StrictMode>,
);
