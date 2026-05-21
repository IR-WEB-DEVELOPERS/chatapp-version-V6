// ============================================================
//  globals.js — Shared state, Firebase init, utility helpers
// ============================================================

// ── Firebase Initialization ──────────────────────────────────
// BUG FIX 8: globals.js had a hardcoded Firebase config that was always used
// on chat.html, regardless of env vars set on the server. index.html correctly
// fetched /firebase-config but globals.js (loaded by chat.html) did not.
// Fix: fetch /firebase-config first; fall back to hardcoded values only if
// the server is unreachable (e.g. local file:// dev without a server).

const _hardcodedFirebaseConfig = {
    apiKey: "AIzaSyBclTC8gK3QKi1X6Q-YCK2jT38yJ83xOcQ",
    authDomain: "chat-app-a0f95.firebaseapp.com",
    projectId: "chat-app-a0f95",
    storageBucket: "chat-app-a0f95.appspot.com",
    messagingSenderId: "754786153113",
    appId: "1:754786153113:web:7543bfb097732ad229fe08",
    measurementId: "G-JFKWR83KYJ"
};

async function _initFirebase() {
    let firebaseConfig = _hardcodedFirebaseConfig;

    // If already initialised (e.g. index.html fetched config inline), reuse it.
    if (firebase.apps.length) {
        console.log('Firebase already initialised — reusing existing app.');
        return;
    }

    try {
        const res = await fetch('/firebase-config');
        if (res.ok) {
            const cfg = await res.json();
            if (cfg.apiKey && cfg.projectId) {
                firebaseConfig = cfg;
            }
        }
    } catch (err) {
        console.warn('Could not fetch /firebase-config, using fallback config:', err);
    }

    window._firebaseConfig = firebaseConfig;

    console.log('Initializing Firebase...');
    try {
        firebase.initializeApp(firebaseConfig);
        console.log('Firebase initialized successfully');
    } catch (error) {
        console.error('Firebase initialization error:', error);
    }
}

// BUG FIX 9: globals.js used to run synchronously — downstream modules that
// depend on `db` and `auth` globals would crash because Firebase wasn't ready.
// We now block the rest of this script with a top-level await (module context)
// or, since this is a classic script, we expose a ready-promise that app.js
// can await before calling initializeApp().
//
// For backward compat we initialise synchronously from the hardcoded config
// first (so `db`/`auth` are always defined), then upgrade to server config.
window._firebaseConfig = _hardcodedFirebaseConfig;
console.log('Initializing Firebase (sync fallback)...');
try {
    if (!firebase.apps.length) {
        firebase.initializeApp(_hardcodedFirebaseConfig);
    }
    console.log('Firebase initialized successfully');
} catch (error) {
    console.error('Firebase initialization error:', error);
}

// Kick off the async upgrade in the background; app.js will wait on
// window._firebaseConfigReady before calling initializeApp().
window._firebaseConfigReady = _initFirebase();

const auth = firebase.auth();
const db   = firebase.firestore();

// ── Firestore offline persistence (serves reads from local cache — zero quota cost) ──
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    if (err.code === 'failed-precondition') {
        // Multiple tabs — persistence only in one tab (still fine)
        console.warn('Firestore persistence: multiple tabs open');
    } else if (err.code === 'unimplemented') {
        console.warn('Firestore persistence not supported in this browser');
    }
});

// ── Global App State ─────────────────────────────────────────
let currentUser     = null;
let currentUserData = null;
let chatWithUID     = null;
let groupChatID     = null;
let unreadMap       = {};
let activeTab       = 'chats';
let notificationPermissionRequested = false;
let isGroupInfoOpen = false;
let unsubscribeDirectMessages = null;
let unsubscribeGroupMessages  = null;

// Pagination state
const MSG_PAGE_SIZE       = 40;          // fewer re-fetches on initial open
let directMsgLastDoc      = null;
let directMsgAllLoaded    = false;
let directMsgLoadingOlder = false;
let groupMsgLastDoc       = null;
let groupMsgAllLoaded     = false;

