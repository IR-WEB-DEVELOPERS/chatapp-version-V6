// ============================================================
//  server.js - Render deployment server
//  Serves static files + Web Push + OTP email endpoints
// ============================================================

try {
    require('dotenv').config();
} catch (err) {
    // Render and other hosts inject env vars directly; dotenv is only for local runs.
}

const express = require('express');
const webpush = require('web-push');
const admin = require('firebase-admin');
const path = require('path');
const crypto = require('crypto');

let nodemailer = null;
try {
    nodemailer = require('nodemailer');
} catch (err) {
    console.warn('Nodemailer not installed yet. Run: npm install');
}

const app = express();
const PORT = process.env.PORT || 8080;

// ── CORS middleware ──────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json());

// ── Fix Cross-Origin-Opener-Policy for Firebase Google popup login ──
// Without this, signInWithPopup fails on strict COOP browsers.
app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
    next();
});

// NOTE: express.static is registered AFTER all API routes below,
// so /firebase-config, /vapid-public-key etc. are never shadowed by disk lookups.

// ── OTP store (backed by Firestore when available, in-memory fallback) ──
// The in-memory Map is used as a write-through cache; Firestore is the
// source of truth so OTPs survive server restarts / cold-starts.
const otpMemCache = new Map();

async function otpStoreSet(key, value, db) {
    otpMemCache.set(key, value);
    if (db) {
        try {
            await db.collection('_otpStore').doc(key.replace(/[^a-zA-Z0-9_-]/g, '_')).set(value);
        } catch (e) { console.warn('OTP Firestore write failed:', e.message); }
    }
}

async function otpStoreGet(key, db) {
    if (otpMemCache.has(key)) return otpMemCache.get(key);
    if (db) {
        try {
            const snap = await db.collection('_otpStore').doc(key.replace(/[^a-zA-Z0-9_-]/g, '_')).get();
            if (snap.exists) {
                const val = snap.data();
                otpMemCache.set(key, val);
                return val;
            }
        } catch (e) { console.warn('OTP Firestore read failed:', e.message); }
    }
    return null;
}

async function otpStoreDelete(key, db) {
    otpMemCache.delete(key);
    if (db) {
        try {
            await db.collection('_otpStore').doc(key.replace(/[^a-zA-Z0-9_-]/g, '_')).delete();
        } catch (e) { console.warn('OTP Firestore delete failed:', e.message); }
    }
}

// ── Rate limiting for /send-otp ──────────────────────────────
// Tracks per-IP and per-email send counts with a rolling 1-hour window
const otpRateLimit = new Map(); // key -> { count, windowStart }
const OTP_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const OTP_MAX_PER_IP = 10;
const OTP_MAX_PER_EMAIL = 5;

function checkOtpRateLimit(ip, email) {
    const now = Date.now();
    for (const key of [`ip:${ip}`, `email:${email}`]) {
        const limit = key.startsWith('ip:') ? OTP_MAX_PER_IP : OTP_MAX_PER_EMAIL;
        let entry = otpRateLimit.get(key);
        if (!entry || now - entry.windowStart > OTP_RATE_WINDOW_MS) {
            entry = { count: 0, windowStart: now };
        }
        if (entry.count >= limit) return false;
        entry.count++;
        otpRateLimit.set(key, entry);
    }
    return true;
}

function loadServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
        const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        const parsed = JSON.parse(json);
        if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
        return parsed;
    }

    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        return {
            type: 'service_account',
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            client_id: process.env.FIREBASE_CLIENT_ID,
            auth_uri: 'https://accounts.google.com/o/oauth2/auth',
            token_uri: 'https://oauth2.googleapis.com/token',
            auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
            client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
        };
    }

    return null;
}

function configureWebPush() {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const email = process.env.VAPID_EMAIL || 'mailto:admin@educhat.app';

    if (!publicKey || !privateKey) {
        console.warn('VAPID keys are not configured. Web push sending will be disabled.');
        return false;
    }

    webpush.setVapidDetails(email, publicKey, privateKey);
    return true;
}

