// ============================================================
//  friends.js — Friends list, search, requests, remove
// ============================================================

// ── Last-message subscriber map: chatId → unsubscribe fn ─────
const _lastMsgUnsubMap = new Map();

// ── User profile real-time listener map: uid → unsubscribe fn ─
const _userUnsubMap = new Map();

function _subscribeUserProfile(uid) {
    if (_userUnsubMap.has(uid)) return;
    const unsub = db.collection('users').doc(uid).onSnapshot(snap => {
        if (!snap.exists) return;
        const data = snap.data();
        enhancedCache.set(`user_${uid}`, data, 30 * 60 * 1000);
        _renderFriendsList();
    }, err => console.warn('User profile listener error:', err));
    _userUnsubMap.set(uid, unsub);
}

function _subscribeLastMsg(chatId) {
    if (_lastMsgUnsubMap.has(chatId)) return;
    const unsub = db.collection('messages')
        .where('chatId', '==', chatId)
        .orderBy('time', 'desc')
        .limit(1)
        .onSnapshot(snap => {
            if (snap.empty) { lastMsgCache.set(chatId, null); _renderFriendsList(); return; }
            const d     = snap.docs[0].data();
            const t     = d.time;
            const tDate = t?.toDate ? t.toDate() : new Date(t || 0);
            const now   = new Date();
            const yest  = new Date(now); yest.setDate(now.getDate() - 1);
            let timeStr = '';
            if (tDate.toDateString() === now.toDateString())
                timeStr = tDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            else if (tDate.toDateString() === yest.toDateString())
                timeStr = 'Yesterday';
            else
                timeStr = tDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

            let preview = '';
            if (d.type === 'call')       preview = d.callType === 'video' ? 'Video call' : 'Voice call';
            else if (d.type === 'file')  preview = 'File';
            else if (d.type === 'voice') preview = 'Voice message';
            else if (d.deletedForAll)    preview = 'Message deleted';
            else {
                const isMine = d.sender === currentUser?.uid;
                preview      = (isMine ? 'You: ' : '') + (d.text || '').replace(/\n/g, ' ');
            }
            lastMsgCache.set(chatId, { time: tDate.getTime(), preview, timeStr });
            _renderFriendsList();
        }, () => { _lastMsgUnsubMap.delete(chatId); });
    _lastMsgUnsubMap.set(chatId, unsub);
}

function _pruneLastMsgSubs(activeChatIds) {
    _lastMsgUnsubMap.forEach((unsub, chatId) => {
        if (!activeChatIds.has(chatId)) { unsub(); _lastMsgUnsubMap.delete(chatId); }
    });
}

// ── Extra UIDs — fetched once per session, then cached ───────
let _extraUIDsCached    = null;
let _extraUIDsFetchedAt = 0;
const EXTRA_UIDS_TTL_MS = 10 * 60 * 1000;

async function _getExtraUIDs(friendsFromArray) {
    const now = Date.now();
    if (_extraUIDsCached && (now - _extraUIDsFetchedAt) < EXTRA_UIDS_TTL_MS) return _extraUIDsCached;
    const extraUIDs = [];
    try {
        const msgSnap = await db.collection('messages')
            .where('participants', 'array-contains', currentUser.uid)
            .limit(50).get();
        const seen = new Set(friendsFromArray);
        msgSnap.forEach(doc => {
            (doc.data().participants || []).forEach(uid => {
                if (uid !== currentUser.uid && !seen.has(uid)) { seen.add(uid); extraUIDs.push(uid); }
            });
        });
    } catch (e) { console.log('Extra UIDs fetch error:', e); }
    _extraUIDsCached    = extraUIDs;
    _extraUIDsFetchedAt = now;
    return extraUIDs;
}

