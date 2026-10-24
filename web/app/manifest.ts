import type { MetadataRoute } from 'next';

// Enough to make the page installable: Chrome no longer requires a service worker,
// and without one there is no cache to serve a stale page after a deploy
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SimultanAI',
    short_name: 'SimultanAI',
    start_url: '/',
    display: 'standalone',
    background_color: '#fff',
    theme_color: '#f7bc2a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      // Android crops icons to a circle: this one keeps the glyph inside the central 80%
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
