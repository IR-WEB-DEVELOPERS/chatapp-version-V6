// ============================================================
//  app.js — Auth, initialization, event listeners, tab switching
// ============================================================

// ── Auth state ───────────────────────────────────────────────
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((err) => {
    console.warn('Firebase auth persistence setup failed:', err);
});

const LOGIN_VERIFIED_PREFIX = 'educhat_login_otp_verified_';

// BUG FIX 14: Guard against initializeApp() being called more than once.
// onAuthStateChanged can fire multiple times (token refresh, tab focus).
// Without this guard the app would re-subscribe to all Firestore listeners
// on every token refresh, causing duplicate messages and listener leaks.
let _appInitialised = false;

function _isLoginVerified(uid) {
    return localStorage.getItem(`${LOGIN_VERIFIED_PREFIX}${uid}`) === 'true';
}

auth.onAuthStateChanged(async (user) => {
    console.log('Auth state changed:', user ? 'logged in' : 'no user');
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    if (!_isLoginVerified(user.uid)) {
        window.location.href = 'index.html';
        return;
    }

    // BUG FIX 14 (cont): Skip re-init on subsequent onAuthStateChanged calls.
    if (_appInitialised) return;
    _appInitialised = true;

    currentUser        = user;
    window.currentUser = currentUser;
    await initializeApp();
});

// ── App initialization ───────────────────────────────────────
async function initializeApp() {
    console.log('Starting app initialization...');
    try {
        await loadUserData();
        initializeDarkMode();
        requestNotificationPermission();
        setupEventListeners();
        await initializeWebRTCManagers();
        startListeners();
        updateUI();
        setupPresence();
        enhancedCache.cleanup();

        // ── E2EE: Generate/publish keys after login ──────────────
        if (window.E2EE) {
            window.E2EE.init(currentUser.uid).catch(e =>
                console.warn('[E2EE] init error:', e)
            );
        }
        // Listens for Firestore invites created when a 1-1 call is
        // upgraded. Shows incoming-call UI so the new member can join.
        _listenGroupCallInvites();

        // Initialize Profile Manager
        if (window.profileManager) {
            const avatarWrap = document.getElementById('userAvatarWrap');
            if (avatarWrap) {
                avatarWrap.addEventListener('click', () => window.profileManager.open());
            }
        }

        // Initialize Stories / Status Manager
        if (window.storiesManager) {
            window.storiesManager.init();
            const addStatusBtn = document.getElementById('addStatusBtn');
            if (addStatusBtn) {
                addStatusBtn.addEventListener('click', () => window.storiesManager.openComposer());
            }
        }

        // Initialize push notifications (Firestore-based, no server needed)
        if (window.pushNotifications) {
            window.pushNotifications.init();
        }

        // Initialize Private Chats / blocked contacts manager
        if (window.privateChatsManager) {
            window.privateChatsManager.init();
        }

        // Auto-backup check runs in background 5s after load
        setTimeout(() => {
            if (window.autoBackup) autoBackup.run();
        }, 5000);

        console.log('App initialized successfully');
        window.dispatchEvent(new Event('appInitialized'));
    } catch (error) {
        console.error('Error initializing app:', error);
        modalManager.showModal('Error', 'Error initializing app: ' + error.message, 'error');
    }
}