// ── Pure render — ZERO Firestore reads ───────────────────────
function _renderFriendsList() {
    const friendsList = document.getElementById('friendsList');
    if (!friendsList || !currentUserData) return;

    const friends = [
        ...(currentUserData.friends || []),
        ...(_extraUIDsCached || [])
    ].filter(uid =>
        !window.privateChatsManager?.isPrivate(uid) &&
        !window.privateChatsManager?.isBlocked(uid)
    );

    if (friends.length === 0) { friendsList.innerHTML = '<div class="no-chats">No chats yet</div>'; return; }

    const entries = friends.map(friendUID => {
        const friendData = enhancedCache.get(`user_${friendUID}`);
        if (!friendData) return null;
        const chatId = generateChatId(currentUser.uid, friendUID);
        const lm     = lastMsgCache.get(chatId);
        return { friendUID, friendData, chatId, lastTime: lm?.time || 0, lastPreview: lm?.preview || '', lastTimeStr: lm?.timeStr || '' };
    }).filter(Boolean).sort((a, b) => b.lastTime - a.lastTime);

    // Skip re-render if nothing changed (saves DOM thrash)
    const renderKey = entries.map(e =>
        `${e.friendUID}:${e.lastTime}:${unreadMap[e.chatId] || 0}:${e.friendData?.status}:${e.friendData?.name}:${e.friendData?.photoURL}`
    ).join('|');
    if (renderKey === _lastFriendsRenderKey) return;
    _lastFriendsRenderKey = renderKey;

    let html = '';
    for (const { friendUID, friendData, chatId, lastPreview, lastTimeStr } of entries) {
        const unreadCount = unreadMap[chatId] || 0;
        const dotColor    = statusDotColor(friendData.status);
        const photoURL    = friendData.photoURL || '';
        const initials    = escapeHTML(friendData.name?.charAt(0)?.toUpperCase() || 'U');
        html += `
            <button class="chat-item" data-uid="${escapeAttribute(friendUID)}">
                <div class="chat-avatar">
                    ${photoURL
                        ? `<img class="avatar-img" src="${escapeAttribute(photoURL)}" alt="${initials}"
                               onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                           <span class="avatar-fallback" style="display:none;">${initials}</span>`
                        : `<span class="avatar-fallback">${initials}</span>`
                    }
                    <span class="status-dot" style="background:${dotColor};"></span>
                </div>
                <div class="chat-info">
                    <div class="chat-item-top">
                        <h4>${escapeHTML(friendData.name)}</h4>
                        ${lastTimeStr ? `<span class="chat-item-time">${escapeHTML(lastTimeStr)}</span>` : ''}
                    </div>
                    <div class="chat-item-bottom">
                        <p class="chat-item-preview">${escapeHTML(lastPreview)}</p>
                        ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ''}
                    </div>
                </div>
            </button>
        `;
    }

    friendsList.innerHTML = html;
    friendsList.querySelectorAll('.chat-item').forEach(item => {
        item.addEventListener('click', () => openChat(item.dataset.uid));
    });
}

// ── Shimmer skeleton helpers ──────────────────────────────────
function _showShimmer(container, count = 5) {
    let html = '';
    for (let i = 0; i < count; i++) {
        html += `
        <div class="chat-item skeleton-item" aria-hidden="true">
            <div class="skeleton skeleton-avatar"></div>
            <div class="chat-info">
                <div class="chat-item-top">
                    <div class="skeleton skeleton-name" style="width:${55 + (i % 3) * 20}px"></div>
                    <div class="skeleton skeleton-time"></div>
                </div>
                <div class="chat-item-bottom">
                    <div class="skeleton skeleton-preview" style="width:${80 + (i % 4) * 25}px"></div>
                </div>
            </div>
        </div>`;
    }
    container.innerHTML = html;
}