// ── Brevo HTTP API — OTP emails (unchanged from original)
// BREVO_API_KEY env var required. SMTP_FROM = sender address.
async function sendOtpEmail({ to, code, purpose }) {
    const apiKey = process.env.BREVO_API_KEY;
    const from   = process.env.SMTP_FROM || 'noreply@example.com';

    if (!apiKey) {
        console.error('BREVO_API_KEY not set');
        return { sent: false, reason: 'BREVO_API_KEY_MISSING' };
    }

    const label = purpose === 'privacy-reset' ? 'private chats reset'
                : purpose === 'passcode-change' ? 'passcode change'
                : 'login';

    const body = JSON.stringify({
        sender:      { email: from },
        to:          [{ email: to }],
        subject:     `EduChat ${label} OTP`,
        textContent: `Your EduChat ${label} OTP is ${code}. It expires in 10 minutes.`,
        htmlContent: `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:8px;">
                <h2 style="color:#2d3748;margin-bottom:8px;">EduChat OTP</h2>
                <p style="color:#4a5568;">Your ${label} verification code is:</p>
                <div style="font-size:2rem;font-weight:bold;letter-spacing:8px;color:#3182ce;padding:16px 0;">${code}</div>
                <p style="color:#718096;font-size:0.9rem;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
            </div>`
    });

    try {
        const https = require('https');
        const result = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.brevo.com',
                path:     '/v3/smtp/email',
                method:   'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'api-key':       apiKey,
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ sent: true });
                    } else {
                        console.error('Brevo API error:', res.statusCode, data);
                        reject(new Error(`Brevo API returned ${res.statusCode}: ${data}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error('Brevo API request timed out'));
            });
            req.write(body);
            req.end();
        });
        return result;
    } catch (err) {
        console.error('sendOtpEmail error:', err.message);
        return { sent: false, reason: err.message };
    }
}

// ── sendReportEmail — uses same Brevo API as OTP emails
async function sendReportEmail({ to, subject, textContent, htmlContent, replyTo }) {
    const apiKey = process.env.BREVO_API_KEY;
    const from   = process.env.SMTP_FROM || 'noreply@educhat.app';
    if (!apiKey) return { sent: false, reason: 'BREVO_API_KEY not set' };

    const bodyObj = {
        sender:      { email: from, name: 'EduChat Reports' },
        to:          [{ email: to }],
        subject,
        textContent,
        htmlContent
    };
    if (replyTo) bodyObj.replyTo = { email: replyTo };

    const body = JSON.stringify(bodyObj);
    const https = require('https');
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.brevo.com',
            path:     '/v3/smtp/email',
            method:   'POST',
            headers: {
                'Content-Type':  'application/json',
                'api-key':       apiKey,
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve({ sent: true });
                else { console.error('[Brevo] send-report error:', res.statusCode, data); reject(new Error(`Brevo ${res.statusCode}: ${data}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Brevo timeout')); });
        req.write(body);
        req.end();
    });
}
function getOtpKey({ uid, email, purpose }) {
    return `${purpose || 'login'}:${uid || email}`;
}

function generateOTP() {
    return crypto.randomInt(100000, 1000000).toString();
}

const pushEnabled = configureWebPush();
const serviceAccount = loadServiceAccount();

let db = null;
try {
    if (serviceAccount) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
        admin.initializeApp();
    }
    db = admin.firestore();
    console.log('Firebase Admin initialized');
} catch (err) {
    console.error('Firebase Admin init error:', err.message);
}

// ── Admin routes ─────────────────────────────────────────────
// Share db and admin SDK via app.locals so adminRoutes.js can access them
app.locals.db       = db;
app.locals.adminSDK = admin;
const adminRouter = require('./adminRoutes');
app.use('/admin', adminRouter);