// ── Start realtime listeners ─────────────────────────────────
function startListeners() {
    let prevRequestCount  = 0;
    let firstReqSnapshot  = true;

    // Friend requests
    db.collection('friendRequests')
        .where('to', '==', currentUser.uid)
        .where('status', '==', 'pending')
        .onSnapshot(snapshot => {
            const newCount = snapshot.size;
            badgeManager.updateBadge('requests', newCount);

            if (!firstReqSnapshot && newCount > prevRequestCount) {
                badgeManager.playNotificationSound();
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'added') {
                        const req = change.doc.data();
                        getUserData(req.from).then(senderData => {
                            toastManager.show({
                                icon: null, type: 'message', title: 'Friend Request',
                                body: `${senderData?.name || 'Someone'} sent you a friend request`,
                                type: 'request',
                                onClick: () => switchTab('friends')
                            });
                        });
                        if (Notification.permission === 'granted') {
                            new Notification('EduChat — Friend Request', { body: 'You have a new friend request!', icon: '/favicon.ico' });
                        }
                    }
                });
            }
            firstReqSnapshot  = false;
            prevRequestCount  = newCount;
            if (activeTab === 'friends') loadFriendRequests();
        });

    // Own user document (friends list changes)
    db.collection('users').doc(currentUser.uid)
        .onSnapshot(doc => {
            if (doc.exists) {
                const prevFriends  = currentUserData?.friends || [];
                currentUserData    = doc.data();
                window.currentUserData = currentUserData;
                // FIX: cache ని fresh data తో update చేయాలి, stale కాకుండా
                enhancedCache.set(`user_${currentUser.uid}`, currentUserData, 30 * 60 * 1000);
                // FIX: unreadMap ని కూడా sync చేయాలి
                if (currentUserData.unreadCounts) {
                    Object.keys(currentUserData.unreadCounts).forEach(chatId => {
                        unreadMap[chatId] = currentUserData.unreadCounts[chatId];
                    });
                }

                const newFriends = currentUserData.friends || [];
                if (JSON.stringify(prevFriends.sort()) !== JSON.stringify(newFriends.sort())) {
                    startFriendsPresenceListener();
                }

                if (activeTab === 'chats')   _renderFriendsList();   // pure render, zero reads
                else if (activeTab === 'friends') loadAllFriends();
            }
        });
}

function updateUI() {
    // Only load what the active tab needs — don't fetch everything at once
    if (activeTab === 'chats')   loadFriendsList();
    else if (activeTab === 'friends') { loadFriendRequests(); loadAllFriends(); }
    else if (activeTab === 'groups')  { loadGroupsList(); loadFriendsForGroup(); }
}

// ── Tab switching ────────────────────────────────────────────
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const activeTabBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (activeTabBtn) activeTabBtn.classList.add('active');

    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    const activePane = document.getElementById(`${tabName}-tab`);
    if (activePane) activePane.classList.add('active');

    activeTab = tabName;

    switch (tabName) {
        case 'chats':   loadFriendsList(); break;
        case 'friends': loadFriendRequests(); loadAllFriends(); break;
        case 'groups':  loadGroupsList(); loadFriendsForGroup(); break;
    }
}