// ── loadFriendsList: orchestrate subs then render ─────────────
async function loadFriendsList() {
    const friendsList = document.getElementById('friendsList');
    if (!friendsList) return;
    if (!currentUserData) { _showShimmer(friendsList, 5); return; }

    const friendsFromArray = currentUserData.friends || [];
    await _getExtraUIDs(friendsFromArray);

    const allUIDs = [...friendsFromArray, ...(_extraUIDsCached || [])].filter(uid =>
        !window.privateChatsManager?.isPrivate(uid) &&
        !window.privateChatsManager?.isBlocked(uid)
    );

    if (allUIDs.length === 0) { friendsList.innerHTML = '<div class="no-chats">No chats yet</div>'; return; }

    // ── Cache-first: render immediately from whatever is in cache ──
    const hasCachedData = allUIDs.some(uid => enhancedCache.get(`user_${uid}`));
    if (!friendsList.querySelector('.chat-item:not(.skeleton-item)')) {
        if (hasCachedData) {
            // Render instantly from cache while Firestore syncs in background
            _renderFriendsList();
        } else {
            // Nothing cached yet — show shimmer while we fetch
            _showShimmer(friendsList, Math.min(allUIDs.length, 6));
        }
    }

    // ── Batch-deduplication: fetch only uncached UIDs ──
    const uncached = [...new Set(allUIDs)].filter(uid => !enhancedCache.get(`user_${uid}`));
    if (uncached.length > 0) {
        // Also warm from IndexedDB before hitting Firestore
        await enhancedCache.warmKeys(uncached.map(uid => `user_${uid}`));
        // Re-check after IndexedDB warm — may have reduced Firestore reads to zero
        const stillUncached = uncached.filter(uid => !enhancedCache.get(`user_${uid}`));
        if (stillUncached.length > 0) {
            const chunks = [];
            // Deduplicate UIDs across chunks — same UID must appear at most once
            const seen = new Set();
            const deduped = stillUncached.filter(uid => seen.has(uid) ? false : (seen.add(uid), true));
            for (let i = 0; i < deduped.length; i += 10) chunks.push(deduped.slice(i, i + 10));
            await Promise.all(chunks.map(async chunk => {
                try {
                    const snap = await db.collection('users')
                        .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
                    snap.forEach(doc => enhancedCache.set(`user_${doc.id}`, doc.data(), 30 * 60 * 1000));
                } catch (e) { console.error('Batch user fetch:', e); }
            }));
        }
    }

    // Subscribe last-message per chat + user profile changes (idempotent)
    const activeChatIds = new Set();
    allUIDs.forEach(uid => {
        const chatId = generateChatId(currentUser.uid, uid);
        activeChatIds.add(chatId);
        _subscribeLastMsg(chatId);
        _subscribeUserProfile(uid);
    });
    _pruneLastMsgSubs(activeChatIds);

    // Final render with full data, then attach lazy-load observer
    _renderFriendsList();
    _attachLazyLoadObserver(friendsList);
}

// ── Lazy load: only subscribe last-msg for visible chats ──────
let _lazyObserver = null;

function _attachLazyLoadObserver(container) {
    if (!('IntersectionObserver' in window)) return; // fallback: already subscribed all above
    if (_lazyObserver) { _lazyObserver.disconnect(); }

    _lazyObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const uid = entry.target.dataset.uid;
                if (uid) {
                    const chatId = generateChatId(currentUser.uid, uid);
                    _subscribeLastMsg(chatId);
                    _subscribeUserProfile(uid);
                    _lazyObserver.unobserve(entry.target); // subscribe once, then stop observing
                }
            }
        });
    }, { root: container, rootMargin: '100px', threshold: 0 });

    container.querySelectorAll('.chat-item[data-uid]').forEach(el => {
        _lazyObserver.observe(el);
    });
}

window._renderFriendsList = _renderFriendsList;

// ── Search debounce & pagination state ───────────────────────
let _searchDebounceTimer = null;
const SEARCH_PAGE_SIZE   = 8;
let _searchCurrentPage   = 0;
let _searchAllResults    = [];
let _lastSearchTerm      = '';

// Debounced entry point (called by input event)
function searchUsersDebounced() {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => searchUsers(), 350);
}

