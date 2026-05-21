// ============================================================
//  autoBackup.js — Auto Backup & Restore
//  7 days కి ఒకసారి messages Drive కి backup చేసి Firestore నుండి delete చేస్తుంది
//
//  BUG FIXES:
//  1. Permission maati maatiki vastondi — fixed by caching the
//     access token in sessionStorage with expiry. Google OAuth2
//     tokens last ~1 hour; we store it so the same session never
//     triggers the consent popup twice.
//  2. showToast / getUserData were undefined — now resolved via
//     window.showToast and window.getUserData (defined in globals.js
//     and ui.js which load before this file).
// ============================================================

const BACKUP_INTERVAL_DAYS = 7;
const BACKUP_FOLDER        = 'EduChat Files';
const BACKUP_SUBFOLDER     = 'Backups';
// NOTE: OAuth scope / token client are now owned by driveFileShare.js.

// Token cache key in sessionStorage
// ── Drive token — delegate entirely to driveFileShare.js ────
//
//  driveFileShare.js and autoBackup.js share ONE OAuth token stored
//  under a single sessionStorage key.  This means the user is asked
//  to authorise Google Drive only once per browser session, regardless
//  of which module triggers the request first.
//
//  window.driveShare (set by driveFileShare.js) exposes:
//    .getToken()              → cached token | null
//    .setToken(t)             → store token
//    .clearToken()            → invalidate token
//    .requestToken(allowPrompt) → Promise<token|null>

function getCachedToken() {
    return window.driveShare?.getToken() ?? null;
}

function setCachedToken(token) {
    window.driveShare?.setToken(token);
}

function clearCachedToken() {
    window.driveShare?.clearToken();
}

async function getBackupToken(allowPrompt = false) {
    // 1. Shared cache — driveFileShare.js may already have a valid token
    const cached = getCachedToken();
    if (cached) return cached;

    // 2. Only show OAuth popup when triggered by a real user gesture
    if (!allowPrompt) {
        console.log('autoBackup: no cached token and not a user-initiated backup — skipping.');
        return null;
    }

    // 3. Delegate to driveFileShare token client (same client_id, same scope)
    if (!window.driveShare?.requestToken) {
        console.warn('autoBackup: driveShare not ready — cannot request token');
        return null;
    }
    return window.driveShare.requestToken(true);
}

// ── Drive folder helpers ─────────────────────────────────────
async function getBackupFolderId(token) {
    const parentSearch = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)`,
        { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json());

    let parentId;
    if (parentSearch.files?.length) {
        parentId = parentSearch.files[0].id;
    } else {
        const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: BACKUP_FOLDER, mimeType: 'application/vnd.google-apps.folder' })
        }).then(r => r.json());
        parentId = cr.id;
    }

    const subSearch = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_SUBFOLDER}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)`,
        { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json());

    if (subSearch.files?.length) return subSearch.files[0].id;

    const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: BACKUP_SUBFOLDER, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    }).then(r => r.json());
    return cr.id;
}

async function uploadBackupToDrive(token, folderId, fileName, jsonData) {
    const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: fileName, parents: [folderId] })], { type: 'application/json' }));
    form.append('file', blob);

    const res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
    ).then(r => r.json());

    return res.id;
}

// ── Helper: retry fetch with token refresh on 401 ───────────
async function fetchWithTokenRefresh(url, token) {
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 401) {
        // Token expired mid-session — clear cache and get fresh token
        clearCachedToken();
        const newToken = await getBackupToken();
        if (!newToken) return null;
        res = await fetch(url, { headers: { Authorization: `Bearer ${newToken}` } });
    }

    return res.ok ? res : null;
}