// ── Open individual chat ─────────────────────────────────────
async function openChat(friendUID) {
    // ── Secured chat: require fingerprint before opening ─────
    const pm = window.privateChatsManager;
    if (pm?.isSecuredChat?.(friendUID)) {
        const available  = await pm.isBiometricAvailable();
        const registered = available && await pm.isBiometricRegisteredAsync?.() || pm.isBiometricRegistered();
        if (available && registered) {
            const ok = await pm.verifyBiometric?.() ?? await pm.verifyForChat();
            if (!ok) {
                window.toastManager?.show({ icon: null, type: 'error', title: '🔒 Fingerprint required', body: 'Could not verify. Chat not opened.', duration: 3000 });
                return; // block opening
            }
        }
    }
    // ─────────────────────────────────────────────────────────

    chatWithUID   = friendUID;
    groupChatID   = null;

    if (unsubscribeGroupMessages) {
        unsubscribeGroupMessages();
        unsubscribeGroupMessages = null;
    }

    startFriendsPresenceListener();

    const defaultChat        = document.getElementById('defaultChat');
    const individualChat     = document.getElementById('individualChat');
    const groupChatContainer = document.getElementById('groupChatContainer');

    if (defaultChat)        defaultChat.style.display        = 'none';
    if (individualChat)     individualChat.style.display     = 'flex';
    if (groupChatContainer) groupChatContainer.style.display = 'none';
    const aiChatPane = document.getElementById('aiChatPane');
    if (aiChatPane)         aiChatPane.style.display         = 'none';

    if (window._hideSidebarOnMobile) window._hideSidebarOnMobile();

    const friendData       = await getUserData(friendUID);
    const chatPartnerName  = document.getElementById('chatPartnerName');
    const chatPartnerStatus = document.getElementById('chatPartnerStatus');
    const chatPartnerAvatar = document.getElementById('chatPartnerAvatar');

    if (chatPartnerAvatar) {
        const photoURL = friendData.photoURL || '';
        const initials = (friendData.name?.charAt(0)?.toUpperCase()) || '?';
        if (photoURL) {
            chatPartnerAvatar.innerHTML = `<img class="avatar-img" src="${escapeAttribute(photoURL)}" alt="${escapeAttribute(initials)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><span class="avatar-fallback" style="display:none;">${escapeHTML(initials)}</span>`;
        } else {
            chatPartnerAvatar.innerHTML = `<span class="avatar-fallback">${escapeHTML(initials)}</span>`;
        }
    }

    if (chatPartnerName) chatPartnerName.textContent = friendData.name;
    if (chatPartnerStatus) {
        chatPartnerStatus.textContent = formatStatus(friendData.status, friendData.lastSeen);
        chatPartnerStatus.className   = friendData.status === 'online' ? 'status-online' : 'status-offline';
    }

    // ── Make chat header avatar + name clickable → view friend profile ──
    const chatPartner = document.querySelector('#individualChat .chat-partner');
    if (chatPartner) {
        chatPartner.style.cursor = 'pointer';
        chatPartner.onclick = () => window.friendProfileViewer?.open(friendUID);
    }

    loadMessages();
    addCallButtonsToChat();
    markChatAsRead(generateChatId(currentUser.uid, friendUID));
    listenTypingIndicator();

    // Wire 3-dot menu in chat header
    const chatMoreBtn = document.getElementById('chatMoreBtn');
    if (chatMoreBtn) {
        chatMoreBtn.onclick = () => {
            openChatOptionsMenu(friendUID, friendData.name || 'User');
        };
    }

    // Expiry timer button
    const chatExpiryBtn = document.getElementById('chatExpiryBtn');
    if (chatExpiryBtn && window.msgExpiry) {
        chatExpiryBtn.onclick = () => {
            const chatId = window.generateChatId?.(window.currentUser?.uid, friendUID) || '';
            window.msgExpiry.showPicker(chatId, false, chatExpiryBtn);
        };
    }

    // Show vanish mode banner if active
    updateVanishBanner(friendUID);

    const msgInput = document.getElementById('msg');
    if (msgInput) msgInput.oninput = onTypingInput;
}

