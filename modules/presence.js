// ============================================================
//  presence.js — Realtime presence, user data loading
// ============================================================

async function loadUserData() {
    console.log('Loading user data for:', currentUser.uid);

    const cacheKey = `user_${currentUser.uid}`;
    // Try L1/localStorage first (sync), then fall back to IndexedDB (async, survives refresh)
    const cached   = enhancedCache.get(cacheKey) ?? await enhancedCache.getAsync(cacheKey);

    if (cached) {
        currentUserData        = cached;
        window.currentUserData = currentUserData;
        updateUserInfo();
        // FIX: unreadMap ని cache నుండి కూడా populate చేయాలి
        if (currentUserData.unreadCounts) {
            Object.keys(currentUserData.unreadCounts).forEach(chatId => {
                unreadMap[chatId] = currentUserData.unreadCounts[chatId];
            });
        }
        return;
    }

    try {
        const userRef = db.collection('users').doc(currentUser.uid);
        let snap      = await userRef.get();

        if (!snap.exists) {
            console.log('Creating new user document...');
            const username = generateUsername(currentUser.displayName || 'user');
            await userRef.set({
                name:              currentUser.displayName || 'User',
                email:             currentUser.email || null,
                // BUG FIX 5: New user documents were created WITHOUT `usernameLower`
                // and `emailLower` fields. friends.js searchUsers() queries Firestore
                // using these fields with range operators (>= / <=). Firestore only
                // returns documents where the queried field EXISTS — so new users
                // were completely invisible in search until these fields were added.
                username,
                usernameLower:     username.toLowerCase(),
                emailLower:        (currentUser.email || '').toLowerCase(),
                usernameChangedAt: null,
                status:            'online',
                friends:           [],
                photoURL:          currentUser.photoURL || null,
                unreadCounts:      {}
            });
            snap = await userRef.get();
        }

        currentUserData        = snap.data();
        window.currentUserData = currentUserData;
        enhancedCache.set(cacheKey, currentUserData, 30 * 60 * 1000);
        console.log('User data loaded:', currentUserData);
        updateUserInfo();

        if (currentUserData.unreadCounts) {
            Object.keys(currentUserData.unreadCounts).forEach(chatId => {
                unreadMap[chatId] = currentUserData.unreadCounts[chatId];
            });
        }

    } catch (error) {
        console.error('Error in loadUserData:', error);
        throw error;
    }
}

function updateUserInfo() {
    const userNameEl     = document.getElementById('userName');
    const userStatusEl   = document.getElementById('userStatus');
    const userAvatarEl   = document.getElementById('userAvatar');
    const avatarFallback = document.getElementById('avatarFallback');

    if (userNameEl)   userNameEl.textContent   = currentUserData.name;
    if (userStatusEl) {
        const I = window.Icons;
        userStatusEl.innerHTML = (I ? '<span style="display:inline-flex;vertical-align:middle;color:#22c55e;margin-right:3px;">' + I.get('onlineDot', 8) + '</span>' : '') + 'Online';
    }

    const photoURL = currentUserData.photoURL || currentUser.photoURL;
    if (photoURL && userAvatarEl && avatarFallback) {
        userAvatarEl.src          = photoURL;
        userAvatarEl.style.display = 'block';
        avatarFallback.style.display = 'none';
    }
}

// ── Presence setup ───────────────────────────────────────────
function setupPresence() {
    if (!currentUser) return;
    const userRef = db.collection('users').doc(currentUser.uid);
    userRef.update({ status: 'online', lastSeen: new Date() }).catch(console.error);

    window.addEventListener('beforeunload', () => {
        userRef.update({ status: 'offline', lastSeen: new Date() }).catch(() => {});
    });

    document.addEventListener('visibilitychange', () => {
        const status = document.visibilityState === 'hidden' ? 'away' : 'online';
        userRef.update({ status, lastSeen: new Date() }).catch(console.error);
    });

    startFriendsPresenceListener();
}

function startFriendsPresenceListener() {
    friendsPresenceUnsubscribers.forEach(unsub => unsub());
    friendsPresenceUnsubscribers = [];

    if (presencePollInterval) clearInterval(presencePollInterval);

    const friends = currentUserData?.friends || [];
    if (friends.length === 0) return;

    // Realtime listener: only current chat partner
    if (chatWithUID) {
        const unsub = db.collection('users').doc(chatWithUID)
            .onSnapshot(doc => {
                if (!doc.exists) return;
                const data     = doc.data();
                const cacheKey = 'user_' + chatWithUID;
                const cached   = enhancedCache.get(cacheKey);
                if (cached) {
                    cached.status   = data.status;
                    cached.lastSeen = data.lastSeen;
                    enhancedCache.set(cacheKey, cached, 30 * 60 * 1000);
                }
                const statusEl = document.getElementById('chatPartnerStatus');
                if (statusEl) {
                    statusEl.textContent = formatStatus(data.status, data.lastSeen);
                    statusEl.className   = data.status === 'online' ? 'status-online' : 'status-offline';
                }
            }, console.error);
        friendsPresenceUnsubscribers.push(unsub);
    }

    // Poll all friends every PRESENCE_POLL_MS — skip entirely when tab is hidden
    async function pollFriendsPresence() {
        // Smart presence: don't waste reads when user isn't looking
        if (document.visibilityState === 'hidden') return;

        const chunks = [];
        for (let i = 0; i < friends.length; i += 10) chunks.push(friends.slice(i, i + 10));

        // Batch-deduplication: collect UIDs that were already fetched this poll cycle
        const fetchedThisCycle = new Set();

        for (const chunk of chunks) {
            // Skip UIDs already fetched this cycle (guards against duplicate UIDs in array)
            const dedupedChunk = chunk.filter(uid => !fetchedThisCycle.has(uid));
            if (dedupedChunk.length === 0) continue;
            dedupedChunk.forEach(uid => fetchedThisCycle.add(uid));

            try {
                const snap = await db.collection('users')
                    .where(firebase.firestore.FieldPath.documentId(), 'in', dedupedChunk)
                    .get();
                snap.forEach(doc => {
                    const data     = doc.data();
                    const cacheKey = 'user_' + doc.id;
                    const cached   = enhancedCache.get(cacheKey);
                    if (cached) {
                        cached.status   = data.status;
                        cached.lastSeen = data.lastSeen;
                        enhancedCache.set(cacheKey, cached, 30 * 60 * 1000);
                    }
                });
                // Pure re-render from updated cache — ZERO additional reads
                if (window._renderFriendsList) window._renderFriendsList();
            } catch (e) { console.error('Presence poll error:', e); }
        }
    }

    pollFriendsPresence();
    presencePollInterval = setInterval(pollFriendsPresence, PRESENCE_POLL_MS);

    // Resume polling immediately when tab becomes visible again (after being hidden)
    document.addEventListener('visibilitychange', function _resumePoll() {
        if (document.visibilityState === 'visible') {
            pollFriendsPresence();
        }
    });
}

window.loadUserData               = loadUserData;
window.setupPresence              = setupPresence;
window.startFriendsPresenceListener = startFriendsPresenceListener;
window.updateUserInfo             = updateUserInfo;

console.log('presence.js loaded');
