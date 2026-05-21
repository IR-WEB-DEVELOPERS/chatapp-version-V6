// ── Firebase auth is initialised by the Firebase SDK scripts loaded in
//    index.html before this file. Do NOT call firebase.initializeApp() here —
//    globals.js (on chat.html) or the compat SDK handles that, and calling it
//    twice causes "Firebase App named '[DEFAULT]' already exists" crashes.

// auth.setPersistence is called once here for the login page context.
const auth = firebase.auth();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((err) => {
    console.warn('Firebase auth persistence setup failed:', err);
});

const LOGIN_VERIFIED_PREFIX = 'educhat_login_otp_verified_';

// BUG FIX 1: currentOtp / currentOtpExpiry were never populated from the
// server response, so the browser-side fallback check was always false.
// Removed the dead variables — verification is 100% server-side now.
let resendTimer = null;
let pendingUser = null;
let otpSendInFlight = false;
let lastOtpKey = '';

function markLoginVerified(uid) {
    // Write to localStorage so the session persists across tabs and browser restarts.
    // Firebase already handles token refresh — we just need to remember that OTP was done.
    localStorage.setItem(`${LOGIN_VERIFIED_PREFIX}${uid}`, 'true');
    localStorage.setItem('educhat_last_verified_uid', uid);
}

function isLoginVerified(uid) {
    return localStorage.getItem(`${LOGIN_VERIFIED_PREFIX}${uid}`) === 'true';
}