app.post('/send-push', async (req, res) => {
    const { uid, title, body, icon, chatId, isGroup, type } = req.body;

    if (!uid || !db) {
        return res.status(400).json({ error: 'Missing uid or db not ready' });
    }
    if (!pushEnabled) {
        return res.status(503).json({ error: 'Web push is not configured' });
    }

    try {
        const subsSnap = await db
            .collection('users')
            .doc(uid)
            .collection('pushSubscriptions')
            .get();

        if (subsSnap.empty) {
            return res.json({ sent: 0, message: 'No subscriptions for this user' });
        }

        const payload = JSON.stringify({ title, body, icon, chatId, isGroup, type });
        const options = { TTL: 86400 };

        let sent = 0;
        await Promise.allSettled(
            subsSnap.docs.map(async (subDoc) => {
                const sub = subDoc.data();
                try {
                    await webpush.sendNotification(
                        { endpoint: sub.endpoint, keys: sub.keys },
                        payload,
                        options
                    );
                    sent++;
                } catch (err) {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        await subDoc.ref.delete();
                    }
                }
            })
        );

        res.json({ sent, total: subsSnap.size });
    } catch (err) {
        console.error('/send-push error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/send-otp', async (req, res) => {
    const { uid, email, purpose = 'login' } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }

    // Rate limiting — block abuse before touching SMTP quota
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!checkOtpRateLimit(ip, email)) {
        return res.status(429).json({ ok: false, error: 'Too many OTP requests. Please wait before trying again.' });
    }

    const code = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const key = getOtpKey({ uid, email, purpose });
    await otpStoreSet(key, { code, expiresAt, email, purpose, attempts: 0 }, db);

    try {
        const delivery = await sendOtpEmail({ to: email, code, purpose });
        console.log(`[OTP] ${purpose} for ${email}: ${delivery.sent ? 'emailed' : delivery.reason}`);
        if (!delivery.sent) {
            await otpStoreDelete(key, db);
            return res.status(503).json({ ok: false, error: 'SMTP is not configured' });
        }
        res.json({ ok: true, sent: true, message: 'OTP sent to email' });
    } catch (err) {
        await otpStoreDelete(key, db);
        console.error('/send-otp error:', err);
        res.status(500).json({ ok: false, error: 'Email failed' });
    }
});

app.post('/verify-otp', async (req, res) => {
    const { uid, email, purpose = 'login', code } = req.body || {};
    const key = getOtpKey({ uid, email, purpose });
    const entry = await otpStoreGet(key, db);

    if (!entry) {
        return res.status(400).json({ ok: false, error: 'OTP not found or expired' });
    }
    if (Date.now() > entry.expiresAt) {
        await otpStoreDelete(key, db);
        return res.status(400).json({ ok: false, error: 'OTP expired' });
    }
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts > 5) {
        await otpStoreDelete(key, db);
        return res.status(429).json({ ok: false, error: 'Too many attempts' });
    }
    // Update attempt count in store
    await otpStoreSet(key, entry, db);

    if (entry.code !== String(code || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Invalid OTP' });
    }

    await otpStoreDelete(key, db);
    res.json({ ok: true });
});

app.get('/health', (_, res) => res.json({ status: 'ok', supabase: true, firestore: !!db }));