// ── Main backup function ─────────────────────────────────────
async function runAutoBackup() {
    if (!currentUser) return;

    // FIX: use window.getUserData so it works regardless of load order
    const _getUserData = window.getUserData || (async (uid) => null);
    const userData     = currentUserData || await _getUserData(currentUser.uid);
    if (!userData) return;

    const lastBackup    = userData.lastBackup?.toDate ? userData.lastBackup.toDate() : (userData.lastBackup ? new Date(userData.lastBackup) : null);
    const daysSinceLast = lastBackup ? (Date.now() - lastBackup.getTime()) / (1000 * 60 * 60 * 24) : 999;

    if (daysSinceLast < BACKUP_INTERVAL_DAYS) {
        console.log(`Backup: ${Math.round(daysSinceLast)} days since last backup, skipping.`);
        return;
    }

    console.log('Starting auto backup...');
    // FIX: use window.showToast which is guaranteed to be defined by ui.js
    window.showToast('📦 Backing up old messages to Drive...', 'info');

    const token = await getBackupToken();
    if (!token) {
        // Silent skip — user will see the toast only when backup actually runs
        console.warn('Backup skipped: no Drive token (will retry on next session)');
        return;
    }

    try {
        const folderId   = await getBackupFolderId(token);
        const cutoffDate = new Date(Date.now() - BACKUP_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
        const uid        = currentUser.uid;
        let totalBacked  = 0;

        // ── Direct messages ─────────────────────────────────
        // NOTE: Compound query (participants + time) requires a composite
        // Firestore index that may not exist. Fetch by participants only and
        // filter by time client-side to avoid the index requirement.
        const dmSnapRaw = await db.collection('messages')
            .where('participants', 'array-contains', uid)
            .get();

        const dmSnap = {
            empty: true,
            docs: dmSnapRaw.docs.filter(doc => {
                const t = doc.data().time;
                const msgDate = t?.toDate ? t.toDate() : (t ? new Date(t) : null);
                return msgDate && msgDate < cutoffDate;
            }),
        };
        dmSnap.empty = dmSnap.docs.length === 0;

        if (!dmSnap.empty) {
            const byChat = {};
            dmSnap.docs.forEach(doc => {
                const d = doc.data();
                if (!byChat[d.chatId]) byChat[d.chatId] = [];
                byChat[d.chatId].push({ id: doc.id, ...d });
            });

            for (const [chatId, msgs] of Object.entries(byChat)) {
                const otherUid  = msgs[0]?.participants?.find(p => p !== uid) || 'unknown';
                const otherUser = await _getUserData(otherUid).catch(() => null);
                const otherName = otherUser?.name || otherUid;
                const fileName  = `dm_${otherName}_${chatId}_${Date.now()}.json`;

                const fileId = await uploadBackupToDrive(token, folderId, fileName, {
                    type: 'direct', chatId,
                    participants: [uid, otherUid],
                    exportedAt:   new Date().toISOString(),
                    messages:     msgs.map(m => ({ ...m, time: m.time?.toDate ? m.time.toDate().toISOString() : m.time }))
                });

                await db.collection('messageArchives').add({
                    type: 'direct', chatId, owner: uid, driveFileId: fileId, fileName,
                    msgCount: msgs.length,
                    dateRange: {
                        from: msgs[msgs.length - 1]?.time?.toDate?.() || cutoffDate,
                        to:   msgs[0]?.time?.toDate?.() || cutoffDate
                    },
                    createdAt: new Date()
                });

                const batch = db.batch();
                dmSnap.docs.filter(doc => doc.data().chatId === chatId).forEach(doc => batch.delete(doc.ref));
                await batch.commit();

                totalBacked += msgs.length;
            }
        }

        // ── Group messages ───────────────────────────────────
        // Same pattern: fetch by sender only, filter by time client-side.
        const gmSnapRaw = await db.collection('groupMessages')
            .where('sender', '==', uid)
            .get();

        const gmSnap = {
            empty: true,
            docs: gmSnapRaw.docs.filter(doc => {
                const t = doc.data().time;
                const msgDate = t?.toDate ? t.toDate() : (t ? new Date(t) : null);
                return msgDate && msgDate < cutoffDate;
            }),
        };
        gmSnap.empty = gmSnap.docs.length === 0;

        if (!gmSnap.empty) {
            const byGroup = {};
            gmSnap.docs.forEach(doc => {
                const d = doc.data();
                if (!byGroup[d.groupId]) byGroup[d.groupId] = [];
                byGroup[d.groupId].push({ id: doc.id, ...d });
            });

            for (const [groupId, msgs] of Object.entries(byGroup)) {
                const groupDoc  = await db.collection('groups').doc(groupId).get();
                const groupName = groupDoc.data()?.name || groupId;
                const fileName  = `group_${groupName}_${groupId}_${Date.now()}.json`;

                const fileId = await uploadBackupToDrive(token, folderId, fileName, {
                    type: 'group', groupId, groupName,
                    exportedAt: new Date().toISOString(),
                    messages:   msgs.map(m => ({ ...m, time: m.time?.toDate ? m.time.toDate().toISOString() : m.time }))
                });

                await db.collection('messageArchives').add({
                    type: 'group', groupId, groupName, owner: uid,
                    driveFileId: fileId, fileName, msgCount: msgs.length, createdAt: new Date()
                });

                const batch = db.batch();
                gmSnap.docs.filter(doc => doc.data().groupId === groupId).forEach(doc => batch.delete(doc.ref));
                await batch.commit();

                totalBacked += msgs.length;
            }
        }

        await db.collection('users').doc(uid).update({ lastBackup: new Date() });
        if (currentUserData) currentUserData.lastBackup = new Date();

        if (totalBacked > 0) {
            window.showToast(`✅ ${totalBacked} messages backed up to Drive!`, 'success');
        } else {
            console.log('Backup: no old messages to backup');
        }

    } catch (err) {
        console.error('Auto backup error:', err);
        window.showToast('Backup failed: ' + err.message, 'error');
    }
}

// ── Fetch archived messages ───────────────────────────────────
async function fetchArchivedMessages(chatId, type = 'direct') {
    if (!currentUser) return [];

    // User clicked 'Load archived messages' — allow OAuth popup
    const token = await getBackupToken(true);
    if (!token) {
        window.showToast('Drive access needed to load old messages', 'error');
        return [];
    }

    try {
        const field = type === 'group' ? 'groupId' : 'chatId';
        const snap  = await db.collection('messageArchives')
            .where('owner', '==', currentUser.uid)
            .where(field, '==', chatId)
            .orderBy('createdAt', 'desc')
            .get();

        if (snap.empty) return [];

        const allMessages = [];

        for (const doc of snap.docs) {
            const { driveFileId } = doc.data();
            try {
                const res = await fetchWithTokenRefresh(
                    `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
                    token
                );
                if (res) {
                    const data = await res.json();
                    allMessages.push(...(data.messages || []));
                }
            } catch (e) {
                console.error('Error fetching archive file:', e);
            }
        }

        allMessages.sort((a, b) => new Date(a.time) - new Date(b.time));
        return allMessages;

    } catch (err) {
        console.error('fetchArchivedMessages error:', err);
        return [];
    }
}

// ── Check archives exist ──────────────────────────────────────
async function hasArchives(chatId, type = 'direct') {
    if (!currentUser) return false;
    const field = type === 'group' ? 'groupId' : 'chatId';
    try {
        const snap = await db.collection('messageArchives')
            .where('owner', '==', currentUser.uid)
            .where(field, '==', chatId)
            .limit(1)
            .get();
        return !snap.empty;
    } catch (e) {
        return false;
    }
}

// ── Expose ───────────────────────────────────────────────────
window.autoBackup = {
    run:            runAutoBackup,
    fetchArchived:  fetchArchivedMessages,
    hasArchives,
    // Call this from a button click to connect Drive manually
    requestToken:   () => getBackupToken(true),
};
