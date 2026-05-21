// ============================================================
//  adminRoutes.js  —  EduChat Admin API  (V7)
//
//  Auth flow:
//    1. Firebase ID token verified (verifyToken)
//    2. UID looked up in Supabase admin_roles table (requireAdmin)
//
//  Data reads  → Supabase (users_mirror, login_logs, sessions,
//                message_stats, feature_stats, daily_active_users,
//                reports, admin_alerts, broadcasts, audit_logs,
//                feature_flags, ip_blacklist, admin_notes, admin_roles)
//
//  User actions → Firestore (source of truth for app) +
//                 Supabase  (mirrors / audit trail)
// ============================================================

const express   = require('express');
const router    = express.Router();
const https     = require('https');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase client (service role — bypasses RLS) ────────────
function getSupabase() {
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY,
        { auth: { persistSession: false } }
    );
}

// ── Firestore + Firebase Admin from app.locals ────────────────
function getDB(req)       { return req.app.locals.db; }
function getAdminSDK(req) { return req.app.locals.adminSDK; }

const PAGE_SIZE = 50;

// ══════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════════════════════

/** 1. Verify Firebase ID token */
async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing token' });
    }
    try {
        const adminSDK    = getAdminSDK(req);
        const decoded     = await adminSDK.auth().verifyIdToken(authHeader.slice(7));
        req.adminToken    = decoded;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

/** 2. Check Supabase admin_roles — this is the single source of truth for admins */
async function requireAdmin(req, res, next) {
    const uid = req.adminToken?.uid;
    if (!uid) return res.status(403).json({ error: 'Forbidden' });
    try {
        const supa = getSupabase();
        const { data, error } = await supa
            .from('admin_roles')
            .select('*')
            .eq('uid', uid)
            .single();

        if (error || !data) return res.status(403).json({ error: 'Not an admin' });

        req.adminDoc = data;

        // Update last_active in background
        supa.from('admin_roles')
            .update({ last_active: new Date().toISOString() })
            .eq('uid', uid)
            .then(() => {}).catch(() => {});

        next();
    } catch (e) {
        return res.status(403).json({ error: 'Admin check failed' });
    }
}

const auth = [verifyToken, requireAdmin];

// ── Audit log writer → both Supabase and Firestore ───────────
async function audit(req, action, targetType, targetId, details = {}) {
    const supa    = getSupabase();
    const db      = getDB(req);
    const entry   = {
        admin_uid:   req.adminToken.uid,
        admin_email: req.adminToken.email || '',
        action,
        target_type: targetType || '',
        target_id:   String(targetId || ''),
        details,
        ip_address:  req.ip || req.headers['x-forwarded-for'] || '',
        created_at:  new Date().toISOString(),
    };

    // Supabase audit_logs
    supa.from('audit_logs').insert(entry).then(() => {}).catch(() => {});

    // Firestore _auditLog (best effort)
    if (db) {
        db.collection('_auditLog').add(entry).catch(() => {});
    }
}

// ══════════════════════════════════════════════════════════════
//  STATS — OVERVIEW  (Supabase + Firestore fallback)
// ══════════════════════════════════════════════════════════════
router.get('/stats/overview', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    try {
        // Total users
        const { count: totalUsers } = await supa
            .from('users_mirror').select('*', { count: 'exact', head: true });

        // Banned count
        const { count: bannedUsers } = await supa
            .from('users_mirror').select('*', { count: 'exact', head: true })
            .eq('is_banned', true);

        // Active today
        const todayStr = new Date().toISOString().slice(0, 10);
        const { count: activeToday } = await supa
            .from('daily_active_users').select('*', { count: 'exact', head: true })
            .eq('active_date', todayStr);

        // Messages today
        const { data: todayStats } = await supa
            .from('message_stats')
            .select('total_messages')
            .eq('stat_date', todayStr);
        const messagesToday = (todayStats || []).reduce((s, r) => s + (r.total_messages || 0), 0);

        // Pending reports
        const { count: pendingReports } = await supa
            .from('reports').select('*', { count: 'exact', head: true })
            .eq('status', 'pending');

        // Active sessions
        const { count: activeSessions } = await supa
            .from('sessions').select('*', { count: 'exact', head: true })
            .eq('is_active', true).eq('force_logout', false);

        // Maintenance mode from Supabase feature_flags
        const { data: maintFlag } = await supa
            .from('feature_flags').select('value').eq('key', 'maintenance_mode').single();
        const maintenanceMode = maintFlag?.value === true;

        res.json({
            totalUsers:    totalUsers    || 0,
            bannedUsers:   bannedUsers   || 0,
            activeToday:   activeToday   || 0,
            messagesToday: messagesToday || 0,
            pendingReports:pendingReports|| 0,
            activeSessions:activeSessions|| 0,
            maintenanceMode,
        });
    } catch (e) {
        // Fallback to Firestore if Supabase fails
        try {
            const usersSnap    = await db.collection('users').get();
            const bannedSnap   = await db.collection('users').where('isBanned', '==', true).get();
            const since24h     = new Date(Date.now() - 86400000).toISOString();
            const activeSnap   = await db.collection('users').where('lastSeen', '>=', since24h).get();
            const todayStart   = new Date(); todayStart.setHours(0,0,0,0);
            const msgsSnap     = await db.collection('messages').where('timestamp', '>=', todayStart.toISOString()).get();
            const gMsgsSnap    = await db.collection('groupMessages').where('timestamp', '>=', todayStart.toISOString()).get();
            const reportsSnap  = await db.collection('_reports').where('status', '==', 'pending').get();
            const sessSnap     = await db.collection('_sessions').where('is_active', '==', true).get();
            const flagSnap     = await db.collection('_flags').doc('maintenance_mode').get();
            res.json({
                totalUsers:    usersSnap.size,
                bannedUsers:   bannedSnap.size,
                activeToday:   activeSnap.size,
                messagesToday: msgsSnap.size + gMsgsSnap.size,
                pendingReports:reportsSnap.size,
                activeSessions:sessSnap.size,
                maintenanceMode: flagSnap.exists ? !!flagSnap.data().value : false,
            });
        } catch (e2) {
            res.status(500).json({ error: e2.message });
        }
    }
});