// ── /passcode — store & retrieve private-chats passcode in Firestore ──────────
// These are used as a server-backed fallback; client writes directly to Firestore too.
app.post('/passcode/save', async (req, res) => {
    const { uid, code } = req.body || {};
    if (!uid || !code || !/^\d{4}$/.test(code)) {
        return res.status(400).json({ ok: false, error: 'uid and 4-digit code required' });
    }
    if (!db) return res.status(503).json({ ok: false, error: 'Firestore unavailable' });
    try {
        await db.collection('privatePasscodes').doc(uid).set({ code, updatedAt: Date.now() });
        res.json({ ok: true });
    } catch (e) {
        console.error('[passcode/save]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/passcode/get', async (req, res) => {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false, error: 'uid required' });
    if (!db) return res.status(503).json({ ok: false, error: 'Firestore unavailable' });
    try {
        const snap = await db.collection('privatePasscodes').doc(uid).get();
        if (!snap.exists) return res.json({ ok: true, code: null });
        res.json({ ok: true, code: snap.data().code });
    } catch (e) {
        console.error('[passcode/get]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── /log-login — called by login.js after successful OTP verify ──────────────
// Writes to Supabase: login_logs + users_mirror upsert
// Does NOT require auth token — it's called from frontend before chat.html loads
app.post('/log-login', async (req, res) => {
    const { uid, email, displayName, photoURL, browser, os, deviceType,
            city, country, ipAddress, userAgent } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false });

    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !supaKey) return res.json({ ok: true, warn: 'Supabase not configured' });

    try {
        const { createClient } = require('@supabase/supabase-js');
        const supa = createClient(supaUrl, supaKey, { auth: { persistSession: false } });
        const now  = new Date().toISOString();

        // 1. Insert login log
        await supa.from('login_logs').insert({
            uid, email: email || '',
            ip_address:  ipAddress  || '',
            user_agent:  userAgent  || '',
            device_type: deviceType || 'desktop',
            os:          os         || '',
            browser:     browser    || '',
            city:        city       || '',
            country:     country    || '',
            is_suspicious: false,
            created_at: now,
        });

        // 2. Upsert users_mirror (sync profile + last_seen)
        await supa.from('users_mirror').upsert({
            uid,
            email:        email       || '',
            display_name: displayName || '',
            photo_url:    photoURL    || '',
            last_seen:    now,
            synced_at:    now,
        }, { onConflict: 'uid' });

        // 3. Insert into daily_active_users
        const today = now.slice(0, 10);
        await supa.from('daily_active_users')
            .upsert({ uid, active_date: today }, { onConflict: 'uid,active_date' });

        res.json({ ok: true });
    } catch (e) {
        console.error('[log-login]', e.message);
        res.json({ ok: false, error: e.message }); // don't crash login flow
    }
});

// ── ICE Servers endpoint — returns TURN credentials for WebRTC ──
// Supports Metered.ca API (set METERED_API_KEY env var) or falls back to free public servers
app.get('/ice-servers', async (req, res) => {
    const meteredKey = process.env.METERED_API_KEY;

    // If Metered API key is set, fetch time-limited credentials
    if (meteredKey) {
        try {
            const r = await fetch(`https://irwebdevelopers.metered.live/api/v1/turn/credentials?apiKey=${meteredKey}`);
            if (r.ok) {
                const servers = await r.json();
                return res.json({ iceServers: servers });
            }
        } catch (e) {
            console.warn('Metered TURN fetch failed:', e.message);
        }
    }

    // Fallback: reliable public TURN servers
    res.json({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            {
                urls: [
                    'turn:openrelay.metered.ca:80',
                    'turn:openrelay.metered.ca:443',
                    'turn:openrelay.metered.ca:443?transport=tcp',
                    'turns:openrelay.metered.ca:443'
                ],
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: ['turn:freestun.net:3478', 'turns:freestun.net:5349'],
                username: 'free',
                credential: 'free'
            }
        ]
    });
});


// ── Profile preview page — /p/:uid ───────────────────────────
// Returns HTML with Open Graph meta tags so WhatsApp/Telegram
// show a rich preview: profile photo + name + QR code.
// Real users opening in browser see the card and can add contact.
function escHtml(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

app.get('/p/:uid', async (req, res) => {
    const uid  = req.params.uid;
    const base = req.protocol + '://' + req.get('host');

    let name='EduChat User', username='', photoURL='';
    let addUrl = base + '/add?uid=' + encodeURIComponent(uid);

    try {
        if (db) {
            const snap = await db.collection('users').doc(uid).get();
            if (snap.exists) {
                const d  = snap.data();
                name     = d.name || d.displayName || name;
                username = d.username || (d.email||'').split('@')[0] || '';
                photoURL = d.photoURL || d.avatar || '';
                addUrl   = base + '/add?uid=' + encodeURIComponent(uid) + '&name=' + encodeURIComponent(name);
            }
        }
    } catch(e) { console.warn('[/p/:uid]', e.message); }

    const title   = escHtml(name + ' — EduChat');
    const desc    = escHtml(username ? 'Add ' + name + ' (@' + username + ') on EduChat' : 'Add ' + name + ' on EduChat');
    const ogImg   = escHtml(photoURL || base + '/icon-192.png');
    const qrSrc   = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(addUrl) + '&bgcolor=ffffff&color=111827&margin=10';
    const initial = escHtml((name||'E').charAt(0).toUpperCase());

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta property="og:type"        content="profile">
<meta property="og:url"         content="${escHtml(base+'/p/'+uid)}">
<meta property="og:title"       content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image"       content="${ogImg}">
<meta property="og:image:width"  content="400">
<meta property="og:image:height" content="400">
<meta property="og:site_name"   content="EduChat">
<meta name="twitter:card"        content="summary">
<meta name="twitter:title"       content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image"       content="${ogImg}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#1e293b;border-radius:20px;padding:36px 28px;max-width:360px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.avatar{width:96px;height:96px;border-radius:50%;object-fit:cover;border:3px solid #6366f1;margin-bottom:16px}
.av-fallback{width:96px;height:96px;border-radius:50%;background:#6366f1;display:inline-flex;align-items:center;justify-content:center;font-size:40px;font-weight:700;margin-bottom:16px;border:3px solid #818cf8}
h1{font-size:1.4rem;font-weight:700;margin-bottom:4px}
.uname{color:#94a3b8;font-size:.9rem;margin-bottom:20px}
.qr-wrap{background:#fff;border-radius:12px;padding:12px;display:inline-block;margin-bottom:20px}
.qr-wrap img{display:block;width:180px;height:180px}
.add-btn{display:block;background:#6366f1;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;font-size:1rem}
.add-btn:hover{background:#4f46e5}
.hint{color:#64748b;font-size:.75rem;margin-top:12px}
</style>
</head>
<body>
<div class="card">
  ${photoURL ? `<img class="avatar" src="${ogImg}" alt="${escHtml(name)}" onerror="this.style.display='none';document.getElementById('avf').style.display='inline-flex'">` : ''}
  <div class="av-fallback" id="avf" style="${photoURL?'display:none':''}"> ${initial}</div>
  <h1>${escHtml(name)}</h1>
  <div class="uname">${username ? '@'+escHtml(username) : 'EduChat'}</div>
  <div class="qr-wrap"><img src="${escHtml(qrSrc)}" alt="QR Code" width="180" height="180"></div>
  <a class="add-btn" href="${escHtml(addUrl)}">Add on EduChat</a>
  <p class="hint">Scan QR or tap button to add contact</p>
</div>
</body>
</html>`;

    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Cache-Control','public, max-age=300');
    res.send(html);
});


// ── Instagram oEmbed proxy ────────────────────────────────────
// Browser can't call Instagram oEmbed directly (CORS), so we proxy it here.
app.get('/instagram-embed', async (req, res) => {
    const url = req.query.url;
    if (!url || !/instagram\.com\/(p|reel|tv)\/[\w-]+/.test(url)) {
        return res.status(400).json({ error: 'Invalid Instagram URL' });
    }
    try {
        const oEmbedURL = `https://graph.facebook.com/v18.0/instagram_oembed?url=${encodeURIComponent(url)}&maxwidth=400&fields=thumbnail_url,html,title&access_token=${process.env.INSTAGRAM_TOKEN || ''}`;
        const response = await fetch(oEmbedURL);
        if (!response.ok) {
            // Fallback: return just the URL info without embed HTML
            return res.json({ thumbnailUrl: null, embedHtml: null, title: 'Instagram Reel' });
        }
        const data = await response.json();
        return res.json({
            thumbnailUrl: data.thumbnail_url || null,
            embedHtml:    data.html           || null,
            title:        data.title          || 'Instagram Reel',
        });
    } catch (err) {
        console.error('Instagram oEmbed error:', err.message);
        return res.json({ thumbnailUrl: null, embedHtml: null, title: 'Instagram Reel' });
    }
});

// ── Google Drive video proxy — streams Drive video to <video> tags ──
// Drive redirects + CORS blocks direct <video src> usage.
// This proxy fetches the Drive download URL server-side and streams bytes
// back to the client, forwarding Range headers for seek support.
app.get('/video-proxy', async (req, res) => {
    const fileId = req.query.id;
    if (!fileId || !/^[\w-]{10,}$/.test(fileId)) {
        return res.status(400).send('Missing or invalid file id');
    }

    // Drive direct download URL (server-side fetch avoids CORS + redirect issues)
    const driveURL = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

    try {
        const headers = { 'User-Agent': 'Mozilla/5.0' };
        // Forward Range header so video seeking works
        if (req.headers.range) headers['Range'] = req.headers.range;

        const driveRes = await fetch(driveURL, { headers, redirect: 'follow' });

        if (!driveRes.ok && driveRes.status !== 206) {
            return res.status(driveRes.status).send('Drive fetch failed');
        }

        // Forward relevant headers
        const ct = driveRes.headers.get('content-type') || 'video/mp4';
        res.setHeader('Content-Type', ct);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');

        const cl = driveRes.headers.get('content-length');
        if (cl) res.setHeader('Content-Length', cl);

        const cr = driveRes.headers.get('content-range');
        if (cr) res.setHeader('Content-Range', cr);

        res.status(driveRes.status === 206 ? 206 : 200);

        // Stream response body
        const reader = driveRes.body.getReader();
        const pump = async () => {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            res.write(Buffer.from(value));
            await pump();
        };
        await pump();
    } catch (err) {
        console.error('Video proxy error:', err.message);
        if (!res.headersSent) res.status(502).send('Video proxy error');
    }
});

// ── VAPID public key endpoint — clients read this instead of hardcoding ──
app.get('/vapid-public-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return res.status(503).json({ error: 'VAPID not configured' });
    res.json({ key });
});

// ── Firebase client config — safe to expose, served from env vars ──
app.get('/firebase-config', (req, res) => {
    const cfg = {
        apiKey:            process.env.FIREBASE_API_KEY,
        authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
        projectId:         process.env.FIREBASE_PROJECT_ID,
        storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId:             process.env.FIREBASE_APP_ID,
        measurementId:     process.env.FIREBASE_MEASUREMENT_ID,
    };
    if (!cfg.apiKey || !cfg.projectId) {
        return res.status(503).json({ error: 'Firebase client config not set in env' });
    }
    res.json(cfg);
});

// ── Multi-Provider AI proxy — Groq → Gemini → OpenRouter fallback ──
// Providers are tried in order; if one fails or hits rate limits, next is used.
// Set any/all of these env vars: GROQ_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY

async function tryGroq(groqMessages) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'llama-3.1-8b-instant', max_tokens: 1000, messages: groqMessages })
    });
    if (response.status === 429 || response.status === 503) return null; // rate limited, try next
    if (!response.ok) throw new Error(`Groq ${response.status}`);
    const data = await response.json();
    return { text: data.choices?.[0]?.message?.content || '...', provider: 'groq' };
}

async function tryGemini(messages, system) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    // Convert messages to Gemini format
    const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));
    const body = {
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: { maxOutputTokens: 1000 }
    };
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (response.status === 429 || response.status === 503) return null; // rate limited, try next
    if (!response.ok) throw new Error(`Gemini ${response.status}`);
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '...';
    return { text, provider: 'gemini' };
}

