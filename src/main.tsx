import './net/install'; // first: records network activity (Settings → App)
import { render } from 'preact';
// Imported first so the service worker registers and `beforeinstallprompt`
// is captured even if it fires before the UI mounts.
import './pwa';
import { App } from './ui/App';
import '@fontsource-variable/inter';
import './style.css';
import { initAppearance, loadPictures } from './ui/appearance';
import { catchExternalLinks } from './desktop/links';

// The user's theme before anything is drawn.
initAppearance();

catchExternalLinks();
void loadPictures();
render(<App />, document.getElementById('app')!);
