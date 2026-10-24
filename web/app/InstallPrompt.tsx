'use client';

import { useEffect, useState } from 'react';

// Chromium only, not in lib.dom
type InstallEvent = Event & { prompt: () => Promise<unknown> };

const DISMISS_KEY = 'simultanai.install-dismissed';

// Install banner on the first visit: Chrome never shows one by itself, it only puts an icon in the address bar.
// Chromium fires beforeinstallprompt (not when already installed); iOS has no event, so it gets the manual steps
export default function InstallPrompt() {
  const [offer, setOffer] = useState<InstallEvent | 'ios' | null>(null);

  useEffect(() => {
    try { if (localStorage.getItem(DISMISS_KEY)) return; } catch { /* storage blocked: show it anyway */ }
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1); // iPadOS reports itself as a Mac
    if (ios) {
      if (!(navigator as Navigator & { standalone?: boolean }).standalone) setOffer('ios'); // standalone = opened from the home screen
      return;
    }
    const onPrompt = (e: Event) => { e.preventDefault(); setOffer(e as InstallEvent); };
    addEventListener('beforeinstallprompt', onPrompt);
    return () => removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!offer) return null;

  function dismiss() {
    setOffer(null);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* not remembered */ }
  }

  async function install() {
    if (offer !== 'ios') await offer?.prompt(); // the event works once: whatever the answer, the banner goes
    dismiss();
  }

  return (
    <div id="install">
      {offer === 'ios'
        ? <p>To install the app: tap Share, then “Add to Home Screen”</p>
        : <><p>Install the app for one-tap access</p><button onClick={install}>Install</button></>}
      <button className="close" aria-label="Close" onClick={dismiss}>×</button>
    </div>
  );
}