// ══════════════════════════════════════════════════════════════
//  STATS — MESSAGES (last 30 days from Supabase)
// ══════════════════════════════════════════════════════════════
router.get('/stats/messages', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data, error } = await supa
            .from('message_stats_daily')   // view that sums hours into days
            .select('*')
            .order('stat_date', { ascending: false })
            .limit(30);
        if (error) throw error;
        res.json(data || []);
    } catch (e) {
        // Fallback: Firestore _dailyStats
        try {
            const db   = getDB(req);
            const snap = await db.collection('_dailyStats').orderBy('stat_date', 'desc').limit(30).get();
            res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        } catch (e2) {
            res.json([]);
        }
    }
});

// ══════════════════════════════════════════════════════════════
//  STATS — DAU (daily active users, last 30 days)
// ══════════════════════════════════════════════════════════════
router.get('/stats/dau', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data, error } = await supa
            .from('dau_counts')   // view: SELECT active_date, COUNT(uid) as user_count
            .select('*')
            .order('active_date', { ascending: false })
            .limit(30);
        if (error) throw error;
        if (data && data.length > 0) return res.json(data);
        throw new Error('empty');
    } catch (e) {
        // Fallback: compute from Firestore users.lastSeen
        try {
            const db     = getDB(req);
            const result = [];
            for (let i = 6; i >= 0; i--) {
                const d  = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
                const d2 = new Date(d); d2.setHours(23,59,59,999);
                const s  = await db.collection('users')
                    .where('lastSeen', '>=', d.toISOString())
                    .where('lastSeen', '<=', d2.toISOString()).get();
                result.push({ active_date: d.toISOString().slice(0,10), user_count: s.size });
            }
            res.json(result);
        } catch (e2) {
            res.json([]);
        }
    }
});