async function searchUsers() {
    const searchInput = document.getElementById('searchUser');
    const searchTerm  = searchInput?.value.trim();
    const resultsDiv  = document.getElementById('searchedUser');

    if (!resultsDiv) return;

    // Empty input → clear
    if (!searchTerm) { resultsDiv.innerHTML = ''; return; }

    // Private chat passcode shortcut
    if (/^\d{4}$/.test(searchTerm)) {
        window.privateChatsManager?.tryUnlockFromSearch(searchTerm);
        searchInput.value = '';
        resultsDiv.innerHTML = '';
        return;
    }

    // Same term, already rendered → skip network call
    if (searchTerm === _lastSearchTerm && _searchAllResults.length > 0) {
        _renderSearchPage(resultsDiv, 0);
        return;
    }

    _lastSearchTerm      = searchTerm;
    _searchCurrentPage   = 0;
    _searchAllResults    = [];

    resultsDiv.innerHTML = '<div class="no-results">Searching...</div>';

    try {
        const allResults = new Map();
        const lower      = searchTerm.toLowerCase();

        // Strategy 1: usernameLower prefix query
        try {
            const snap = await db.collection('users')
                .where('usernameLower', '>=', lower)
                .where('usernameLower', '<=', lower + '\uf8ff')
                .limit(20).get();
            snap.forEach(doc => { if (doc.id !== currentUser.uid) allResults.set(doc.id, doc.data()); });
        } catch {
            try {
                const snap = await db.collection('users')
                    .where('username', '>=', searchTerm)
                    .where('username', '<=', searchTerm + '\uf8ff')
                    .limit(20).get();
                snap.forEach(doc => { if (doc.id !== currentUser.uid) allResults.set(doc.id, doc.data()); });
            } catch { /* ignore */ }
        }

        // Strategy 2: emailLower prefix query
        try {
            const snap = await db.collection('users')
                .where('emailLower', '>=', lower)
                .where('emailLower', '<=', lower + '\uf8ff')
                .limit(20).get();
            snap.forEach(doc => { if (doc.id !== currentUser.uid && !allResults.has(doc.id)) allResults.set(doc.id, doc.data()); });
        } catch { /* ignore */ }

        // Strategy 3: client-side name match (only if few results so far)
        if (allResults.size < 5) {
            try {
                // Check cache first to avoid extra Firestore read
                const cacheKey = 'search_users_pool';
                let pool = window.enhancedCache?.get(cacheKey);
                if (!pool) {
                    const snap = await db.collection('users').limit(100).get();
                    pool = snap.docs.map(d => ({ id: d.id, data: d.data() }));
                    window.enhancedCache?.set(cacheKey, pool, 5 * 60 * 1000); // 5 min cache
                }
                pool.forEach(({ id, data: user }) => {
                    if (id !== currentUser.uid && !allResults.has(id)) {
                        if ((user.username || '').toLowerCase().includes(lower) ||
                            (user.name     || '').toLowerCase().includes(lower)) {
                            allResults.set(id, user);
                        }
                    }
                });
            } catch { /* ignore */ }
        }

        // Filter out self + blocked contacts
        const blockedList = window.privateChatsManager
            ? Array.from(window.privateChatsManager.isBlocked ? [] : []).map(u => u.uid)
            : [];
        // Get full blocked list via internal API
        const rawBlocked = (() => {
            try {
                return JSON.parse(localStorage.getItem(`blocked_${currentUser.uid}`) || '[]');
            } catch { return []; }
        })();
        const blockedSet = new Set(rawBlocked.map(u => u.uid || u));

        _searchAllResults = Array.from(allResults.entries())
            .filter(([uid]) => !blockedSet.has(uid)) // hide blocked users from search
            .slice(0, 50);

        _renderSearchPage(resultsDiv, 0);

    } catch (error) {
        console.error('Error searching users:', error);
        if (resultsDiv) resultsDiv.innerHTML = '<div class="no-results">Error searching users.</div>';
    }
}

