// ============================================================
//  chatInteractions.js
//  1. Reactions (long-press / reaction bar)
//  2. Double-tap to reply
//  3. Drag-to-reply (swipe right gesture)
//  4. Profile & Group share links
// ============================================================

// ── Reaction emoji set (these are REACTION emojis — not UI icons) ──
const REACTIONS = ['❤️', '😂', '😮', '😢', '🙏', '👍'];

// ── Firestore reaction path helpers ──────────────────────────
function _reactionPath(chatType) {
    return chatType === 'group' ? 'groupMessages' : 'messages';
}

// ── Save reaction — no read, pure update ─────────────────────
async function saveReaction(msgId, emoji, chatType) {
    const col = _reactionPath(chatType);
    const uid = window.currentUser?.uid;
    if (!uid || !msgId) return;
    try {
        const ref = window.db.collection(col).doc(msgId);
        // Check local DOM for existing reaction to decide toggle
        const chip = document.querySelector(`.message[data-id="${msgId}"] .reaction-chip[data-emoji="${emoji}"].mine`);
        if (chip) {
            // Already reacted — remove (FieldValue.delete on that key)
            await ref.update({ [`reactions.${uid}`]: firebase.firestore.FieldValue.delete() });
        } else {
            // Add or change reaction — single write, no read
            await ref.update({ [`reactions.${uid}`]: emoji });
        }
    } catch (e) { console.error('saveReaction error:', e); }
}

// ── Build reactions display HTML ─────────────────────────────
function buildReactionsHTML(reactions = {}) {
    if (!reactions || !Object.keys(reactions).length) return '';
    const counts = {};
    const myUID  = window.currentUser?.uid;
    let myEmoji  = null;

    Object.entries(reactions).forEach(([uid, emoji]) => {
        counts[emoji] = (counts[emoji] || 0) + 1;
        if (uid === myUID) myEmoji = emoji;
    });

    const chips = Object.entries(counts).map(([emoji, count]) => {
        const mine = emoji === myEmoji;
        return `<span class="reaction-chip${mine ? ' mine' : ''}" data-emoji="${emoji}">${emoji}${count > 1 ? `<span class="reaction-count">${count}</span>` : ''}</span>`;
    }).join('');

    return `<div class="msg-reactions">${chips}</div>`;
}

// ── Show reaction picker above a message ─────────────────────
function showReactionPicker(msgEl, msgId, chatType) {
    // Remove any existing picker
    document.querySelectorAll('.reaction-picker').forEach(p => p.remove());

    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.innerHTML = REACTIONS.map(e =>
        `<button class="reaction-opt" data-emoji="${e}" title="${e}">${e}</button>`
    ).join('');

    // Position above the bubble
    const rect = msgEl.getBoundingClientRect();
    picker.style.cssText = `
        position: fixed;
        left: ${Math.min(rect.left, window.innerWidth - 280)}px;
        top: ${rect.top - 56}px;
        z-index: 3000;
    `;

    document.body.appendChild(picker);

    picker.querySelectorAll('.reaction-opt').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await saveReaction(msgId, btn.dataset.emoji, chatType);
            picker.remove();
        });
    });

    // Close on outside click
    const close = (e) => {
        if (!picker.contains(e.target)) {
            picker.remove();
            document.removeEventListener('click', close, { capture: true });
        }
    };
    setTimeout(() => document.addEventListener('click', close, { capture: true }), 0);
}

// ── Double-tap reply (mobile) ────────────────────────────────
const _tapState = new Map(); // msgId → { lastTap, timer }

function handleDoubleTap(msgEl, msg, chatType) {
    const id  = msg.id;
    const now = Date.now();
    const st  = _tapState.get(id) || {};

    if (st.lastTap && (now - st.lastTap) < 300) {
        // Double tap detected
        clearTimeout(st.timer);
        _tapState.delete(id);
        triggerReplyAnim(msgEl);
        window.setReply?.(msg, chatType);
    } else {
        const timer = setTimeout(() => _tapState.delete(id), 350);
        _tapState.set(id, { lastTap: now, timer });
    }
}

