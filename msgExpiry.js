// ============================================================
//  msgExpiry.js — Per-chat message expiry timer
//
//  Works like WhatsApp's "disappearing messages":
//  User sets a timer (off / 24h / 7d / 30d) per chat.
//  A Cloud Function (or server cron) deletes expired messages.
//  On the client, we also hide/grey-out visually expired messages.
//
//  Storage: Firestore  chatSettings/{chatId}  { expiryMs: N }
//           Firestore  groupSettings/{gid}    { expiryMs: N }
//  Each message doc gets an  expiresAt  Timestamp when sent.
// ============================================================

window.msgExpiry = (() => {

    const DURATIONS = [
        { label: 'Off',      ms: 0 },
        { label: '1 hour',   ms: 60 * 60 * 1000 },
        { label: '24 hours', ms: 24 * 60 * 60 * 1000 },
        { label: '7 days',   ms: 7  * 24 * 60 * 60 * 1000 },
        { label: '30 days',  ms: 30 * 24 * 60 * 60 * 1000 },
    ];

    // ── Get expiry setting for a chat ─────────────────────────
    async function getExpiryMs(chatId, isGroup = false) {
        if (!window.db) return 0;
        try {
            const col  = isGroup ? 'groupSettings' : 'chatSettings';
            const snap = await window.db.collection(col).doc(chatId).get();
            return snap.data()?.expiryMs || 0;
        } catch { return 0; }
    }

    // ── Set expiry setting for a chat ─────────────────────────
    async function setExpiryMs(chatId, ms, isGroup = false) {
        if (!window.db) return;
        const col = isGroup ? 'groupSettings' : 'chatSettings';
        await window.db.collection(col).doc(chatId).set({ expiryMs: ms }, { merge: true });

        // Announce to chat partner via a system message
        const label = DURATIONS.find(d => d.ms === ms)?.label || 'Off';
        const text  = ms === 0
            ? 'Message auto-delete turned off'
            : `Messages will auto-delete after ${label}`;

        if (!isGroup && window.currentUser && window.chatWithUID) {
            const chatId2 = window.generateChatId?.(window.currentUser.uid, window.chatWithUID) || chatId;
            await window.db.collection('messages').add({
                chatId:       chatId2,
                participants: [window.currentUser.uid, window.chatWithUID],
                sender:       window.currentUser.uid,
                type:         'system',
                text,
                time:         new Date(),
                delivered:    true,
                seenBy:       []
            });
        }
    }

    // ── Compute expiresAt for a new message ───────────────────
    async function getExpiresAt(chatId, isGroup = false) {
        const ms = await getExpiryMs(chatId, isGroup);
        if (!ms) return null;
        return new Date(Date.now() + ms);
    }

    // ── Client-side: delete visually expired messages ─────────
    function pruneExpiredFromDOM(containerEl) {
        if (!containerEl) return;
        const now = Date.now();
        containerEl.querySelectorAll('[data-expires-at]').forEach(el => {
            const t = Number(el.dataset.expiresAt);
            if (t && now > t) {
                el.style.opacity = '0.35';
                const textEl = el.querySelector('.message-text');
                if (textEl) textEl.textContent = '🕒 Message expired';
                el.style.pointerEvents = 'none';
            }
        });
    }

    // ── Server-side cleanup (called from server.js cron) ──────
    // This is just documentation — the actual deletion runs in
    // server.js via the /cron/delete-expired-messages route.

    // ── Show expiry picker UI ─────────────────────────────────
    function showPicker(chatId, isGroup, anchorEl) {
        // Remove any existing picker
        document.getElementById('expiryPicker')?.remove();

        const picker = document.createElement('div');
        picker.id        = 'expiryPicker';
        picker.className = 'expiry-picker';
        picker.innerHTML = `
            <div class="expiry-picker-header">
                <span>⏱ Auto-delete messages</span>
                <button class="expiry-picker-close">✕</button>
            </div>
            ${DURATIONS.map(d => `
                <button class="expiry-option" data-ms="${d.ms}">${d.ms === 0 ? '🚫 ' : '🕒 '}${d.label}</button>
            `).join('')}
        `;
        document.body.appendChild(picker);

        // Position near anchor
        if (anchorEl) {
            const rect = anchorEl.getBoundingClientRect();
            picker.style.top  = (rect.bottom + 8) + 'px';
            picker.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px';
        }

        // Highlight current setting
        getExpiryMs(chatId, isGroup).then(cur => {
            picker.querySelectorAll('.expiry-option').forEach(btn => {
                if (Number(btn.dataset.ms) === cur) btn.classList.add('active');
            });
        });

        picker.querySelector('.expiry-picker-close').onclick = () => picker.remove();
        picker.querySelectorAll('.expiry-option').forEach(btn => {
            btn.onclick = async () => {
                const ms = Number(btn.dataset.ms);
                await setExpiryMs(chatId, ms, isGroup);
                picker.remove();
                const label = DURATIONS.find(d => d.ms === ms)?.label || 'Off';
                window.toastManager?.show({
                    icon: null, type: 'success',
                    title: ms === 0 ? 'Auto-delete off' : `Auto-delete: ${label}`,
                    body: ms === 0 ? 'Messages will be kept' : 'New messages will auto-delete',
                    duration: 3000
                });
            };
        });

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', function h(e) {
                if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', h); }
            });
        }, 50);
    }

    return { DURATIONS, getExpiryMs, setExpiryMs, getExpiresAt, pruneExpiredFromDOM, showPicker };

})();