async function tryOpenRouter(groqMessages) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': process.env.APP_URL || 'https://educhat.app',
            'X-Title': 'EduChat AI'
        },
        body: JSON.stringify({ model: 'meta-llama/llama-3.2-3b-instruct:free', max_tokens: 1000, messages: groqMessages })
    });
    if (response.status === 429 || response.status === 503) return null;
    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const data = await response.json();
    return { text: data.choices?.[0]?.message?.content || '...', provider: 'openrouter' };
}

app.post('/api/ai-chat', async (req, res) => {
    const { messages, system } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array required' });
    }

    const groqMessages = [{ role: 'system', content: system || '' }, ...messages];
    const errors = [];

    // Try providers in order: Groq (fastest) → Gemini (high limits) → OpenRouter (free fallback)
    const providers = [
        () => tryGroq(groqMessages),
        () => tryGemini(messages, system),
        () => tryOpenRouter(groqMessages)
    ];

    for (const tryProvider of providers) {
        try {
            const result = await tryProvider();
            if (result) {
                console.log(`[AI] Responded via ${result.provider}`);
                return res.json({ text: result.text });
            }
        } catch (err) {
            console.warn(`[AI] Provider error: ${err.message}`);
            errors.push(err.message);
        }
    }

    // All providers failed or not configured
    const noKeys = !process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY;
    if (noKeys) {
        return res.status(503).json({ error: 'AI not configured. Set GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY.' });
    }
    console.error('[AI] All providers failed:', errors);
    res.status(503).json({ error: 'AI temporarily unavailable. Please try again.' });
});

