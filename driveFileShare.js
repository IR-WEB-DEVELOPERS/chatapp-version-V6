// ============================================================
//  EduChat — Google Drive File Sharing
//  Handles: auth, upload, file messages display
// ============================================================

const DRIVE_CLIENT_ID = '191214500535-6nironkv53bia01cct6lbfgmi6u0286s.apps.googleusercontent.com';
const DRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive.file';
const EDUCHAT_FOLDER  = 'EduChat Files'; // folder name in user's Drive

// Token cache keys — SHARED with autoBackup.js so both modules
// reuse the same OAuth token and the user is prompted only once per session.
const DRIVE_TOKEN_CACHE_KEY    = 'driveSharedAccessToken';
const DRIVE_TOKEN_EXPIRY_KEY   = 'driveSharedAccessTokenExpiry';
const DRIVE_TOKEN_TTL_MS       = 55 * 60 * 1000; // 55 minutes (Google tokens last 60 min)

let driveTokenClient  = null;
let driveAccessToken  = null;   // in-memory (fast path)
let pendingUploadFile = null;   // file waiting after auth
let pendingUploadCtx  = null;   // { type: 'direct'|'group' }
let _sharedTokenResolve = null; // for autoBackup.js requestToken()

// ── Token cache helpers ─────────────────────────────────────
function getDriveCachedToken() {
    // Check in-memory first
    if (driveAccessToken) return driveAccessToken;
    try {
        const token  = sessionStorage.getItem(DRIVE_TOKEN_CACHE_KEY);
        const expiry = parseInt(sessionStorage.getItem(DRIVE_TOKEN_EXPIRY_KEY) || '0', 10);
        if (token && Date.now() < expiry) {
            driveAccessToken = token; // restore to memory
            return token;
        }
    } catch (e) { /* private browsing */ }
    return null;
}

function setDriveCachedToken(token) {
    driveAccessToken = token;
    try {
        sessionStorage.setItem(DRIVE_TOKEN_CACHE_KEY, token);
        sessionStorage.setItem(DRIVE_TOKEN_EXPIRY_KEY, String(Date.now() + DRIVE_TOKEN_TTL_MS));
    } catch (e) { /* ignore */ }
}

function clearDriveCachedToken() {
    driveAccessToken = null;
    try {
        sessionStorage.removeItem(DRIVE_TOKEN_CACHE_KEY);
        sessionStorage.removeItem(DRIVE_TOKEN_EXPIRY_KEY);
    } catch (e) { /* ignore */ }
}

// ── Request Drive token (upload-retry path only — token expired mid-upload) ──
// NOTE: Do NOT call requestAccessToken() here — we are not in a direct user
// gesture, so the browser will block the popup. Instead, clear the bad token
// and ask the user to retry, which will go through the attach button click path.
function requestDriveToken(file, ctx) {
    clearDriveCachedToken();
    showToast('Drive session expired — please tap 📎 to re-attach the file', 'error');
}

// ── Get or create EduChat folder in Drive ──────────────────
async function getOrCreateEduChatFolder() {
    // Search for existing folder
    const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='${EDUCHAT_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${driveAccessToken}` } }
    );
    const searchData = await searchRes.json();

    if (searchData.files && searchData.files.length > 0) {
        return searchData.files[0].id;
    }

    // Create folder
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${driveAccessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            name: EDUCHAT_FOLDER,
            mimeType: 'application/vnd.google-apps.folder',
        }),
    });
    const folder = await createRes.json();
    return folder.id;
}

// ── Fetch with timeout helper ───────────────────────────────
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(id);
    }
}