function ensureOtpModal() {
    let modal = document.getElementById('loginOtpModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'loginOtpModal';
    modal.className = 'login-otp-overlay';
    modal.innerHTML = `
        <div class="login-otp-card">
            <div class="login-otp-header">
                <div>
                    <h3>Email OTP Verification</h3>
                    <p>Enter the 6-digit OTP sent to your email.</p>
                </div>
                <button id="closeLoginOtp" class="login-otp-close" type="button">&times;</button>
            </div>
            <div class="login-otp-body">
                <div class="login-otp-email" id="loginOtpEmail"></div>
                <input id="loginOtpInput" class="login-otp-input" type="text" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code">
                <div id="loginOtpError" class="login-otp-error"></div>
                <button id="verifyLoginOtp" class="login-otp-primary" type="button">Verify OTP</button>
                <button id="resendLoginOtp" class="login-otp-secondary" type="button">Resend OTP</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('closeLoginOtp').addEventListener('click', async () => {
        modal.style.display = 'none';
        clearInterval(resendTimer);
        await auth.signOut();
        pendingUser = null;
        otpSendInFlight = false;
        lastOtpKey = '';
        // BUG FIX 3: Closing OTP modal must also re-enable the Google button
        // so the user can try again without reloading the page.
        const googleBtn = document.getElementById('googleLogin');
        if (googleBtn) googleBtn.disabled = false;
    });
    document.getElementById('verifyLoginOtp').addEventListener('click', verifyLoginOtp);
    document.getElementById('resendLoginOtp').addEventListener('click', () => sendLoginOtp(pendingUser));
    document.getElementById('loginOtpInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') verifyLoginOtp();
    });

    // BUG FIX 4: Only allow numeric characters in the OTP input field.
    document.getElementById('loginOtpInput').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '');
    });

    return modal;
}

async function sendLoginOtp(user) {
    if (!user?.email) {
        alert('No email found for this account.');
        await auth.signOut();
        return;
    }
    const existingModal = document.getElementById('loginOtpModal');
    const key = `${user.uid}:${user.email}`;
    if (otpSendInFlight || (lastOtpKey === key && existingModal?.style.display === 'flex')) return;

    otpSendInFlight = true;
    lastOtpKey = key;
    pendingUser = user;

    // Show modal immediately — don't wait for SMTP round-trip
    const modal = ensureOtpModal();
    document.getElementById('loginOtpEmail').textContent = user.email;
    document.getElementById('loginOtpInput').value = '';
    document.getElementById('loginOtpError').textContent = 'Sending OTP to your email…';
    document.getElementById('verifyLoginOtp').disabled = true;
    document.getElementById('resendLoginOtp').disabled = true;
    modal.style.display = 'flex';
    document.getElementById('loginOtpInput').focus();

    let response;
    try {
        response = await fetch('/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: user.uid, email: user.email, purpose: 'login' })
        }).then(r => r.json());
    } catch (err) {
        console.error('Backend OTP send failed:', err);
        response = { ok: false, error: 'Failed to send OTP. Check SMTP settings.' };
    }

    document.getElementById('verifyLoginOtp').disabled = false;

    if (!response?.ok) {
        otpSendInFlight = false;
        lastOtpKey = '';
        modal.style.display = 'none';
        await auth.signOut();
        // BUG FIX 3: Re-enable Google button on failure so user can retry.
        const googleBtn = document.getElementById('googleLogin');
        if (googleBtn) googleBtn.disabled = false;
        alert(response?.error || 'Failed to send OTP.');
        return;
    }

    document.getElementById('loginOtpError').textContent = '';
    startResendCountdown();
    otpSendInFlight = false;
}

function startResendCountdown() {
    let seconds = 60;
    const resendBtn = document.getElementById('resendLoginOtp');
    resendBtn.disabled = true;
    resendBtn.textContent = `Resend OTP (${seconds}s)`;
    clearInterval(resendTimer);
    resendTimer = setInterval(() => {
        seconds--;
        resendBtn.textContent = `Resend OTP (${seconds}s)`;
        if (seconds <= 0) {
            clearInterval(resendTimer);
            resendBtn.disabled = false;
            resendBtn.textContent = 'Resend OTP';
        }
    }, 1000);
}

async function verifyLoginOtp() {
    const input = (document.getElementById('loginOtpInput')?.value || '').trim();
    const error = document.getElementById('loginOtpError');
    const verifyBtn = document.getElementById('verifyLoginOtp');

    if (!/^\d{6}$/.test(input)) {
        error.textContent = 'Enter a valid 6-digit OTP.';
        return;
    }

    // BUG FIX 5: Disable button while verifying to prevent double-submit.
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying…';

    let valid = false;
    try {
        const result = await fetch('/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uid: pendingUser.uid,
                email: pendingUser.email,
                purpose: 'login',
                code: input
            })
        }).then(r => r.json());
        valid = !!result.ok;
        if (!valid && result.error) error.textContent = result.error;
    } catch (err) {
        // BUG FIX 1 (cont): Removed insecure browser-side OTP fallback.
        // If the server is unreachable, we show an error and let the user retry.
        console.error('Backend OTP verify failed:', err);
        error.textContent = 'Network error. Please try again.';
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify OTP';
        return;
    }

    if (!valid) {
        if (!error.textContent) error.textContent = 'Invalid or expired OTP.';
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify OTP';
        return;
    }

    clearInterval(resendTimer);

    // ── TOTP: if user has 2FA enabled, verify before proceeding ─
    try {
        const firestoreDb = window.db || (firebase.firestore ? firebase.firestore() : null);
        if (firestoreDb) {
            const snap = await firestoreDb.collection('users').doc(pendingUser.uid).get();
            if (snap.data()?.totpEnabled) {
                if (!window.totpManager) {
                    console.warn('[TOTP] totpManager not loaded — blocking login for safety');
                    verifyBtn.disabled = false;
                    verifyBtn.textContent = 'Verify OTP';
                    error.textContent = '2FA module not loaded. Please refresh and try again.';
                    return;
                }
                const ok = await window.totpManager.showVerifyModal(pendingUser.uid);
                if (!ok) {
                    // User cancelled TOTP — sign out Firebase session so they don't get stuck
                    try { await firebase.auth().signOut(); } catch(_) {}
                    pendingUser = null;
                    const modal = document.getElementById('loginOtpModal');
                    if (modal) modal.style.display = 'none';
                    const googleBtn = document.getElementById('googleLogin');
                    if (googleBtn) googleBtn.disabled = false;
                    window.toastManager?.show({ icon: null, type: 'info', title: '2FA cancelled', body: 'Please log in again to continue', duration: 3000 });
                    return;
                }
            }
        } else {
            console.warn('[TOTP] No Firestore available on login page — TOTP check skipped');
        }
    } catch(e) { console.warn('[TOTP login check]', e.message); }
    // ─────────────────────────────────────────────────────────

    markLoginVerified(pendingUser.uid);

    // ── Login Activity Log (Supabase + Firestore) ──────────────
    try {
        const ua         = navigator.userAgent || '';
        const browser    = /Chrome\//.test(ua)    ? 'Chrome'
                         : /Firefox\//.test(ua)   ? 'Firefox'
                         : /Safari\//.test(ua)    ? 'Safari'
                         : /Edg\//.test(ua)       ? 'Edge' : 'Browser';
        const os         = /Android/.test(ua)      ? 'Android'
                         : /iPhone|iPad/.test(ua)  ? 'iOS'
                         : /Windows/.test(ua)      ? 'Windows'
                         : /Mac/.test(ua)          ? 'macOS'
                         : /Linux/.test(ua)        ? 'Linux' : 'Unknown OS';
        const deviceType = /Mobi|Android|iPhone|iPad/.test(ua) ? 'mobile'
                         : /Tablet|iPad/.test(ua)               ? 'tablet' : 'desktop';

        let city = '', country = '', ipAddress = '';
        try {
            const geo = await fetch('https://ipapi.co/json/').then(r => r.json());
            city      = geo.city         || '';
            country   = geo.country_name || '';
            ipAddress = geo.ip           || '';
        } catch { /* geo optional */ }

        const now = new Date().toISOString();

        // 1. Firestore loginActivity (keep existing)
        if (window.db) {
            window.db.collection('users').doc(pendingUser.uid)
                .collection('loginActivity')
                .add({ uid: pendingUser.uid, time: now, browser: browser + ' on ' + os, city, country })
                .catch(() => {});
            window.db.collection('users').doc(pendingUser.uid).update({
                lastLoginAt: now, lastLoginPlatform: browser + ' on ' + os,
                lastLoginLocation: city + (country ? ', ' + country : ''),
                lastSeen: now,
            }).catch(() => {});
        }

        // 2. Server → Supabase login_logs + users_mirror sync
        fetch('/log-login', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uid:         pendingUser.uid,
                email:       pendingUser.email       || '',
                displayName: pendingUser.displayName || '',
                photoURL:    pendingUser.photoURL    || '',
                browser, os, deviceType, city, country, ipAddress,
                userAgent: ua,
            }),
        }).catch(() => {}); // fire-and-forget

    } catch(e) { console.warn('[LoginActivity]', e.message); }
    // ─────────────────────────────────────────────────────────

    window.location.href = 'chat.html';
}

// Tracks whether OTP flow was triggered by a manual button click.
// onAuthStateChanged fires on every page load for existing sessions —
// we must NOT send OTP automatically; only redirect if already verified.
let _otpTriggeredByClick = false;

document.getElementById('googleLogin').onclick = async (e) => {
    const btn = e.currentTarget;
    // BUG FIX 6: Disable button immediately on click to prevent double-clicks
    // that fire two Google popups / two sendLoginOtp calls.
    btn.disabled = true;
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        _otpTriggeredByClick = true;
        const result = await auth.signInWithPopup(provider);
        await sendLoginOtp(result.user);
    } catch (error) {
        _otpTriggeredByClick = false;
        console.error('Login error:', error);
        btn.disabled = false;
        // BUG FIX 7: Don't alert on popup-closed-by-user — that's not an error.
        if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
            alert('Login failed: ' + (error.message || 'Please try again.'));
        }
    }
};

auth.onAuthStateChanged(user => {
    if (user && isLoginVerified(user.uid)) {
        // Already verified — redirect immediately without showing the login page
        window.location.replace('chat.html');
        return;
    }

    // No verified session — show the login UI
    const main = document.getElementById('loginMain');
    if (main) main.style.visibility = 'visible';

    // Dismiss PWA splash screen
    const splash = document.getElementById('pwaSplash');
    if (splash) {
        splash.classList.add('hide');
        setTimeout(() => splash.remove(), 650);
    }

    if (!user) return;

    // Only send OTP if user explicitly clicked the Google button.
    // Existing Firebase sessions trigger this callback on page load —
    // we do NOT want to auto-show the OTP modal in that case.
    if (_otpTriggeredByClick) {
        _otpTriggeredByClick = false;
        sendLoginOtp(user);
    }
});