// ── Event listeners setup ─────────────────────────────────────
function setupEventListeners() {
    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabBtn  = e.target.closest('.tab-btn');
            const tabName = tabBtn?.dataset.tab;
            if (tabName) switchTab(tabName);
        });
    });

    // Mobile sidebar
    function showSidebar() {
        const sidebar  = document.querySelector('.sidebar');
        const chatArea = document.querySelector('.chat-area');
        if (!sidebar) return;
        sidebar.classList.remove('mobile-hidden');
        chatArea?.classList.remove('mobile-chat-open');
        document.getElementById('sidebarBackdrop')?.remove();
    }

    function hideSidebar() {
        if (window.innerWidth > 599) return;
        const sidebar  = document.querySelector('.sidebar');
        const chatArea = document.querySelector('.chat-area');
        if (!sidebar) return;
        sidebar.classList.add('mobile-hidden');
        chatArea?.classList.add('mobile-chat-open');
        // Push history so Android back button fires popstate
        history.pushState({ chatOpen: true }, '');
    }

    // popstate = Android back button pressed while in chat
    window.addEventListener('popstate', function () {
        const chatArea = document.querySelector('.chat-area');
        if (!chatArea?.classList.contains('mobile-chat-open')) return;

        // Helper: re-arm so next back is also caught
        function rearm() { history.pushState({ chatOpen: true }, ''); }

        // Close overlays first (priority order)
        const fp  = document.querySelector('.fp-overlay');
        if (fp)  { window.friendProfileViewer?.close?.(); rearm(); return; }

        const qr  = document.getElementById('qrScannerOverlay');
        if (qr)  { window.QRManager?.closeScannerModal?.(); rearm(); return; }

        const otv = document.querySelector('.otv-overlay');
        if (otv) { otv.remove(); rearm(); return; }

        const lb  = document.querySelector('.mlb-overlay, #mediaLightbox, .media-lightbox-overlay');
        if (lb)  { window.mediaLightbox?.close?.(); lb.isConnected && lb.remove(); rearm(); return; }

        const modals = Array.from(document.querySelectorAll('.modal-overlay'))
            .filter(m => m.style.display !== 'none' && m.offsetParent !== null);
        if (modals.length) {
            const top = modals[modals.length - 1];
            const btn = top.querySelector('.modal-close, [data-action="cancel"]');
            btn ? btn.click() : (top.style.display = 'none');
            rearm(); return;
        }

        const dd = document.getElementById('sidebarDropdown');
        if (dd?.classList.contains('open')) { dd.classList.remove('open'); rearm(); return; }

        // Nothing open → go back to sidebar (home)
        showSidebar();
        if (typeof window.unsubscribeDirectMessages === 'function') {
            window.unsubscribeDirectMessages(); window.unsubscribeDirectMessages = null;
        }
        if (typeof window.unsubscribeGroupMessages === 'function') {
            window.unsubscribeGroupMessages(); window.unsubscribeGroupMessages = null;
        }
        window.chatWithUID = null;
        window.groupChatID = null;
        const dc = document.getElementById('defaultChat');
        const ic = document.getElementById('individualChat');
        const gc = document.getElementById('groupChatContainer');
        const ai = document.getElementById('aiChatPane');
        if (dc) dc.style.display = 'flex';
        if (ic) ic.style.display = 'none';
        if (gc) gc.style.display = 'none';
        if (ai) ai.style.display = 'none';
    });

    window._hideSidebarOnMobile = hideSidebar;
    window._showSidebarOnMobile = showSidebar;

    document.getElementById('backToSidebarBtn1')?.addEventListener('click', showSidebar);
    document.getElementById('backToSidebarBtn2')?.addEventListener('click', showSidebar);
    document.getElementById('openSidebarBtn')?.addEventListener('click', showSidebar);

    window.addEventListener('resize', () => {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        if (window.innerWidth > 599) {
            sidebar.classList.remove('mobile-hidden');
            const backdrop = document.getElementById('sidebarBackdrop');
            if (backdrop) backdrop.remove();
        }
    });

    // Search. A 4-digit value is reserved as the Private Chats unlock code.
    document.getElementById('searchBtn')?.addEventListener('click', () => {
        const value = document.getElementById('searchUser')?.value.trim() || '';
        if (/^\d{4}$/.test(value)) {
            window.privateChatsManager?.tryUnlockFromSearch(value);
            document.getElementById('searchUser').value = '';
            document.getElementById('searchedUser').innerHTML = '';
            return;
        }
        searchUsers();
    });
    // Live-as-you-type debounced search
    document.getElementById('searchUser')?.addEventListener('input', () => {
        const val = document.getElementById('searchUser').value.trim();
        if (!val) { document.getElementById('searchedUser').innerHTML = ''; return; }
        searchUsersDebounced();
    });
    document.getElementById('searchUser')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const value = e.currentTarget.value.trim();
            if (/^\d{4}$/.test(value)) {
                window.privateChatsManager?.tryUnlockFromSearch(value);
                e.currentTarget.value = '';
                const results = document.getElementById('searchedUser');
                if (results) results.innerHTML = '';
                return;
            }
            searchUsers();
        }
    });

    // Direct message send
    const sendBtn  = document.getElementById('sendBtn');
    const msgInput = document.getElementById('msg');
    if (sendBtn)  sendBtn.addEventListener('click', () => window.sendMessage?.());
    if (msgInput) {
        msgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendMessage?.(); }
        });
        msgInput.addEventListener('input', () => {
            msgInput.style.height = 'auto';
            msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
        });
    }

    // Group message send
    const sendGroupBtn  = document.getElementById('sendGroupBtn');
    const groupMsgInput = document.getElementById('groupMsg');
    if (sendGroupBtn)  sendGroupBtn.addEventListener('click', () => window.sendGroupMessage?.());
    if (groupMsgInput) {
        groupMsgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendGroupMessage?.(); }
        });
        groupMsgInput.addEventListener('input', () => {
            groupMsgInput.style.height = 'auto';
            groupMsgInput.style.height = Math.min(groupMsgInput.scrollHeight, 120) + 'px';
        });
    }

    // Group creation
    document.getElementById('createGroupBtn')?.addEventListener('click', createGroup);

    // Toggle create group panel
    document.getElementById('toggleCreateGroup')?.addEventListener('click', () => {
        const body  = document.getElementById('createGroupBody');
        const arrow = document.getElementById('createGroupArrow');
        if (body && arrow) {
            body.classList.toggle('open');
            arrow.classList.toggle('open');
        }
    });

    // Add member
    document.getElementById('addMemberBtn')?.addEventListener('click', openAddMemberModal);
    document.getElementById('closeAddMemberModal')?.addEventListener('click', () => {
        document.getElementById('addMemberModal').style.display = 'none';
    });
    document.getElementById('cancelAddMember')?.addEventListener('click', () => {
        document.getElementById('addMemberModal').style.display = 'none';
    });
    document.getElementById('confirmAddMember')?.addEventListener('click', confirmAddMembers);

    // Leave group
    document.getElementById('leaveGroupBtn')?.addEventListener('click', openLeaveGroupModal);
    document.getElementById('closeLeaveModal')?.addEventListener('click', () => {
        document.getElementById('leaveGroupModal').style.display = 'none';
    });
    document.getElementById('cancelLeave')?.addEventListener('click', () => {
        document.getElementById('leaveGroupModal').style.display = 'none';
    });
    document.getElementById('confirmLeave')?.addEventListener('click', confirmLeaveGroup);

    setupSidebarMenu();

    // Legacy logout & dark mode buttons, if an older HTML build still has them
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    document.getElementById('toggleDark')?.addEventListener('click', toggleDarkMode);

    // Emoji picker
    document.querySelectorAll('.emoji-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = e.target.closest('.message-input-container')?.querySelector('textarea');
            if (input && window.emojiPicker) window.emojiPicker.toggle(input);
        });
    });
}

