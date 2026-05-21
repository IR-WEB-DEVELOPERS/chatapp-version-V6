// ============================================================
//  totp.js — Client-side TOTP (Google Authenticator) manager
//
//  Calls server.js routes:
//    POST /totp/setup   → get secret + otpauth URL
//    POST /totp/verify  → verify a 6-digit code
//    POST /totp/disable → disable 2FA
//
//  Usage:
//    window.totpManager.showSetupModal()
//    window.totpManager.showVerifyModal(uid)  → returns Promise<bool>
//    window.totpManager.isEnabled(uid)        → checks Firestore
// ============================================================

window.totpManager = (() => {

    // ── Check if TOTP is enabled for a user ───────────────────
    async function isEnabled(uid) {
        if (!window.db || !uid) return false;
        try {
            const snap = await window.db.collection('users').doc(uid).get();
            return snap.data()?.totpEnabled === true;
        } catch { return false; }
    }

    // ── Setup Modal ───────────────────────────────────────────
    async function showSetupModal() {
        const uid = window.currentUser?.uid;
        if (!uid) return;

        // Remove any existing modal
        document.getElementById('totpSetupModal')?.remove();

        const overlay = document.createElement('div');
        overlay.id        = 'totpSetupModal';
        overlay.className = 'modal-overlay totp-overlay';
        overlay.innerHTML = `
            <div class="modal totp-modal">
                <div class="modal-header">
                    <h3>🔐 Set up 2-Factor Auth</h3>
                    <button class="modal-close" id="totpSetupClose">✕</button>
                </div>
                <div class="modal-body totp-body">
                    <p class="totp-step">Step 1: Scan this QR code with <strong>Google Authenticator</strong> or any TOTP app</p>
                    <div class="totp-qr-wrap" id="totpQrWrap">
                        <div class="totp-spinner"></div>
                    </div>
                    <p class="totp-secret-label">Or enter this key manually:</p>
                    <div class="totp-secret" id="totpSecret">Loading...</div>
                    <p class="totp-step">Step 2: Enter the 6-digit code from the app to confirm</p>
                    <div class="totp-code-wrap">
                        <input type="text" id="totpConfirmCode" class="totp-input" maxlength="6"
                            placeholder="000000" inputmode="numeric" autocomplete="one-time-code">
                        <button class="totp-btn" id="totpConfirmBtn">Verify & Enable</button>
                    </div>
                    <div class="totp-error" id="totpSetupError" style="display:none"></div>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.querySelector('#totpSetupClose').onclick = () => overlay.remove();
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        // Call server to generate secret
        try {
            const res  = await fetch('/totp/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uid })
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error);

            // Show QR code via qrserver API
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.otpauth)}&bgcolor=ffffff&color=111827&margin=10`;
            overlay.querySelector('#totpQrWrap').innerHTML = `<img src="${qrUrl}" width="200" height="200" alt="TOTP QR">`;
            overlay.querySelector('#totpSecret').textContent = data.secret;

            // Confirm button
            overlay.querySelector('#totpConfirmBtn').onclick = async () => {
                const code    = overlay.querySelector('#totpConfirmCode').value.trim();
                const errEl   = overlay.querySelector('#totpSetupError');
                const btn     = overlay.querySelector('#totpConfirmBtn');

                if (code.length !== 6) { errEl.textContent = 'Enter 6 digits'; errEl.style.display = 'block'; return; }

                btn.disabled    = true;
                btn.textContent = 'Verifying...';
                errEl.style.display = 'none';

                const r = await fetch('/totp/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uid, token: code, confirmSetup: true })
                });
                const d = await r.json();

                if (d.ok) {
                    overlay.remove();
                    window.toastManager?.show({ icon: null, type: 'success', title: '✅ 2FA Enabled!', body: 'Your account is now protected with Google Authenticator', duration: 4000 });
                } else {
                    btn.disabled    = false;
                    btn.textContent = 'Verify & Enable';
                    errEl.textContent = d.error || 'Invalid code. Try again.';
                    errEl.style.display = 'block';
                }
            };

        } catch(e) {
            overlay.querySelector('#totpQrWrap').textContent = 'Failed to generate QR. Check server.';
            console.error('[TOTP Setup]', e);
        }
    }

    // ── Verify Modal (called at login if TOTP enabled) ────────
    function showVerifyModal(uid) {
        return new Promise(resolve => {
            document.getElementById('totpVerifyModal')?.remove();

            const overlay = document.createElement('div');
            overlay.id        = 'totpVerifyModal';
            overlay.className = 'modal-overlay totp-overlay';
            overlay.innerHTML = `
                <div class="modal totp-modal totp-verify-modal">
                    <div class="modal-header">
                        <h3>🔐 Two-Factor Authentication</h3>
                    </div>
                    <div class="modal-body totp-body">
                        <p class="totp-step">Open <strong>Google Authenticator</strong> and enter the 6-digit code for EduChat</p>
                        <div class="totp-code-wrap">
                            <input type="text" id="totpVerifyCode" class="totp-input" maxlength="6"
                                placeholder="000000" inputmode="numeric" autocomplete="one-time-code" autofocus>
                            <button class="totp-btn" id="totpVerifyBtn">Verify</button>
                        </div>
                        <div class="totp-error" id="totpVerifyError" style="display:none"></div>
                        <button class="totp-link-btn" id="totpVerifyCancel">Use email OTP instead</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            // Auto-submit on 6 digits
            overlay.querySelector('#totpVerifyCode').addEventListener('input', e => {
                if (e.target.value.length === 6) overlay.querySelector('#totpVerifyBtn').click();
            });

            overlay.querySelector('#totpVerifyCancel').onclick = () => {
                overlay.remove();
                resolve(false);
            };

            overlay.querySelector('#totpVerifyBtn').onclick = async () => {
                const code  = overlay.querySelector('#totpVerifyCode').value.trim();
                const errEl = overlay.querySelector('#totpVerifyError');
                const btn   = overlay.querySelector('#totpVerifyBtn');

                if (code.length !== 6) { errEl.textContent = 'Enter 6 digits'; errEl.style.display = 'block'; return; }

                btn.disabled    = true;
                btn.textContent = 'Verifying...';
                errEl.style.display = 'none';

                const r = await fetch('/totp/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uid, token: code })
                });
                const d = await r.json();

                if (d.ok) {
                    overlay.remove();
                    resolve(true);
                } else {
                    btn.disabled    = false;
                    btn.textContent = 'Verify';
                    errEl.textContent = 'Invalid code. Try again.';
                    errEl.style.display = 'block';
                }
            };
        });
    }

    // ── Disable Modal ─────────────────────────────────────────
    function showDisableModal() {
        const uid = window.currentUser?.uid;
        if (!uid) return Promise.resolve();

        return new Promise(resolve => {
            document.getElementById('totpDisableModal')?.remove();

            const overlay = document.createElement('div');
            overlay.id        = 'totpDisableModal';
            overlay.className = 'modal-overlay totp-overlay';
            overlay.innerHTML = `
                <div class="modal totp-modal totp-verify-modal">
                    <div class="modal-header">
                        <h3>🔐 Disable 2-Factor Auth</h3>
                        <button class="modal-close" id="totpDisableClose">✕</button>
                    </div>
                    <div class="modal-body totp-body">
                        <p class="totp-step">Enter the 6-digit code from <strong>Google Authenticator</strong> to confirm disabling 2FA</p>
                        <div class="totp-code-wrap">
                            <input type="text" id="totpDisableCode" class="totp-input" maxlength="6"
                                placeholder="000000" inputmode="numeric" autocomplete="one-time-code" autofocus>
                            <button class="totp-btn totp-btn-danger" id="totpDisableBtn">Disable 2FA</button>
                        </div>
                        <div class="totp-error" id="totpDisableError" style="display:none"></div>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            const closeOverlay = () => { overlay.remove(); resolve(); };
            overlay.querySelector('#totpDisableClose').onclick = closeOverlay;
            overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });

            // Auto-submit on 6 digits
            overlay.querySelector('#totpDisableCode').addEventListener('input', e => {
                if (e.target.value.length === 6) overlay.querySelector('#totpDisableBtn').click();
            });

            overlay.querySelector('#totpDisableBtn').onclick = async () => {
                const code  = overlay.querySelector('#totpDisableCode').value.trim();
                const errEl = overlay.querySelector('#totpDisableError');
                const btn   = overlay.querySelector('#totpDisableBtn');

                if (code.length !== 6) { errEl.textContent = 'Enter 6 digits'; errEl.style.display = 'block'; return; }

                btn.disabled    = true;
                btn.textContent = 'Disabling...';
                errEl.style.display = 'none';

                try {
                    const r = await fetch('/totp/disable', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ uid, token: code })
                    });
                    const d = await r.json();

                    if (d.ok) {
                        overlay.remove();
                        window.toastManager?.show({ icon: null, type: 'success', title: '2FA Disabled', body: 'Two-factor authentication has been turned off', duration: 3000 });
                        resolve();
                    } else {
                        btn.disabled    = false;
                        btn.textContent = 'Disable 2FA';
                        errEl.textContent = d.error || 'Invalid code. Try again.';
                        errEl.style.display = 'block';
                        overlay.querySelector('#totpDisableCode').value = '';
                        overlay.querySelector('#totpDisableCode').focus();
                    }
                } catch {
                    btn.disabled    = false;
                    btn.textContent = 'Disable 2FA';
                    errEl.textContent = 'Network error. Try again.';
                    errEl.style.display = 'block';
                }
            };
        });
    }

    return { isEnabled, showSetupModal, showVerifyModal, showDisableModal };

})();