function triggerReplyAnim(msgEl) {
    msgEl.classList.add('reply-swipe-anim');
    setTimeout(() => msgEl.classList.remove('reply-swipe-anim'), 400);
}

// ── Drag-to-reply (swipe right on mobile) ────────────────────
function attachSwipeReply(msgEl, msg, chatType) {
    let startX = 0, currentX = 0;
    let dragging = false;
    let triggered = false;
    const THRESHOLD = 72;

    function onTouchStart(e) {
        startX    = e.touches[0].clientX;
        currentX  = startX;
        dragging  = true;
        triggered = false;
        msgEl.style.transition = 'none';
    }

    function onTouchMove(e) {
        if (!dragging) return;
        currentX = e.touches[0].clientX;
        const dx = currentX - startX;
        if (dx < 0) return; // Only swipe right
        const capped = Math.min(dx, THRESHOLD + 20);
        msgEl.style.transform = `translateX(${capped}px)`;

        if (dx >= THRESHOLD && !triggered) {
            triggered = true;
            navigator.vibrate?.(30);
            _showSwipeArrow(msgEl);
        }
    }

    function onTouchEnd() {
        if (!dragging) return;
        dragging = false;
        msgEl.style.transition = 'transform 0.25s cubic-bezier(0.34,1.56,0.64,1)';
        msgEl.style.transform  = 'translateX(0)';

        if (triggered) {
            setTimeout(() => {
                window.setReply?.(msg, chatType);
            }, 100);
        }
        setTimeout(() => {
            msgEl.style.transition = '';
            document.querySelector('.swipe-reply-arrow')?.remove();
        }, 280);
    }

    msgEl.addEventListener('touchstart', onTouchStart, { passive: true });
    msgEl.addEventListener('touchmove',  onTouchMove,  { passive: true });
    msgEl.addEventListener('touchend',   onTouchEnd);
}

function _showSwipeArrow(msgEl) {
    document.querySelector('.swipe-reply-arrow')?.remove();
    const arrow = document.createElement('div');
    arrow.className = 'swipe-reply-arrow';
    arrow.innerHTML = window.Icons?.get('reply', 18) || '↩';
    msgEl.appendChild(arrow);
}

// ── Long-press for reaction picker (mobile) ──────────────────
function attachLongPress(msgEl, msg, chatType) {
    let pressTimer = null;
    const HOLD_MS  = 480;

    function onStart(e) {
        pressTimer = setTimeout(() => {
            navigator.vibrate?.(40);
            showReactionPicker(msgEl, msg.id, chatType);
        }, HOLD_MS);
    }
    function onEnd() { clearTimeout(pressTimer); }

    msgEl.addEventListener('touchstart', onStart, { passive: true });
    msgEl.addEventListener('touchend',   onEnd);
    msgEl.addEventListener('touchmove',  onEnd,   { passive: true });
    msgEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showReactionPicker(msgEl, msg.id, chatType);
    });
}

// ── Attach all interactions to rendered messages ─────────────
function attachChatInteractions(container, messages, chatType) {
    if (!container) return;

    container.querySelectorAll('.message[data-id]').forEach(msgEl => {
        const msgId = msgEl.dataset.id;
        const msg   = messages.find(m => m.id === msgId);
        if (!msg || msg.deletedForAll) return;

        // Double-tap → reply
        msgEl.addEventListener('touchend', () => handleDoubleTap(msgEl, msg, chatType));

        // Swipe right → reply
        attachSwipeReply(msgEl, msg, chatType);

        // Long-press / right-click → reaction picker
        attachLongPress(msgEl, msg, chatType);

        // Reaction chip click → toggle off
        msgEl.querySelectorAll('.reaction-chip').forEach(chip => {
            chip.addEventListener('click', async (e) => {
                e.stopPropagation();
                await saveReaction(msgId, chip.dataset.emoji, chatType);
            });
        });
    });
}