function setupSidebarMenu() {
    const menuBtn  = document.getElementById('sidebarMenuBtn');
    const dropdown = document.getElementById('sidebarDropdown');
    if (!menuBtn || !dropdown || menuBtn.dataset.bound === 'true') return;

    menuBtn.dataset.bound = 'true';

    const closeMenu = () => dropdown.classList.remove('open');
    const runAndClose = (handler) => {
        closeMenu();
        if (handler) handler();
    };

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && e.target !== menuBtn) closeMenu();
    });

    document.getElementById('sdropProfile')?.addEventListener('click', () => {
        runAndClose(() => window.profileManager?.open());
    });
    document.getElementById('sdropTheme')?.addEventListener('click', () => {
        // Close dropdown first, then open theme panel
        document.getElementById('sidebarDropdown')?.classList.remove('open');
        if (window.ThemeManager) ThemeManager.openPanel();
        else toggleDarkMode();
    });
    document.getElementById('sdropPrivate')?.addEventListener('click', () => {
        runAndClose(() => window.privateChatsManager?.openMenu());
    });
    document.getElementById('sdropBlocked')?.addEventListener('click', () => {
        runAndClose(() => window.privateChatsManager?.openBlockedContacts());
    });
    document.getElementById('sdropNotifications')?.addEventListener('click', () => {
        runAndClose(requestNotificationPermission);
    });
    document.getElementById('sdropHelp')?.addEventListener('click', () => {
        runAndClose(() => {
            const overlay = document.getElementById('helpAboutOverlay');
            if (overlay) overlay.style.display = 'flex';
        });
    });
    document.getElementById('closeHelpOverlay')?.addEventListener('click', () => {
        const overlay = document.getElementById('helpAboutOverlay');
        if (overlay) overlay.style.display = 'none';
    });
    document.getElementById('sdropLogout')?.addEventListener('click', () => {
        runAndClose(logout);
    });

    if (window._syncThemeDropdownLabel) window._syncThemeDropdownLabel();
}