// ── Upload file to Drive, return { url, name, size, mimeType } ─
async function uploadFileToDrive(file, ctx) {
    // Show uploading indicator
    setAttachBtnLoading(true, ctx.type);

    // Show progress toast
    showToast(`⏳ Uploading ${file.name}…`, 'info');

    const MAX_RETRIES = 2;
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (attempt > 0) showToast(`🔄 Retrying upload (${attempt}/${MAX_RETRIES})…`, 'info');

            const folderId = await getOrCreateEduChatFolder();

            // Multipart upload
            const metadata = {
                name: file.name,
                parents: [folderId],
            };

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', file);

            // Use resumable upload for files > 5MB to avoid timeouts
            const useResumable = file.size > 5 * 1024 * 1024;
            const uploadUrl = useResumable
                ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,mimeType,webViewLink,webContentLink'
                : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,mimeType,webViewLink,webContentLink';

            const uploadRes = await fetchWithTimeout(
                uploadUrl,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${driveAccessToken}` },
                    body: form,
                },
                60000  // 60s timeout for uploads
            );

            if (!uploadRes.ok) {
                const err = await uploadRes.json();
                // Token might be expired
                if (err.error?.code === 401) {
                    clearDriveCachedToken();
                    requestDriveToken(file, ctx);
                    return;
                }
                throw new Error(err.error?.message || 'Upload failed');
            }

            const fileData = await uploadRes.json();

            // Make file publicly readable (anyone with link can view/download)
            await fetchWithTimeout(
                `https://www.googleapis.com/drive/v3/files/${fileData.id}/permissions`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${driveAccessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
                },
                15000  // 15s timeout for permissions
            );

        // Send as file message
        const isImageUpload = (fileData.mimeType || '').startsWith('image/');
        const fileMsg = {
            type: 'file',
            fileName: fileData.name,
            fileSize: fileData.size,
            fileMime: fileData.mimeType,
            fileUrl:  fileData.webViewLink,        // view link (HTML page)
            downloadUrl: fileData.webContentLink,  // direct download
            // thumbnailUrl: embeddable image URL for <img> tags (no CORS/auth issues)
            thumbnailUrl: isImageUpload
                ? `https://drive.google.com/thumbnail?id=${fileData.id}&sz=w800`
                : null,
            text: '',
            time: new Date(),
        };

        if (ctx.type === 'direct') {
            await sendFileMessage(fileMsg);
        } else {
            await sendGroupFileMessage(fileMsg);
        }

            showToast(`✅ ${file.name} sent!`, 'success');
            setAttachBtnLoading(false, ctx.type);
            if (window.notifyUploadDone) window.notifyUploadDone(true);
            return; // success — exit retry loop

        } catch (err) {
            lastError = err;
            console.warn(`Drive upload attempt ${attempt + 1} failed:`, err.message);
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); // backoff
            }
        }
    }

    // All retries exhausted
    console.error('Drive upload error (all retries failed):', lastError);
    showToast(
        lastError?.name === 'AbortError'
            ? '⏱️ Upload timed out — check connection and retry'
            : 'File upload failed: ' + lastError?.message,
        'error'
    );
    setAttachBtnLoading(false, ctx.type);
    if (window.notifyUploadDone) window.notifyUploadDone(false);
}

// ── Send file message to Firestore (direct chat) ───────────
async function sendFileMessage(fileMsg) {
    if (!currentUser || !chatWithUID) return;
    // Inject caption from inline file preview bar
    if (window._pendingFileCaption !== undefined) {
        fileMsg.text = window._pendingFileCaption;
        window._pendingFileCaption = undefined;
    }
    const chatId = generateChatId(currentUser.uid, chatWithUID);
    const msgData = {
        chatId,
        participants: [currentUser.uid, chatWithUID],
        sender: currentUser.uid,
        ...fileMsg,
    };
    // OTV flag — if one-time view is toggled on, mark this file message too
    if (window._oneTimeViewEnabled) {
        msgData.oneTimeView = true;
        msgData.oneTimeViewOpened = false;
    }
    await db.collection('messages').add(msgData);
    await db.collection('users').doc(chatWithUID).update({
        [`unreadCounts.${chatId}`]: firebase.firestore.FieldValue.increment(1),
    });
    // Reset OTV toggle after file send
    if (window._oneTimeViewEnabled) {
        window._oneTimeViewEnabled = false;
        const ind = document.getElementById('otvIndicator');
        if (ind) ind.style.display = 'none';
        const badge = document.getElementById('tbOtvBadge');
        if (badge) badge.style.display = 'none';
    }
}