// ══════════════════════════════════════════════════════════════
//  STATS — FEATURES (last 30 days)
// ══════════════════════════════════════════════════════════════
router.get('/stats/features', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data, error } = await supa
            .from('feature_stats')
            .select('*')
            .order('stat_date', { ascending: false })
            .limit(30);
        if (error) throw error;
        res.json(data || []);
    } catch (e) {
        try {
            const db   = getDB(req);
            const snap = await db.collection('_featureStats').orderBy('stat_date', 'desc').limit(30).get();
            res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        } catch (e2) {
            res.json([]);
        }
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — LIST (paginated, search, filter)
//  Reads from Supabase users_mirror
// ══════════════════════════════════════════════════════════════
router.get('/users', ...auth, async (req, res) => {
    const supa   = getSupabase();
    const page   = parseInt(req.query.page) || 0;
    const search = (req.query.search || '').trim();
    const filter = req.query.filter || '';

    try {
        let query = supa
            .from('users_mirror')
            .select('uid, email, display_name, photo_url, is_banned, ban_reason, totp_enabled, last_seen, created_at, group_count, friend_count', { count: 'exact' })
            .eq('is_deleted', false)
            .order('created_at', { ascending: false });

        if (filter === 'banned')  query = query.eq('is_banned', true);
        if (filter === 'totp')    query = query.eq('totp_enabled', true);
        if (filter === 'no_totp') query = query.eq('totp_enabled', false);

        if (search) {
            query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%,uid.ilike.%${search}%`);
        }

        const { data, error, count } = await query
            .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

        if (error) throw error;
        res.json({ users: data || [], total: count || 0 });
    } catch (e) {
        // Fallback: Firestore
        try {
            const db     = getDB(req);
            let   query2 = db.collection('users').orderBy('createdAt', 'desc');
            if (filter === 'banned') query2 = query2.where('isBanned', '==', true);
            if (filter === 'totp')   query2 = query2.where('totpEnabled', '==', true);
            const snap   = await query2.limit(500).get();
            let   users  = snap.docs.map(d => {
                const u = d.data();
                return {
                    uid: d.id, display_name: u.displayName||'', email: u.email||'',
                    photo_url: u.photoURL||'', is_banned: !!u.isBanned,
                    ban_reason: u.banReason||'', totp_enabled: !!u.totpEnabled,
                    last_seen: u.lastSeen||u.createdAt||'', created_at: u.createdAt||'',
                    group_count: (u.groups||[]).length, friend_count: (u.friends||[]).length,
                };
            });
            if (search) {
                const s = search.toLowerCase();
                users = users.filter(u =>
                    u.display_name.toLowerCase().includes(s) ||
                    u.email.toLowerCase().includes(s) ||
                    u.uid.toLowerCase().includes(s)
                );
            }
            if (filter === 'no_totp') users = users.filter(u => !u.totp_enabled);
            const total  = users.length;
            const sliced = users.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
            res.json({ users: sliced, total });
        } catch (e2) {
            res.status(500).json({ error: e2.message });
        }
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — SINGLE PROFILE
//  Primary: Supabase users_mirror + sessions + admin_notes
//  Fallback: Firestore
// ══════════════════════════════════════════════════════════════
router.get('/users/:uid', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    const uid  = req.params.uid;
    try {
        const { data: u, error } = await supa
            .from('users_mirror').select('*').eq('uid', uid).single();
        if (error || !u) throw new Error('not found in mirror');

        const { data: sessions } = await supa
            .from('sessions').select('*')
            .eq('uid', uid).eq('is_active', true)
            .order('last_active', { ascending: false });

        const { data: notes } = await supa
            .from('admin_notes').select('*')
            .eq('target_uid', uid)
            .order('created_at', { ascending: false })
            .limit(20);

        res.json({
            user: {
                uid,
                display_name: u.display_name  || '',
                email:        u.email         || '',
                photo_url:    u.photo_url     || '',
                is_banned:    !!u.is_banned,
                ban_reason:   u.ban_reason    || '',
                ban_expires:  u.ban_expires_at|| null,
                totp_enabled: !!u.totp_enabled,
                last_seen:    u.last_seen     || '',
                created_at:   u.created_at   || '',
                friend_count: u.friend_count  || 0,
                group_count:  u.group_count   || 0,
            },
            sessions: sessions || [],
            notes:    notes    || [],
        });
    } catch (e) {
        // Fallback: Firestore
        try {
            const snap = await db.collection('users').doc(uid).get();
            if (!snap.exists) return res.status(404).json({ error: 'User not found' });
            const u = snap.data();
            const sessSnap  = await db.collection('_sessions').where('uid', '==', uid).where('is_active', '==', true).get();
            const notesSnap = await db.collection('_adminNotes').where('uid', '==', uid).orderBy('created_at', 'desc').limit(20).get();
            res.json({
                user: {
                    uid,
                    display_name: u.displayName||'', email: u.email||'',
                    photo_url:    u.photoURL||'',    is_banned:    !!u.isBanned,
                    ban_reason:   u.banReason||'',   ban_expires:  u.banExpires||null,
                    totp_enabled: !!u.totpEnabled,   last_seen:    u.lastSeen||'',
                    created_at:   u.createdAt||'',   friend_count: (u.friends||[]).length,
                    group_count:  (u.groups||[]).length,
                },
                sessions: sessSnap.docs.map(d => ({ id: d.id, ...d.data() })),
                notes:    notesSnap.docs.map(d => ({ id: d.id, ...d.data() })),
            });
        } catch (e2) {
            res.status(500).json({ error: e2.message });
        }
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — BAN
//  → Firestore users doc + Supabase users_mirror
// ══════════════════════════════════════════════════════════════
router.post('/users/:uid/ban', ...auth, async (req, res) => {
    const supa   = getSupabase();
    const db     = getDB(req);
    const uid    = req.params.uid;
    const reason = req.body.reason || 'Violation of terms';
    const expiry = req.body.expiresAt || null;
    const now    = new Date().toISOString();
    try {
        // Firestore
        await db.collection('users').doc(uid).update({
            isBanned:   true,
            banReason:  reason,
            banExpires: expiry,
            bannedAt:   now,
            bannedBy:   req.adminToken.uid,
        });

        // Supabase mirror
        await supa.from('users_mirror').upsert({
            uid,
            is_banned:     true,
            ban_reason:    reason,
            ban_expires_at:expiry,
            banned_by:     req.adminToken.uid,
            banned_at:     now,
            synced_at:     now,
        }, { onConflict: 'uid' });

        await audit(req, 'ban_user', 'user', uid, { reason, expiry });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — UNBAN
// ══════════════════════════════════════════════════════════════
router.post('/users/:uid/unban', ...auth, async (req, res) => {
    const supa     = getSupabase();
    const db       = getDB(req);
    const adminSDK = getAdminSDK(req);
    const uid      = req.params.uid;
    const now      = new Date().toISOString();
    try {
        await db.collection('users').doc(uid).update({
            isBanned:   false,
            banReason:  adminSDK.firestore.FieldValue.delete(),
            banExpires: adminSDK.firestore.FieldValue.delete(),
        });

        await supa.from('users_mirror').upsert({
            uid, is_banned: false, ban_reason: null,
            ban_expires_at: null, banned_by: null, banned_at: null,
            synced_at: now,
        }, { onConflict: 'uid' });

        await audit(req, 'unban_user', 'user', uid);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — DELETE
// ══════════════════════════════════════════════════════════════
router.delete('/users/:uid', ...auth, async (req, res) => {
    const supa     = getSupabase();
    const db       = getDB(req);
    const adminSDK = getAdminSDK(req);
    const uid      = req.params.uid;
    try {
        // Firebase Auth
        try { await adminSDK.auth().deleteUser(uid); } catch(e) {}

        // Firestore user doc
        await db.collection('users').doc(uid).delete();

        // Firestore messages (best effort)
        const mSnap = await db.collection('messages').where('senderUID', '==', uid).limit(200).get();
        const batch = db.batch();
        mSnap.docs.forEach(d => batch.delete(d.ref));
        if (!mSnap.empty) await batch.commit();

        // Supabase — mark as deleted
        await supa.from('users_mirror').upsert({
            uid, is_deleted: true, synced_at: new Date().toISOString(),
        }, { onConflict: 'uid' });

        await audit(req, 'delete_user', 'user', uid);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — FORCE LOGOUT
// ══════════════════════════════════════════════════════════════
router.post('/users/:uid/force-logout', ...auth, async (req, res) => {
    const supa     = getSupabase();
    const db       = getDB(req);
    const adminSDK = getAdminSDK(req);
    const uid      = req.params.uid;
    const now      = new Date().toISOString();
    try {
        // Revoke Firebase tokens
        await adminSDK.auth().revokeRefreshTokens(uid);

        // Firestore sessions
        const snap = await db.collection('_sessions').where('uid', '==', uid).where('is_active', '==', true).get();
        const batch = db.batch();
        snap.docs.forEach(d => batch.update(d.ref, { is_active: false, terminated_at: now, terminated_by: 'admin' }));
        if (!snap.empty) await batch.commit();

        // Supabase sessions
        await supa.from('sessions')
            .update({ is_active: false, force_logout: true, logged_out_at: now })
            .eq('uid', uid).eq('is_active', true);

        await audit(req, 'force_logout', 'user', uid);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — RESET TOTP
// ══════════════════════════════════════════════════════════════
router.post('/users/:uid/reset-totp', ...auth, async (req, res) => {
    const supa     = getSupabase();
    const db       = getDB(req);
    const adminSDK = getAdminSDK(req);
    const uid      = req.params.uid;
    try {
        await db.collection('users').doc(uid).update({
            totpEnabled:       false,
            totpSecret:        adminSDK.firestore.FieldValue.delete(),
            totpSecretPending: adminSDK.firestore.FieldValue.delete(),
        });

        await supa.from('users_mirror').upsert({
            uid, totp_enabled: false, synced_at: new Date().toISOString(),
        }, { onConflict: 'uid' });

        await audit(req, 'reset_totp', 'user', uid);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — SEND IN-APP ALERT
//  → Firestore _userAlerts + Supabase admin_alerts
// ══════════════════════════════════════════════════════════════
router.post('/users/:uid/send-alert', ...auth, async (req, res) => {
    const supa      = getSupabase();
    const db        = getDB(req);
    const uid       = req.params.uid;
    const { title, message, alertType } = req.body;
    const now       = new Date().toISOString();
    try {
        // Firestore (app reads from here)
        await db.collection('_userAlerts').add({
            uid, title: title||'Admin Notice', message: message||'',
            alert_type: alertType||'info', read: false, created_at: now,
        });

        // Supabase admin_alerts
        await supa.from('admin_alerts').insert({
            target_uid: uid, title: title||'Admin Notice', message: message||'',
            alert_type: alertType||'info', sent_by: req.adminToken.uid,
            is_seen: false, created_at: now,
        });

        await audit(req, 'send_alert', 'user', uid, { title, alertType });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — SEND EMAIL (via Brevo)
// ══════════════════════════════════════════════════════════════
async function sendEmailViaBrevo({ to, subject, text }) {
    const apiKey = process.env.BREVO_API_KEY;
    const from   = process.env.SMTP_FROM || 'noreply@educhat.app';
    if (!apiKey) throw new Error('BREVO_API_KEY not configured');
    const bodyStr = JSON.stringify({
        sender:      { email: from },
        to:          [{ email: to }],
        subject,
        textContent: text,
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">${text.replace(/\n/g,'<br>')}</div>`,
    });
    return new Promise((resolve, reject) => {
        const rq = https.request({
            hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
            headers: {
                'Content-Type': 'application/json', 'api-key': apiKey,
                'Content-Length': Buffer.byteLength(bodyStr),
            },
        }, (rs) => {
            let data = '';
            rs.on('data', c => data += c);
            rs.on('end', () => {
                if (rs.statusCode >= 200 && rs.statusCode < 300) resolve({ ok: true });
                else reject(new Error(`Brevo error ${rs.statusCode}: ${data}`));
            });
        });
        rq.on('error', reject);
        rq.write(bodyStr);
        rq.end();
    });
}

router.post('/users/:uid/send-email', ...auth, async (req, res) => {
    const db              = getDB(req);
    const uid             = req.params.uid;
    const { subject, body } = req.body;
    try {
        const userSnap = await db.collection('users').doc(uid).get();
        if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
        const email = userSnap.data().email;
        if (!email) return res.status(400).json({ error: 'User has no email' });
        await sendEmailViaBrevo({ to: email, subject: subject||'(no subject)', text: body||'' });
        await audit(req, 'send_email', 'user', uid, { subject });
        res.json({ ok: true, sentTo: email });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — ADD ADMIN NOTE → Supabase admin_notes + Firestore
// ══════════════════════════════════════════════════════════════
router.post('/users/:uid/note', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    const uid  = req.params.uid;
    const note = req.body.note || '';
    const now  = new Date().toISOString();
    try {
        await supa.from('admin_notes').insert({
            target_uid: uid, note, written_by: req.adminToken.uid, created_at: now,
        });
        // Firestore backup
        db.collection('_adminNotes').add({
            uid, note, admin_uid: req.adminToken.uid,
            admin_email: req.adminToken.email||'', created_at: now,
        }).catch(() => {});
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  USERS — EXPORT CSV
// ══════════════════════════════════════════════════════════════
router.get('/users/export', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data } = await supa
            .from('users_mirror')
            .select('uid,email,display_name,is_banned,totp_enabled,last_seen,created_at')
            .eq('is_deleted', false)
            .order('created_at', { ascending: false });
        const rows = [['UID','Email','DisplayName','IsBanned','TotpEnabled','LastSeen','CreatedAt']];
        (data||[]).forEach(u => rows.push([u.uid,u.email||'',u.display_name||'',u.is_banned,u.totp_enabled,u.last_seen||'',u.created_at||'']));
        const csv = rows.map(r => r.map(f => `"${String(f).replace(/"/g,'""')}"`).join(',')).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
        res.send(csv);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  REPORTS — read from Supabase, actions write to Supabase
// ══════════════════════════════════════════════════════════════
router.get('/reports', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data, error } = await supa
            .from('pending_reports_view')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(200);
        if (error) throw error;
        res.json(data || []);
    } catch (e) {
        // Fallback: Firestore
        try {
            const db   = getDB(req);
            const snap = await db.collection('_reports').orderBy('created_at', 'desc').limit(200).get();
            const reports = await Promise.all(snap.docs.map(async d => {
                const r = d.data();
                let reporter_name='', target_name='', target_is_banned=false;
                try { const rs = await db.collection('users').doc(r.reporter_uid).get(); reporter_name = rs.data()?.displayName||rs.data()?.email||''; } catch(e){}
                try { const ts = await db.collection('users').doc(r.target_uid).get(); target_name = ts.data()?.displayName||ts.data()?.email||''; target_is_banned = !!ts.data()?.isBanned; } catch(e){}
                return { id: d.id, ...r, reporter_name, target_name, target_is_banned };
            }));
            res.json(reports);
        } catch (e2) {
            res.status(500).json({ error: e2.message });
        }
    }
});

router.post('/reports/:id/action', ...auth, async (req, res) => {
    const supa   = getSupabase();
    const id     = req.params.id;
    const action = req.body.action; // 'actioned' | 'dismissed'
    const now    = new Date().toISOString();
    try {
        await supa.from('reports').update({
            status: action, reviewed_by: req.adminToken.uid, reviewed_at: now,
        }).eq('id', id);

        // Also update Firestore
        const db = getDB(req);
        db.collection('_reports').doc(String(id)).update({ status: action, reviewed_by: req.adminToken.uid, reviewed_at: now }).catch(() => {});

        await audit(req, 'report_action', 'report', id, { action });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  MESSAGES — SEARCH (Firestore — content lives there)
// ══════════════════════════════════════════════════════════════
router.get('/messages/search', ...auth, async (req, res) => {
    const db = getDB(req);
    const q  = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.json([]);
    try {
        const results = [];
        const dmSnap  = await db.collection('messages').orderBy('timestamp', 'desc').limit(500).get();
        dmSnap.docs.forEach(d => {
            const m = d.data();
            if ((m.text||m.content||'').toLowerCase().includes(q)) {
                results.push({ id:d.id, sender_uid:m.senderUID||'', sender_name:m.senderName||m.senderUID||'', content:m.text||m.content||'', chat_type:'direct', chat_id:m.chatId||m.conversationId||'', created_at:m.timestamp||'' });
            }
        });
        const gmSnap = await db.collection('groupMessages').orderBy('timestamp', 'desc').limit(500).get();
        gmSnap.docs.forEach(d => {
            const m = d.data();
            if ((m.text||m.content||'').toLowerCase().includes(q)) {
                results.push({ id:d.id, sender_uid:m.senderUID||'', sender_name:m.senderName||m.senderUID||'', content:m.text||m.content||'', chat_type:'group', chat_id:m.groupId||m.chatId||'', created_at:m.timestamp||'' });
            }
        });
        results.sort((a,b)=> b.created_at > a.created_at ? 1 : -1);
        res.json(results.slice(0,50));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  SECURITY — LOGIN LOGS (Supabase)
// ══════════════════════════════════════════════════════════════
router.get('/security/login-logs', ...auth, async (req, res) => {
    const supa    = getSupabase();
    const page    = parseInt(req.query.page) || 0;
    const suspOnly = req.query.suspicious === 'true';
    try {
        let query = supa
            .from('login_logs')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false });
        if (suspOnly) query = query.eq('is_suspicious', true);
        const { data, error, count } = await query
            .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
        if (error) throw error;
        res.json({ logs: data||[], total: count||0 });
    } catch (e) {
        // Fallback Firestore
        try {
            const db   = getDB(req);
            let q2     = db.collection('_loginLogs').orderBy('created_at', 'desc');
            if (suspOnly) q2 = q2.where('is_suspicious', '==', true);
            const snap = await q2.limit(500).get();
            const all  = snap.docs.map(d => ({ id:d.id, ...d.data() }));
            const logs = all.slice(page*PAGE_SIZE, (page+1)*PAGE_SIZE);
            res.json({ logs, total: all.length });
        } catch (e2) {
            res.json({ logs:[], total:0 });
        }
    }
});

// ══════════════════════════════════════════════════════════════
//  SECURITY — IP BLACKLIST (Supabase)
// ══════════════════════════════════════════════════════════════
router.get('/security/ip-blacklist', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data, error } = await supa
            .from('ip_blacklist').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data || []);
    } catch (e) {
        try {
            const db   = getDB(req);
            const snap = await db.collection('_ipBlacklist').orderBy('created_at', 'desc').get();
            res.json(snap.docs.map(d => ({ id:d.id, ...d.data() })));
        } catch (e2) { res.json([]); }
    }
});

router.post('/security/ip-blacklist', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    const { ipAddress, reason } = req.body;
    if (!ipAddress) return res.status(400).json({ error: 'ipAddress required' });
    const now  = new Date().toISOString();
    try {
        // Supabase
        await supa.from('ip_blacklist').insert({
            ip_address: ipAddress, reason: reason||'', added_by: req.adminToken.uid, created_at: now,
        });
        // Firestore
        db.collection('_ipBlacklist').doc(ipAddress.replace(/\./g,'_')).set({
            ip_address: ipAddress, reason: reason||'', blocked_by: req.adminToken.uid, created_at: now,
        }).catch(() => {});
        await audit(req, 'block_ip', 'ip', ipAddress, { reason });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/security/ip-blacklist/:ip', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    const ip   = req.params.ip;
    try {
        await supa.from('ip_blacklist').delete().eq('ip_address', ip);
        db.collection('_ipBlacklist').doc(ip.replace(/\./g,'_')).delete().catch(() => {});
        await audit(req, 'unblock_ip', 'ip', ip);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  SECURITY — SESSIONS (Supabase active_sessions_view)
// ══════════════════════════════════════════════════════════════
router.get('/security/sessions', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data, error } = await supa
            .from('active_sessions_view')
            .select('*')
            .order('last_active', { ascending: false })
            .limit(200);
        if (error) throw error;
        res.json(data || []);
    } catch (e) {
        // Fallback Firestore
        try {
            const db   = getDB(req);
            const snap = await db.collection('_sessions').where('is_active','==',true).orderBy('last_active','desc').limit(200).get();
            const sessions = await Promise.all(snap.docs.map(async d => {
                const s = d.data();
                let display_name='', email='';
                try { const us = await db.collection('users').doc(s.uid).get(); display_name=us.data()?.displayName||''; email=us.data()?.email||''; } catch(e){}
                return { id:d.id, ...s, display_name, email };
            }));
            res.json(sessions);
        } catch (e2) { res.json([]); }
    }
});

router.post('/sessions/:id/logout', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    const id   = req.params.id;
    const now  = new Date().toISOString();
    try {
        await supa.from('sessions').update({ is_active:false, force_logout:true, logged_out_at:now }).eq('id', id);
        db.collection('_sessions').doc(String(id)).update({ is_active:false, terminated_at:now, terminated_by:req.adminToken.uid }).catch(() => {});
        await audit(req, 'terminate_session', 'session', id);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/sessions/terminate-all', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    const now  = new Date().toISOString();
    try {
        await supa.from('sessions').update({ is_active:false, force_logout:true, logged_out_at:now }).eq('is_active', true);
        // Firestore
        const snap = await db.collection('_sessions').where('is_active','==',true).get();
        const batch = db.batch();
        snap.docs.forEach(d => batch.update(d.ref, { is_active:false, terminated_at:now, terminated_by:'admin_global' }));
        if (!snap.empty) await batch.commit();
        await audit(req, 'force_logout_all', 'global', '', { count: snap.size });
        res.json({ ok:true, terminated: snap.size });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  BROADCAST → Firestore (app reads) + Supabase broadcasts table
// ══════════════════════════════════════════════════════════════
router.post('/broadcast', ...auth, async (req, res) => {
    const supa  = getSupabase();
    const db    = getDB(req);
    const { title, message, channel, audience } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    const now   = new Date().toISOString();
    try {
        // Get target users
        let usersSnap;
        const ago7  = new Date(Date.now() - 7*86400000).toISOString();
        const ago30 = new Date(Date.now() - 30*86400000).toISOString();
        if (audience === 'active') {
            usersSnap = await db.collection('users').where('lastSeen','>=',ago7).get();
        } else if (audience === 'new') {
            usersSnap = await db.collection('users').where('createdAt','>=',ago30).get();
        } else if (audience === 'inactive') {
            const all = await db.collection('users').get();
            usersSnap = { docs: all.docs.filter(d => { const ls=d.data().lastSeen||''; return !ls||ls<ago30; }) };
        } else {
            usersSnap = await db.collection('users').get();
        }
        const sent = usersSnap.docs.length;

        // Write to Firestore _broadcasts in batches of 400
        for (let i=0; i<usersSnap.docs.length; i+=400) {
            const batch = db.batch();
            usersSnap.docs.slice(i,i+400).forEach(ud => {
                const ref = db.collection('_broadcasts').doc();
                batch.set(ref, { uid:ud.id, title, message, channel:channel||'in_app', read:false, created_at:now, sender_uid:req.adminToken.uid });
            });
            await batch.commit();
        }

        // Supabase broadcasts table
        await supa.from('broadcasts').insert({
            title, message, channel:channel||'in_app', target_filter:audience||'all',
            sent_by:req.adminToken.uid, status:'sent', sent_at:now, recipient_count:sent,
        });

        await audit(req, 'broadcast', 'global', '', { title, audience, channel, sent });
        res.json({ ok:true, sent });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  FEATURE FLAGS → Supabase feature_flags + Firestore _flags
// ══════════════════════════════════════════════════════════════
const DEFAULT_FLAGS = [
    { key:'maintenance_mode',  label:'Maintenance Mode',  description:'Show maintenance screen to all users.',   value:false },
    { key:'ai_chat_enabled',   label:'AI Chat',           description:'Enable AI assistant for users.',           value:true  },
    { key:'voice_calls',       label:'Voice Calls',       description:'Allow voice calls between users.',         value:true  },
    { key:'video_calls',       label:'Video Calls',       description:'Allow video calls between users.',         value:true  },
    { key:'file_sharing',      label:'File Sharing',      description:'Allow file uploads in chat.',              value:true  },
    { key:'new_registrations', label:'New Registrations', description:'Allow new users to sign up.',              value:true  },
    { key:'stories',           label:'Stories',           description:'Enable the stories / status feature.',     value:true  },
    { key:'group_chats',       label:'Group Chats',       description:'Allow creation of group chats.',           value:true  },
    { key:'friend_requests',   label:'Friend Requests',   description:'Allow sending friend requests.',           value:true  },
    { key:'totp_enforcement',  label:'Force TOTP for All',description:'Require all users to set up TOTP.',        value:false },
];

router.get('/flags', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data, error } = await supa.from('feature_flags').select('*');
        if (error) throw error;
        const saved = {};
        (data||[]).forEach(f => { saved[f.key] = f; });
        const flags = DEFAULT_FLAGS.map(f => ({
            ...f,
            value:       saved[f.key] !== undefined ? !!saved[f.key].value : f.value,
            label:       saved[f.key]?.label       || f.label,
            description: saved[f.key]?.description || f.description,
        }));
        // Include any extra flags in Supabase not in defaults
        (data||[]).forEach(f => {
            if (!DEFAULT_FLAGS.find(d => d.key === f.key)) {
                flags.push({ key:f.key, label:f.label||f.key, description:f.description||'', value:!!f.value });
            }
        });
        res.json(flags);
    } catch (e) {
        // Fallback: Firestore
        try {
            const db   = getDB(req);
            const snap = await db.collection('_flags').get();
            const saved = {};
            snap.docs.forEach(d => { saved[d.id] = d.data(); });
            const flags = DEFAULT_FLAGS.map(f => ({
                ...f, value: saved[f.key] !== undefined ? !!saved[f.key].value : f.value,
            }));
            res.json(flags);
        } catch (e2) {
            res.json(DEFAULT_FLAGS);
        }
    }
});

router.patch('/flags/:key', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    const key  = req.params.key;
    const val  = req.body.value;
    const now  = new Date().toISOString();
    try {
        // Supabase
        await supa.from('feature_flags').upsert({
            key, value: val, updated_by: req.adminToken.uid, updated_at: now,
        }, { onConflict: 'key' });

        // Firestore
        db.collection('_flags').doc(key).set({ value:val, updated_at:now, updated_by:req.adminToken.uid }, { merge:true }).catch(() => {});

        await audit(req, 'toggle_flag', 'flag', key, { value:val });
        res.json({ ok:true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  AUDIT LOGS → Supabase audit_logs
// ══════════════════════════════════════════════════════════════
router.get('/audit-logs', ...auth, async (req, res) => {
    const supa   = getSupabase();
    const page   = parseInt(req.query.page) || 0;
    const action = req.query.action || '';
    try {
        let query = supa
            .from('audit_logs')
            .select('*', { count:'exact' })
            .order('created_at', { ascending:false });
        if (action) query = query.eq('action', action);
        const { data, error, count } = await query
            .range(page*PAGE_SIZE, (page+1)*PAGE_SIZE-1);
        if (error) throw error;
        res.json({ logs:data||[], total:count||0 });
    } catch (e) {
        // Fallback: Firestore
        try {
            const db   = getDB(req);
            let q2     = db.collection('_auditLog').orderBy('created_at','desc');
            if (action) q2 = q2.where('action','==',action);
            const snap = await q2.limit(500).get();
            const all  = snap.docs.map(d => ({ id:d.id, ...d.data() }));
            const logs = all.slice(page*PAGE_SIZE, (page+1)*PAGE_SIZE);
            res.json({ logs, total:all.length });
        } catch (e2) {
            res.json({ logs:[], total:0 });
        }
    }
});

router.get('/audit-logs/export', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data } = await supa
            .from('audit_logs').select('*').order('created_at',{ ascending:false }).limit(1000);
        const rows = [['Time','Admin','Action','TargetType','TargetID','Details','IP']];
        (data||[]).forEach(l => rows.push([l.created_at||'',l.admin_email||'',l.action||'',l.target_type||'',l.target_id||'',JSON.stringify(l.details||{}),l.ip_address||'']));
        const csv = rows.map(r => r.map(f=>`"${String(f).replace(/"/g,'""')}"`).join(',')).join('\n');
        res.setHeader('Content-Type','text/csv');
        res.setHeader('Content-Disposition','attachment; filename="audit-log.csv"');
        res.send(csv);
    } catch (e) {
        res.status(500).json({ error:e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  ADMIN TEAM → Supabase admin_roles (single source of truth)
// ══════════════════════════════════════════════════════════════
router.get('/team', ...auth, async (req, res) => {
    const supa = getSupabase();
    try {
        const { data, error } = await supa
            .from('admin_roles').select('*').order('created_at',{ ascending:false });
        if (error) throw error;
        res.json(data || []);
    } catch (e) {
        res.json([]);
    }
});

router.post('/team', ...auth, async (req, res) => {
    const supa = getSupabase();
    if (req.adminDoc?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only super admins can add admins' });
    }
    const { uid, email, displayName, role } = req.body;
    if (!uid || !email) return res.status(400).json({ error: 'uid and email required' });
    const now = new Date().toISOString();
    try {
        await supa.from('admin_roles').upsert({
            uid, email, display_name:displayName||'', role:role||'moderator',
            added_by:req.adminToken.uid, created_at:now,
        }, { onConflict:'uid' });

        // Also write to Firestore _admins for backward compatibility
        const db = getDB(req);
        db.collection('_admins').doc(uid).set({
            email, display_name:displayName||'', role:role||'moderator',
            added_by:req.adminToken.uid, created_at:now,
        }).catch(() => {});

        await audit(req, 'add_admin', 'admin', uid, { email, role });
        res.json({ ok:true });
    } catch (e) {
        res.status(500).json({ error:e.message });
    }
});

router.delete('/team/:uid', ...auth, async (req, res) => {
    const supa = getSupabase();
    const uid  = req.params.uid;
    if (req.adminDoc?.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only super admins can remove admins' });
    }
    if (uid === req.adminToken.uid) {
        return res.status(400).json({ error: 'Cannot remove yourself' });
    }
    try {
        await supa.from('admin_roles').delete().eq('uid', uid);
        const db = getDB(req);
        db.collection('_admins').doc(uid).delete().catch(() => {});
        await audit(req, 'remove_admin', 'admin', uid);
        res.json({ ok:true });
    } catch (e) {
        res.status(500).json({ error:e.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  SYSTEM ACTIONS
// ══════════════════════════════════════════════════════════════
router.post('/system/clear-all-sessions', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    const now  = new Date().toISOString();
    try {
        const { count } = await supa.from('sessions')
            .update({ is_active:false, force_logout:true, logged_out_at:now })
            .eq('is_active',true).select('*',{ count:'exact',head:true });

        const snap  = await db.collection('_sessions').where('is_active','==',true).get();
        const batch = db.batch();
        snap.docs.forEach(d => batch.update(d.ref,{ is_active:false, terminated_at:now }));
        if (!snap.empty) await batch.commit();

        await audit(req, 'clear_all_sessions', 'global', '', { count });
        res.json({ ok:true, cleared: count||snap.size });
    } catch (e) {
        res.status(500).json({ error:e.message });
    }
});

router.post('/system/flush-cache', ...auth, async (req, res) => {
    await audit(req, 'flush_cache', 'system', '');
    res.json({ ok:true, message:'Cache flush acknowledged' });
});

router.post('/system/send-health-check', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    let   supaOk=false, firestoreOk=false;
    try { await supa.from('feature_flags').select('key').limit(1); supaOk=true; } catch(e){}
    try { await db.collection('_healthChecks').add({ run_by:req.adminToken.uid, timestamp:new Date().toISOString(), status:'ok' }); firestoreOk=true; } catch(e){}
    res.json({ ok:supaOk&&firestoreOk, supabase:supaOk, firestore:firestoreOk });
});

// ══════════════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════════════
router.get('/health-full', ...auth, async (req, res) => {
    const supa = getSupabase();
    const db   = getDB(req);
    let   supaOk=false, firestoreOk=false;
    try { await supa.from('feature_flags').select('key').limit(1); supaOk=true; } catch(e){}
    try { await db.collection('_healthChecks').limit(1).get(); firestoreOk=true; } catch(e){}
    res.json({ supabase:supaOk, firestore:firestoreOk, timestamp:new Date().toISOString() });
});

module.exports = router;
