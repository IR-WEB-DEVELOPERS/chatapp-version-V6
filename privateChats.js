// ============================================================
//  privateChats.js — Private Chats with 4-digit passcode,
//                    email OTP fallback, block contacts
// ============================================================

window.privateChatsManager = (() => {

    // ── State ─────────────────────────────────────────────────
    let _initialized     = false;
    let _unlocked        = false;
    let _passcodeBuffer  = '';
    let _otpCode         = '';
    let _otpExpiry       = 0;
    let _otpResendTimer  = null;
    let _otpPurpose      = 'reset';
    let _privateContacts = [];

    // ── Helpers ───────────────────────────────────────────────
    // In-memory cache so we don't hit Firestore on every keystroke
    let _cachedCode = null;

    async function _getStoredCode() {
        if (!window.currentUser) return null;
        // Return cached value if available
        if (_cachedCode !== null) return _cachedCode;
        try {
            const snap = await window.db.collection('privatePasscodes')
                .doc(window.currentUser.uid).get();
            if (snap.exists) {
                _cachedCode = snap.data().code || null;
                return _cachedCode;
            }
        } catch (e) {
            console.warn('[PC] Firestore get failed, fallback to localStorage:', e.message);
            return localStorage.getItem(`pc_code_${window.currentUser.uid}`);
        }
        return null;
    }

    async function _setStoredCode(code) {
        if (!window.currentUser) return;
        _cachedCode = code;
        try {
            await window.db.collection('privatePasscodes')
                .doc(window.currentUser.uid).set({
                    code,
                    updatedAt: Date.now()
                });
            // Also keep localStorage as fallback for offline
            localStorage.setItem(`pc_code_${window.currentUser.uid}`, code);
        } catch (e) {
            console.warn('[PC] Firestore set failed, using localStorage only:', e.message);
            localStorage.setItem(`pc_code_${window.currentUser.uid}`, code);
        }
    }
    function _getPrivateList() {
        if (!window.currentUser) return [];
        try {
            return JSON.parse(localStorage.getItem(`pc_list_${window.currentUser.uid}`) || '[]');
        } catch { return []; }
    }
    function _setPrivateList(arr) {
        if (!window.currentUser) return;
        localStorage.setItem(`pc_list_${window.currentUser.uid}`, JSON.stringify(arr));
    }
    function _getBlockedList() {
        if (!window.currentUser) return [];
        try {
            return JSON.parse(localStorage.getItem(`blocked_${window.currentUser.uid}`) || '[]');
        } catch { return []; }
    }
    function _setBlockedList(arr) {
        if (!window.currentUser) return;
        localStorage.setItem(`blocked_${window.currentUser.uid}`, JSON.stringify(arr));
    }

    // ── Dot indicator update ──────────────────────────────────
    function _updateDots(containerId, count) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const dots = container.querySelectorAll('.dot');
        dots.forEach((dot, i) => {
            dot.classList.toggle('filled', i < count);
        });
    }

    // ── Secured Chats (per-chat fingerprint lock) ────────────
    const _SC_KEY = () => `sc_list_${window.currentUser?.uid}`;

    function _getSecuredList() {
        try { return JSON.parse(localStorage.getItem(_SC_KEY()) || '[]'); } catch { return []; }
    }
    function _setSecuredList(arr) {
        localStorage.setItem(_SC_KEY(), JSON.stringify(arr));
    }
    function isSecuredChat(uid) {
        return _getSecuredList().includes(uid);
    }
    function _addSecuredChat(uid) {
        const list = _getSecuredList();
        if (!list.includes(uid)) { list.push(uid); _setSecuredList(list); }
    }
    function _removeSecuredChat(uid) {
        _setSecuredList(_getSecuredList().filter(u => u !== uid));
    }

    // Verify biometric for any purpose — used everywhere in the app.
    // Returns true if biometric passes, OR if biometric is not set up (allow through).
    // Always uses stored credId → shows fingerprint, not passkey picker.
    async function verifyForChat() {
        const available  = await _isBiometricAvailable();
        if (!available) return true; // device has no biometric hardware
        const registered = await _isBiometricRegisteredAsync(); // checks Firestore too
        if (!registered) return true; // user hasn't set up biometric
        return await _verifyBiometric(); // _verifyBiometric loads credId internally
    }

    // ── Biometric (WebAuthn) helpers ──────────────────────────
    // We store the registered credential ID in Firestore so the browser knows
    // WHICH authenticator to invoke → shows fingerprint, not a "create passkey" dialog.
    // localStorage is kept as fast cache; Firestore is the source of truth.

    const _WEBAUTHN_KEY      = () => `pc_webauthn_${window.currentUser?.uid}`;
    const _WEBAUTHN_CRED_KEY = () => `pc_webauthn_cred_${window.currentUser?.uid}`;

    // Helper: base64url encode/decode for rawId bytes
    function _bufToBase64(buf) {
        return btoa(String.fromCharCode(...new Uint8Array(buf)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function _base64ToBuf(b64) {
        const s = b64.replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;
    }

    // Save credentialId to localStorage + Firestore
    async function _saveCredentialId(base64Id) {
        if (!window.currentUser) return;
        localStorage.setItem(_WEBAUTHN_CRED_KEY(), base64Id);
        localStorage.setItem(_WEBAUTHN_KEY(), '1');
        try {
            await window.db.collection('privatePasscodes')
                .doc(window.currentUser.uid)
                .set({ webauthnCredId: base64Id, webauthnEnabled: true }, { merge: true });
        } catch(e) { console.warn('[WebAuthn] Firestore cred save failed:', e.message); }
    }

    // Load credentialId: localStorage first, then Firestore fallback
    async function _loadCredentialId() {
        const cached = localStorage.getItem(_WEBAUTHN_CRED_KEY());
        if (cached) return cached;
        try {
            const snap = await window.db.collection('privatePasscodes')
                .doc(window.currentUser?.uid).get();
            if (snap.exists && snap.data().webauthnCredId) {
                const id = snap.data().webauthnCredId;
                localStorage.setItem(_WEBAUTHN_CRED_KEY(), id);
                localStorage.setItem(_WEBAUTHN_KEY(), '1');
                return id;
            }
        } catch(e) { console.warn('[WebAuthn] Firestore cred load failed:', e.message); }
        return null;
    }

    async function _clearCredentialId() {
        localStorage.removeItem(_WEBAUTHN_CRED_KEY());
        localStorage.removeItem(_WEBAUTHN_KEY());
        try {
            await window.db.collection('privatePasscodes')
                .doc(window.currentUser?.uid)
                .set({ webauthnCredId: null, webauthnEnabled: false }, { merge: true });
        } catch(e) { /* ignore */ }
    }

    function _isBiometricRegistered() {
        // Fast sync check from localStorage cache
        return localStorage.getItem(_WEBAUTHN_KEY()) === '1';
    }

    // Async version: checks Firestore if localStorage is empty (cache-clear recovery)
    async function _isBiometricRegisteredAsync() {
        if (_isBiometricRegistered()) return true;
        const credId = await _loadCredentialId(); // populates localStorage on hit
        return !!credId;
    }

    async function _isBiometricAvailable() {
        try {
            return !!(window.PublicKeyCredential &&
                await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
        } catch { return false; }
    }

    async function _registerBiometric() {
        try {
            const uid  = window.currentUser?.uid || 'user';
            const cred = await navigator.credentials.create({
                publicKey: {
                    challenge:  crypto.getRandomValues(new Uint8Array(32)),
                    rp:         { name: 'EduChat Private Chats' },
                    user:       { id: new TextEncoder().encode(uid), name: uid, displayName: 'EduChat User' },
                    pubKeyCredParams: [
                        { type: 'public-key', alg: -7  },   // ES256
                        { type: 'public-key', alg: -257 }   // RS256 fallback
                    ],
                    authenticatorSelection: {
                        authenticatorAttachment: 'platform',  // device fingerprint only — no Google/YubiKey
                        userVerification:        'required',
                        residentKey:             'preferred'
                    },
                    timeout: 60000
                }
            });
            if (cred) {
                await _saveCredentialId(_bufToBase64(cred.rawId));
                return true;
            }
        } catch(e) { console.warn('[WebAuthn] Register failed:', e.message); }
        return false;
    }

    async function _verifyBiometric() {
        try {
            // Pass allowCredentials with stored ID → browser shows fingerprint prompt,
            // NOT the generic "choose a passkey" / Google account picker.
            const b64Id = await _loadCredentialId();
            const allowCredentials = b64Id
                ? [{ id: _base64ToBuf(b64Id), type: 'public-key' }]
                : [];
            const cred = await navigator.credentials.get({
                publicKey: {
                    challenge:        crypto.getRandomValues(new Uint8Array(32)),
                    userVerification: 'required',
                    allowCredentials,
                    timeout:          60000
                }
            });
            return !!cred;
        } catch(e) { console.warn('[WebAuthn] Verify failed:', e.message); return false; }
    }

    // ── Passcode Entry Modal ──────────────────────────────────
    // If biometric is enabled → auto-trigger fingerprint.
    // On failure/cancel → reveal passcode numpad as fallback.
    async function _openPasscodeModal() {
        _passcodeBuffer = '';
        _updateDots('passcodeDots', 0);
        const errEl = document.getElementById('passcodeError');
        if (errEl) errEl.style.display = 'none';

        const available = await _isBiometricAvailable();
        const credId    = available ? await _loadCredentialId() : null;
        const bioEnabled = available && !!credId;

        document.getElementById('privateChatsPasscodeModal').style.display = 'flex';

        const bioBtn  = document.getElementById('passcodeBiometricBtn');
        const numpad  = document.getElementById('passcodeNumpad');
        const dotsRow = document.getElementById('passcodeDotsRow');

        if (bioEnabled) {
            // Start with fingerprint; hide numpad
            if (numpad)  numpad.style.display  = 'none';
            if (dotsRow) dotsRow.style.display = 'none';
            if (bioBtn)  { bioBtn.style.display = 'flex'; bioBtn.disabled = false; bioBtn.innerHTML = '<span style="font-size:22px;">👆</span> Use Fingerprint'; }
            // Auto-trigger fingerprint after short delay so modal renders first
            setTimeout(() => _tryBiometricUnlock(true), 250);
        } else {
            // No biometric → straight to numpad
            if (numpad)  numpad.style.display  = 'grid';
            if (dotsRow) dotsRow.style.display = 'flex';
            if (bioBtn)  bioBtn.style.display  = 'none';
        }
    }

    function _showPasscodeNumpad() {
        const numpad  = document.getElementById('passcodeNumpad');
        const dotsRow = document.getElementById('passcodeDotsRow');
        const hintEl  = document.getElementById('passcodeFallbackHint');
        if (numpad)  numpad.style.display  = 'grid';
        if (dotsRow) dotsRow.style.display = 'flex';
        if (hintEl)  hintEl.style.display  = 'block';
    }

    function _closePasscodeModal() {
        document.getElementById('privateChatsPasscodeModal').style.display = 'none';
        _passcodeBuffer = '';
    }

    function _onPasscodeEntry(buf) {
        _updateDots('passcodeDots', buf.length);
        if (buf.length === 4) {
            setTimeout(() => _checkPasscode(buf), 100);
        }
    }

    // autoTriggered = true: called silently on modal open; failure just reveals numpad, no scary toast
    async function _tryBiometricUnlock(autoTriggered = false) {
        const bioBtn = document.getElementById('passcodeBiometricBtn');
        if (bioBtn) { bioBtn.disabled = true; bioBtn.textContent = '🔍 Verifying…'; }

        const ok = await _verifyBiometric();

        if (bioBtn) { bioBtn.disabled = false; bioBtn.innerHTML = '<span style="font-size:22px;">👆</span> Use Fingerprint'; }

        if (ok) {
            _unlocked = true;
            _closePasscodeModal();
            _showPrivateChatsSection();
            window.toastManager?.show({ icon: null, type: 'success', title: '🔓 Unlocked', body: 'Fingerprint verified', duration: 2000 });
        } else {
            // Reveal numpad fallback
            _showPasscodeNumpad();
            if (!autoTriggered) {
                window.toastManager?.show({ icon: null, type: 'error', title: 'Fingerprint failed', body: 'Enter passcode instead', duration: 2500 });
            }
        }
    }

    async function _checkPasscode(code) {
        const stored = await _getStoredCode();
        if (code === stored) {
            _unlocked = true;
            _closePasscodeModal();
            _showPrivateChatsSection();
            if (window.showToast) showToast('Private chats unlocked!', 'success');
        } else {
            _passcodeBuffer = '';
            _updateDots('passcodeDots', 0);
            const errEl = document.getElementById('passcodeError');
            if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Wrong passcode! Try again.'; }
            setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 2000);
        }
    }

    // ── Setup Modal (first time) ──────────────────────────────
    let _setupStep = 'set';
    let _setupFirstCode = '';
    let _setupBuffer = '';

    function _openSetupModal() {
        _setupStep    = 'set';
        _setupBuffer  = '';
        _setupFirstCode = '';
        _updateDots('setupPasscodeDots', 0);
        document.getElementById('setupModalSubtitle').textContent = 'Create a 4-digit passcode';
        const errEl = document.getElementById('setupError');
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        document.getElementById('privateChatsSetupModal').style.display = 'flex';
    }

    function _onSetupEntry(buf) {
        _updateDots('setupPasscodeDots', buf.length);
        if (buf.length === 4) {
            setTimeout(async () => {
                if (_setupStep === 'set') {
                    _setupFirstCode = buf;
                    _setupBuffer = '';
                    _setupStep = 'confirm';
                    _updateDots('setupPasscodeDots', 0);
                    document.getElementById('setupModalSubtitle').textContent = 'Confirm your passcode';
                } else {
                    if (buf === _setupFirstCode) {
                        // ── Biometric verification before saving ──────────────
                        const bioAvailable  = await _isBiometricAvailable();
                        const bioRegistered = _isBiometricRegistered();
                        if (bioAvailable && bioRegistered) {
                            const subtitle = document.getElementById('setupModalSubtitle');
                            if (subtitle) subtitle.textContent = 'Verify with fingerprint to save';
                            const bioOk = await _verifyBiometric();
                            if (!bioOk) {
                                const errEl = document.getElementById('setupError');
                                if (errEl) { errEl.textContent = 'Fingerprint verification failed. Try again.'; errEl.style.display = 'block'; }
                                setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 3000);
                                _setupBuffer = '';
                                _setupStep = 'confirm';
                                _updateDots('setupPasscodeDots', 0);
                                if (subtitle) subtitle.textContent = 'Confirm your passcode';
                                return;
                            }
                        }
                        // ── Save to Firestore ─────────────────────────────────
                        await _setStoredCode(buf);
                        document.getElementById('privateChatsSetupModal').style.display = 'none';
                        _unlocked = true;
                        _showPrivateChatsSection();
                        if (window.showToast) showToast('Private chats enabled!', 'success');
                    } else {
                        _setupBuffer = '';
                        _setupStep = 'set';
                        _setupFirstCode = '';
                        _updateDots('setupPasscodeDots', 0);
                        document.getElementById('setupModalSubtitle').textContent = 'Create a 4-digit passcode';
                        const errEl = document.getElementById('setupError');
                        if (errEl) { errEl.textContent = "Passcodes didn't match! Try again."; errEl.style.display = 'block'; }
                        setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 2000);
                    }
                }
            }, 100);
        }
    }

    // ── Change Passcode Modal ─────────────────────────────────
    // Flow: [OTP sent automatically] → user verifies OTP → enters CURRENT passcode → enters NEW twice
    let _changeStep   = 'otp';   // 'otp' | 'old' | 'new' | 'confirm'
    let _changeBuffer = '';
    let _changeNewCode = '';
    let _changeOtpVerified = false;

    async function _openChangePasscodeModal() {
        _changeStep   = 'otp';
        _changeBuffer = '';
        _changeNewCode = '';
        _changeOtpVerified = false;
        _updateDots('changePasscodeDots', 0);
        const errEl = document.getElementById('changePasscodeError');
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        document.getElementById('changePasscodeModal').style.display = 'flex';

        // Show OTP step UI
        _showChangeOtpStep();

        // Auto-send OTP
        const sent = await _sendOTPForChange();
        if (!sent) {
            if (errEl) { errEl.textContent = 'Failed to send OTP. Check SMTP settings.'; errEl.style.display = 'block'; }
        }
    }

    function _showChangeOtpStep() {
        const subtitle = document.getElementById('changePasscodeSubtitle');
        const otpRow   = document.getElementById('changePasscodeOtpRow');
        const numpad   = document.getElementById('changePasscodeNumpad');
        if (subtitle) subtitle.textContent = 'Enter OTP sent to your email';
        if (otpRow) otpRow.style.display = 'flex';
        if (numpad) numpad.style.display = 'none';
    }

    function _showChangePasscodeStep(label) {
        const subtitle = document.getElementById('changePasscodeSubtitle');
        const otpRow   = document.getElementById('changePasscodeOtpRow');
        const numpad   = document.getElementById('changePasscodeNumpad');
        if (subtitle) subtitle.textContent = label;
        if (otpRow) otpRow.style.display = 'none';
        if (numpad) numpad.style.display = 'grid';
    }

    async function _sendOTPForChange() {
        const user  = window.currentUser;
        const email = user?.email || '';
        if (!email) return false;
        try {
            const result = await fetch('/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uid: user.uid, email, purpose: 'passcode-change' })
            }).then(r => r.json());
            if (result?.ok) {
                if (window.showToast) showToast(`OTP sent to ${email}`, 'success');
                return true;
            }
        } catch (e) { console.warn('[PC] send OTP change error:', e); }
        return false;
    }

    async function _verifyChangeOTP(inputCode) {
        const user = window.currentUser;
        try {
            const result = await fetch('/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uid: user.uid, email: user.email, purpose: 'passcode-change', code: inputCode })
            }).then(r => r.json());
            return !!result.ok;
        } catch (e) { console.warn('[PC] verify OTP change error:', e); }
        return false;
    }

    function _onChangeEntry(buf) {
        _updateDots('changePasscodeDots', buf.length);
        if (buf.length === 4) {
            setTimeout(async () => {
                if (_changeStep === 'old') {
                    const stored = await _getStoredCode();
                    if (buf === stored) {
                        _changeBuffer = '';
                        _changeStep = 'new';
                        _updateDots('changePasscodeDots', 0);
                        _showChangePasscodeStep('Enter NEW passcode');
                    } else {
                        _changeBuffer = '';
                        _updateDots('changePasscodeDots', 0);
                        const errEl = document.getElementById('changePasscodeError');
                        if (errEl) { errEl.textContent = 'Wrong passcode!'; errEl.style.display = 'block'; }
                        setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 2000);
                    }
                } else if (_changeStep === 'new') {
                    _changeNewCode = buf;
                    _changeBuffer  = '';
                    _changeStep    = 'confirm';
                    _updateDots('changePasscodeDots', 0);
                    _showChangePasscodeStep('Confirm NEW passcode');
                } else if (_changeStep === 'confirm') {
                    if (buf === _changeNewCode) {
                        await _setStoredCode(buf);
                        _cachedCode = buf;
                        document.getElementById('changePasscodeModal').style.display = 'none';
                        if (window.showToast) showToast('Passcode changed!', 'success');
                    } else {
                        _changeBuffer  = '';
                        _changeStep    = 'new';
                        _changeNewCode = '';
                        _updateDots('changePasscodeDots', 0);
                        _showChangePasscodeStep("Didn't match. Enter NEW passcode again.");
                        const errEl = document.getElementById('changePasscodeError');
                        if (errEl) { errEl.textContent = "Passcodes didn't match!"; errEl.style.display = 'block'; }
                        setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 2000);
                    }
                }
            }, 100);
        }
    }

    // ── Email OTP ─────────────────────────────────────────────
    function _generateOTP() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    async function _sendOTP() {
        const user  = window.currentUser;
        const email = user?.email || '';
        if (!email) {
            if (window.showToast) showToast('No email found for this account', 'error');
            return false;
        }

        try {
            _otpCode = '';
            _otpExpiry = 0;
            const result = await fetch('/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uid: user.uid,
                    email,
                    purpose: 'privacy-reset'
                })
            }).then(r => r.json());

            if (!result?.ok) throw new Error(result?.error || 'Failed to send OTP');

            const emailLabel = document.getElementById('otpEmailLabel');
            if (emailLabel) emailLabel.textContent = email;
            if (window.showToast) showToast(result.sent ? `OTP sent to ${email}` : 'OTP send failed. Check server SMTP settings.', result.sent ? 'success' : 'error');
            return true;
        } catch (err) {
            console.error('OTP send error:', err);
            if (window.showToast) showToast('Failed to send OTP. Check SMTP settings.', 'error');
            return false;
        }
    }

    function _openOTPModal(purpose) {
        _otpPurpose = purpose;
        const emailLabel = document.getElementById('otpEmailLabel');
        if (emailLabel) emailLabel.textContent = window.currentUser?.email || '';
        document.getElementById('emailOtpModal').style.display = 'flex';
        const otpInput = document.getElementById('otpInput');
        if (otpInput) { otpInput.value = ''; otpInput.focus(); }
        const errEl = document.getElementById('otpError');
        if (errEl) errEl.style.display = 'none';

        let secs = 60;
        const resendBtn = document.getElementById('resendOtpBtn');
        if (resendBtn) { resendBtn.disabled = true; resendBtn.textContent = `Resend OTP (${secs}s)`; }
        if (_otpResendTimer) clearInterval(_otpResendTimer);
        _otpResendTimer = setInterval(() => {
            secs--;
            if (resendBtn) resendBtn.textContent = `Resend OTP (${secs}s)`;
            if (secs <= 0) {
                clearInterval(_otpResendTimer);
                if (resendBtn) { resendBtn.disabled = false; resendBtn.textContent = 'Resend OTP'; }
            }
        }, 1000);

        _sendOTP();
    }

    async function _verifyOTP(inputCode) {
        try {
            const user = window.currentUser;
            const result = await fetch('/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uid: user.uid,
                    email: user.email,
                    purpose: 'privacy-reset',
                    code: inputCode
                })
            }).then(r => r.json());
            return !!result.ok;
        } catch (err) {
            console.warn('Backend OTP verify failed, using browser fallback OTP:', err);
        }
        return inputCode === _otpCode && Date.now() < _otpExpiry;
    }

    // ── Show/hide private chats section ──────────────────────
    function _showPrivateChatsSection() {
        const section = document.getElementById('privateChatsSection');
        if (section) section.style.display = 'block';
        _loadPrivateChatsUI();
    }

    function _hidePrivateChatsSection() {
        const section = document.getElementById('privateChatsSection');
        if (section) section.style.display = 'none';
        _unlocked = false;
    }

    function _loadPrivateChatsUI() {
        const list = document.getElementById('privateChatsListUI');
        if (!list) return;
        _privateContacts = _getPrivateList();
        if (_privateContacts.length === 0) {
            list.innerHTML = `<div class="empty-state" style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">
                No private chats yet.<br>Right-click a friend → "Move to Private"
            </div>`;
            return;
        }
        list.innerHTML = '';
        _privateContacts.forEach(uid => {
            const userData = (window.enhancedCache?.get && window.enhancedCache.get(`user_${uid}`)) || { name: uid.slice(0, 8) + '...', status: 'offline' };
            const item = document.createElement('div');
            item.className = 'friend-item private-chat-item';
            item.innerHTML = `
                <div class="friend-avatar"><span class="avatar-fallback" data-icon="lock"></span></div>
                <div class="friend-info">
                    <span class="friend-name">${window.escapeHTML ? escapeHTML(userData.name || uid) : (userData.name || uid)}</span>
                    <span class="friend-status">${window.escapeHTML ? escapeHTML(userData.status || 'offline') : (userData.status || 'offline')}</span>
                </div>
                <button class="remove-private-btn" data-uid="${uid}" title="Remove from private" data-icon-btn="close"></button>
            `;
            item.querySelector('.remove-private-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                _removeFromPrivate(uid);
            });
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('remove-private-btn')) return;
                if (window.openChat) window.openChat(uid, userData.name || uid, userData);
            });
            list.appendChild(item);
        });
    }

    // ── Private list management ───────────────────────────────
    function _addToPrivate(uid) {
        const list = _getPrivateList();
        if (!list.includes(uid)) {
            list.push(uid);
            _setPrivateList(list);
            _privateContacts = list;
            if (window.showToast) showToast('Chat moved to private', 'success');
            if (_unlocked) _loadPrivateChatsUI();
            if (window.loadFriendsList) window.loadFriendsList();
        }
    }

    function _removeFromPrivate(uid) {
        let list = _getPrivateList();
        list = list.filter(u => u !== uid);
        _setPrivateList(list);
        _privateContacts = list;
        if (window.showToast) showToast('Removed from private chats', 'info');
        if (_unlocked) _loadPrivateChatsUI();
        if (window.loadFriendsList) window.loadFriendsList();
    }

    function isPrivate(uid) {
        return _getPrivateList().includes(uid);
    }

    // ── Block contacts ────────────────────────────────────────
    function blockContact(uid, name) {
        const list = _getBlockedList();
        if (!list.find(u => u.uid === uid)) {
            list.push({ uid, name: name || uid });
            _setBlockedList(list);
            if (window.showToast) showToast(`${name || 'User'} blocked`, 'success');
            if (window.loadFriendsList) window.loadFriendsList();
        }
    }

    function unblockContact(uid) {
        let list = _getBlockedList();
        list = list.filter(u => u.uid !== uid);
        _setBlockedList(list);
        if (window.showToast) showToast('Contact unblocked', 'info');
        if (window.loadFriendsList) window.loadFriendsList();
        if (window.loadAllFriends) window.loadAllFriends();
        openBlockedContacts();
    }

    function isBlocked(uid) {
        return _getBlockedList().some(u => u.uid === uid);
    }

    function openBlockedContacts() {
        const modal = document.getElementById('blockedContactsModal');
        if (!modal) return;
        const listEl = document.getElementById('blockedContactsList');
        if (!listEl) return;
        const blocked = _getBlockedList();
        if (blocked.length === 0) {
            listEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);">No blocked contacts</div>`;
        } else {
            listEl.innerHTML = blocked.map(u => `
                <div class="blocked-item" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span class="block-icon-svg" style="display:flex;align-items:center;"></span>
                        <span style="font-weight:500;">${window.escapeHTML ? escapeHTML(u.name) : u.name}</span>
                    </div>
                    <button class="btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="window.privateChatsManager.unblockContact('${u.uid}')">Unblock</button>
                </div>
            `).join('');
        }
        modal.style.display = 'flex';
    }

    // ── Search passcode unlock ────────────────────────────────
    async function tryUnlockFromSearch(code) {
        const stored = await _getStoredCode();
        if (!stored) {
            if (window.showToast) showToast('Private chats not set up yet. Use the menu to set up.', 'info');
            return;
        }
        if (code === stored) {
            _unlocked = true;
            _showPrivateChatsSection();
            if (window.showToast) showToast('Private chats unlocked!', 'success');
        } else {
            if (window.showToast) showToast('Wrong passcode!', 'error');
        }
    }

    // ── Menu open ─────────────────────────────────────────────
    async function openMenu() {
        const stored = await _getStoredCode();
        if (!stored) {
            _openSetupModal();
        } else if (_unlocked) {
            _showPrivateChatsMenu();
        } else {
            _openPasscodeModal();
        }
    }

    function _showPrivateChatsMenu() {
        const opts = [
            { label: 'Change Passcode',    action: () => _openChangePasscodeModal() },
            { label: 'Lock Private Chats', action: () => { _hidePrivateChatsSection(); if (window.showToast) showToast('Private chats locked', 'info'); } },
        ];
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal" style="max-width:300px;">
                <div class="modal-header"><h3>Private Chats</h3><button class="modal-close" id="pcMenuClose" data-icon-btn="close"></button></div>
                <div class="modal-body" style="padding:8px 0;">
                    ${opts.map((o, i) => `<button class="dropdown-item" style="width:100%;text-align:left;padding:12px 20px;" data-pc-opt="${i}">${o.label}</button>`).join('')}
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#pcMenuClose').onclick = () => modal.remove();
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        modal.querySelectorAll('[data-pc-opt]').forEach(btn => {
            btn.onclick = () => { modal.remove(); opts[+btn.dataset.pcOpt].action(); };
        });
    }

    // ── Init ──────────────────────────────────────────────────
    function init() {
        if (_initialized) return;
        _initialized = true;

        document.getElementById('closePrivateModal')?.addEventListener('click', _closePasscodeModal);
        document.getElementById('closeSetupModal')?.addEventListener('click', () => {
            document.getElementById('privateChatsSetupModal').style.display = 'none';
        });
        document.getElementById('closeChangePasscodeModal')?.addEventListener('click', () => {
            document.getElementById('changePasscodeModal').style.display = 'none';
        });
        document.getElementById('closeOtpModal')?.addEventListener('click', () => {
            document.getElementById('emailOtpModal').style.display = 'none';
            clearInterval(_otpResendTimer);
        });
        document.getElementById('closeBlockedModal')?.addEventListener('click', () => {
            document.getElementById('blockedContactsModal').style.display = 'none';
        });
        document.getElementById('closeBlockedBtn')?.addEventListener('click', () => {
            document.getElementById('blockedContactsModal').style.display = 'none';
        });

        document.getElementById('lockPrivateBtn')?.addEventListener('click', () => {
            _hidePrivateChatsSection();
            if (window.showToast) showToast('Private chats locked', 'info');
        });

        // Passcode numpad
        document.querySelectorAll('#privateChatsPasscodeModal .num-btn[data-n]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (_passcodeBuffer.length >= 4) return;
                _passcodeBuffer += btn.dataset.n;
                _onPasscodeEntry(_passcodeBuffer);
            });
        });
        document.getElementById('passcodeBackBtn')?.addEventListener('click', () => {
            _passcodeBuffer = _passcodeBuffer.slice(0, -1);
            _onPasscodeEntry(_passcodeBuffer);
        });

        // Biometric unlock button
        document.getElementById('passcodeBiometricBtn')?.addEventListener('click', () => {
            _tryBiometricUnlock();
        });

        // Setup numpad
        document.querySelectorAll('#privateChatsSetupModal .num-btn[data-setup]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (_setupBuffer.length >= 4) return;
                _setupBuffer += btn.dataset.setup;
                _onSetupEntry(_setupBuffer);
            });
        });
        document.getElementById('setupBackBtn')?.addEventListener('click', () => {
            _setupBuffer = _setupBuffer.slice(0, -1);
            _onSetupEntry(_setupBuffer);
        });

        // Change passcode numpad
        document.querySelectorAll('#changePasscodeModal .num-btn[data-change]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (_changeBuffer.length >= 4) return;
                _changeBuffer += btn.dataset.change;
                _onChangeEntry(_changeBuffer);
            });
        });
        document.getElementById('changeBackBtn')?.addEventListener('click', () => {
            _changeBuffer = _changeBuffer.slice(0, -1);
            _onChangeEntry(_changeBuffer);
        });

        // Change passcode: OTP verify step
        document.getElementById('verifyChangeOtpBtn')?.addEventListener('click', async () => {
            const input  = (document.getElementById('changeOtpInput')?.value || '').trim();
            const errEl  = document.getElementById('changePasscodeError');
            if (input.length !== 6) {
                if (errEl) { errEl.textContent = 'Enter 6-digit OTP'; errEl.style.display = 'block'; }
                return;
            }
            const valid = await _verifyChangeOTP(input);
            if (valid) {
                _changeOtpVerified = true;
                _changeStep  = 'old';
                _changeBuffer = '';
                _updateDots('changePasscodeDots', 0);
                _showChangePasscodeStep('Enter your CURRENT passcode');
                if (window.showToast) showToast('OTP verified! Enter current passcode.', 'success');
            } else {
                if (errEl) { errEl.textContent = 'Invalid or expired OTP!'; errEl.style.display = 'block'; }
                setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 3000);
            }
        });
        document.getElementById('changeOtpInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('verifyChangeOtpBtn')?.click();
        });
        document.getElementById('resendChangeOtpBtn')?.addEventListener('click', async () => {
            const btn = document.getElementById('resendChangeOtpBtn');
            if (btn) { btn.disabled = true; }
            await _sendOTPForChange();
            let secs = 60;
            const timer = setInterval(() => {
                secs--;
                if (btn) btn.textContent = `Resend OTP (${secs}s)`;
                if (secs <= 0) { clearInterval(timer); if (btn) { btn.disabled = false; btn.textContent = 'Resend OTP'; } }
            }, 1000);
        });

        // Forgot passcode → email OTP
        document.getElementById('forgotPasscodeBtn')?.addEventListener('click', () => {
            _closePasscodeModal();
            _otpPurpose = 'reset';
            _openOTPModal('reset');
        });

        // Resend OTP
        document.getElementById('resendOtpBtn')?.addEventListener('click', () => {
            _sendOTP();
            let secs = 60;
            const resendBtn = document.getElementById('resendOtpBtn');
            if (resendBtn) resendBtn.disabled = true;
            if (_otpResendTimer) clearInterval(_otpResendTimer);
            _otpResendTimer = setInterval(() => {
                secs--;
                if (resendBtn) resendBtn.textContent = `Resend OTP (${secs}s)`;
                if (secs <= 0) {
                    clearInterval(_otpResendTimer);
                    if (resendBtn) { resendBtn.disabled = false; resendBtn.textContent = 'Resend OTP'; }
                }
            }, 1000);
        });

        // Verify OTP
        document.getElementById('verifyOtpBtn')?.addEventListener('click', async () => {
            const inputCode = (document.getElementById('otpInput')?.value || '').trim();
            const errEl = document.getElementById('otpError');
            if (inputCode.length !== 6) {
                if (errEl) { errEl.textContent = 'Enter 6-digit OTP'; errEl.style.display = 'block'; }
                return;
            }
            const valid = await _verifyOTP(inputCode);
            if (valid) {
                clearInterval(_otpResendTimer);
                document.getElementById('emailOtpModal').style.display = 'none';
                if (_otpPurpose === 'reset') {
                    if (window.showToast) showToast('OTP verified! Set your new passcode.', 'success');
                    _setupStep = 'set';
                    _setupBuffer = '';
                    _setupFirstCode = '';
                    document.getElementById('setupModalSubtitle').textContent = 'Set a new 4-digit passcode';
                    document.getElementById('privateChatsSetupModal').style.display = 'flex';
                } else {
                    if (window.showToast) showToast('OTP verified!', 'success');
                    _openChangePasscodeModal();
                }
            } else {
                if (errEl) { errEl.textContent = 'Invalid or expired OTP!'; errEl.style.display = 'block'; }
            }
        });

        document.getElementById('otpInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('verifyOtpBtn')?.click();
        });

        // ── Search bar secret code detection ─────────────────
        // Listens on the main search input: type exactly 4 digits → unlock
        const searchInput = document.getElementById('searchUser');
        if (searchInput) {
            let _searchCodeTimer = null;
            searchInput.addEventListener('input', (e) => {
                const val = e.target.value.trim();
                if (/^\d{4}$/.test(val)) {
                    clearTimeout(_searchCodeTimer);
                    _searchCodeTimer = setTimeout(() => {
                        tryUnlockFromSearch(val);
                        searchInput.value = '';
                        // Clear search results if any
                        const results = document.getElementById('searchedUser');
                        if (results) results.innerHTML = '';
                    }, 300);
                }
            });
        }

        window._isPrivateChat      = isPrivate;
        window._isBlocked          = isBlocked;
        window._addToPrivateChat   = _addToPrivate;
        window._blockContact       = blockContact;
        window._verifyBiometricRaw = _verifyBiometric;
        window._isSecuredChat      = isSecuredChat;
    }

    return {
        init,
        openMenu,
        openBlockedContacts,
        tryUnlockFromSearch,
        unblockContact,
        blockContact,
        isPrivate,
        isBlocked,
        addToPrivate: _addToPrivate,
        removeFromPrivate: _removeFromPrivate,
        isUnlocked: () => _unlocked,
        // Secured Chats API
        isSecuredChat,
        addSecuredChat: _addSecuredChat,
        removeSecuredChat: _removeSecuredChat,
        verifyForChat,
        // Biometric API (called from Settings and app-wide)
        isBiometricAvailable: _isBiometricAvailable,
        isBiometricRegistered: _isBiometricRegistered,           // sync, localStorage only
        isBiometricRegisteredAsync: _isBiometricRegisteredAsync, // async, also checks Firestore
        registerBiometric: _registerBiometric,
        disableBiometric: () => _clearCredentialId(),
        verifyBiometric: _verifyBiometric, // raw verify — always passes allowCredentials
    };

})();