// ── Send file message to Firestore (group chat) ────────────
async function sendGroupFileMessage(fileMsg) {
    if (!currentUser || !groupChatID) return;
    // Inject caption from inline file preview bar
    if (window._pendingFileCaption !== undefined) {
        fileMsg.text = window._pendingFileCaption;
        window._pendingFileCaption = undefined;
    }
    const msgData = {
        groupId: groupChatID,
        sender: currentUser.uid,
        senderName: currentUserData?.name || 'User',
        ...fileMsg,
    };
    // OTV flag — if one-time view is toggled on, mark this file message too
    if (window._oneTimeViewEnabled) {
        msgData.oneTimeView = true;
        msgData.oneTimeViewOpened = false;
    }
    await db.collection('groupMessages').add(msgData);
    // Reset OTV toggle after file send
    if (window._oneTimeViewEnabled) {
        window._oneTimeViewEnabled = false;
        const ind = document.getElementById('otvGroupIndicator');
        if (ind) ind.style.display = 'none';
        const badge = document.getElementById('tbOtvGroupBadge');
        if (badge) badge.style.display = 'none';
    }
}

// ── Render a file message bubble ───────────────────────────
function renderFileMessage(msg, isSent) {
    const mime     = msg.fileMime || '';
    const isImage  = mime.startsWith('image/');
    const isPDF    = mime === 'application/pdf';
    const kb       = msg.fileSize ? Math.round(Number(msg.fileSize) / 1024) : null;
    const sizeStr  = kb ? (kb >= 1024 ? `${(kb/1024).toFixed(1)} MB` : `${kb} KB`) : '';

    const safeFileName    = escapeHTML(msg.fileName || 'File');
    const safeFileUrl     = escapeAttribute(msg.fileUrl || '#');
    const safeDownloadUrl = escapeAttribute(msg.downloadUrl || msg.fileUrl || '#');

    // For images: prefer thumbnailUrl (embeddable), else derive from fileUrl id
    let safeImgSrc  = '';
    let safeLargeSrc = '';
    if (isImage) {
        if (msg.thumbnailUrl) {
            safeImgSrc   = escapeAttribute(msg.thumbnailUrl);
            // Large version: same thumbnail API but bigger
            safeLargeSrc = escapeAttribute(msg.thumbnailUrl.replace(/sz=w\d+/, 'sz=w1600'));
        } else {
            // Derive file ID from fileUrl and use thumbnail API
            const idMatch = (msg.fileUrl || '').match(/\/d\/([^/]+)\//);
            if (idMatch) {
                safeImgSrc   = escapeAttribute(`https://drive.google.com/thumbnail?id=${idMatch[1]}&sz=w800`);
                safeLargeSrc = escapeAttribute(`https://drive.google.com/thumbnail?id=${idMatch[1]}&sz=w1600`);
            }
        }
        if (!safeImgSrc) safeImgSrc = safeDownloadUrl;
        if (!safeLargeSrc) safeLargeSrc = safeImgSrc;
    }

    if (isImage) {
        const safeCaption = escapeHTML(msg.text || '');
        const safeCaptionAttr = escapeAttribute(msg.text || safeFileName);
        // Thumbnail in chat — click opens lightbox (mediaLightbox.js)
        return `
            <div class="file-msg-wrap">
                <div class="file-msg-img-wrap">
                    <img 
                        src="${safeImgSrc}"
                        alt="${safeFileName}"
                        class="file-msg-image"
                        loading="lazy"
                        data-thumb="${safeImgSrc}"
                        data-full="${safeLargeSrc}"
                        data-download="${safeDownloadUrl}"
                        data-caption="${safeCaptionAttr}"
                        onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
                    >
                    <div class="file-msg-image-fallback" style="display:none">🖼️ ${safeFileName}</div>
                </div>
                ${safeCaption ? `<div class="file-msg-caption">${safeCaption}</div>` : ''}
                <div class="file-msg-actions">
                    <button class="file-action-btn mlb-open-btn"
                        data-thumb="${safeImgSrc}"
                        data-full="${safeLargeSrc}"
                        data-download="${safeDownloadUrl}"
                        data-caption="${safeCaptionAttr}">👁 View</button>
                    <a href="${safeDownloadUrl}" target="_blank" rel="noopener" class="file-action-btn">⬇ Download</a>
                </div>
            </div>
        `;
    }

    // Generic file / PDF / Video / Docs — ALL open in lightbox via Drive embed
    const icon = isPDF ? '📄' : getFileIcon(mime);

    // Extract Drive file ID to build embeddable preview URL
    const fileIdMatch = (msg.fileUrl || '').match(/\/d\/([^/]+)\//);
    const fileId      = fileIdMatch ? fileIdMatch[1] : '';

    // Google Drive /preview works for: PDF, Docs, Sheets, Slides, video, images, etc.
    const embedUrl = fileId ? `https://drive.google.com/file/d/${fileId}/preview` : '';

    const viewBtnHtml = embedUrl
        ? `<button class="file-action-btn mlb-open-btn"
               data-src="${escapeAttribute(embedUrl)}"
               data-type="embed"
               data-caption="${safeFileName}"
               data-download="${safeDownloadUrl}">👁 View</button>`
        : `<a href="${safeFileUrl}" target="_blank" rel="noopener" class="file-action-btn">👁 View</a>`;

    const safeCaptionGeneric = escapeHTML(msg.text || '');
    return `
        <div class="file-msg-wrap">
            <div class="file-msg-card">
                <span class="file-icon">${icon}</span>
                <div class="file-msg-info">
                    <span class="file-name">${safeFileName}</span>
                    ${sizeStr ? `<span class="file-size">${sizeStr}</span>` : ''}
                </div>
            </div>
            ${safeCaptionGeneric ? `<div class="file-msg-caption">${safeCaptionGeneric}</div>` : ''}
            <div class="file-msg-actions">
                ${viewBtnHtml}
                <a href="${safeDownloadUrl}" target="_blank" rel="noopener" class="file-action-btn">⬇ Download</a>
            </div>
        </div>
    `;
}

function getFileIcon(mime) {
    if (mime.startsWith('video/'))      return '🎬';
    if (mime.startsWith('audio/'))      return '🎵';
    if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z')) return '🗜️';
    if (mime.includes('word') || mime.includes('document')) return '📝';
    if (mime.includes('sheet') || mime.includes('excel'))   return '📊';
    if (mime.includes('presentation') || mime.includes('powerpoint')) return '📊';
    if (mime.includes('text'))          return '📃';
    return '📎';
}

// ── UI helpers ──────────────────────────────────────────────
function setAttachBtnLoading(loading, chatType) {
    const btns = chatType === 'direct'
        ? document.querySelectorAll('.attach-btn[data-chat="direct"]')
        : document.querySelectorAll('.attach-btn[data-chat="group"]');
    btns.forEach(btn => {
        btn.disabled = loading;
        btn.textContent = loading ? '⏳' : '📎';
    });
}

// showToast is defined in chat.js — re-use it
function showToast(msg, type = 'info') {
    if (window._showToast) {
        window._showToast(msg, type);
    }
}

// ── Wire up file input triggers ─────────────────────────────
//
//  THE POPUP PROBLEM:
//  Browsers only allow popups (OAuth windows) from a *direct* user gesture
//  (a synchronous click handler). By the time the file-input `change` event
//  fires, the browser no longer considers it a trusted gesture, so
//  requestAccessToken() → popup_failed_to_open.
//
//  CORRECT FLOW:
//  1. User clicks attach button (direct gesture ✅)
//  2a. Token already cached  → open file picker immediately
//  2b. No token              → call requestAccessToken() RIGHT NOW (still inside
//      the click handler, gesture is still trusted) → OAuth popup opens fine
//  3. Token callback fires   → set pendingPickerChatType, open file picker
//  4. User picks file        → upload with cached token
//
// ─────────────────────────────────────────────────────────────
let pendingPickerChatType = null; // set when we need to open picker after auth

function openFilePicker(chatType) {
    document.getElementById(`fileInput-${chatType}`)?.click();
}

function setupAttachButtons() {
    ['direct', 'group'].forEach(chatType => {
        const input = document.createElement('input');
        input.type   = 'file';
        input.id     = `fileInput-${chatType}`;
        input.accept = 'image/*,application/pdf,video/*,audio/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.txt';
        input.style.display = 'none';

        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            input.value = '';
            if (!file) return;
            if (file.size > 25 * 1024 * 1024) {
                showToast('File too large (max 25 MB)', 'error');
                return;
            }
            // Show preview + caption modal before uploading
            showFilePreviewModal(file, chatType);
        });

        document.body.appendChild(input);
    });

    // Attach button click — this is the ONLY place we call requestAccessToken,
    // because this is the only guaranteed direct user gesture.
    document.querySelectorAll('.attach-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const chatType = btn.dataset.chat;
            if (!driveTokenClient) initDriveAuth();

            if (getDriveCachedToken()) {
                // Already have a valid token — open picker immediately
                openFilePicker(chatType);
            } else {
                // No token yet — request it NOW while we're still in the click handler.
                // The browser treats this as a trusted popup because we're synchronous
                // inside the click event. The token callback will open the picker.
                pendingPickerChatType = chatType;
                driveTokenClient.requestAccessToken({ prompt: '' });
            }
        });
    });
}