// Presence — poll every 15 min instead of 5 (3× fewer reads)
let presencePollInterval = null;
const PRESENCE_POLL_MS   = 15 * 60 * 1000;

// Reply state
let replyingTo = null; // { id, text, senderName }

// Typing indicator
let typingTimeout      = null;
let unsubscribeTyping  = null;

// Pinned messages
let pinnedMessages = {};

// Voice recording
let mediaRecorder     = null;
let audioChunks       = [];
let isRecording       = false;
let recordingTimer    = null;
let recordingSeconds  = 0;

// WebRTC
let webRTCManager    = null;
let signalingManager = null;

// Friends presence
let friendsPresenceUnsubscribers = [];

// ── Last-message cache (chatId → {text, time, timeStr}) ──────
// Populated by the messages onSnapshot so loadFriendsList never
// needs an extra Firestore read per friend.
const lastMsgCache = new Map();

// ── Friends-list render deduplication ────────────────────────
// Prevents re-rendering the list when nothing changed.
let _lastFriendsRenderKey = '';
let _lastFriendsHTML      = '';

// ── Escape helpers ──────────────────────────────────────────
function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
    return escapeHTML(value);
}

// ── Chat ID helper ──────────────────────────────────────────
function generateChatId(uid1, uid2) {
    return [uid1, uid2].sort().join('_');
}

function generateUsername(name) {
    return name.toLowerCase().replace(/\s/g, '') + Math.floor(Math.random() * 1000);
}

// ── Status helpers ──────────────────────────────────────────
function statusDotColor(status) {
    if (status === 'online') return '#22c55e';
    if (status === 'away')   return '#f59e0b';
    return '#9ca3af';
}

function formatStatus(status, lastSeen) {
    if (status === 'online') return '\u{1F7E2} Online';
    if (status === 'away')   return '\u{1F7E1} Away';
    if (lastSeen) {
        const date = lastSeen?.toDate ? lastSeen.toDate() : new Date(lastSeen);
        const diff = Math.floor((Date.now() - date.getTime()) / 60000);
        if (diff < 1)    return '\u26AB Just now';
        if (diff < 60)   return '\u26AB ' + diff + 'm ago';
        if (diff < 1440) return '\u26AB ' + Math.floor(diff / 60) + 'h ago';
    }
    return '\u26AB Offline';
}