// ── /api/send-report — About page issue report → admin email ──
// Called from about.html when user submits a report.
// Uses Gmail SMTP (primary) → Brevo HTTP API (fallback) — same as OTP emails.
// Required env vars: SMTP_USER + SMTP_PASS (Gmail App Password) — same as OTP setup.
// Report destination: ADMIN_REPORT_EMAIL env var (required). Same BREVO_API_KEY as OTP.
app.post('/api/send-report', async (req, res) => {
    const {
        type        = 'Other',
        name        = '(not provided)',
        userEmail   = '(not provided)',
        description,
        timestamp   = new Date().toISOString(),
        page        = '',
        toEmail     = ''
    } = req.body || {};

    if (!description || description.trim().length < 5) {
        return res.status(400).json({ ok: false, error: 'Description is required' });
    }

    const adminEmail = process.env.ADMIN_REPORT_EMAIL;
    const fromEmail  = process.env.SMTP_FROM || 'noreply@educhat.app';

    if (!adminEmail) {
        console.warn('[send-report] ADMIN_REPORT_EMAIL not set');
        return res.status(503).json({ ok: false, error: 'Report email address not configured' });
    }

    const subject     = `[EduChat Report] ${type}`;
    const htmlContent = `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:10px;">
            <div style="background:#4f8cff;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
                <h2 style="color:#fff;margin:0;font-size:18px;">🚩 EduChat Issue Report</h2>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:8px 0;color:#64748b;width:130px;">Issue Type</td><td style="padding:8px 0;font-weight:600;color:#1e293b;">${escHtml(type)}</td></tr>
                <tr><td style="padding:8px 0;color:#64748b;">Reporter Name</td><td style="padding:8px 0;color:#1e293b;">${escHtml(name)}</td></tr>
                <tr><td style="padding:8px 0;color:#64748b;">Reporter Email</td><td style="padding:8px 0;color:#1e293b;">${escHtml(userEmail)}</td></tr>
                <tr><td style="padding:8px 0;color:#64748b;">Time</td><td style="padding:8px 0;color:#1e293b;">${escHtml(timestamp)}</td></tr>
                <tr><td style="padding:8px 0;color:#64748b;">Page</td><td style="padding:8px 0;color:#1e293b;">${escHtml(page)}</td></tr>
            </table>
            <div style="margin-top:20px;">
                <div style="font-size:13px;color:#64748b;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">Description</div>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;font-size:14px;color:#334155;white-space:pre-wrap;line-height:1.6;">${escHtml(description.trim())}</div>
            </div>
            <p style="margin-top:20px;font-size:12px;color:#94a3b8;">Sent from EduChat About Page · ${escHtml(timestamp)}</p>
        </div>`;
    const textContent =
`EduChat Issue Report
====================
Type    : ${type}
Name    : ${name}
Email   : ${userEmail}
Time    : ${timestamp}
Page    : ${page}

Description:
${description.trim()}

---
Sent from EduChat About Page`;

    try {
        const result = await sendReportEmail({
            to: adminEmail, subject, textContent, htmlContent,
            replyTo: userEmail !== '(not provided)' ? userEmail : undefined
        });

        if (!result.sent) {
            console.error('[send-report] Email failed:', result.reason);
            return res.status(503).json({ ok: false, error: 'Email delivery failed: ' + result.reason });
        }

        console.log(`[send-report] Report "${type}" from "${name}" → sent to ${adminEmail}`);

        // Also log report to Firestore for record-keeping (non-blocking)
        if (db) {
            db.collection('reports').add({
                type, name, userEmail, description: description.trim(),
                page, timestamp, sentTo: adminEmail,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            }).catch(e => console.warn('[send-report] Firestore log failed:', e.message));
        }

        res.json({ ok: true, message: 'Report sent successfully' });

    } catch (err) {
        console.error('[send-report] Error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── Static files — registered after API routes so dynamic endpoints win ──
// ── TOTP (Google Authenticator) ───────────────────────────────
// Uses node's built-in crypto — no extra npm packages needed.
// Implements RFC 6238 TOTP with SHA-1, 30s step, 6 digits.

function _base32Decode(s) {
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    s = s.toUpperCase().replace(/=+$/, '');
    let bits = 0, val = 0;
    const out = [];
    for (const c of s) {
        val = (val << 5) | alpha.indexOf(c);
        bits += 5;
        if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); }
    }
    return Buffer.from(out);
}

function _base32Encode(buf) {
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, val = 0, out = '';
    for (const b of buf) {
        val = (val << 8) | b; bits += 8;
        while (bits >= 5) { bits -= 5; out += alpha[(val >> bits) & 31]; }
    }
    if (bits) out += alpha[(val << (5 - bits)) & 31];
    while (out.length % 8) out += '=';
    return out;
}

function _totpCode(secret, step) {
    const key     = _base32Decode(secret);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac    = crypto.createHmac('sha1', key).update(counter).digest();
    const offset  = hmac[hmac.length - 1] & 0x0f;
    const code    = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return String(code).padStart(6, '0');
}

function _verifyTotp(secret, token) {
    const step = Math.floor(Date.now() / 30000);
    // Allow ±1 step (30s window)
    for (const s of [step - 1, step, step + 1]) {
        if (_totpCode(secret, s) === token) return true;
    }
    return false;
}

// POST /totp/setup — generates a new TOTP secret for a user
app.post('/totp/setup', async (req, res) => {
    const { uid } = req.body;
    if (!uid || !db) return res.status(400).json({ ok: false, error: 'uid required' });

    const secret  = _base32Encode(crypto.randomBytes(20));
    const issuer  = 'EduChat';
    const snap    = await db.collection('users').doc(uid).get().catch(() => null);
    const email   = snap?.data()?.email || uid;
    const otpauth = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

    // Store secret temporarily (unverified) — confirmed on first verify
    await db.collection('users').doc(uid).update({
        totpSecretPending: secret,
        totpEnabled: false
    });

    res.json({ ok: true, secret, otpauth });
});

// POST /totp/verify — verify a TOTP code; if ok, mark 2FA as enabled
app.post('/totp/verify', async (req, res) => {
    const { uid, token, confirmSetup } = req.body;
    if (!uid || !token || !db) return res.status(400).json({ ok: false, error: 'uid + token required' });

    const snap   = await db.collection('users').doc(uid).get().catch(() => null);
    const data   = snap?.data() || {};
    const secret = confirmSetup
        ? data.totpSecretPending
        : data.totpSecret;

    if (!secret) return res.status(400).json({ ok: false, error: 'TOTP not set up' });

    const valid = _verifyTotp(secret, String(token).trim());
    if (!valid) return res.json({ ok: false, error: 'Invalid code' });

    if (confirmSetup) {
        // First successful verify — promote pending secret to active
        await db.collection('users').doc(uid).update({
            totpSecret:        secret,
            totpSecretPending: admin.firestore.FieldValue.delete(),
            totpEnabled:       true
        });
    }

    res.json({ ok: true });
});

// POST /totp/disable — disable TOTP for a user (requires a valid token)
app.post('/totp/disable', async (req, res) => {
    const { uid, token } = req.body;
    if (!uid || !token || !db) return res.status(400).json({ ok: false });

    const snap   = await db.collection('users').doc(uid).get().catch(() => null);
    const secret = snap?.data()?.totpSecret;
    if (!secret) return res.json({ ok: false, error: 'TOTP not enabled' });
    if (!_verifyTotp(secret, String(token).trim())) return res.json({ ok: false, error: 'Invalid code' });

    await db.collection('users').doc(uid).update({
        totpSecret:  admin.firestore.FieldValue.delete(),
        totpEnabled: false
    });
    res.json({ ok: true });
});


app.use(express.static(path.join(__dirname)));

// ── SPA catch-all — ONLY for navigation requests, not missing assets ──
// This prevents /sw.js, /manifest.json, and module JS from returning chat.html.
app.use((req, res, next) => {
    // Only handle GET requests that look like page navigations (Accept: text/html)
    const acceptsHtml = (req.headers.accept || '').includes('text/html');
    if (req.method === 'GET' && acceptsHtml) {
        return res.sendFile(path.join(__dirname, 'chat.html'));
    }
    next();
});

// ── Final 404 for anything else (missing JS/CSS/JSON assets) ──

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ── Cron: delete expired messages ────────────────────────────
// Hit this from an external cron job (e.g. cron-job.org) every 5 min:
//   GET https://yourapp.com/cron/delete-expired?secret=YOUR_CRON_SECRET
async function _deleteExpiredMessages() {
    if (!db) return { deleted: 0 };
    const now     = admin.firestore.Timestamp.now();
    let   deleted = 0;
    const cols    = ['messages', 'groupMessages'];
    for (const col of cols) {
        let snap;
        try {
            snap = await db.collection(col)
                .where('expiresAt', '<=', now)
                .limit(200)
                .get();
        } catch(e) { console.warn('[cron]', col, e.message); continue; }
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        if (!snap.empty) { await batch.commit(); deleted += snap.size; }
    }
    return { deleted };
}

app.get('/cron/delete-expired', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.query.secret !== secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const result = await _deleteExpiredMessages();
        console.log('[cron] Deleted expired messages:', result.deleted);
        res.json({ ok: true, ...result });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Also run on server startup and every 5 min internally
setInterval(() => _deleteExpiredMessages().catch(e => console.warn('[expiry cron]', e.message)), 5 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`EduChat server running on port ${PORT}`);
});