// ── Init Google Identity Services ──────────────────────────
function initDriveAuth() {
    if (!window.google?.accounts?.oauth2) {
        console.warn('Google Identity Services not loaded yet');
        return;
    }
    driveTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: DRIVE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: (tokenResponse) => {
            if (tokenResponse.error) {
                console.error('Drive auth error:', tokenResponse.error);
                showToast('Drive access denied', 'error');
                pendingPickerChatType = null;
                pendingUploadFile = null;
                pendingUploadCtx  = null;
                return;
            }
            setDriveCachedToken(tokenResponse.access_token);

            // Resolve any pending requestToken() promise (used by autoBackup.js)
            if (_sharedTokenResolve) {
                const resolve = _sharedTokenResolve;
                _sharedTokenResolve = null;
                resolve(tokenResponse.access_token);
                return;
            }

            // If auth was triggered by the attach button, open the file picker now
            if (pendingPickerChatType) {
                const chatType = pendingPickerChatType;
                pendingPickerChatType = null;
                openFilePicker(chatType);
                return;
            }

            // Fallback: a file was already pending (e.g. token expired mid-upload)
            if (pendingUploadFile) {
                const file = pendingUploadFile;
                const ctx  = pendingUploadCtx;
                pendingUploadFile = null;
                pendingUploadCtx  = null;
                uploadFileToDrive(file, ctx);
            }
        },
        error_callback: (err) => {
            console.error('Drive token error:', err);
            pendingPickerChatType = null;
            pendingUploadFile = null;
            pendingUploadCtx  = null;
            if (_sharedTokenResolve) { _sharedTokenResolve(null); _sharedTokenResolve = null; }
            if (err.type !== 'popup_closed') {
                showToast('Drive auth failed: ' + err.type, 'error');
            }
        }
    });
}
// ── Expose globally ─────────────────────────────────────────
// Also expose DRIVE_CLIENT_ID at window level so autoBackup.js
// can reference it without needing driveShare._clientId.
window.DRIVE_CLIENT_ID = DRIVE_CLIENT_ID;