// ── App-level lock: when app comes back from background ──────
(function() {
    const APP_LOCK_KEY          = () => `app_bio_lock_${window.currentUser?.uid || 'guest'}`;
    const APP_LOCK_UNLOCKED_KEY = () => `app_lock_unlocked_${window.currentUser?.uid || 'guest'}`;
    let _appLockOverlay = null;
    let _appLockHidden  = false;

    async function _showAppLockScreen() {
        // Already showing
        if (_appLockOverlay && document.body.contains(_appLockOverlay)) return;
        // Already unlocked this session (e.g. page refresh) — don't re-prompt
        if (sessionStorage.getItem(APP_LOCK_UNLOCKED_KEY()) === '1') return;

        const pm = window.privateChatsManager;
        if (!pm) return;
        const available  = await pm.isBiometricAvailable?.();
        if (!available) return; // device has no biometric hardware
        // Check Firestore too for cache-cleared scenarios
        const registered = await pm.isBiometricRegisteredAsync?.() || pm.isBiometricRegistered?.();
        if (!registered) return; // biometric not set up

        // Check if global app lock is enabled
        if (localStorage.getItem(APP_LOCK_KEY()) !== '1') return;

        _appLockOverlay = document.createElement('div');
        _appLockOverlay.id = 'appLockOverlay';
        _appLockOverlay.style.cssText = `
            position:fixed;inset:0;z-index:99999;
            background:var(--bg,#0f172a);
            display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;
        `;
        _appLockOverlay.innerHTML = `
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent,#6366f1)" stroke-width="1.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <div style="color:var(--text,#f1f5f9);font-size:18px;font-weight:600;">App Locked</div>
            <div style="color:var(--text-secondary,#94a3b8);font-size:13px;">Use fingerprint to unlock</div>
            <button id="appLockBioBtn" style="
                margin-top:8px;padding:12px 32px;border-radius:999px;border:none;
                background:var(--accent,#6366f1);color:#fff;font-size:15px;font-weight:600;cursor:pointer;
            ">
                🔓 Unlock with Fingerprint
            </button>
        `;
        document.body.appendChild(_appLockOverlay);

        const tryUnlock = async () => {
            const btn = document.getElementById('appLockBioBtn');
            if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }
            // Use pm.verifyBiometric — loads stored credId → shows fingerprint, not passkey picker
            const ok = await pm.isBiometricAvailable?.() && await pm.verifyBiometric?.();
            if (ok) {
                _appLockOverlay?.remove();
                _appLockOverlay = null;
                // Mark session as unlocked so refresh doesn't re-prompt
                sessionStorage.setItem(APP_LOCK_UNLOCKED_KEY(), '1');
            } else {
                if (btn) { btn.disabled = false; btn.textContent = '👆 Unlock with Fingerprint'; }
                window.toastManager?.show({ icon: null, type: 'error', title: 'Fingerprint failed', body: 'Try again', duration: 2000 });
            }
        };

        document.getElementById('appLockBioBtn')?.addEventListener('click', tryUnlock);
        // Auto-trigger fingerprint prompt
        setTimeout(tryUnlock, 300);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            _appLockHidden = true;
            // Clear session unlock flag so coming back from background re-prompts
            sessionStorage.removeItem(APP_LOCK_UNLOCKED_KEY());
        } else if (document.visibilityState === 'visible' && _appLockHidden) {
            _appLockHidden = false;
            _showAppLockScreen();
        }
    });

    // PWA: app completely closed & reopened = fresh page load, visibilitychange won't fire.
    // Fix: don't wait for appInitialized event (race condition — event may already have fired
    // before this listener registers). Instead, poll until currentUser is available.
    (function _checkAppLockOnLoad() {
        const uid = window.currentUser?.uid;
        if (uid) {
            const key = `app_bio_lock_${uid}`;
            if (localStorage.getItem(key) === '1') {
                _showAppLockScreen();
            }
            return;
        }
        // currentUser not set yet — wait for appInitialized or retry
        const onInit = () => {
            const uid2 = window.currentUser?.uid;
            if (!uid2) return;
            const key = `app_bio_lock_${uid2}`;
            if (localStorage.getItem(key) === '1') {
                _showAppLockScreen();
            }
        };
        window.addEventListener('appInitialized', onInit, { once: true });
        // Safety fallback: also check after 2s in case event already fired
        setTimeout(() => {
            const uid3 = window.currentUser?.uid;
            if (!uid3) return;
            const key = `app_bio_lock_${uid3}`;
            if (localStorage.getItem(key) === '1' && (!_appLockOverlay || !document.body.contains(_appLockOverlay))) {
                _showAppLockScreen();
            }
        }, 2000);
    })();

    // Also handle pageshow (back/forward cache on mobile)
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) {
            _appLockHidden = true;
            _showAppLockScreen();
        }
    });

    // Expose for profile.js toggle
    window.appLockManager = {
        isEnabled: () => localStorage.getItem(`app_bio_lock_${window.currentUser?.uid || 'guest'}`) === '1',
        enable:    () => localStorage.setItem(`app_bio_lock_${window.currentUser?.uid || 'guest'}`, '1'),
        disable:   () => localStorage.removeItem(`app_bio_lock_${window.currentUser?.uid || 'guest'}`),
    };
})();

window.addEventListener('appInitialized', () => {
    window.privateChatsManager?.init();
});
