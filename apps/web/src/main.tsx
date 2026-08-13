import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { desktopProjectFileSystem } from './desktopFiles.js';
import { browserProjectFileSystem } from './projectFiles.js';
import { isDesktop } from './shell.js';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

// The single place the desktop-vs-browser choice is made. Everything below
// takes a `ProjectFileSystem` and never asks which one it got, which is what
// keeps the shell out of the app.
const fileSystem = isDesktop() ? desktopProjectFileSystem : browserProjectFileSystem;

createRoot(container).render(
  <StrictMode>
    <App fileSystem={fileSystem} />
  </StrictMode>,
);