// ── Logout ────────────────────────────────────────────────────
async function logout() {
    try {
        if (currentUser) {
            await db.collection('users').doc(currentUser.uid).update({
                status: 'offline', lastSeen: new Date()
            });
        }
        friendsPresenceUnsubscribers.forEach(unsub => unsub());
        friendsPresenceUnsubscribers = [];
        localStorage.removeItem(`${LOGIN_VERIFIED_PREFIX}${currentUser.uid}`);
        localStorage.removeItem('educhat_last_verified_uid');
        sessionStorage.removeItem(`${LOGIN_VERIFIED_PREFIX}${currentUser.uid}`);
        await auth.signOut();
        window.location.href = 'index.html';
    } catch (error) {
        console.error('Logout error:', error);
        window.location.href = 'index.html';
    }
}

// Init Drive file sharing after GIS loads
window.addEventListener('load', () => {
    setTimeout(() => {
        if (window.driveShare) window.driveShare.init();
    }, 1500);
});

// ── Vanish Mode Banner ────────────────────────────────────────
let _vanishBannerUnsub = null;

function _showVanishBanner(on) {
    const existing = document.getElementById('vanishModeBanner');
    if (existing) existing.remove();
    if (!on) return;
    const individualChat = document.getElementById('individualChat');
    if (!individualChat) return;
    const banner = document.createElement('div');
    banner.id        = 'vanishModeBanner';
    banner.className = 'vanish-mode-banner';
    banner.innerHTML = `
        <span class="vanish-banner-icon">👻</span>
        <span class="vanish-banner-text">Vanish Mode is <strong>ON</strong> — messages will disappear when turned off</span>
    `;
    const chatHeader = individualChat.querySelector('.chat-header');
    if (chatHeader && chatHeader.nextSibling) {
        individualChat.insertBefore(banner, chatHeader.nextSibling);
    } else {
        individualChat.prepend(banner);
    }
}

function updateVanishBanner(friendUID) {
    // Unsubscribe previous listener
    if (_vanishBannerUnsub) { _vanishBannerUnsub(); _vanishBannerUnsub = null; }

    const existing = document.getElementById('vanishModeBanner');
    if (existing) existing.remove();

    if (!friendUID || !currentUser) return;
    const chatId = generateChatId(currentUser.uid, friendUID);

    // Listen to Firestore for real-time vanish state (syncs with other user)
    _vanishBannerUnsub = db.collection('vanishMode').doc(chatId).onSnapshot(doc => {
        // Only update banner if still in the same chat
        if (chatWithUID !== friendUID) return;
        const enabled = doc.exists && doc.data()?.enabled === true;
        // Keep localStorage in sync
        localStorage.setItem(`vanishMode_${chatId}`, enabled ? 'true' : 'false');
        _showVanishBanner(enabled);

        // If vanish was turned OFF by the other person, hard-delete vanish messages
        if (!enabled && doc.exists && doc.data()?.toggledBy !== currentUser.uid) {
            if (window.deleteVanishMessages) window.deleteVanishMessages(chatId);
        }
    });
}
window.updateVanishBanner = updateVanishBanner;

// ── Read-only getters for active chat context ─────────────────
// chat.html inline scripts (vanish, location, contact) use these
// instead of accessing private module variables directly.
window.getActiveChatUID = () => chatWithUID;
window.getActiveGroupID = () => groupChatID;

window.initializeApp      = initializeApp;
window.switchTab          = switchTab;
window.openChat           = openChat;

// ── openChatById — notification tap నుండి call అవుతుంది ──────
// chatId format: "uid1_uid2" (direct) లేదా groupId (group)
function openChatById(chatId, isGroup) {
    if (!chatId) return;
    if (isGroup) {
        if (window.openGroupChat) window.openGroupChat(chatId);
        return;
    }
    // Direct chat: chatId లో current user uid కాకుండా ఉన్న uid extract చేయాలి
    if (!currentUser) return;
    const parts = chatId.split('_');
    const friendUID = parts.find(p => p !== currentUser.uid);
    if (friendUID) openChat(friendUID);
}
window.openChatById = openChatById;
window.updateUI           = updateUI;
window.logout             = logout;

