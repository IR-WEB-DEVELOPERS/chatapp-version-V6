// ============================================================
//  profile.js — User Profile Page: display name, bio, avatar
//               Stories/Status: 24hr disappearing WhatsApp-style
// ============================================================

const profileManager = (() => {

    // ── State ─────────────────────────────────────────────────
    let _overlay = null;
    let _newAvatarURL = null;
    let _newAvatarBase64 = null; // compressed base64 for Firestore storage

    // ── Open Profile Modal ────────────────────────────────────
    function open() {
        if (_overlay) return;

        const user = window.currentUserData || {};
        const auth = window.currentUser || {};

        _newAvatarURL = null;

        _overlay = document.createElement('div');
        _overlay.className = 'profile-modal-overlay';
        _overlay.innerHTML = `
            <div class="profile-modal" id="profileModalBox">
                <div class="profile-banner"></div>
                <button class="profile-close-btn" id="profileCloseBtn">✕</button>

                <div class="profile-avatar-section">
                    <div class="profile-avatar-ring" id="profileAvatarRing">
                        ${auth.photoURL || user.photoURL
                            ? `<img class="profile-avatar-img" id="profileAvatarImg"
                                src="${escapeAttribute(auth.photoURL || user.photoURL)}"
                                onerror="this.style.display='none';document.getElementById('profileAvatarFallback').style.display='flex';"
                               />`
                            : ''}
                        <div class="profile-avatar-fallback" id="profileAvatarFallback"
                             style="${(auth.photoURL || user.photoURL) ? 'display:none;' : ''}">
                            👤
                        </div>
                        <button class="profile-avatar-edit-btn" id="profileAvatarEditBtn" title="Change photo">📷</button>
                    </div>
                    <input type="file" id="avatarFileInput" accept="image/*" style="display:none;">
                </div>

                <div class="profile-body">
                    <div class="profile-display-name">
                        <h2 id="profileDisplayName">${escapeHTML(user.name || auth.displayName || 'User')}</h2>
                    </div>
                    <div class="profile-username-tag">@${escapeHTML(user.username || '')}</div>

                    <hr class="profile-divider">

                    <!-- Display Name -->
                    <div class="profile-field">
                        <label>Display Name</label>
                        <div class="profile-field-wrap">
                            <input type="text" class="profile-input" id="profileNameInput"
                                value="${escapeAttribute(user.name || auth.displayName || '')}"
                                maxlength="40" placeholder="Your display name">
                            <span class="profile-field-edit-icon">✏️</span>
                        </div>
                    </div>

                    <!-- Bio -->
                    <div class="profile-field">
                        <label>Bio</label>
                        <div class="profile-field-wrap">
                            <textarea class="profile-input profile-textarea" id="profileBioInput"
                                maxlength="150" placeholder="Write something about yourself...">${escapeHTML(user.bio || '')}</textarea>
                        </div>
                        <div class="profile-char-count" id="profileBioCount">
                            ${(user.bio || '').length}/150
                        </div>
                    </div>

                    <!-- Email (read-only) -->
                    <div class="profile-field">
                        <label>Email</label>
                        <div class="profile-field-wrap">
                            <input type="email" class="profile-input" readonly
                                value="${escapeAttribute(user.email || auth.email || '')}">
                        </div>
                    </div>

                    <button class="profile-save-btn" id="profileSaveBtn">Save Changes</button>

                    <!-- Security Section -->
                    <hr class="profile-divider" style="margin-top:20px;">
                    <div class="profile-field">
                        <label>🔐 Security</label>
                        <div class="profile-security-list">
                            <div class="security-row" id="totpRow">
                                <div class="security-row-info">
                                    <span class="security-row-title">Two-Factor Auth (TOTP)</span>
                                    <span class="security-row-desc">Require Google Authenticator on login</span>
                                </div>
                                <button class="security-toggle-btn" id="totpToggleBtn">Enable</button>
                            </div>
                            <div class="security-row" id="biometricRow">
                                <div class="security-row-info">
                                    <span class="security-row-title">Biometric Unlock</span>
                                    <span class="security-row-desc">Use fingerprint/Face ID for Private Chats</span>
                                </div>
                                <button class="security-toggle-btn" id="biometricToggleBtn">Enable</button>
                            </div>
                            <div class="security-row" id="appLockRow">
                                <div class="security-row-info">
                                    <span class="security-row-title">App Lock</span>
                                    <span class="security-row-desc">Require fingerprint when reopening app</span>
                                </div>
                                <button class="security-toggle-btn" id="appLockToggleBtn">Enable</button>
                            </div>
                            <div class="security-row" id="loginActivityRow" style="cursor:pointer">
                                <div class="security-row-info">
                                    <span class="security-row-title">Login Activity</span>
                                    <span class="security-row-desc" id="lastLoginDesc">Loading...</span>
                                </div>
                                <button class="security-toggle-btn security-btn-neutral" id="viewActivityBtn">View</button>
                            </div>
                        </div>
                    </div>

                    <!-- QR Code Section -->
                    <hr class="profile-divider" style="margin-top:20px;">
                    <div class="profile-field">
                        <label>My QR Code</label>
                        <div class="profile-qr-wrap" id="profileQrWrap">
                            <div class="profile-qr-box" id="profileQrBox"></div>
                            <div class="profile-qr-actions">
                                <button class="profile-qr-btn" id="profileQrShareBtn">📤 Share QR</button>
                                <button class="profile-qr-btn profile-qr-copy" id="profileQrCopyBtn">🔗 Copy Link</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(_overlay);
        _bindEvents();
    }

    function close() {
        if (_overlay) {
            _overlay.remove();
            _overlay = null;
            _newAvatarURL = null;
            _newAvatarBase64 = null;
        }
    }

    function _bindEvents() {
        // Close
        document.getElementById('profileCloseBtn').onclick = close;
        _overlay.onclick = (e) => { if (e.target === _overlay) close(); };

        // Avatar edit — trigger file picker
        document.getElementById('profileAvatarEditBtn').onclick = () => {
            document.getElementById('avatarFileInput').click();
        };

        // File selected — compress with canvas and preview
        document.getElementById('avatarFileInput').onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                showToast('Please select an image file', 'error');
                return;
            }

            const reader = new FileReader();
            reader.onload = (ev) => {
                const original = new Image();
                original.onload = () => {
                    // Compress: resize to 200x200, JPEG quality 0.7
                    const canvas = document.createElement('canvas');
                    canvas.width = 200;
                    canvas.height = 200;
                    const ctx = canvas.getContext('2d');

                    // Crop square from center
                    const size = Math.min(original.width, original.height);
                    const sx = (original.width - size) / 2;
                    const sy = (original.height - size) / 2;
                    ctx.drawImage(original, sx, sy, size, size, 0, 0, 200, 200);

                    const base64 = canvas.toDataURL('image/jpeg', 0.7);
                    _newAvatarBase64 = base64;

                    // Live preview
                    let img = document.getElementById('profileAvatarImg');
                    const fallback = document.getElementById('profileAvatarFallback');
                    if (!img) {
                        img = document.createElement('img');
                        img.className = 'profile-avatar-img';
                        img.id = 'profileAvatarImg';
                        document.getElementById('profileAvatarRing').prepend(img);
                    }
                    img.src = base64;
                    img.style.display = 'block';
                    fallback.style.display = 'none';
                };
                original.src = ev.target.result;
            };
            reader.readAsDataURL(file);
        };

        // Bio char count
        document.getElementById('profileBioInput').oninput = (e) => {
            const len = e.target.value.length;
            const counter = document.getElementById('profileBioCount');
            counter.textContent = `${len}/150`;
            counter.className = 'profile-char-count' + (len > 140 ? ' over' : '');
        };

        // Save
        document.getElementById('profileSaveBtn').onclick = _save;

        // QR Code for own profile
        const user  = window.currentUserData || {};
        const auth  = window.currentUser || {};
        const myUID = auth.uid;

        // ── Security: TOTP toggle ─────────────────────────────
        if (myUID && window.totpManager) {
            const totpBtn = document.getElementById('totpToggleBtn');
            window.totpManager.isEnabled(myUID).then(enabled => {
                if (totpBtn) {
                    totpBtn.textContent = enabled ? 'Disable' : 'Enable';
                    totpBtn.classList.toggle('security-btn-danger', enabled);
                }
            });
            if (totpBtn) totpBtn.onclick = async () => {
                totpBtn.disabled = true;
                const prevText = totpBtn.textContent;
                totpBtn.textContent = '...';
                try {
                    const enabled = await window.totpManager.isEnabled(myUID);
                    if (enabled) {
                        await window.totpManager.showDisableModal();
                    } else {
                        await window.totpManager.showSetupModal();
                    }
                } catch(e) { console.warn('[TOTP toggle]', e); }
                // Refresh button state from Firestore
                try {
                    const nowEnabled = await window.totpManager.isEnabled(myUID);
                    totpBtn.textContent = nowEnabled ? 'Disable' : 'Enable';
                    totpBtn.classList.toggle('security-btn-danger', nowEnabled);
                } catch {
                    totpBtn.textContent = prevText;
                }
                totpBtn.disabled = false;
            };
        }

        // ── Security: Biometric toggle ────────────────────────
        if (myUID && window.privateChatsManager) {
            const bioBtn = document.getElementById('biometricToggleBtn');
            const pm     = window.privateChatsManager;
            pm.isBiometricAvailable().then(available => {
                if (!available) {
                    document.getElementById('biometricRow').style.opacity = '0.4';
                    if (bioBtn) { bioBtn.disabled = true; bioBtn.textContent = 'Not available'; }
                    return;
                }
                const registered = pm.isBiometricRegistered();
                if (bioBtn) {
                    bioBtn.textContent = registered ? 'Disable' : 'Enable';
                    bioBtn.classList.toggle('security-btn-danger', registered);
                    bioBtn.onclick = async () => {
                        if (pm.isBiometricRegistered()) {
                            pm.disableBiometric();
                            bioBtn.textContent = 'Enable';
                            bioBtn.classList.remove('security-btn-danger');
                            window.toastManager?.show({ icon: null, type: 'info', title: 'Biometric disabled', body: '', duration: 2000 });
                        } else {
                            const ok = await pm.registerBiometric();
                            if (ok) {
                                bioBtn.textContent = 'Disable';
                                bioBtn.classList.add('security-btn-danger');
                                window.toastManager?.show({ icon: null, type: 'success', title: '✅ Biometric enabled', body: 'Use fingerprint/Face ID to unlock Private Chats', duration: 3000 });
                            } else {
                                window.toastManager?.show({ icon: null, type: 'error', title: 'Registration failed', body: 'Try again or use passcode', duration: 3000 });
                            }
                        }
                    };
                }
            });
        }

        // ── Security: App Lock toggle ─────────────────────────
        if (myUID) {
            const appLockBtn = document.getElementById('appLockToggleBtn');
            const appLockRow = document.getElementById('appLockRow');
            if (appLockBtn) {
                const pm = window.privateChatsManager;

                const refreshAppLockBtn = async () => {
                    const available  = await pm?.isBiometricAvailable?.() || false;
                    const registered = pm?.isBiometricRegistered?.() || false;
                    if (!available || !registered) {
                        appLockRow.style.opacity = '0.4';
                        appLockBtn.disabled = true;
                        appLockBtn.textContent = 'Not available';
                        return;
                    }
                    const enabled = window.appLockManager?.isEnabled?.() || false;
                    appLockBtn.textContent = enabled ? 'Disable' : 'Enable';
                    appLockBtn.classList.toggle('security-btn-danger', enabled);
                };

                refreshAppLockBtn();

                appLockBtn.onclick = async () => {
                    const pm = window.privateChatsManager;
                    const available  = await pm?.isBiometricAvailable?.();
                    // Check Firestore too for cache-cleared scenarios
                    const registered = available && (await pm?.isBiometricRegisteredAsync?.() || pm?.isBiometricRegistered?.());
                    if (!available || !registered) {
                        window.toastManager?.show({ icon: null, type: 'info', title: 'Set up Biometric first', body: 'Enable Biometric Unlock above first', duration: 3000 });
                        return;
                    }
                    // Always use pm.verifyBiometric — passes stored credId → fingerprint, not passkey picker
                    const doVerify = () => pm?.verifyBiometric?.() ?? window._verifyBiometricRaw?.();
                    const enabled = window.appLockManager?.isEnabled?.();
                    if (enabled) {
                        const ok = await doVerify();
                        if (!ok) { window.toastManager?.show({ icon: null, type: 'error', title: 'Fingerprint failed', body: 'Could not disable App Lock', duration: 2500 }); return; }
                        window.appLockManager.disable();
                        window.toastManager?.show({ icon: null, type: 'info', title: 'App Lock disabled', body: '', duration: 2000 });
                    } else {
                        const ok = await doVerify();
                        if (!ok) { window.toastManager?.show({ icon: null, type: 'error', title: 'Fingerprint failed', body: 'Could not enable App Lock', duration: 2500 }); return; }
                        window.appLockManager.enable();
                        window.toastManager?.show({ icon: null, type: 'success', title: '🔒 App Lock enabled', body: 'Fingerprint required when you reopen the app', duration: 3000 });
                    }
                    refreshAppLockBtn();
                };
            }
        }

        // ── Security: Last login info ─────────────────────────
        if (myUID && window.db) {
            window.db.collection('users').doc(myUID).get().then(snap => {
                const d   = snap.data() || {};
                const el  = document.getElementById('lastLoginDesc');
                if (el && d.lastLoginPlatform) {
                    const date = d.lastLoginAt ? new Date(d.lastLoginAt).toLocaleDateString() : '';
                    el.textContent = `Last: ${d.lastLoginPlatform}${d.lastLoginLocation ? ' · ' + d.lastLoginLocation : ''}${date ? ' · ' + date : ''}`;
                }
            }).catch(() => {});

            document.getElementById('viewActivityBtn')?.addEventListener('click', async () => {
                const snaps = await window.db.collection('users').doc(myUID)
                    .collection('loginActivity').orderBy('time', 'desc').limit(10).get();
                if (snaps.empty) { window.toastManager?.show({ icon: null, type: 'info', title: 'No activity logged yet', body: '', duration: 3000 }); return; }

                const rows = snaps.docs.map(d => {
                    const x    = d.data();
                    const date = new Date(x.time).toLocaleString();
                    const loc  = x.location || 'Unknown location';
                    return `<div class="activity-row">
                        <span class="activity-icon">📱</span>
                        <div class="activity-info">
                            <div class="activity-platform">${x.platform || 'Unknown'}</div>
                            <div class="activity-meta">${loc} &nbsp;·&nbsp; ${date}</div>
                        </div>
                    </div>`;
                }).join('');

                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay';
                overlay.style.zIndex = '9200';
                overlay.innerHTML = `
                    <div class="modal" style="max-width:420px;width:92%;">
                        <div class="modal-header">
                            <h3>🔒 Login Activity</h3>
                            <button class="modal-close" id="activityModalClose">✕</button>
                        </div>
                        <div class="modal-body" style="max-height:60vh;overflow-y:auto;padding:8px 16px;">
                            <p style="font-size:12px;color:var(--text-secondary,#94a3b8);margin-bottom:12px;">Last 10 logins</p>
                            <div class="activity-list">${rows}</div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn-primary" id="activityModalOk">Close</button>
                        </div>
                    </div>
                    <style>
                        .activity-list { display:flex;flex-direction:column;gap:10px; }
                        .activity-row { display:flex;align-items:flex-start;gap:10px;padding:8px;border-radius:8px;background:var(--surface2,rgba(255,255,255,0.04)); }
                        .activity-icon { font-size:18px;margin-top:2px; }
                        .activity-info { display:flex;flex-direction:column;gap:2px; }
                        .activity-platform { font-size:13px;font-weight:600;color:var(--text,#f1f5f9); }
                        .activity-meta { font-size:11px;color:var(--text-secondary,#94a3b8); }
                    </style>`;
                document.body.appendChild(overlay);
                const close = () => overlay.remove();
                overlay.querySelector('#activityModalClose').onclick = close;
                overlay.querySelector('#activityModalOk').onclick    = close;
                overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
            });
        }

        if (myUID && window.QRManager) {
            const box = document.getElementById('profileQrBox');
            if (box) {
                const qrText = window.QRManager.profileQRData(myUID, user.name || auth.displayName || 'Me');
                window.QRManager.generateQR(box, qrText, { size: 180 });
            }
            // Share button — sends profile link + QR image via Web Share / clipboard
            document.getElementById('profileQrShareBtn').onclick = () => {
                const b    = document.getElementById('profileQrBox');
                const name = user.name || auth.displayName || 'Me';
                window.QRManager.shareQR(b, name, myUID);
            };
            // Copy Link button
            const copyBtn = document.getElementById('profileQrCopyBtn');
            if (copyBtn) {
                copyBtn.onclick = async () => {
                    const link = window.location.origin + '/p/' + myUID;
                    try {
                        await navigator.clipboard.writeText(link);
                        window.toastManager?.show({ icon: null, type: 'success', title: 'Link copied!', body: 'Share it on WhatsApp or any app', duration: 3000 });
                    } catch {
                        window.toastManager?.show({ icon: null, type: 'info', title: link, body: 'Copy this link', duration: 5000 });
                    }
                };
            }
        }
    }

    async function _save() {
        const btn = document.getElementById('profileSaveBtn');
        const nameVal = document.getElementById('profileNameInput').value.trim();
        const bioVal  = document.getElementById('profileBioInput').value.trim();

        if (!nameVal) {
            showToast('Display name cannot be empty', 'error');
            return;
        }

        btn.disabled = true;
        btn.classList.add('saving');
        btn.textContent = 'Saving...';

        // Use new base64 if selected, else keep existing photoURL
        const avatarURL = _newAvatarBase64
            ? _newAvatarBase64
            : (_newAvatarURL || document.getElementById('avatarUrlInput')?.value.trim() || null);

        try {
            const updates = {
                name:     nameVal,
                bio:      bioVal,
                photoURL: avatarURL
            };

            await window.db.collection('users').doc(window.currentUser.uid).update(updates);

            // Update cached data
            if (window.currentUserData) {
                window.currentUserData.name     = nameVal;
                window.currentUserData.bio      = bioVal;
                window.currentUserData.photoURL = avatarURL;
                window.enhancedCache.set(`user_${window.currentUser.uid}`, window.currentUserData, 30 * 60 * 1000);
            }

            // Update sidebar UI
            const userNameEl = document.getElementById('userName');
            if (userNameEl) userNameEl.textContent = nameVal;

            const userAvatarEl   = document.getElementById('userAvatar');
            const avatarFallback = document.getElementById('avatarFallback');
            if (avatarURL) {
                if (userAvatarEl) {
                    userAvatarEl.src = avatarURL;
                    userAvatarEl.style.display = 'block';
                }
                if (avatarFallback) avatarFallback.style.display = 'none';
            }

            showToast('Profile updated successfully!', 'success');
            close();
        } catch (err) {
            console.error('Profile save error:', err);
            showToast('Failed to save profile: ' + err.message, 'error');
            btn.disabled = false;
            btn.classList.remove('saving');
            btn.textContent = 'Save Changes';
        }
    }

    return { open, close };
})();

window.profileManager = profileManager;


// ============================================================
//  storiesManager — WhatsApp-style 24hr disappearing status
// ============================================================

const storiesManager = (() => {

    const STORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    let _stories = []; // local cache: [{uid, name, photoURL, stories:[...]}]
    let _unsubscribe = null;

    // ── Bootstrap: render bar + subscribe ────────────────────
    function init() {
        _renderBar();
        _subscribe();
    }

    // ── Subscribe to Firestore stories ───────────────────────
    function _subscribe() {
        if (_unsubscribe) _unsubscribe();
        if (!window.db || !window.currentUser) return;

        const cutoff = new Date(Date.now() - STORY_TTL_MS);

        _unsubscribe = window.db.collection('stories')
            .where('createdAt', '>=', cutoff)
            .orderBy('createdAt', 'desc')
            .onSnapshot(snap => {
                const raw = [];
                snap.forEach(doc => {
                    raw.push({ id: doc.id, ...doc.data() });
                });
                _processAndRender(raw);
            }, err => console.error('Stories snapshot error:', err));
    }

    // ── Group stories by user ─────────────────────────────────
    async function _processAndRender(rawStories) {
        // Group by uid
        const map = new Map();
        for (const s of rawStories) {
            if (!map.has(s.uid)) map.set(s.uid, []);
            map.get(s.uid).push(s);
        }

        // Build grouped array, mine first
        const myUID = window.currentUser.uid;
        const friends = window.currentUserData?.friends || [];

        const grouped = [];

        // Always show "my status" first
        const myStories = map.get(myUID) || [];
        grouped.push({
            uid: myUID,
            name: window.currentUserData?.name || 'You',
            photoURL: window.currentUserData?.photoURL || window.currentUser.photoURL,
            stories: myStories,
            isMine: true
        });

        // Then friends who have stories
        for (const [uid, stories] of map.entries()) {
            if (uid === myUID) continue;
            if (!friends.includes(uid)) continue; // only friends' stories
            let userData = window.enhancedCache.get(`user_${uid}`);
            if (!userData) {
                try {
                    userData = await window.getUserData(uid);
                } catch (_) {}
            }
            grouped.push({
                uid,
                name: userData?.name || 'User',
                photoURL: userData?.photoURL || null,
                stories,
                isMine: false
            });
        }

        _stories = grouped;
        _renderBar();
    }

    // ── Render the stories bar in sidebar ────────────────────
    function _renderBar() {
        const bar = document.getElementById('storiesBar');
        if (!bar) return;

        const scroll = bar.querySelector('.stories-scroll');
        if (!scroll) return;

        scroll.innerHTML = '';

        for (const group of _stories) {
            const hasStories = group.stories.length > 0;
            const bubble = document.createElement('div');
            bubble.className = 'story-bubble';
            bubble.dataset.uid = group.uid;

            const ringClass = hasStories && !group.isMine ? 'story-ring' : (group.isMine ? 'story-ring' : 'story-ring seen');

            bubble.innerHTML = `
                <div class="${ringClass}">
                    <div class="story-ring-inner">
                        ${group.photoURL
                            ? `<img src="${escapeAttribute(group.photoURL)}" alt="" onerror="this.style.display='none';this.nextSibling.style.display='flex';">
                               <div class="story-fallback" style="display:none;">👤</div>`
                            : `<div class="story-fallback">👤</div>`}
                    </div>
                    ${group.isMine ? '<div class="story-add-btn">+</div>' : ''}
                </div>
                <span class="story-name ${group.isMine ? 'mine' : ''}">${escapeHTML(group.isMine ? 'My Status' : group.name)}</span>
            `;

            bubble.onclick = () => {
                if (group.isMine && !hasStories) {
                    _openComposer();
                } else if (group.isMine) {
                    // Long press to add — just click to view
                    _openViewer(group, _stories, _stories.indexOf(group));
                } else {
                    if (hasStories) _openViewer(group, _stories, _stories.indexOf(group));
                }
            };

            // My status: right-click / long-press to add new
            if (group.isMine) {
                const addBtn = bubble.querySelector('.story-add-btn');
                if (addBtn) {
                    addBtn.onclick = (e) => {
                        e.stopPropagation();
                        _openComposer();
                    };
                }
            }

            scroll.appendChild(bubble);
        }
    }

    // ── Story Composer Modal ──────────────────────────────────
    // ── Instagram URL validator ───────────────────────────────
    function _isInstagramURL(url) {
        return /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+/.test(url);
    }

    function _openComposer(prefillURL = '') {
        const overlay = document.createElement('div');
        overlay.className = 'story-composer-overlay';
        overlay.innerHTML = `
            <div class="story-composer">
                <h3>📸 Add Status</h3>

                <div class="story-type-tabs">
                    <button class="story-type-tab ${!prefillURL ? 'active' : ''}" data-type="text">✍️ Text</button>
                    <button class="story-type-tab" data-type="image">🖼️ Image</button>
                    <button class="story-type-tab" data-type="video">🎬 Video</button>
                    <button class="story-type-tab ${prefillURL ? 'active' : ''}" data-type="instagram">📱 Instagram</button>
                </div>

                <!-- Text panel -->
                <div id="storyTextPanel" style="display:${!prefillURL ? 'block' : 'none'};">
                    <textarea class="story-text-input" id="storyTextInput"
                        placeholder="What's on your mind? Your status disappears in 24 hrs ⏳"
                        maxlength="280"></textarea>
                </div>

                <!-- Instagram panel -->
                <div id="storyInstaPanel" style="display:${prefillURL ? 'block' : 'none'};">
                    <input type="url" class="story-insta-input" id="storyInstaInput"
                        placeholder="https://www.instagram.com/reel/..."
                        value="${escapeAttribute(prefillURL)}">
                    <div id="storyInstaPreview" class="story-insta-preview"></div>
                </div>

                <!-- Image panel -->
                <div id="storyImagePanel" style="display:none;">
                    <div class="story-video-upload-area" id="storyImageDropZone">
                        <input type="file" id="storyImageInput" accept="image/*" style="display:none;">
                        <div class="story-video-placeholder" id="storyImagePlaceholder">
                            <span style="font-size:2rem;">🖼️</span>
                            <p>Click or drag an image here</p>
                            <small>JPG, PNG, GIF, WebP · Max 20MB</small>
                        </div>
                        <img id="storyImagePreview" class="story-image-preview" style="display:none;max-width:100%;max-height:200px;border-radius:8px;object-fit:contain;" alt="preview">
                        <button id="storyImageChangeBtn" class="story-video-change-btn" style="display:none;">🔄 Change Image</button>
                    </div>
                    <textarea class="story-text-input" id="storyImageCaptionInput"
                        placeholder="Add a caption... (optional)"
                        maxlength="200"
                        style="margin-top:10px;min-height:60px;"></textarea>
                    <div id="storyImageProgress" style="display:none;margin-top:8px;">
                        <div style="background:rgba(255,255,255,0.15);border-radius:4px;overflow:hidden;height:6px;">
                            <div id="storyImageProgressBar" style="height:100%;background:#4CAF50;width:0%;transition:width 0.3s;"></div>
                        </div>
                        <small id="storyImageProgressLabel" style="color:rgba(255,255,255,0.7);font-size:11px;">Uploading...</small>
                    </div>
                </div>

                <!-- Video panel -->
                <div id="storyVideoPanel" style="display:none;">
                    <div class="story-video-upload-area" id="storyVideoDropZone">
                        <input type="file" id="storyVideoInput" accept="video/*" style="display:none;">
                        <div class="story-video-placeholder" id="storyVideoPlaceholder">
                            <span style="font-size:2rem;">🎬</span>
                            <p>Click or drag a video here</p>
                            <small>MP4, WebM, MOV · Max 100MB</small>
                        </div>
                        <video id="storyVideoPreview" class="story-video-preview" controls playsinline style="display:none;max-width:100%;max-height:200px;border-radius:8px;"></video>
                        <button id="storyVideoChangeBtn" class="story-video-change-btn" style="display:none;">🔄 Change Video</button>
                    </div>
                    <textarea class="story-text-input" id="storyVideoCaptionInput"
                        placeholder="Add a caption... (optional)"
                        maxlength="200"
                        style="margin-top:10px;min-height:60px;"></textarea>
                    <div id="storyVideoProgress" style="display:none;margin-top:8px;">
                        <div style="background:rgba(255,255,255,0.15);border-radius:4px;overflow:hidden;height:6px;">
                            <div id="storyVideoProgressBar" style="height:100%;background:#4CAF50;width:0%;transition:width 0.3s;"></div>
                        </div>
                        <small id="storyVideoProgressLabel" style="color:rgba(255,255,255,0.7);font-size:11px;">Uploading...</small>
                    </div>
                </div>

                <div class="story-composer-actions">
                    <button class="story-cancel-btn" id="storyCancelBtn">Cancel</button>
                    <button class="story-post-btn" id="storyPostBtn">Post Status</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        let _instaEmbedData = null; // { url, thumbnailUrl, embedHtml, title }

        // Type tabs
        overlay.querySelectorAll('.story-type-tab').forEach(tab => {
            tab.onclick = () => {
                overlay.querySelectorAll('.story-type-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const type = tab.dataset.type;
                document.getElementById('storyTextPanel').style.display    = type === 'text'      ? 'block' : 'none';
                document.getElementById('storyInstaPanel').style.display   = type === 'instagram' ? 'block' : 'none';
                document.getElementById('storyVideoPanel').style.display   = type === 'video'     ? 'block' : 'none';
                document.getElementById('storyImagePanel').style.display   = type === 'image'     ? 'block' : 'none';
            };
        });

        // Instagram URL input → fetch embed preview
        let _debounceTimer = null;
        const _fetchPreview = async (url) => {
            const previewEl = document.getElementById('storyInstaPreview');
            if (!url) { previewEl.innerHTML = ''; _instaEmbedData = null; return; }
            if (!_isInstagramURL(url)) {
                previewEl.innerHTML = `<p class="insta-preview-error">Please paste an Instagram post/reel link</p>`;
                _instaEmbedData = null;
                return;
            }
            previewEl.innerHTML = `<p class="insta-preview-loading">⏳ Loading preview...</p>`;
            try {
                const res = await fetch(`/instagram-embed?url=${encodeURIComponent(url)}`);
                if (!res.ok) throw new Error('Preview fetch failed');
                const data = await res.json();
                _instaEmbedData = { url, ...data };
                previewEl.innerHTML = `
                    <div class="insta-preview-card">
                        ${data.thumbnailUrl ? `<img src="${escapeAttribute(data.thumbnailUrl)}" class="insta-preview-thumb" alt="preview">` : ''}
                        <p class="insta-preview-title">${escapeHTML(data.title || 'Instagram Reel')}</p>
                        <span class="insta-preview-badge">Instagram</span>
                    </div>`;
            } catch (err) {
                previewEl.innerHTML = `<p class="insta-preview-error">Preview failed to load — you can still post if the link is valid</p>`;
                // Still allow posting with just the URL
                _instaEmbedData = { url, thumbnailUrl: null, embedHtml: null, title: null };
            }
        };

        document.getElementById('storyInstaInput').oninput = (e) => {
            clearTimeout(_debounceTimer);
            _debounceTimer = setTimeout(() => _fetchPreview(e.target.value.trim()), 600);
        };

        // If prefilled (from Instagram share), auto-fetch preview
        if (prefillURL) {
            setTimeout(() => _fetchPreview(prefillURL), 300);
        }

        // ── Video picker ──────────────────────────────────────
        let _selectedVideoFile = null;

        const videoInput    = document.getElementById('storyVideoInput');
        const videoDropZone = document.getElementById('storyVideoDropZone');
        const videoPreview  = document.getElementById('storyVideoPreview');
        const videoPlaceholder = document.getElementById('storyVideoPlaceholder');
        const videoChangeBtn   = document.getElementById('storyVideoChangeBtn');

        function _setVideoFile(file) {
            if (!file || !file.type.startsWith('video/')) {
                showToast('Please select a valid video file', 'warning');
                return;
            }
            if (file.size > 100 * 1024 * 1024) {
                showToast('Video must be under 100MB', 'warning');
                return;
            }
            _selectedVideoFile = file;
            const url = URL.createObjectURL(file);
            videoPreview.src = url;
            videoPreview.style.display = 'block';
            videoPlaceholder.style.display = 'none';
            videoChangeBtn.style.display = 'inline-block';
        }

        videoDropZone.onclick = (e) => {
            if (e.target === videoChangeBtn || e.target === videoPreview) return;
            if (!_selectedVideoFile) videoInput.click();
        };
        videoChangeBtn.onclick = () => videoInput.click();
        videoInput.onchange = (e) => { if (e.target.files[0]) _setVideoFile(e.target.files[0]); };

        videoDropZone.ondragover = (e) => { e.preventDefault(); videoDropZone.classList.add('drag-over'); };
        videoDropZone.ondragleave = () => videoDropZone.classList.remove('drag-over');
        videoDropZone.ondrop = (e) => {
            e.preventDefault();
            videoDropZone.classList.remove('drag-over');
            const f = e.dataTransfer.files[0];
            if (f) _setVideoFile(f);
        };

        // ── Image picker ──────────────────────────────────────
        let _selectedImageFile = null;

        const imageInput       = document.getElementById('storyImageInput');
        const imageDropZone    = document.getElementById('storyImageDropZone');
        const imagePreview     = document.getElementById('storyImagePreview');
        const imagePlaceholder = document.getElementById('storyImagePlaceholder');
        const imageChangeBtn   = document.getElementById('storyImageChangeBtn');

        function _setImageFile(file) {
            if (!file || !file.type.startsWith('image/')) {
                showToast('Please select a valid image file', 'warning');
                return;
            }
            if (file.size > 20 * 1024 * 1024) {
                showToast('Image must be under 20MB', 'warning');
                return;
            }
            _selectedImageFile = file;
            const url = URL.createObjectURL(file);
            imagePreview.src = url;
            imagePreview.style.display = 'block';
            imagePlaceholder.style.display = 'none';
            imageChangeBtn.style.display = 'inline-block';
        }

        imageDropZone.onclick = (e) => {
            if (e.target === imageChangeBtn || e.target === imagePreview) return;
            if (!_selectedImageFile) imageInput.click();
        };
        imageChangeBtn.onclick = () => imageInput.click();
        imageInput.onchange = (e) => { if (e.target.files[0]) _setImageFile(e.target.files[0]); };

        imageDropZone.ondragover = (e) => { e.preventDefault(); imageDropZone.classList.add('drag-over'); };
        imageDropZone.ondragleave = () => imageDropZone.classList.remove('drag-over');
        imageDropZone.ondrop = (e) => {
            e.preventDefault();
            imageDropZone.classList.remove('drag-over');
            const f = e.dataTransfer.files[0];
            if (f) _setImageFile(f);
        };

        // Cancel
        document.getElementById('storyCancelBtn').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        // Post
        document.getElementById('storyPostBtn').onclick = async () => {
            const activeTab = overlay.querySelector('.story-type-tab.active').dataset.type;
            let storyData = null;

            if (activeTab === 'text') {
                const text = document.getElementById('storyTextInput').value.trim();
                if (!text) { showToast('Please enter some text', 'warning'); return; }
                storyData = { type: 'text', text };
            } else if (activeTab === 'image') {
                if (!_selectedImageFile) {
                    showToast('Please select an image first', 'warning');
                    return;
                }
                const caption = document.getElementById('storyImageCaptionInput').value.trim();

                const progressEl  = document.getElementById('storyImageProgress');
                const progressBar = document.getElementById('storyImageProgressBar');
                const progressLabel = document.getElementById('storyImageProgressLabel');
                progressEl.style.display = 'block';
                progressBar.style.width = '10%';
                progressLabel.textContent = 'Uploading image...';

                const btn = document.getElementById('storyPostBtn');
                btn.disabled = true;
                btn.textContent = 'Uploading...';

                try {
                    let fakeProgress = 10;
                    const fakeTimer = setInterval(() => {
                        fakeProgress = Math.min(fakeProgress + 15, 85);
                        progressBar.style.width = fakeProgress + '%';
                    }, 300);

                    const { viewLink } = await _uploadStatusFileToDrive(_selectedImageFile);

                    clearInterval(fakeTimer);
                    progressBar.style.width = '100%';
                    progressLabel.textContent = 'Almost done...';

                    storyData = {
                        type: 'image',
                        imageURL: viewLink,
                        caption: caption || null,
                    };

                    await window.db.collection('stories').add({
                        uid:       window.currentUser.uid,
                        name:      window.currentUserData?.name || window.currentUser.displayName,
                        photoURL:  window.currentUserData?.photoURL || window.currentUser.photoURL || null,
                        createdAt: new Date(),
                        expiresAt: new Date(Date.now() + STORY_TTL_MS),
                        ...storyData
                    });
                    showToast('Image status posted! 🎉 Disappears in 24hrs', 'success');
                    overlay.remove();
                } catch (err) {
                    console.error('Image story post error:', err);
                    showToast('Failed to post image: ' + err.message, 'error');
                    btn.disabled = false;
                    btn.textContent = 'Post Status';
                    document.getElementById('storyImageProgress').style.display = 'none';
                }
                return;
            } else if (activeTab === 'video') {
                if (!_selectedVideoFile) {
                    showToast('Please select a video first', 'warning');
                    return;
                }
                const caption = document.getElementById('storyVideoCaptionInput').value.trim();

                // Show progress UI
                const progressEl = document.getElementById('storyVideoProgress');
                const progressBar = document.getElementById('storyVideoProgressBar');
                const progressLabel = document.getElementById('storyVideoProgressLabel');
                progressEl.style.display = 'block';
                progressBar.style.width = '10%';
                progressLabel.textContent = 'Uploading video...';

                const btn = document.getElementById('storyPostBtn');
                btn.disabled = true;
                btn.textContent = 'Uploading...';

                try {
                    // Simulate progress (Drive upload doesn't give XHR progress via fetch)
                    let fakeProgress = 10;
                    const fakeTimer = setInterval(() => {
                        fakeProgress = Math.min(fakeProgress + 8, 85);
                        progressBar.style.width = fakeProgress + '%';
                    }, 400);

                    const { viewLink } = await _uploadStatusFileToDrive(_selectedVideoFile);

                    clearInterval(fakeTimer);
                    progressBar.style.width = '100%';
                    progressLabel.textContent = 'Almost done...';

                    storyData = {
                        type: 'video',
                        imageURL: viewLink,   // reuse imageURL field for video URL
                        caption: caption || null,
                    };

                    await window.db.collection('stories').add({
                        uid:       window.currentUser.uid,
                        name:      window.currentUserData?.name || window.currentUser.displayName,
                        photoURL:  window.currentUserData?.photoURL || window.currentUser.photoURL || null,
                        createdAt: new Date(),
                        expiresAt: new Date(Date.now() + STORY_TTL_MS),
                        ...storyData
                    });
                    showToast('Video status posted! 🎉 Disappears in 24hrs', 'success');
                    overlay.remove();
                } catch (err) {
                    console.error('Video story post error:', err);
                    showToast('Failed to post video: ' + err.message, 'error');
                    btn.disabled = false;
                    btn.textContent = 'Post Status';
                    document.getElementById('storyVideoProgress').style.display = 'none';
                }
                return; // Early return — Firestore add already done above
            } else {
                const url = document.getElementById('storyInstaInput').value.trim();
                if (!url || !_isInstagramURL(url)) {
                    showToast('Please paste a valid Instagram link', 'warning');
                    return;
                }
                storyData = {
                    type: 'instagram',
                    instaURL: url,
                    thumbnailUrl: _instaEmbedData?.thumbnailUrl || null,
                    embedHtml:    _instaEmbedData?.embedHtml    || null,
                    title:        _instaEmbedData?.title        || null,
                };
            }

            const btn = document.getElementById('storyPostBtn');
            btn.disabled = true;
            btn.textContent = 'Posting...';

            try {
                await window.db.collection('stories').add({
                    uid:       window.currentUser.uid,
                    name:      window.currentUserData?.name || window.currentUser.displayName,
                    photoURL:  window.currentUserData?.photoURL || window.currentUser.photoURL || null,
                    createdAt: new Date(),
                    expiresAt: new Date(Date.now() + STORY_TTL_MS),
                    ...storyData
                });
                showToast('Status posted! 🎉 Disappears in 24hrs', 'success');
                overlay.remove();
            } catch (err) {
                console.error('Story post error:', err);
                showToast('Failed to post status: ' + err.message, 'error');
                btn.disabled = false;
                btn.textContent = 'Post Status';
            }
        };
    }

    // ── Upload status media to Google Drive (returns {viewLink}) ─
    async function _uploadStatusFileToDrive(file) {
        // Reuse driveFileShare.js token infrastructure
        const token = await _getStatusDriveToken();

        // Get/create EduChat Status folder
        const folderId = await _getOrCreateStatusFolder(token);

        const metadata = { name: file.name, parents: [folderId] };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', file);

        const uploadRes = await fetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,webContentLink',
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: form,
            }
        );

        if (!uploadRes.ok) {
            const err = await uploadRes.json();
            throw new Error(err.error?.message || 'Drive upload failed');
        }

        const fileData = await uploadRes.json();

        // Make publicly readable
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileData.id}/permissions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ role: 'reader', type: 'anyone' }),
        });

        // Use thumbnail URL for images (embeddable in <img> tags, no CORS/auth issues).
        // For videos, fall back to uc?export=download (best available without Firebase Storage).
        const isImage = file.type.startsWith('image/');
        const viewLink = isImage
            ? `https://drive.google.com/thumbnail?id=${fileData.id}&sz=w800`
            : `https://drive.google.com/uc?export=download&id=${fileData.id}`;

        return { viewLink, fileId: fileData.id };
    }

    // ── Get Drive access token (reuses driveFileShare token cache) ─
    function _getStatusDriveToken() {
        return new Promise((resolve, reject) => {
            // Try cached token from driveFileShare.js session cache
            const cached = sessionStorage.getItem('driveShareAccessToken');
            const expiry = parseInt(sessionStorage.getItem('driveShareAccessTokenExpiry') || '0', 10);
            if (cached && Date.now() < expiry) {
                resolve(cached);
                return;
            }

            // Request new token via Google Identity Services
            if (!window.google?.accounts?.oauth2) {
                reject(new Error('Google Identity Services not loaded'));
                return;
            }

            const client = google.accounts.oauth2.initTokenClient({
                client_id: window.DRIVE_CLIENT_ID || '191214500535-6nironkv53bia01cct6lbfgmi6u0286s.apps.googleusercontent.com',
                scope: 'https://www.googleapis.com/auth/drive.file',
                callback: (tokenResponse) => {
                    if (tokenResponse.error) {
                        reject(new Error(tokenResponse.error));
                        return;
                    }
                    // Cache it for reuse
                    sessionStorage.setItem('driveShareAccessToken', tokenResponse.access_token);
                    sessionStorage.setItem('driveShareAccessTokenExpiry', String(Date.now() + 55 * 60 * 1000));
                    resolve(tokenResponse.access_token);
                },
                error_callback: (err) => {
                    if (err.type === 'popup_closed') reject(new Error('Google sign-in was closed'));
                    else reject(new Error('Drive auth failed: ' + err.type));
                }
            });
            client.requestAccessToken({ prompt: '' });
        });
    }

    // ── Get or create "EduChat Status" folder in Drive ──────────
    async function _getOrCreateStatusFolder(token) {
        const folderName = 'EduChat Status';
        const searchRes = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const searchData = await searchRes.json();
        if (searchData.files?.length > 0) return searchData.files[0].id;

        const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
        });
        const folder = await createRes.json();
        return folder.id;
    }

    // ── Story Viewer ──────────────────────────────────────────
    function _openViewer(group, allGroups, groupIdx) {
        if (!group.stories || group.stories.length === 0) return;

        // ── State ──────────────────────────────────────────────
        let current  = 0;
        let timer    = null;
        let paused   = false;
        let pausedAt = 0;   // ms elapsed when paused
        let videoEl  = null;

        const DURATION = 5000;

        const overlay = document.createElement('div');
        overlay.className = 'story-viewer-overlay';
        document.body.appendChild(overlay);

        // ── Group navigation ───────────────────────────────────
        function _nextGroup() {
            if (!allGroups) { clearTimeout(timer); overlay.remove(); return; }
            let ni = (groupIdx ?? -1) + 1;
            while (ni < allGroups.length && allGroups[ni].stories.length === 0) ni++;
            clearTimeout(timer);
            overlay.remove();
            if (ni < allGroups.length) _openViewer(allGroups[ni], allGroups, ni);
        }

        function _prevGroup() {
            if (!allGroups) return;
            let pi = (groupIdx ?? allGroups.length) - 1;
            while (pi >= 0 && allGroups[pi].stories.length === 0) pi--;
            clearTimeout(timer);
            overlay.remove();
            if (pi >= 0) _openViewer(allGroups[pi], allGroups, pi);
        }

        function _goNext() {
            if (current + 1 < group.stories.length) _render(current + 1);
            else _nextGroup();
        }

        function _goPrev() {
            if (current > 0) _render(current - 1);
            else _prevGroup();
        }

        // ── Hold to pause ──────────────────────────────────────
        function _pause() {
            if (paused) return;
            paused = true;
            clearTimeout(timer);
            if (videoEl && !videoEl.paused) videoEl.pause();
            const fill = document.getElementById('storyFill_' + current);
            if (fill) fill.style.animationPlayState = 'paused';
        }

        function _resume() {
            if (!paused) return;
            paused = false;
            if (videoEl && videoEl.paused && !videoEl.ended) videoEl.play().catch(() => {});
            const fill = document.getElementById('storyFill_' + current);
            if (fill) fill.style.animationPlayState = 'running';
            const story = group.stories[current];
            if (story.type !== 'video' && story.type !== 'instagram') {
                const remaining = DURATION - pausedAt;
                timer = setTimeout(_goNext, Math.max(remaining, 300));
            }
        }

        // ── Convert Drive URL to proxy URL for <video> tag ─────
        function _driveVideoSrc(url) {
            // Extract file ID from any Drive URL pattern
            const m = url.match(/[?&]id=([^&]+)/) || url.match(/\/file\/d\/([^/?]+)/);
            if (m) return `/video-proxy?id=${encodeURIComponent(m[1])}`;
            return url; // fallback: use as-is
        }

        // ── Render ─────────────────────────────────────────────
        function _render(idx) {
            current  = idx;
            paused   = false;
            pausedAt = 0;
            clearTimeout(timer);
            videoEl  = null;

            const story = group.stories[idx];
            const timeAgo = _timeAgo(story.createdAt?.toDate ? story.createdAt.toDate() : new Date(story.createdAt));

            overlay.innerHTML = `
                <div class="story-viewer">
                    <div class="story-progress-bars" id="storyProgressBars">
                        ${group.stories.map((s, i) => `
                            <div class="story-progress-bar">
                                <div class="story-progress-fill ${i < idx ? 'done' : ''}"
                                     id="storyFill_${i}"
                                     style="${i === idx && s.type !== 'video' && s.type !== 'instagram' ? '--story-duration:' + DURATION + 'ms' : ''}">
                                </div>
                            </div>
                        `).join('')}
                    </div>

                    <div class="story-viewer-header">
                        <div class="story-viewer-user">
                            ${group.photoURL
                                ? `<img class="story-viewer-avatar" src="${escapeAttribute(group.photoURL)}" alt="" onerror="this.style.display='none';">`
                                : `<div class="story-viewer-avatar-fallback">👤</div>`}
                            <div>
                                <div class="story-viewer-name">${escapeHTML(group.name)}</div>
                                <div class="story-viewer-time">${timeAgo}</div>
                            </div>
                        </div>
                        <button class="story-viewer-close" id="storyViewerClose">✕</button>
                    </div>

                    <div class="story-content" id="storyContent">
                        ${story.type === 'instagram'
                            ? (() => {
                                  const m2 = story.instaURL.match(/instagram\.com\/(p|reel|tv)\/([\w-]+)/);
                                  const embedSrc = m2 ? `https://www.instagram.com/${m2[1]}/${m2[2]}/embed/` : null;
                                  return `<div class="story-insta-embed" id="storyInstaEmbed">
                                      ${embedSrc
                                          ? `<iframe src="${escapeAttribute(embedSrc)}" class="story-insta-iframe"
                                                 frameborder="0" scrolling="no" allowtransparency="true" allowfullscreen="true"
                                                 allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"></iframe>`
                                          : `<div class="story-insta-no-thumb">
                                                 <a href="${escapeAttribute(story.instaURL)}" target="_blank" rel="noopener" class="story-insta-open-btn">
                                                     Open in Instagram
                                                 </a>
                                             </div>`}
                                  </div>`;
                              })()
                            : story.type === 'image'
                            ? `<img class="story-content-image"
                                    src="${escapeAttribute(story.imageURL)}"
                                    alt="Status"
                                    onerror="this.style.display='none';document.getElementById('storyMediaFallback').style.display='flex';">
                               ${story.caption ? `<div class="story-caption">${escapeHTML(story.caption)}</div>` : ''}
                               <div id="storyMediaFallback" class="story-media-fallback" style="display:none;">
                                   <span>🖼️ Image couldn't load</span>
                               </div>`
                            : story.type === 'video'
                                ? `<div class="story-video-wrapper">
                                       <video id="storyVideoEl" class="story-content-video"
                                              src="${escapeAttribute(_driveVideoSrc(story.imageURL))}"
                                              autoplay playsinline
                                              style="max-width:100%;max-height:70vh;border-radius:8px;display:block;margin:auto;">
                                       </video>
                                       <div id="storyMediaFallback" class="story-media-fallback" style="display:none;text-align:center;padding:20px;color:#fff;flex-direction:column;gap:8px;">
                                           <span>Video could not load</span>
                                           <a href="${escapeAttribute(story.imageURL)}" target="_blank" rel="noopener" style="color:#7c9ef8;font-size:0.85rem;">Open in Drive</a>
                                       </div>
                                       ${story.caption ? `<div class="story-caption">${escapeHTML(story.caption)}</div>` : ''}
                                   </div>`
                                : `<div class="story-content-text">${escapeHTML(story.text)}</div>`}
                    </div>

                    <!-- Invisible tap zones -->
                    <div class="story-tap-prev" id="storyTapPrev"></div>
                    <div class="story-tap-next" id="storyTapNext"></div>

                    ${group.isMine ? `<button class="story-delete-btn" id="storyDeleteBtn">🗑️ Delete</button>` : ''}
                </div>
            `;

            // Progress bar start (text/image only — video waits for metadata)
            if (story.type !== 'video' && story.type !== 'instagram') {
                setTimeout(() => {
                    const fill = document.getElementById('storyFill_' + idx);
                    if (fill) fill.classList.add('active');
                }, 50);
                timer = setTimeout(_goNext, DURATION);
            }

            // ── Video wiring ───────────────────────────────────
            if (story.type === 'video') {
                videoEl = document.getElementById('storyVideoEl');
                if (videoEl) {
                    videoEl.onerror = () => {
                        videoEl.style.display = 'none';
                        const fb = document.getElementById('storyMediaFallback');
                        if (fb) { fb.style.display = 'flex'; fb.style.flexDirection = 'column'; fb.style.gap = '8px'; }
                    };
                    videoEl.onloadedmetadata = () => {
                        const dur = (videoEl.duration || 5) * 1000;
                        const fill = document.getElementById('storyFill_' + idx);
                        if (fill) {
                            fill.style.setProperty('--story-duration', dur + 'ms');
                            fill.classList.add('active');
                        }
                    };
                    videoEl.onended = () => {
                        const fill = document.getElementById('storyFill_' + idx);
                        if (fill) { fill.classList.remove('active'); fill.classList.add('done'); }
                        setTimeout(_goNext, 300);
                    };
                    videoEl.play().catch(() => {});
                }
            }

            // ── Instagram embed ────────────────────────────────
            if (story.type === 'instagram') {
                if (window.instgrm) window.instgrm.Embeds.process();
                else if (!document.getElementById('instagram-embed-script')) {
                    const s = document.createElement('script');
                    s.id = 'instagram-embed-script';
                    s.src = 'https://www.instagram.com/embed.js';
                    s.async = true;
                    s.onload = () => window.instgrm?.Embeds.process();
                    document.body.appendChild(s);
                }
            }

            // ── Close ──────────────────────────────────────────
            document.getElementById('storyViewerClose').onclick = (e) => {
                e.stopPropagation();
                clearTimeout(timer);
                overlay.remove();
            };

            // ── Delete ─────────────────────────────────────────
            if (group.isMine) {
                document.getElementById('storyDeleteBtn').onclick = async (e) => {
                    e.stopPropagation();
                    if (!confirm('Delete this status?')) return;
                    clearTimeout(timer);
                    try {
                        await window.db.collection('stories').doc(story.id).delete();
                        showToast('Status deleted', 'info');
                    } catch (err) {
                        showToast('Delete failed: ' + err.message, 'error');
                    }
                    overlay.remove();
                };
            }

            // ── Tap zones ──────────────────────────────────────
            document.getElementById('storyTapPrev').onclick = (e) => { e.stopPropagation(); _goPrev(); };
            document.getElementById('storyTapNext').onclick = (e) => { e.stopPropagation(); _goNext(); };

            // ── Hold to pause (pointer events) ─────────────────
            const viewer = overlay.querySelector('.story-viewer');
            viewer.addEventListener('pointerdown', (e) => {
                if (e.target.closest('.story-viewer-close, .story-delete-btn, .story-insta-open-btn, a, button')) return;
                _pause();
            });
            viewer.addEventListener('pointerup',     () => _resume());
            viewer.addEventListener('pointercancel', () => _resume());
            viewer.addEventListener('pointerleave',  () => { if (paused) _resume(); });

            // ── Swipe left/right → change person ──────────────
            let tsX = 0, tsY = 0;
            overlay.addEventListener('touchstart', (e) => {
                tsX = e.touches[0].clientX;
                tsY = e.touches[0].clientY;
            }, { passive: true });
            overlay.addEventListener('touchend', (e) => {
                const dx = e.changedTouches[0].clientX - tsX;
                const dy = e.changedTouches[0].clientY - tsY;
                if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
                    if (dx < 0) _nextGroup();
                    else        _prevGroup();
                }
            }, { passive: true });
        }

        _render(0);
    }
    // ── Time formatting ───────────────────────────────────────
    function _timeAgo(date) {
        const diffMs = Date.now() - date.getTime();
        const diffM  = Math.floor(diffMs / 60000);
        if (diffM < 1)    return 'Just now';
        if (diffM < 60)   return `${diffM}m ago`;
        const diffH = Math.floor(diffM / 60);
        if (diffH < 24)   return `${diffH}h ago`;
        return 'Yesterday';
    }

    // ── Public API ────────────────────────────────────────────
    return { init, openComposer: _openComposer };
})();

window.storiesManager = storiesManager;
console.log('profile.js loaded');
