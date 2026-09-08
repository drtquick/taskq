// TaskQ Service Worker - Offline caching and PWA support
// Bump CACHE_VERSION on every deploy so the activate handler can evict the old cache.
const CACHE_VERSION = '2026-09-08-03';
const CACHE_NAME = `taskq-${CACHE_VERSION}`;

// Only genuinely static, rarely changing assets belong here.
// The app document at / is deliberately excluded: it is served network-first below.
const STATIC_ASSETS = [
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-192x192.png',
  '/favicon-512x512.png',
  '/apple-touch-icon.png',
  '/manifest.json'
];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean every cache that is not the current version
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Never intercept Firebase, Google APIs, or the TaskQ API. Let the network handle them.
  if (url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebase') ||
      url.hostname === 'api.taskq.qponent.com') {
    return;
  }

  const isHtml = event.request.mode === 'navigate' ||
                 url.pathname === '/' ||
                 url.pathname.endsWith('.html');

  // Network-first for the app shell, so a deploy is live on the very next load.
  if (isHtml) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() =>
        caches.match(event.request).then(cached => cached || caches.match('/index.html') || caches.match('/'))
      )
    );
    return;
  }

  // Cache-first for static assets, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        event.waitUntil(
          fetch(event.request).then(response => {
            if (response.ok) {
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, response));
            }
          }).catch(() => {})
        );
        return cached;
      }
      return fetch(event.request).then(response => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
