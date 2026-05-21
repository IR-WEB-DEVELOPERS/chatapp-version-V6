// ============================================================
//  EduChat Service Worker — PWA + Auto-Update + Push
//
//  Strategy:
//   • App shell (HTML/JS/CSS) → Network-first, cache fallback
//   • Static assets (images, audio) → Cache-first
//   • Firebase/Google APIs → Never intercept
//
//  Auto-update: When new SW installs, all open tabs reload
//   automatically — no hard refresh needed.
// ============================================================

const CACHE_VERSION = 'educhat-v8';
const OFFLINE_URL   = '/index.html';

// Files to pre-cache on install (offline fallback)
const PRECACHE = [
    '/',
    '/index.html',
    '/chat.html',
    '/manifest.json',
    '/icon-192.png',
    '/splash-logo.png',
    '/modules/ring.mp3',
    '/modules/ping.mp3',
];

// Extensions treated as app code → always network-first
const APP_EXTENSIONS = ['.html', '.js', '.css'];

function isAppFile(url) {
    try {
        const pathname = new URL(url).pathname;
        return APP_EXTENSIONS.some(ext => pathname.endsWith(ext));
    } catch { return false; }
}

function isThirdParty(url) {
    try {
        const hostname = new URL(url).hostname;
        return (
            hostname.includes('firestore.googleapis.com') ||
            hostname.includes('firebase') ||
            hostname.includes('googleapis.com') ||
            hostname.includes('gstatic.com') ||
            hostname.includes('accounts.google.com') ||
            hostname.includes('anthropic.com')
        );
    } catch { return true; }
}

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then(cache => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())   // activate immediately
    );
});

// ── Activate — delete old caches, claim all tabs ─────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
            .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
            .then(clients => {
                // Tell every open tab: new version is live → auto reload
                clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
            })
    );
});

// ── Fetch ────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    if (isThirdParty(event.request.url))  return;

    if (isAppFile(event.request.url)) {
        // ── Network-first for HTML / JS / CSS ────────────────
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_VERSION)
                            .then(cache => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request)
                    .then(cached => cached || caches.match(OFFLINE_URL))
                )
        );
    } else {
        // ── Cache-first for images, audio, fonts ─────────────
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(response => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        const clone = response.clone();
                        caches.open(CACHE_VERSION)
                            .then(cache => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => {
                    if (event.request.destination === 'document')
                        return caches.match(OFFLINE_URL);
                });
            })
        );
    }
});

// ============================================================
//  Push Notifications (PATH A — browser closed)
// ============================================================
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; }
    catch (e) { data = { title: 'EduChat', body: event.data ? event.data.text() : 'New message' }; }
    event.waitUntil(showPushNotification(data));
});

// ============================================================
//  Messages from main app (PATH B — tab open)
// ============================================================
self.addEventListener('message', (event) => {
    const { type } = event.data || {};
    if (type === 'SHOW_NOTIFICATION') showPushNotification(event.data);
});

// ── Show system notification ─────────────────────────────────
async function showPushNotification({ title, body, icon, chatId, isGroup, type }) {
    const clients    = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const foreground = clients.some(c => c.visibilityState === 'visible');
    const isCall     = type === 'call_video' || type === 'call_voice';
    if (foreground && !isCall) return;

    await self.registration.showNotification(title || 'EduChat', {
        body:     body  || '',
        icon:     icon  || '/icon-192.png',
        badge:    '/icon-192.png',
        vibrate:  isCall ? [500, 200, 500, 200, 500] : [200, 100, 200],
        tag:      isCall ? 'educhat-call' : (chatId || 'educhat'),
        renotify: true,
        requireInteraction: isCall,
        data:     { chatId, isGroup, type },
        actions:  isCall
            ? [{ action: 'open', title: '📲 Answer' }, { action: 'close', title: '❌ Decline' }]
            : [{ action: 'open', title: '💬 Open' },   { action: 'close', title: '✕' }]
    });
}

// ── Notification clicked ─────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const { chatId, isGroup, type } = event.notification.data || {};
    const isCall = type === 'call_video' || type === 'call_voice';

    if (event.action === 'close') {
        if (isCall && chatId) {
            event.waitUntil(
                self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
                    const existing = clients.find(c =>
                        c.url.includes('/chat.html') || c.url.includes(self.location.origin));
                    if (existing) existing.postMessage({ type: 'DECLINE_CALL', callId: chatId, callType: type });
                    else self.clients.openWindow(`/chat.html?declineCall=${chatId}&callType=${type}`);
                })
            );
        }
        return;
    }

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            const existing = clients.find(c =>
                c.url.includes('/chat.html') || c.url.includes(self.location.origin));
            if (existing) {
                existing.focus();
                existing.postMessage({ type: 'NOTIFICATION_CLICKED', chatId, isGroup, callType: type });
            } else {
                const url = isCall
                    ? `/chat.html?callType=${type}&chatId=${chatId || ''}`
                    : '/chat.html';
                self.clients.openWindow(url);
            }
        })
    );
});