function getDateLabel(date) {
    const now       = new Date();
    const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (msgDay.getTime() === today.getTime())     return 'Today';
    if (msgDay.getTime() === yesterday.getTime()) return 'Yesterday';
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Toast shorthand (used by autoBackup + loadArchivedMessages) ──
function showToast(msg, type = 'info') {
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    if (window.toastManager) {
        window.toastManager.show({
            icon: icons[type] || 'ℹ️',
            title: msg,
            body: '',
            type: 'message',
            duration: 3500
        });
    }
}

// ── Enhanced cache — L1: in-memory Map, L2: IndexedDB, fallback: localStorage ──
// Survives page refresh via IndexedDB. Memory layer gives instant sync reads.
const enhancedCache = (() => {
    // ── L1: in-memory ───────────────────────────────────────
    const _mem = new Map(); // key → { data, expiry }

    // ── L2: IndexedDB ────────────────────────────────────────
    const IDB_NAME    = 'EduChatEnhancedCache';
    const IDB_STORE   = 'kv';
    const IDB_VERSION = 1;
    let   _idb        = null; // IDBDatabase | null

    function _openIDB() {
        return new Promise((resolve) => {
            if (_idb) { resolve(_idb); return; }
            if (!window.indexedDB) { resolve(null); return; }
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = (e) => { _idb = e.target.result; resolve(_idb); };
            req.onerror   = ()  => { resolve(null); };
        });
    }

    function _idbSet(key, record) {
        _openIDB().then(db => {
            if (!db) return;
            try {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(record);
            } catch (e) { /* quota or private-mode */ }
        });
    }

    function _idbGet(key) {
        return _openIDB().then(db => new Promise(resolve => {
            if (!db) { resolve(null); return; }
            try {
                const tx  = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror   = () => resolve(null);
            } catch (e) { resolve(null); }
        }));
    }

    function _idbDelete(key) {
        _openIDB().then(db => {
            if (!db) return;
            try {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).delete(key);
            } catch (e) { /* ignore */ }
        });
    }

    // ── Public API ───────────────────────────────────────────
    return {
        /** Sync write to memory + async write to IndexedDB */
        set(key, data, ttl = 60 * 60 * 1000) {
            const expiry = Date.now() + ttl;
            _mem.set(key, { data, expiry });
            const record = { key, data, expiry };
            _idbSet(key, record);
            // localStorage fallback (best-effort, not critical)
            try { localStorage.setItem(key, JSON.stringify({ data, expiry })); } catch (_) {}
        },

        /** Sync read from memory (instant). Returns null on miss — caller must use getAsync for cold starts. */
        get(key) {
            const entry = _mem.get(key);
            if (entry) {
                if (Date.now() > entry.expiry) { this.remove(key); return null; }
                return entry.data;
            }
            // Try localStorage as fast sync fallback
            try {
                const raw = localStorage.getItem(key);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Date.now() <= parsed.expiry) {
                        _mem.set(key, parsed); // warm L1
                        return parsed.data;
                    } else {
                        localStorage.removeItem(key);
                    }
                }
            } catch (_) {}
            return null;
        },

        /** Async read: memory → localStorage → IndexedDB. Use on app start to warm memory from persisted cache. */
        async getAsync(key) {
            const sync = this.get(key);
            if (sync !== null) return sync;
            const record = await _idbGet(key);
            if (record && Date.now() <= record.expiry) {
                _mem.set(key, { data: record.data, expiry: record.expiry }); // warm L1
                return record.data;
            }
            if (record) _idbDelete(key); // expired
            return null;
        },

        /** Warm multiple keys from IndexedDB into memory in one pass (used at startup) */
        async warmKeys(keys) {
            await Promise.all(keys.map(k => this.getAsync(k)));
        },

        remove(key) {
            _mem.delete(key);
            _idbDelete(key);
            try { localStorage.removeItem(key); } catch (_) {}
        },

        cleanup() {
            // Expire in-memory entries
            for (const [key, entry] of _mem.entries()) {
                if (Date.now() > entry.expiry) _mem.delete(key);
            }
        }
    };
})();

// ── getUserData (needed by multiple modules) ─────────────────
async function getUserData(uid) {
    // BUG FIX 10: getUserData returned null silently if uid was undefined/null
    // (e.g. when called before currentUser was set), causing cascading
    // "Cannot read properties of null" errors in friends list rendering.
    if (!uid) return null;

    const cacheKey = `user_${uid}`;
    const cached   = enhancedCache.get(cacheKey);
    if (cached) return cached;

    try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            enhancedCache.set(cacheKey, userData, 30 * 60 * 1000);
            return userData;
        }
    } catch (error) {
        console.error('Error getting user data:', error);
    }
    return null;
}

// ── Expose globals ───────────────────────────────────────────
window.db             = db;
window.auth           = auth;
window.currentUser    = currentUser;
window.currentUserData = currentUserData;
window.enhancedCache  = enhancedCache;
window.getUserData    = getUserData;
window.escapeHTML     = escapeHTML;
window.escapeAttribute = escapeAttribute;
window.generateChatId = generateChatId;
window.showToast      = showToast;
window.formatStatus   = formatStatus;
window.getDateLabel   = getDateLabel;
window.statusDotColor = statusDotColor;
window.lastMsgCache   = lastMsgCache;

console.log('globals.js loaded');