// ── Group Call Invite Listener ───────────────────────────────────────────────
// When someone calls upgradeToGroupCall() they write to groupCallInvites.
// This listener picks it up and shows a joinable incoming-call notification.
let _gcInviteUnsub = null;

function _listenGroupCallInvites() {
    if (!window.currentUser || !window.db) return;
    if (_gcInviteUnsub) { _gcInviteUnsub(); _gcInviteUnsub = null; }

    _gcInviteUnsub = window.db.collection('groupCallInvites')
        .where('to', '==', window.currentUser.uid)
        .where('status', '==', 'pending')
        .onSnapshot(snap => {
            snap.docChanges().forEach(async change => {
                if (change.type !== 'added') return;

                const invite = change.doc.data();
                const docRef = change.doc.ref;

                // Ignore stale invites (older than 45 s)
                const age = (Date.now() - (invite.created?.toDate?.() || new Date(invite.created)).getTime()) / 1000;
                if (age > 45) {
                    docRef.update({ status: 'expired' }).catch(() => {});
                    return;
                }

                console.log('📞 Group call invite received from', invite.fromName, 'room:', invite.roomId);
                _showGroupCallInviteUI(invite, docRef);
            });
        }, err => console.error('Group call invite listener error:', err));
}

function _showGroupCallInviteUI(invite, docRef) {
    // Remove any existing invite UI first
    document.getElementById('gcInviteModal')?.remove();

    // Stop ring if already ringing from a 1-1 call
    const ringAudio = document.getElementById('ringSound');
    if (ringAudio) {
        ringAudio.currentTime = 0;
        ringAudio.play().catch(() => {});
    }

    const modal = document.createElement('div');
    modal.id = 'gcInviteModal';
    modal.className = 'incoming-call-overlay';   // reuse existing call overlay style
    modal.innerHTML = `
        <div class="incoming-call-modal">
            <div class="caller-info">
                <div class="caller-avatar large">
                    ${(invite.fromName || 'U').charAt(0).toUpperCase()}
                </div>
                <h3>${(invite.fromName || 'Someone').replace(/</g, '&lt;')}</h3>
                <p>Invited you to a ${invite.isVideo ? 'Video' : 'Voice'} Call</p>
            </div>
            <div class="incoming-call-controls">
                <button class="call-btn accept-call" id="gcInviteAccept">
                    ${window.Icons ? window.Icons.get('phoneAccept', 24) : '✓'}
                </button>
                <button class="call-btn decline-call" id="gcInviteDecline">
                    ${window.Icons ? window.Icons.get('phoneEnd', 24) : '✕'}
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Auto-dismiss after 45 s
    const autoDecline = setTimeout(() => {
        modal.remove();
        docRef.update({ status: 'expired' }).catch(() => {});
        if (ringAudio) { ringAudio.pause(); ringAudio.currentTime = 0; }
    }, 45000);

    const cleanup = () => {
        clearTimeout(autoDecline);
        modal.remove();
        if (ringAudio) { ringAudio.pause(); ringAudio.currentTime = 0; }
    };

    document.getElementById('gcInviteAccept').addEventListener('click', async () => {
        cleanup();
        await docRef.update({ status: 'accepted' });
        // If user is in a 1-1 call, end it first
        if (window.webRTCManager?.currentCallId) {
            await window.webRTCManager.endCall(true);
        }
        // Join the group call room
        if (window.GroupCallManager) {
            await window.GroupCallManager.joinExistingCall(invite.roomId, invite.isVideo);
        }
    });

    document.getElementById('gcInviteDecline').addEventListener('click', async () => {
        cleanup();
        await docRef.update({ status: 'declined' }).catch(() => {});
    });
}

window._listenGroupCallInvites = _listenGroupCallInvites;

console.log('app.js loaded');