function _renderSearchPage(resultsDiv, page) {
    _searchCurrentPage = page;
    resultsDiv.innerHTML = '';

    if (_searchAllResults.length === 0) {
        resultsDiv.innerHTML = '<div class="no-results">No users found</div>';
        return;
    }

    const start     = page * SEARCH_PAGE_SIZE;
    const end       = start + SEARCH_PAGE_SIZE;
    const pageItems = _searchAllResults.slice(start, end);
    const totalPages = Math.ceil(_searchAllResults.length / SEARCH_PAGE_SIZE);

    pageItems.forEach(([userId, user]) => {
        const isFriend  = (currentUserData?.friends || []).includes(userId);
        const photoURL  = user.photoURL || '';
        const initials  = (user.name?.charAt(0)?.toUpperCase()) || '?';
        const div = document.createElement('div');
        div.className = 'search-result';
        div.innerHTML = `
            <div class="search-result-inner">
                <div class="search-result-avatar" onclick="window.friendProfileViewer?.open('${escapeAttribute(userId)}')" style="cursor:pointer;">
                    ${photoURL
                        ? `<img class="avatar-img" src="${escapeAttribute(photoURL)}" alt="${escapeHTML(initials)}"
                               onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                           <span class="avatar-fallback" style="display:none;">${escapeHTML(initials)}</span>`
                        : `<span class="avatar-fallback">${escapeHTML(initials)}</span>`
                    }
                </div>
                <div class="search-result-info" onclick="window.friendProfileViewer?.open('${escapeAttribute(userId)}')" style="cursor:pointer;flex:1;">
                    <strong>${escapeHTML(user.name || 'Unknown')}</strong>
                    <div style="font-size:0.8rem;color:#718096;">@${escapeHTML(user.username || 'No username')}</div>
                </div>
                ${isFriend
                    ? `<button class="primary-btn" disabled style="opacity:0.5;cursor:default;">Friends</button>`
                    : `<button class="primary-btn add-friend-btn" data-uid="${escapeAttribute(userId)}">Add Friend</button>`
                }
            </div>
        `;
        resultsDiv.appendChild(div);
    });

    // Pagination controls
    if (totalPages > 1) {
        const nav = document.createElement('div');
        nav.className = 'search-pagination';
        nav.innerHTML = `
            <button class="search-page-btn" id="searchPrevBtn" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
            <span class="search-page-info">${page + 1} / ${totalPages}</span>
            <button class="search-page-btn" id="searchNextBtn" ${page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
        `;
        resultsDiv.appendChild(nav);
        document.getElementById('searchPrevBtn')?.addEventListener('click', () => _renderSearchPage(resultsDiv, page - 1));
        document.getElementById('searchNextBtn')?.addEventListener('click', () => _renderSearchPage(resultsDiv, page + 1));
    }

    resultsDiv.querySelectorAll('.add-friend-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = '...';
            await sendFriendRequest(btn.dataset.uid);
            btn.textContent = '✅ Sent';
        });
    });
}

async function sendFriendRequest(toUID) {
    try {
        const requestId = generateChatId(currentUser.uid, toUID);
        await db.collection('friendRequests').doc(requestId).set({
            from: currentUser.uid, to: toUID, status: 'pending', timestamp: new Date()
        });
        modalManager.showModal('Success', 'Friend request sent!', 'success');
    } catch (error) {
        console.error('Error sending friend request:', error);
        modalManager.showModal('Error', 'Failed to send friend request', 'error');
    }
}