// ── File Preview Modal integration ──────────────────────────
// Listen for startFileUpload events dispatched by the preview modal
document.addEventListener('startFileUpload', (e) => {
    const { file, chatType, caption } = e.detail;
    window._pendingFileCaption = caption || '';
    uploadFileToDrive(file, { type: chatType });
});


window.driveShare = {
    init: () => {
        initDriveAuth();
        setupAttachButtons();
    },
    renderFileMessage,
    _clientId: DRIVE_CLIENT_ID,
    // ── Shared token API for autoBackup.js ──────────────────
    // autoBackup reuses these so both modules share one OAuth token
    // and the user is asked to sign in only once per session.
    getToken:   getDriveCachedToken,
    setToken:   setDriveCachedToken,
    clearToken: clearDriveCachedToken,
    // Request a fresh token — safe to call from any context;
    // allowPrompt=true only works inside a direct user gesture.
    requestToken: (allowPrompt = false) => {
        if (!driveTokenClient) initDriveAuth();
        if (!driveTokenClient) return Promise.resolve(null);
        const cached = getDriveCachedToken();
        if (cached) return Promise.resolve(cached);
        if (!allowPrompt) return Promise.resolve(null);
        return new Promise((resolve) => {
            _sharedTokenResolve = resolve;
            driveTokenClient.requestAccessToken({ prompt: '' });
        });
    },
};