// ── Profile Share Link ────────────────────────────────────────
async function shareProfileLink(uid) {
    const userData = window.currentUserData;
    if (!userData && uid === window.currentUser?.uid) return;

    const username = userData?.username || uid;
    // Build a deep-link. If app has a domain, use it. Fallback to location.
    const base = window.location.origin;
    const link = `${base}/chat.html?addFriend=${encodeURIComponent(uid)}`;
    const title = `Connect with ${userData?.name || 'me'} on EduChat`;

    if (navigator.share) {
        try {
            await navigator.share({ title, text: `${title}\n${link}`, url: link });
            return;
        } catch (e) { /* fallback to copy */ }
    }

    await _copyToClipboard(link);
    window.showToast?.('Profile link copied!', 'success');
}

// ── Group Share Link ──────────────────────────────────────────
async function shareGroupLink(groupId, groupName) {
    const base = window.location.origin;
    const link = `${base}/chat.html?joinGroup=${encodeURIComponent(groupId)}`;
    const title = `Join "${groupName || 'Group'}" on EduChat`;

    if (navigator.share) {
        try {
            await navigator.share({ title, text: `${title}\n${link}`, url: link });
            return;
        } catch (e) { /* fallback to copy */ }
    }

    await _copyToClipboard(link);
    window.showToast?.('Group invite link copied!', 'success');
}

// ── Handle invite links on app load ──────────────────────────
function handleInviteLinks() {
    const params = new URLSearchParams(window.location.search);
    const addFriend = params.get('addFriend');
    const joinGroup = params.get('joinGroup');

    if (addFriend) {
        // Wait for auth then send friend request
        const tryAdd = () => {
            if (window.currentUser && window.currentUserData) {
                if (addFriend !== window.currentUser.uid) {
                    window.sendFriendRequest?.(addFriend);
                }
                // Clean URL
                window.history.replaceState({}, '', window.location.pathname);
            } else {
                setTimeout(tryAdd, 500);
            }
        };
        tryAdd();
    }

    if (joinGroup) {
        const tryJoin = () => {
            if (window.currentUser && window.currentUserData) {
                _joinGroupFromLink(joinGroup);
                window.history.replaceState({}, '', window.location.pathname);
            } else {
                setTimeout(tryJoin, 500);
            }
        };
        tryJoin();
    }
}

async function _joinGroupFromLink(groupId) {
    try {
        const groupDoc = await window.db.collection('groups').doc(groupId).get();
        if (!groupDoc.exists) {
            window.showToast?.('Group not found or link expired', 'error');
            return;
        }
        const group = groupDoc.data();
        const uid   = window.currentUser.uid;

        if ((group.members || []).includes(uid)) {
            window.showToast?.(`Already in "${group.name}"`, 'info');
            return;
        }

        const confirmed = await window.modalManager?.showModal(
            'Join Group',
            `Join "${group.name}"?`,
            'info', 'Join', 'Cancel'
        );
        if (!confirmed) return;

        await window.db.collection('groups').doc(groupId).update({
            members: firebase.firestore.FieldValue.arrayUnion(uid)
        });
        window.showToast?.(`Joined "${group.name}"!`, 'success');
        window.loadGroupsList?.();
    } catch (e) {
        console.error('joinGroup error:', e);
        window.showToast?.('Failed to join group', 'error');
    }
}

async function _copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
}

// ── Expose ────────────────────────────────────────────────────
window.chatInteractions = {
    attach: attachChatInteractions,
    showReactionPicker,
    buildReactionsHTML,
    shareProfileLink,
    shareGroupLink,
    handleInviteLinks
};

// Handle invite links when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handleInviteLinks);
} else {
    handleInviteLinks();
}

console.log('chatInteractions.js loaded');