let _lastReqFetchAt = 0;
async function loadFriendRequests() {
    const requestsDiv = document.getElementById('friendRequests');
    if (!requestsDiv) return;

    // Throttle: don't re-fetch if last fetch was < 30s ago
    const now = Date.now();
    if (now - _lastReqFetchAt < 30_000 && requestsDiv.querySelector('.request-item')) return;
    _lastReqFetchAt = now;

    try {
        const snapshot = await db.collection('friendRequests')
            .where('to', '==', currentUser.uid)
            .where('status', '==', 'pending')
            .get();

        if (snapshot.empty) {
            requestsDiv.innerHTML = '<div class="no-requests">No pending requests</div>';
            return;
        }

        let html = '';
        for (const doc of snapshot.docs) {
            const request  = doc.data();
            const fromUser = await getUserData(request.from);
            if (fromUser) {
                const reqPhoto    = fromUser.photoURL || '';
                const reqInitials = escapeHTML(fromUser.name?.charAt(0)?.toUpperCase() || 'U');
                html += `
                    <div class="request-item">
                        <div class="friend-avatar">
                            ${reqPhoto
                                ? `<img class="avatar-img" src="${escapeAttribute(reqPhoto)}" alt="${reqInitials}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                                   <span class="avatar-fallback" style="display:none;">${reqInitials}</span>`
                                : `<span class="avatar-fallback">${reqInitials}</span>`
                            }
                        </div>
                        <div class="friend-info">
                            <h4>${escapeHTML(fromUser.name)}</h4>
                            <p>@${escapeHTML(fromUser.username)}</p>
                        </div>
                        <div class="request-actions">
                            <button class="accept-btn"  data-requestid="${escapeAttribute(doc.id)}">Accept</button>
                            <button class="decline-btn" data-requestid="${escapeAttribute(doc.id)}">Decline</button>
                        </div>
                    </div>
                `;
            }
        }

        requestsDiv.innerHTML = html;
        requestsDiv.querySelectorAll('.accept-btn').forEach(btn  => btn.addEventListener('click', () => acceptFriendRequest(btn.dataset.requestid)));
        requestsDiv.querySelectorAll('.decline-btn').forEach(btn => btn.addEventListener('click', () => declineFriendRequest(btn.dataset.requestid)));

    } catch (error) {
        console.error('Error loading friend requests:', error);
        requestsDiv.innerHTML = '<div class="no-requests">Error loading requests</div>';
    }
}

async function acceptFriendRequest(requestId) {
    try {
        const requestDoc = await db.collection('friendRequests').doc(requestId).get();
        if (!requestDoc.exists) return;
        const request = requestDoc.data();

        await db.collection('friendRequests').doc(requestId).update({ status: 'accepted' });

        const batch = db.batch();
        batch.update(db.collection('users').doc(request.from), { friends: firebase.firestore.FieldValue.arrayUnion(request.to) });
        batch.update(db.collection('users').doc(request.to),   { friends: firebase.firestore.FieldValue.arrayUnion(request.from) });
        await batch.commit();

        loadFriendRequests();
        loadAllFriends();
    } catch (error) {
        console.error('Error accepting friend request:', error);
        modalManager.showModal('Error', 'Failed to accept friend request', 'error');
    }
}

async function declineFriendRequest(requestId) {
    try {
        await db.collection('friendRequests').doc(requestId).update({ status: 'declined' });
        loadFriendRequests();
    } catch (error) {
        console.error('Error declining friend request:', error);
        modalManager.showModal('Error', 'Failed to decline friend request', 'error');
    }
}

async function loadAllFriends() {
    const friendsDiv = document.getElementById('friendsListAll');
    if (!friendsDiv) return;

    try {
        const friends = currentUserData.friends || [];
        if (friends.length === 0) { friendsDiv.innerHTML = '<div class="no-friends">No friends yet</div>'; return; }

        // Warm cache in batches — only fetch what isn't cached
        const uncached = friends.filter(uid => !enhancedCache.get(`user_${uid}`));
        if (uncached.length > 0) {
            const chunks = [];
            for (let i = 0; i < uncached.length; i += 10) chunks.push(uncached.slice(i, i + 10));
            await Promise.all(chunks.map(async chunk => {
                try {
                    const snap = await db.collection('users')
                        .where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
                    snap.forEach(doc => enhancedCache.set(`user_${doc.id}`, doc.data(), 30 * 60 * 1000));
                } catch (e) { console.error('loadAllFriends batch:', e); }
            }));
        }

        let html = '';
        for (const friendUID of friends) {
            const friendData = enhancedCache.get(`user_${friendUID}`);
            if (!friendData) continue;
            const dotColor = statusDotColor(friendData.status);
            const photoURL = friendData.photoURL || '';
            const initials = escapeHTML(friendData.name?.charAt(0)?.toUpperCase() || 'U');
            html += `
                <div class="friend-item">
                    <div class="friend-avatar">
                        ${photoURL
                            ? `<img class="avatar-img" src="${escapeAttribute(photoURL)}" alt="${initials}"
                                   onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                               <span class="avatar-fallback" style="display:none;">${initials}</span>`
                            : `<span class="avatar-fallback">${initials}</span>`
                        }
                        <span class="status-dot" style="background:${dotColor};"></span>
                    </div>
                    <div class="friend-info">
                        <h4>${escapeHTML(friendData.name)}</h4>
                        <p style="font-size:0.75rem;">${formatStatus(friendData.status, friendData.lastSeen)}</p>
                    </div>
                    <button class="friend-menu-btn" data-uid="${escapeAttribute(friendUID)}" data-name="${escapeAttribute(friendData.name || 'User')}" title="Friend Options">...</button>
                    <button class="remove-friend-btn" data-uid="${escapeAttribute(friendUID)}" title="Remove Friend">&times;</button>
                </div>
            `;
        }

        friendsDiv.innerHTML = html;
        friendsDiv.querySelectorAll('.friend-menu-btn').forEach(btn => {
            btn.addEventListener('click', () => openChatOptionsMenu(btn.dataset.uid, btn.dataset.name));
        });
        friendsDiv.querySelectorAll('.remove-friend-btn').forEach(btn => {
            btn.addEventListener('click', () => removeFriend(btn.dataset.uid));
        });

    } catch (error) {
        console.error('Error loading friends:', error);
        friendsDiv.innerHTML = '<div class="no-friends">Error loading friends</div>';
    }
}


async function removeFriend(friendUID) {
    const confirmed = await modalManager.showModal('Remove Friend', 'Are you sure you want to remove this friend?', 'warning', 'Remove', 'Cancel');
    if (!confirmed) return;

    try {
        const batch = db.batch();
        batch.update(db.collection('users').doc(currentUser.uid), { friends: firebase.firestore.FieldValue.arrayRemove(friendUID) });
        batch.update(db.collection('users').doc(friendUID),       { friends: firebase.firestore.FieldValue.arrayRemove(currentUser.uid) });
        await batch.commit();
        loadAllFriends();
        loadFriendsList();
    } catch (error) {
        console.error('Error removing friend:', error);
        modalManager.showModal('Error', 'Failed to remove friend', 'error');
    }
}

async function openChatOptionsMenu(friendUID, friendName = 'User') {
    const isPrivate = window.privateChatsManager?.isPrivate(friendUID);
    const privateText = isPrivate ? 'Remove from Private Chats' : 'Move to Private Chats';

    // Check current vanish mode state — read from Firestore (source of truth)
    const chatId = generateChatId(currentUser.uid, friendUID);
    const vanishKey = `vanishMode_${chatId}`;
    let isVanishOn = localStorage.getItem(vanishKey) === 'true';
    try {
        const vanishDoc = await db.collection('vanishMode').doc(chatId).get();
        if (vanishDoc.exists) {
            isVanishOn = vanishDoc.data()?.enabled === true;
            localStorage.setItem(vanishKey, isVanishOn ? 'true' : 'false');
        }
    } catch(e) { /* fallback to localStorage */ }
    const vanishText = isVanishOn ? '👻 Vanish Mode: ON  (tap to turn off)' : '👻 Vanish Mode: OFF (tap to turn on)';

    const isSecured   = window.privateChatsManager?.isSecuredChat?.(friendUID) || false;
    const secureText  = isSecured ? '🔓 Remove Chat Security' : '🔒 Add Security (Fingerprint)';

    const action = await new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal chat-options-modal">
                <div class="modal-header">
                    <h3>Chat Options</h3>
                    <button class="modal-close" data-action="cancel">&times;</button>
                </div>
                <div class="modal-body chat-options-body">
                    <button class="chat-option-btn${isVanishOn ? ' vanish-active' : ''}" data-action="vanish">${escapeHTML(vanishText)}</button>
                    <button class="chat-option-btn${isSecured ? ' secured-active' : ''}" data-action="secure">${escapeHTML(secureText)}</button>
                    <button class="chat-option-btn" data-action="private">${escapeHTML(privateText)}</button>
                    <button class="chat-option-btn danger" data-action="block">Block Contact</button>
                    <button class="chat-option-btn muted" data-action="cancel">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const close = (result) => {
            modal.remove();
            resolve(result);
        };

        modal.addEventListener('click', (e) => {
            if (e.target === modal) close('cancel');
            const btn = e.target.closest('[data-action]');
            if (btn) close(btn.dataset.action);
        });
    });

    if (action === 'vanish') {
        const nowOn = !isVanishOn;
        localStorage.setItem(vanishKey, nowOn ? 'true' : 'false');

        // Sync vanish state to Firestore so the other person sees it too
        try {
            await db.collection('vanishMode').doc(chatId).set({
                enabled: nowOn,
                toggledBy: currentUser.uid,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch(e) {
            console.error('Vanish mode Firestore sync error:', e);
        }

        if (!nowOn) {
            // Vanish mode OFF — hard-delete all messages sent during vanish mode
            await deleteVanishMessages(chatId);
        }

        // Update banner in current open chat if it's the same chat
        if (window.updateVanishBanner) window.updateVanishBanner(friendUID);
        return;
    }

    if (action === 'secure') {
        const pm = window.privateChatsManager;
        if (!pm) return;
        const available  = await pm.isBiometricAvailable();
        // Check Firestore too (covers cache-clear scenario)
        const registered = available && (await pm.isBiometricRegisteredAsync?.() || pm.isBiometricRegistered());
        if (!available) {
            window.toastManager?.show({ icon: null, type: 'error', title: 'Biometric not available', body: 'Your device does not support fingerprint/Face ID', duration: 3000 });
            return;
        }
        if (!registered) {
            window.toastManager?.show({ icon: null, type: 'info', title: 'Biometric not set up', body: 'Enable Biometric Unlock in Profile → Security first', duration: 4000 });
            return;
        }
        // Always use verifyBiometric directly — passes stored credId → fingerprint prompt, not passkey picker
        const doVerify = () => pm.verifyBiometric?.() ?? pm.verifyForChat();
        if (isSecured) {
            const ok = await doVerify();
            if (!ok) { window.toastManager?.show({ icon: null, type: 'error', title: 'Fingerprint failed', body: 'Could not remove security', duration: 2500 }); return; }
            pm.removeSecuredChat(friendUID);
            window.toastManager?.show({ icon: null, type: 'info', title: '🔓 Security removed', body: `${friendName} chat is now open`, duration: 3000 });
        } else {
            const ok = await doVerify();
            if (!ok) { window.toastManager?.show({ icon: null, type: 'error', title: 'Fingerprint failed', body: 'Could not enable security', duration: 2500 }); return; }
            pm.addSecuredChat(friendUID);
            window.toastManager?.show({ icon: null, type: 'success', title: '🔒 Security enabled', body: `${friendName} chat requires fingerprint to open`, duration: 3000 });
        }
        return;
    }

    if (action === 'private') {
        if (isPrivate) {
            window.privateChatsManager?.removeFromPrivate(friendUID);
        } else {
            window.privateChatsManager?.addToPrivate(friendUID);
        }
        loadFriendsList();
        return;
    }

    if (action === 'block') {
        const confirmed = await modalManager.showModal(
            'Block Contact',
            `Block ${friendName}? They will be hidden from your chat list on this device.`,
            'warning',
            'Block',
            'Cancel'
        );
        if (confirmed) {
            window.privateChatsManager?.blockContact(friendUID, friendName);
            loadFriendsList();
            loadAllFriends();
        }
    }
}

// ── Vanish Mode — hard-delete messages flagged with vanishMode:true ─
async function deleteVanishMessages(chatId) {
    if (!currentUser) return;
    try {
        const snap = await db.collection('messages')
            .where('chatId', '==', chatId)
            .where('vanishMode', '==', true)
            .get();
        const batch = db.batch();
        snap.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        if (!snap.empty) await batch.commit();
    } catch (e) {
        console.error('Vanish delete error:', e);
    }
}
window.deleteVanishMessages = deleteVanishMessages;

// ── Expose ───────────────────────────────────────────────────
window.loadFriendsList      = loadFriendsList;
window.loadAllFriends       = loadAllFriends;
window.loadFriendRequests   = loadFriendRequests;
window.searchUsers          = searchUsers;
window.searchUsersDebounced = searchUsersDebounced;
window.sendFriendRequest    = sendFriendRequest;
window.acceptFriendRequest  = acceptFriendRequest;
window.declineFriendRequest = declineFriendRequest;
window.removeFriend         = removeFriend;
window.openChatOptionsMenu  = openChatOptionsMenu;

console.log('friends.js loaded');
