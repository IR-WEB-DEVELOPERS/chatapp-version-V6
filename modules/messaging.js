// ============================================================
//  messaging.js — Message display, send, scroll, typing,
//                 seen receipts, pin, voice recording
// ============================================================

// ── Scroll to bottom helper (FIX: chat top problem) ─────────
function scrollToBottom(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    // Double rAF: first frame paints DOM, second frame measures correct scrollHeight
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
        });
    });
}

// Check if user is near bottom (within 120px) — if yes, auto-scroll on new messages
function _isNearBottom(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

// ── Message rendering helpers ─────────────────────────────────
function renderMessageActions(msg, isSent) {
    const safeId   = escapeAttribute(msg.id || '');
    const isPinned = msg.pinned;
    const I = window.Icons;
    const replyIcon  = I ? I.get('reply',   16) : '↩';
    const fwdIcon    = I ? I.get('forward', 16) : '↪';
    const pinIcon    = isPinned ? (I ? I.get('pinFill',16) : '⊕') : (I ? I.get('pin',16) : '⊕');
    const trashIcon  = I ? I.get('trash',   16) : '[del]';
    const editIcon   = I ? I.get('edit',    16) : '[edit]';
    const isSentMsg  = msg.sender === (window.currentUser?.uid || '');
    return `
        <div class="msg-actions">
            <button class="msg-action-btn" data-action="reply"   data-id="${safeId}" title="Reply">${replyIcon}</button>
            <button class="msg-action-btn" data-action="forward" data-id="${safeId}" title="Forward">${fwdIcon}</button>
            <button class="msg-action-btn${isPinned ? ' pinned-active' : ''}" data-action="pin" data-id="${safeId}" title="${isPinned ? 'Unpin' : 'Pin'}">${pinIcon}</button>
            ${isSentMsg ? `<button class="msg-action-btn msg-action-edit" data-action="edit" data-id="${safeId}" title="Edit">${editIcon}</button>` : ''}
            <button class="msg-action-btn msg-action-delete" data-action="delete" data-id="${safeId}" title="Delete">${trashIcon}</button>
        </div>
    `;
}

function renderReplyQuote(msg) {
    if (!msg.replyTo) return '';
    return `
        <div class="reply-quote">
            <span class="reply-quote-author">${escapeHTML(msg.replyTo.senderName || 'User')}</span>
            <span class="reply-quote-text">${escapeHTML((msg.replyTo.text || '').substring(0, 80))}</span>
        </div>
    `;
}

function renderSeenTicks(msg, isSent) {
    if (!isSent) return '';
    const I    = window.Icons;
    const seen = msg.seenBy && msg.seenBy.some(uid => uid !== currentUser.uid);
    if (I) {
        return seen
            ? `<span class="msg-ticks ticks-seen" title="Seen">${I.get('checkDouble', 14)}</span>`
            : `<span class="msg-ticks ticks-delivered" title="Delivered">${I.get('check', 14)}</span>`;
    }
    return seen
        ? '<span class="msg-ticks ticks-seen">✓✓</span>'
        : '<span class="msg-ticks ticks-delivered">✓</span>';
}

function renderVoiceMessage(msg) {
    const safeUrl = escapeAttribute(msg.audioUrl || '');
    const dur     = msg.audioDuration ? `${Math.floor(msg.audioDuration)}s` : '';
    const I = window.Icons;
    const playIcon  = I ? I.get('play',  18) : '▶';
    const pauseIcon = I ? I.get('pause', 18) : '⏸';
    return `
        <div class="voice-msg-bubble">
            <button class="voice-play-btn" data-playing="false"
                onclick="
                    const a=this.nextElementSibling;
                    const playing=a.paused;
                    playing?a.play():a.pause();
                    this.dataset.playing=playing?'true':'false';
                    this.innerHTML=playing?'${pauseIcon.replace(/'/g,"\\'")}':'${playIcon.replace(/'/g,"\\'")}';
                ">${playIcon}</button>
            <audio src="${safeUrl}" style="display:none"
                onended="this.previousElementSibling.dataset.playing='false';this.previousElementSibling.innerHTML='${playIcon.replace(/'/g,"\\'")}';"></audio>
            <div class="voice-waveform">
                <div class="voice-wave-bar"></div><div class="voice-wave-bar"></div><div class="voice-wave-bar"></div>
                <div class="voice-wave-bar"></div><div class="voice-wave-bar"></div><div class="voice-wave-bar"></div>
                <div class="voice-wave-bar"></div><div class="voice-wave-bar"></div>
            </div>
            <span class="voice-duration">${dur}</span>
        </div>
    `;
}


// ── Location message renderer ────────────────────────────────
function renderLocationMessage(msg) {
    const mapsUrl = msg.mapsUrl || `https://www.google.com/maps?q=${msg.lat},${msg.lng}`;
    const lat = msg.lat ? msg.lat.toFixed(5) : '';
    const lng = msg.lng ? msg.lng.toFixed(5) : '';
    const safeUrl = escapeAttribute(mapsUrl);
    return `
    <a class="location-msg-card" href="${safeUrl}" target="_blank" rel="noopener" style="text-decoration:none;display:block;cursor:pointer;">
        <div class="location-map-preview">
            <div class="location-map-bg">
                <div class="location-map-grid"></div>
                <div class="location-pin-dot"></div>
            </div>
        </div>
        <div class="location-msg-info">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <div class="location-msg-text-wrap">
                <div class="location-msg-text">Location shared</div>
                <div class="location-msg-sub">${lat}, ${lng}</div>
            </div>
        </div>
        <div class="location-open-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open in Maps
        </div>
    </a>`;
}

// ── Contact message renderer ─────────────────────────────────
function renderContactMessage(msg) {
    const name = escapeHTML(msg.contactName || 'Contact');
    const phone = escapeHTML(msg.contactPhone || '');
    const rawPhone = escapeAttribute(msg.contactPhone || '');
    return `
    <div class="contact-msg-card">
        <div class="contact-msg-avatar">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <div>
            <div class="contact-msg-name">${name}</div>
            <div class="contact-msg-phone contact-phone-copy" data-phone="${rawPhone}" title="Tap to copy number" style="cursor:pointer;">
                ${phone}
                <svg class="copy-phone-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-left:4px;vertical-align:middle;opacity:0.6;"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </div>
        </div>
    </div>`;
}


function buildMessageHTML(msg, isSent, isGroup) {
    const I          = window.Icons;
    const rawTime    = msg.time || msg.timestamp || Date.now();
    const time       = rawTime?.toDate ? rawTime.toDate() : new Date(rawTime);
    const timeString = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateLabel  = getDateLabel(time);

    if (msg.type === 'call') {
        const callIcon = msg.callType === 'video' ? (I ? I.get('callVideo',16) : '[video]') : (I ? I.get('callPhone',16) : '[call]');
        const missed   = msg.missed ? ' · Missed' : (msg.duration ? ` · ${msg.duration}` : '');
        const who      = isSent ? 'Outgoing call' : 'Incoming call';
        return { html: `
            <div class="message call-log">
                <div class="call-log-bubble">
                    <span class="call-log-icon">${callIcon}</span>
                    <span class="call-log-label">${who}${missed}</span>
                    <span class="call-log-time">${timeString}</span>
                </div>
            </div>
        `, dateLabel };
    }

    if (msg.deletedForAll) {
        return { html: `
            <div class="message ${isSent ? 'sent' : 'received'} deleted-msg">
                <div class="message-text deleted-text"><span class="del-icon"></span> This message was deleted</div>
                <div class="message-time">${timeString}</div>
            </div>
        `, dateLabel };
    }

    // ── One Time View message ────────────────────────────────
    if (msg.oneTimeView && !isSent) {
        if (msg.oneTimeViewOpened) {
            // Already opened by receiver — show "vanished" placeholder
            return { html: `
                <div class="message received deleted-msg otv-expired">
                    <div class="message-text deleted-text"><span class="otv-icon" style="display:inline-flex;vertical-align:middle">${I ? I.get('eyeExpired', 14) : ''}</span> One-time message expired</div>
                    <div class="message-time">${timeString}</div>
                </div>
            `, dateLabel };
        }
        // Not yet opened — show locked bubble with tap-to-view
        return { html: `
            <div class="message received otv-locked" data-id="${escapeAttribute(msg.id || '')}" data-chattype="${isGroup ? 'group' : 'direct'}">
                <div class="otv-bubble" onclick="openOneTimeViewMessage('${escapeAttribute(msg.id || '')}', '${isGroup ? 'group' : 'direct'}')">
                    <span class="otv-eye-icon" style="display:inline-flex">${I ? I.get('eyeView', 20) : ''}</span>
                    <span class="otv-label">Tap to view · <em>disappears after opening</em></span>
                </div>
                <div class="message-time">${timeString}</div>
            </div>
        `, dateLabel };
    }
    if (msg.oneTimeView && isSent) {
        // Sender sees status of their OTV message
        const status = msg.oneTimeViewOpened ? 'Viewed once · deleted' : 'One-time view · waiting';
        return { html: `
            <div class="message sent otv-sent">
                <div class="otv-sent-bubble">
                    <span class="otv-eye-icon" style="display:inline-flex">${I ? I.get('eyeView', 16) : ''}</span>
                    <span class="otv-sent-text">${escapeHTML(msg.text)}</span>
                </div>
                <div class="message-time otv-status-label">${status} · ${timeString}</div>
            </div>
        `, dateLabel };
    }

    if (msg.deletedFor && msg.deletedFor.includes(currentUser.uid)) {
        return { html: '', dateLabel };
    }

    let bodyHtml;
    if (msg.type === 'voice') {
        bodyHtml = renderVoiceMessage(msg);
    } else if (msg.type === 'file' && window.driveShare) {
        bodyHtml = window.driveShare.renderFileMessage(msg, isSent);
    } else if (msg.type === 'location') {
        bodyHtml = renderLocationMessage(msg);
    } else if (msg.type === 'contact') {
        bodyHtml = renderContactMessage(msg);
    } else {
        const rawText = msg.text || '';
        const urlMatches = rawText.match(/(https?:\/\/[^\s<>"]+)/g) || [];
        const linkedText = escapeHTML(rawText).replace(/\n/g, '<br>').replace(
            /(https?:\/\/[^\s<>"&]+)/g,
            '<a href="$1" target="_blank" rel="noopener" class="chat-link">$1</a>'
        );
        const dataLinks = urlMatches.length ? ` data-links='${JSON.stringify(urlMatches).replace(/'/g, "&#39;")}'` : '';
        const editedBadge = msg.edited ? '<span class="edited-badge"> (edited)</span>' : '';
        bodyHtml = `<div class="message-text"${dataLinks}>${linkedText}${editedBadge}</div>`;
    }

    const pinnedBadge = msg.pinned
        ? `<span class="pinned-badge">${I ? I.get('pinFill', 12) : ''}</span>`
        : '';
    const senderLabel = (isGroup && !isSent && msg.sender !== 'system')
        ? `<div class="message-sender">${escapeHTML(msg.senderName || 'User')}</div>` : '';
    const reactionsHTML = window.chatInteractions
        ? window.chatInteractions.buildReactionsHTML(msg.reactions)
        : '';

    return { html: `
        <div class="message ${isSent ? 'sent' : 'received'}${msg.pinned ? ' is-pinned' : ''}" data-id="${escapeAttribute(msg.id || '')}">
            ${renderMessageActions(msg, isSent)}
            ${senderLabel}
            ${renderReplyQuote(msg)}
            ${bodyHtml}
            <div class="message-time">
                ${pinnedBadge}
                ${timeString}
                ${renderSeenTicks(msg, isSent)}
            </div>
            ${reactionsHTML}
        </div>
    `, dateLabel };
}

// ── Shared render core ────────────────────────────────────────
function renderMessagesToHTML(messages, isGroup) {
    let html = '';
    let lastDateLabel = null;
    let archivedSectionStarted = false;
    let archivedSectionEnded   = false;

    messages.forEach(msg => {
        const isSent = msg.sender === currentUser.uid;

        if (msg._archived && !archivedSectionStarted) {
            html += `<div class="date-separator" style="opacity:0.6"><span>Archived messages</span></div>`;
            archivedSectionStarted = true;
        }
        if (!msg._archived && archivedSectionStarted && !archivedSectionEnded) {
            html += `<div class="date-separator" style="opacity:0.6"><span>─── Recent messages ───</span></div>`;
            archivedSectionEnded = true;
        }

        const { html: msgHtml, dateLabel } = buildMessageHTML(msg, isSent, isGroup);

        if (dateLabel !== lastDateLabel) {
            html += `<div class="date-separator"><span>${dateLabel}</span></div>`;
            lastDateLabel = dateLabel;
        }

        html += msgHtml;
    });
    return html;
}

// ── Direct messages display ──────────────────────────────────
async function displayMessages(messages) {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    // ── E2EE: Decrypt messages before rendering ───────────────
    if (window.E2EE && chatWithUID) {
        await Promise.all(messages.map(async msg => {
            if (msg.encryptedText && msg.iv) {
                const peerUid = msg.sender === currentUser.uid ? chatWithUID : msg.sender;
                msg.text = await window.E2EE.decryptDirect(msg, peerUid);
            }
            if (msg.replyTo?.encryptedText && msg.replyTo?.iv) {
                const peerUid = msg.sender === currentUser.uid ? chatWithUID : msg.sender;
                msg.replyTo.text = await window.E2EE.decryptDirect(msg.replyTo, peerUid);
            }
        }));
    }
    // ─────────────────────────────────────────────────────────

    renderPinnedBanner(messages.find(m => m.pinned && !m.deletedForAll), 'direct');
    markMessagesAsSeen(messages);

    const wasNearBottom = _isNearBottom('chat');

    chatContainer.innerHTML = renderMessagesToHTML(messages, false);
    attachMessageActionListeners(chatContainer, messages, 'direct');
    window.chatInteractions?.attach(chatContainer, messages, 'direct');
    attachLinkPreviews(chatContainer);

    // Scroll to bottom only if user was already near bottom (don't hijack manual scroll)
    if (wasNearBottom) {
        scrollToBottom('chat');
        // Also scroll after images load (they change scrollHeight)
        chatContainer.querySelectorAll('img').forEach(img => {
            if (!img.complete) {
                img.addEventListener('load', () => {
                    if (_isNearBottom('chat') || chatContainer.scrollTop === 0) {
                        scrollToBottom('chat');
                    }
                }, { once: true });
            }
        });
    }
}

// ── Group messages display ───────────────────────────────────
async function displayGroupMessages(messages) {
    const chatContainer = document.getElementById('groupChat');
    if (!chatContainer) return;

    // ── E2EE: Decrypt group messages before rendering ─────────
    if (window.E2EE) {
        await Promise.all(messages.map(async msg => {
            if (msg.encryptedText && msg.iv && msg.encryptedKeys) {
                msg.text = await window.E2EE.decryptGroup(msg, msg.sender);
            }
        }));
    }
    // ─────────────────────────────────────────────────────────

    renderPinnedBanner(messages.find(m => m.pinned && !m.deletedForAll), 'group');
    markGroupMessagesAsSeen(messages);

    const wasNearBottomG = _isNearBottom('groupChat');

    chatContainer.innerHTML = renderMessagesToHTML(messages, true);
    attachMessageActionListeners(chatContainer, messages, 'group');
    window.chatInteractions?.attach(chatContainer, messages, 'group');
    attachLinkPreviews(chatContainer);

    if (wasNearBottomG) {
        scrollToBottom('groupChat');
        chatContainer.querySelectorAll('img').forEach(img => {
            if (!img.complete) {
                img.addEventListener('load', () => {
                    if (_isNearBottom('groupChat') || chatContainer.scrollTop === 0) {
                        scrollToBottom('groupChat');
                    }
                }, { once: true });
            }
        });
    }
}

// BUG FIX 1 (cont): separate seen function for group messages
function markGroupMessagesAsSeen(messages) {
    if (!groupChatID || !currentUser) return;
    messages
        .filter(m => m.sender !== currentUser.uid && !(m.seenBy || []).includes(currentUser.uid) && !m.deletedForAll && m.sender !== 'system')
        .forEach(msg => {
            db.collection('groupMessages').doc(msg.id).update({
                seenBy: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
            }).catch(() => {});
        });
}

// ── Load direct messages ─────────────────────────────────────
async function loadMessages() {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    // FIX: chatWithUID ని local variable లో capture చేయాలి
    // async await తర్వాత chatWithUID change అయిపోయే race condition fix
    const capturedUID = chatWithUID;
    const chatId = generateChatId(currentUser.uid, capturedUID);

    directMsgLastDoc      = null;
    directMsgAllLoaded    = false;

    if (unsubscribeDirectMessages) {
        unsubscribeDirectMessages();
        unsubscribeDirectMessages = null;
    }

    // Show cached messages immediately
    const cachedMessages = await hybridCache.getMessages(chatId);
    // FIX: await తర్వాత user వేరే chat కి switch అయి ఉంటే — stale display skip చేయాలి
    if (cachedMessages && cachedMessages.length > 0 && chatWithUID === capturedUID) {
        displayMessages(cachedMessages);
    }

    // FIX: switch అయ్యాక subscription ని create చేయకూడదు
    if (chatWithUID !== capturedUID) return;

    // Inject archive button
    autoBackup.hasArchives(chatId, 'direct').then(() => {
        injectArchiveButton(chatContainer, chatId, 'direct');
    });

    let prevMessageCount = 0;
    let firstMsgSnapshot = true;

    try {
        unsubscribeDirectMessages = db.collection('messages')
            .where('chatId', '==', chatId)
            .orderBy('time', 'desc')
            .limit(MSG_PAGE_SIZE)
            .onSnapshot(snapshot => {
                // FIX: Snapshot callback లో wrong chat update కాకుండా guard చేయాలి
                if (chatWithUID !== capturedUID) return;

                if (!snapshot.empty) {
                    directMsgLastDoc = snapshot.docs[snapshot.docs.length - 1];
                }

                const messages = [];
                snapshot.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
                messages.sort((a, b) => {
                    const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
                    const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
                    return tA - tB;
                });

                // Notify on new incoming message
                if (!firstMsgSnapshot && messages.length > prevMessageCount) {
                    const newest = messages[messages.length - 1];
                    if (newest && newest.sender !== currentUser.uid) {
                        badgeManager.playNotificationSound();
                        if (document.visibilityState !== 'visible' && Notification.permission === 'granted') {
                            new Notification('EduChat — New Message', { body: newest.text, icon: '/favicon.ico' });
                        }
                        getUserData(newest.sender).then(senderData => {
                            toastManager.show({
                                icon: null, type: 'message', title: senderData?.name || 'New Message',
                                body: newest.text, type: 'message', onClick: () => {}
                            });
                        });
                    }
                }

                firstMsgSnapshot = false;
                prevMessageCount = messages.length;
                displayMessages(messages);
                hybridCache.setMessages(chatId, messages);
            }, error => {
                // Index not yet built — fall back to unordered query (client-side sort still works)
                console.warn('loadMessages: index not ready, falling back to unordered query:', error.code);
                if (error.code === 'failed-precondition') {
                    unsubscribeDirectMessages = db.collection('messages')
                        .where('chatId', '==', chatId)
                        .onSnapshot(snapshot => {
                            const messages = [];
                            snapshot.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
                            messages.sort((a, b) => {
                                const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
                                const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
                                return tA - tB;
                            });
                            displayMessages(messages);
                            hybridCache.setMessages(chatId, messages);
                        }, err2 => console.error('loadMessages fallback error:', err2));
                }
            });
    } catch (error) {
        console.error('Error loading messages:', error);
    }
}

// ── Load group messages ──────────────────────────────────────
async function loadGroupMessages() {
    const chatContainer = document.getElementById('groupChat');
    if (!chatContainer) return;

    if (unsubscribeGroupMessages) {
        unsubscribeGroupMessages();
        unsubscribeGroupMessages = null;
    }

    injectArchiveButton(chatContainer, groupChatID, 'group');

    let prevGroupMsgCount  = 0;
    let firstGroupSnapshot = true;

    try {
        unsubscribeGroupMessages = db.collection('groupMessages')
            .where('groupId', '==', groupChatID)
            .orderBy('time', 'desc')
            .limit(MSG_PAGE_SIZE)
            .onSnapshot(snapshot => {
                if (!snapshot.empty) groupMsgLastDoc = snapshot.docs[snapshot.docs.length - 1];

                const messages = [];
                snapshot.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
                messages.sort((a, b) => {
                    const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
                    const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
                    return tA - tB;
                });

                if (!firstGroupSnapshot && messages.length > prevGroupMsgCount) {
                    const newest = messages[messages.length - 1];
                    if (newest && newest.sender !== currentUser.uid && newest.sender !== 'system') {
                        badgeManager.playNotificationSound();
                        if (document.visibilityState !== 'visible' && Notification.permission === 'granted') {
                            const groupChatName = document.getElementById('groupChatName');
                            new Notification(`EduChat — ${groupChatName?.textContent || 'Group'}`, {
                                body: `${newest.senderName || 'Someone'}: ${newest.text}`, icon: '/favicon.ico'
                            });
                        }
                        const groupChatNameEl = document.getElementById('groupChatName');
                        toastManager.show({
                            icon: null, type: 'message',
                            title: groupChatNameEl?.textContent || 'Group Message',
                            body: `${newest.senderName || 'Someone'}: ${newest.text}`,
                            type: 'group'
                        });
                    }
                }

                firstGroupSnapshot = false;
                prevGroupMsgCount  = messages.length;
                displayGroupMessages(messages);
            }, error => {
                // Index not yet built — fall back to unordered query
                console.warn('loadGroupMessages: index not ready, falling back:', error.code);
                if (error.code === 'failed-precondition') {
                    unsubscribeGroupMessages = db.collection('groupMessages')
                        .where('groupId', '==', groupChatID)
                        .onSnapshot(snapshot => {
                            const messages = [];
                            snapshot.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
                            messages.sort((a, b) => {
                                const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
                                const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
                                return tA - tB;
                            });
                            displayGroupMessages(messages);
                        }, err2 => console.error('loadGroupMessages fallback error:', err2));
                }
            });
    } catch (error) {
        console.error('Error loading group messages:', error);
    }
}

// ── Load older direct messages ───────────────────────────────
async function loadOlderDirectMessages() {
    if (directMsgLoadingOlder || directMsgAllLoaded || !directMsgLastDoc) return;
    const chatId        = generateChatId(currentUser.uid, chatWithUID);
    const chatContainer = document.getElementById('chat');
    directMsgLoadingOlder = true;

    const btn = document.getElementById('loadOlderBtn');
    if (btn) btn.textContent = 'Loading...';

    try {
        const snap = await db.collection('messages')
            .where('chatId', '==', chatId)
            .orderBy('time', 'desc')
            .startAfter(directMsgLastDoc)
            .limit(MSG_PAGE_SIZE)
            .get();

        if (snap.empty || snap.docs.length < MSG_PAGE_SIZE) {
            directMsgAllLoaded = true;
            if (btn) btn.style.display = 'none';
        } else {
            directMsgLastDoc = snap.docs[snap.docs.length - 1];
            if (btn) btn.textContent = 'Load older messages';
        }

        const older = [];
        snap.forEach(doc => older.push({ id: doc.id, ...doc.data() }));
        older.sort((a, b) => {
            const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
            const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
            return tA - tB;
        });

        const prevHeight = chatContainer.scrollHeight;
        const cachedNow  = (await hybridCache.getMessages(chatId)) || [];
        displayMessages([...older, ...cachedNow]);
        // Restore scroll position (don't jump to bottom for older messages)
        requestAnimationFrame(() => {
            chatContainer.scrollTop = chatContainer.scrollHeight - prevHeight;
        });
    } catch (e) {
        console.error('loadOlderDirectMessages error:', e);
    } finally {
        directMsgLoadingOlder = false;
    }
}

// ── Load older group messages ────────────────────────────────
async function loadOlderGroupMessages() {
    if (groupMsgAllLoaded || !groupMsgLastDoc) return;
    const chatContainer = document.getElementById('groupChat');
    if (!chatContainer) return;

    const btn = document.getElementById('loadOlderBtn');
    if (btn) btn.textContent = 'Loading...';

    try {
        const snap = await db.collection('groupMessages')
            .where('groupId', '==', groupChatID)
            .orderBy('time', 'desc')
            .startAfter(groupMsgLastDoc)
            .limit(MSG_PAGE_SIZE)
            .get();

        if (snap.empty || snap.docs.length < MSG_PAGE_SIZE) {
            groupMsgAllLoaded = true;
            if (btn) btn.style.display = 'none';
        } else {
            groupMsgLastDoc = snap.docs[snap.docs.length - 1];
            if (btn) btn.textContent = 'Load older messages';
        }

        const older = [];
        snap.forEach(doc => older.push({ id: doc.id, ...doc.data() }));
        older.sort((a, b) => {
            const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
            const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
            return tA - tB;
        });

        const prevHeight = chatContainer.scrollHeight;
        const cachedNow  = (await hybridCache.getMessages(groupChatID)) || [];
        displayGroupMessages([...older, ...cachedNow]);
        requestAnimationFrame(() => {
            chatContainer.scrollTop = chatContainer.scrollHeight - prevHeight;
        });
    } catch (e) {
        console.error('loadOlderGroupMessages error:', e);
        if (btn) btn.textContent = 'Load older messages';
    }
}

// ── Archive button injection ─────────────────────────────────
function injectArchiveButton(container, chatId, type) {
    if (document.getElementById('loadOlderBtn')) return;

    const wrap     = document.createElement('div');
    wrap.style.cssText = 'text-align:center;padding:8px 0 4px;';

    const olderBtn = document.createElement('button');
    olderBtn.id    = 'loadOlderBtn';
    olderBtn.textContent = 'Load older messages';
    olderBtn.style.cssText = 'font-size:12px;padding:4px 14px;border-radius:20px;border:1px solid #ccc;background:transparent;cursor:pointer;margin-right:6px;';
    olderBtn.onclick = () => type === 'group' ? loadOlderGroupMessages() : loadOlderDirectMessages();

    const archBtn = document.createElement('button');
    archBtn.id    = 'loadArchiveBtn';
    archBtn.textContent = 'Load archived messages';
    archBtn.style.cssText = 'font-size:12px;padding:4px 14px;border-radius:20px;border:1px solid #6366f1;color:#6366f1;background:transparent;cursor:pointer;';
    archBtn.onclick = () => loadArchivedMessages(chatId, type);

    wrap.appendChild(olderBtn);
    wrap.appendChild(archBtn);
    container.insertBefore(wrap, container.firstChild);
}

// ── Load archived messages ───────────────────────────────────
async function loadArchivedMessages(chatId, type) {
    const chatContainer = document.getElementById(type === 'group' ? 'groupChat' : 'chat');
    if (!chatContainer) return;

    const archBtn = document.getElementById('loadArchiveBtn');
    if (archBtn) { archBtn.textContent = 'Fetching from Drive...'; archBtn.disabled = true; }

    showToast('Loading archived messages from Drive...', 'info');

    const archived = await autoBackup.fetchArchived(chatId, type);

    if (archived.length === 0) {
        showToast('No archived messages found', 'info');
        if (archBtn) { archBtn.textContent = 'Load archived messages'; archBtn.disabled = false; }
        return;
    }

    const cachedNow    = (await hybridCache.getMessages(chatId)) || [];
    const normalised   = archived.map(m => ({ ...m, _archived: true }));
    const allMsgs      = [...normalised, ...cachedNow];

    if (type === 'group') displayGroupMessages(allMsgs);
    else                  displayMessages(allMsgs);

    if (archBtn) archBtn.style.display = 'none';
    showToast(`Loaded ${archived.length} archived messages`, 'success');
}

// ── Send direct message ──────────────────────────────────────
async function sendMessage() {
    const input = document.getElementById('msg');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !chatWithUID) return;

    // Handle edit mode
    if (editingMsgId && editingChatType === 'direct') {
        await saveEditedMessage(text, 'direct');
        return;
    }

    try {
        const chatId  = generateChatId(currentUser.uid, chatWithUID);
        const msgData = {
            chatId,
            participants: [currentUser.uid, chatWithUID],
            sender: currentUser.uid,
            text,
            time: new Date(),
            type: 'text',
            delivered: true,
            seenBy: []
        };
        if (replyingTo) msgData.replyTo = replyingTo;
        // Vanish mode flag — if vanish mode is on for this chat
        const _vanishKey = `vanishMode_${chatId}`;
        if (localStorage.getItem(_vanishKey) === 'true') {
            msgData.vanishMode = true;
        }
        // One Time View flag — set by toggle button
        if (window._oneTimeViewEnabled) {
            msgData.oneTimeView = true;
            msgData.oneTimeViewOpened = false;
        }

        // ── Message Expiry: add expiresAt if timer is set ───────
        if (window.msgExpiry && chatId) {
            const expiresAt = await window.msgExpiry.getExpiresAt(chatId, false);
            if (expiresAt) msgData.expiresAt = expiresAt;
        }
        // ─────────────────────────────────────────────────────

        // ── E2EE: Encrypt before saving ──────────────────────
        if (window.E2EE) {
            const enc = await window.E2EE.encryptDirect(text, chatWithUID);
            if (enc) {
                msgData.encryptedText = enc.encryptedText;
                msgData.iv            = enc.iv;
                delete msgData.text;   // don't store plaintext
            }
            // Encrypt replyTo.text if present
            if (msgData.replyTo?.text && enc) {
                const encReply = await window.E2EE.encryptDirect(msgData.replyTo.text, chatWithUID);
                if (encReply) {
                    msgData.replyTo.encryptedText = encReply.encryptedText;
                    msgData.replyTo.iv            = encReply.iv;
                    delete msgData.replyTo.text;
                }
            }
        }
        // ─────────────────────────────────────────────────────

        await db.collection('messages').add(msgData);
        input.value = '';
        input.style.height = 'auto';
        cancelReply('directReplyBar');
        clearTypingIndicator();
        // Reset one-time view toggle after each send
        if (window._oneTimeViewEnabled) {
            window._oneTimeViewEnabled = false;
            const ind = document.getElementById('otvIndicator');
            if (ind) ind.style.display = 'none';
            const badge = document.getElementById('tbOtvBadge');
            if (badge) badge.style.display = 'none';
            const otvBtn = document.getElementById('tbOtvBtn');
            if (otvBtn) otvBtn.classList.remove('tb-item-active');
        }

        await db.collection('users').doc(chatWithUID).update({
            [`unreadCounts.${chatId}`]: firebase.firestore.FieldValue.increment(1)
        });

        // Push notification to receiver
        if (window.pushNotifications) {
            window.pushNotifications.notifyNewMessage({
                toUID:       chatWithUID,
                fromName:    currentUserData?.name || 'Someone',
                messageText: text,
                chatId,
                isGroup:     false
            });
        }
    } catch (error) {
        console.error('Error sending message:', error);
        modalManager.showModal('Error', 'Failed to send message', 'error');
    }
}

// ── Send group message ───────────────────────────────────────
async function sendGroupMessage() {
    const input = document.getElementById('groupMsg');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !groupChatID) return;

    // Handle edit mode
    if (editingMsgId && editingChatType === 'group') {
        await saveEditedMessage(text, 'group');
        return;
    }

    try {
        const msgData = {
            groupId:    groupChatID,
            sender:     currentUser.uid,
            senderName: currentUserData?.name || 'User',
            text,
            time:       new Date(),
            type:       'text',
            delivered:  true,
            seenBy:     []
        };
        if (replyingTo) msgData.replyTo = replyingTo;
        // One Time View flag
        if (window._oneTimeViewEnabled) {
            msgData.oneTimeView = true;
            msgData.oneTimeViewOpened = false;
        }

        // ── E2EE: Encrypt group message before saving ─────────
        if (window.E2EE && groupChatID) {
            try {
                const groupDoc  = await db.collection('groups').doc(groupChatID).get();
                const memberUids = groupDoc.data()?.members || [];
                if (memberUids.length > 0) {
                    const enc = await window.E2EE.encryptGroup(text, memberUids);
                    if (enc) {
                        msgData.encryptedText = enc.encryptedText;
                        msgData.iv            = enc.iv;
                        msgData.encryptedKeys = enc.encryptedKeys;
                        delete msgData.text;
                    }
                }
            } catch (e) { console.warn('[E2EE] Group encrypt skipped:', e); }
        }
        // ─────────────────────────────────────────────────────

        await db.collection('groupMessages').add(msgData);
        input.value = '';
        input.style.height = 'auto';
        cancelReply('groupReplyBar');
        // Reset one-time view toggle after each send
        if (window._oneTimeViewEnabled) {
            window._oneTimeViewEnabled = false;
            const ind = document.getElementById('otvGroupIndicator');
            if (ind) ind.style.display = 'none';
            const badge = document.getElementById('tbOtvGroupBadge');
            if (badge) badge.style.display = 'none';
            const otvBtn = document.getElementById('tbOtvGroupBtn');
            if (otvBtn) otvBtn.classList.remove('tb-item-active');
        }

        // Push notification to all group members (except sender)
        if (window.pushNotifications) {
            try {
                const groupDoc = await db.collection('groups').doc(groupChatID).get();
                const groupData = groupDoc.data();
                const members = (groupData?.members || []).filter(uid => uid !== currentUser.uid);
                const groupName = groupData?.name || 'Group';
                members.forEach(uid => {
                    window.pushNotifications.notifyNewMessage({
                        toUID:       uid,
                        fromName:    currentUserData?.name || 'Someone',
                        messageText: text,
                        chatId:      groupChatID,
                        isGroup:     true,
                        groupName
                    });
                });
            } catch (e) { /* non-critical */ }
        }
    } catch (error) {
        console.error('Error sending group message:', error);
        modalManager.showModal('Error', 'Failed to send message', 'error');
    }
}

// ── Reply helpers ────────────────────────────────────────────
async function setReply(msg, chatType) {
    let senderName = msg.senderName || '';
    if (!senderName) {
        if (msg.sender === currentUser.uid) {
            senderName = currentUserData?.name || 'You';
        } else {
            const ud = await getUserData(msg.sender).catch(() => null);
            senderName = ud?.name || 'User';
        }
    }
    replyingTo = { id: msg.id, text: msg.text || '', senderName };

    const inputId     = chatType === 'group' ? 'groupMsg' : 'msg';
    const containerId = chatType === 'group' ? 'groupReplyBar' : 'directReplyBar';

    let bar = document.getElementById(containerId);
    if (!bar) {
        const inputArea = document.getElementById(inputId)?.closest('.message-input');
        if (inputArea) {
            bar = document.createElement('div');
            bar.id        = containerId;
            bar.className = 'reply-bar';
            bar.innerHTML = `
                <div class="reply-bar-inner">
                    <span class="reply-bar-icon">${window.Icons ? window.Icons.get('reply', 16) : '↩'}</span>
                    <div class="reply-bar-content">
                        <span class="reply-bar-author">${escapeHTML(replyingTo.senderName)}</span>
                        <span class="reply-bar-text">${escapeHTML(replyingTo.text.substring(0, 60))}</span>
                    </div>
                    <button class="reply-bar-cancel" id="${containerId}Cancel">${window.Icons ? window.Icons.get('close', 16) : '✕'}</button>
                </div>
            `;
            inputArea.insertBefore(bar, inputArea.firstChild);
            document.getElementById(containerId + 'Cancel').onclick = () => cancelReply(containerId);
        }
    } else {
        bar.querySelector('.reply-bar-author').textContent = replyingTo.senderName;
        bar.querySelector('.reply-bar-text').textContent   = replyingTo.text.substring(0, 60);
        bar.style.display = '';
    }
    document.getElementById(inputId)?.focus();
}

function cancelReply(containerId) {
    replyingTo = null;
    const bar  = document.getElementById(containerId);
    if (bar) bar.style.display = 'none';
}

// ── Delete menu ──────────────────────────────────────────────
async function showDeleteMenu(msgId, chatType) {
    const overlay = document.createElement('div');
    overlay.className = 'delete-overlay';
    overlay.innerHTML = `
        <div class="delete-sheet">
            <p class="delete-sheet-title">Delete message?</p>
            <button class="delete-opt delete-for-me">Delete for Me</button>
            <button class="delete-opt delete-for-all">Delete for Everyone</button>
            <button class="delete-opt delete-cancel">Cancel</button>
        </div>
    `;
    document.body.appendChild(overlay);

    const collection = chatType === 'group' ? 'groupMessages' : 'messages';

    overlay.querySelector('.delete-for-me').onclick = async () => {
        try {
            await db.collection(collection).doc(msgId).update({
                deletedFor: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
            });
        } catch (e) { console.error(e); }
        overlay.remove();
    };
    overlay.querySelector('.delete-for-all').onclick = async () => {
        // Find the message to check the 5-min window
        try {
            const msgDoc = await db.collection(collection).doc(msgId).get();
            const msgData = msgDoc.data();
            const msgTime = msgData?.time?.toDate ? msgData.time.toDate() : new Date(msgData?.time);
            const elapsed = Date.now() - msgTime.getTime();
            if (msgData?.sender !== currentUser.uid || elapsed > 5 * 60 * 1000) {
                overlay.remove();
                toastManager.show({ icon: null, type: 'info', title: 'Cannot delete for everyone', body: 'Only available within 5 minutes of sending.', duration: 3500 });
                return;
            }
            await db.collection(collection).doc(msgId).update({ deletedForAll: true });
        } catch (e) { console.error(e); }
        overlay.remove();
    };
    overlay.querySelector('.delete-cancel').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// ── Forward modal ────────────────────────────────────────────
async function showForwardModal(msg) {
    const friends = currentUserData.friends || [];
    if (friends.length === 0) {
        modalManager.showModal('Forward', 'No friends to forward to.', 'info');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'delete-overlay';

    let friendsHtml = '';
    for (const uid of friends) {
        const fd = await getUserData(uid);
        if (fd) friendsHtml += `<button class="forward-friend-btn" data-uid="${escapeAttribute(uid)}">${escapeHTML(fd.name)}</button>`;
    }

    overlay.innerHTML = `
        <div class="delete-sheet">
            <p class="delete-sheet-title">Forward to...</p>
            <div class="forward-list">${friendsHtml}</div>
            <button class="delete-opt delete-cancel" style="margin-top:8px">Cancel</button>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('.forward-friend-btn').forEach(btn => {
        btn.onclick = async () => {
            const toUID  = btn.dataset.uid;
            const chatId = generateChatId(currentUser.uid, toUID);
            try {
                await db.collection('messages').add({
                    chatId,
                    participants: [currentUser.uid, toUID],
                    sender:       currentUser.uid,
                    text:         msg.text || '',
                    time:         new Date(),
                    type:         msg.type || 'text',
                    forwarded:    true
                });
                await db.collection('users').doc(toUID).update({
                    [`unreadCounts.${chatId}`]: firebase.firestore.FieldValue.increment(1)
                });
            } catch (e) { console.error(e); }
            overlay.remove();
            toastManager.show({ icon: null, type: 'success', title: 'Forwarded', body: `Message forwarded to ${btn.textContent}`, type: 'message', duration: 2500 });
        };
    });
    overlay.querySelector('.delete-cancel').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// ── Attach action listeners ───────────────────────────────────
function attachMessageActionListeners(container, messages, chatType) {
    container.querySelectorAll('.msg-action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const msgId  = btn.dataset.id;
            const msg    = messages.find(m => m.id === msgId);
            if (!msg) return;

            if (action === 'reply')      await setReply(msg, chatType);
            else if (action === 'forward') showForwardModal(msg);
            else if (action === 'delete')  showDeleteMenu(msgId, chatType);
            else if (action === 'pin')     togglePinMessage(msgId, chatType, !msg.pinned);
            else if (action === 'edit')    startEditMessage(msg, chatType);
        });
    });
}

// ── Typing indicator ─────────────────────────────────────────
function setTypingIndicator(isTyping) {
    if (!chatWithUID || !currentUser) return;
    const chatId = generateChatId(currentUser.uid, chatWithUID);
    const ref    = db.collection('typing').doc(chatId);
    ref.set({ [currentUser.uid]: isTyping }, { merge: true }).catch(() => {});
}

function clearTypingIndicator() {
    if (typingTimeout) clearTimeout(typingTimeout);
    setTypingIndicator(false);
}

function listenTypingIndicator() {
    if (!chatWithUID || !currentUser) return;
    if (unsubscribeTyping) { unsubscribeTyping(); unsubscribeTyping = null; }
    const chatId = generateChatId(currentUser.uid, chatWithUID);
    unsubscribeTyping = db.collection('typing').doc(chatId).onSnapshot(doc => {
        const data            = doc.data() || {};
        const isPartnerTyping = data[chatWithUID] === true;
        const el              = document.getElementById('typingIndicator');
        if (el) el.style.display = isPartnerTyping ? 'flex' : 'none';
    });
}

function onTypingInput() {
    setTypingIndicator(true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => setTypingIndicator(false), 2500);
}

// ── Seen receipts ────────────────────────────────────────────
function markMessagesAsSeen(messages) {
    if (!chatWithUID || !currentUser) return;
    messages
        .filter(m => m.sender !== currentUser.uid && !(m.seenBy || []).includes(currentUser.uid) && !m.deletedForAll)
        .forEach(msg => {
            db.collection('messages').doc(msg.id).update({
                seenBy: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
            }).catch(() => {});
        });
}

// ── Pin messages ─────────────────────────────────────────────
async function togglePinMessage(msgId, chatType, shouldPin) {
    const collection = chatType === 'group' ? 'groupMessages' : 'messages';
    const chatId     = chatType === 'group' ? groupChatID : generateChatId(currentUser.uid, chatWithUID);
    const field      = chatType === 'group' ? 'groupId' : 'chatId';

    try {
        const pinned = await db.collection(collection).where(field, '==', chatId).where('pinned', '==', true).get();
        const batch  = db.batch();
        pinned.forEach(doc => batch.update(doc.ref, { pinned: false }));
        if (shouldPin) batch.update(db.collection(collection).doc(msgId), { pinned: true });
        await batch.commit();
        toastManager.show({ icon: null, type: shouldPin ? 'success' : 'info', title: shouldPin ? 'Message pinned' : 'Message unpinned', body: '', type: 'info', duration: 2000 });
    } catch (e) { console.error('Pin error:', e); }
}

function renderPinnedBanner(pinnedMsg, chatType) {
    const containerId = chatType === 'group' ? 'groupChat'       : 'chat';
    const bannerId    = chatType === 'group' ? 'groupPinnedBanner' : 'directPinnedBanner';

    let banner        = document.getElementById(bannerId);
    const container   = document.getElementById(containerId);
    if (!container) return;
    const parent = container.parentElement;
    if (!parent)  return;

    if (!pinnedMsg) { if (banner) banner.remove(); return; }

    if (!banner) {
        banner = document.createElement('div');
        banner.id        = bannerId;
        banner.className = 'pinned-banner';
        parent.insertBefore(banner, container);
    }

    const text = pinnedMsg.type === 'voice' ? 'Voice message' : (pinnedMsg.text || '').substring(0, 60);
    const I = window.Icons;
    const pinIc   = I ? I.get('pinFill', 16) : '📌';
    const closeIc = I ? I.get('close',   16) : '✕';
    banner.innerHTML = `
        <span class="pinned-banner-icon">${pinIc}</span>
        <div class="pinned-banner-content">
            <span class="pinned-banner-label">Pinned Message</span>
            <span class="pinned-banner-text">${escapeHTML(text)}</span>
        </div>
        <button class="pinned-banner-close" onclick="togglePinMessage('${escapeAttribute(pinnedMsg.id)}','${chatType}',false)">${closeIc}</button>
    `;
}

// ── Voice recording ──────────────────────────────────────────
async function startVoiceRecording(chatType) {
    if (isRecording) { stopVoiceRecording(chatType); return; }
    try {
        const stream  = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks   = [];
        isRecording   = true;
        recordingSeconds = 0;

        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(audioChunks, { type: 'audio/webm' });
            await uploadAndSendVoice(blob, recordingSeconds, chatType);
        };

        mediaRecorder.start(100);

        const btn = document.getElementById(chatType === 'group' ? 'groupVoiceBtn' : 'voiceBtn');
        if (btn) { btn.classList.add('recording'); btn.title = 'Stop recording'; btn.innerHTML = window.Icons ? window.Icons.get('micStop', 20) : '[stop]'; }

        const timerEl = document.getElementById(chatType === 'group' ? 'groupVoiceTimer' : 'voiceTimer');
        if (timerEl) timerEl.style.display = 'inline';

        recordingTimer = setInterval(() => {
            recordingSeconds++;
            if (timerEl) timerEl.textContent = `${Math.floor(recordingSeconds/60).toString().padStart(2,'0')}:${(recordingSeconds%60).toString().padStart(2,'0')}`;
            if (recordingSeconds >= 120) stopVoiceRecording(chatType);
        }, 1000);

    } catch (e) {
        console.error('Mic error:', e);
        modalManager.showModal('Error', 'Microphone access denied. Please allow mic permission.', 'error');
    }
}

function stopVoiceRecording(chatType) {
    if (!isRecording || !mediaRecorder) return;
    isRecording = false;
    if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
    mediaRecorder.stop();

    const btn = document.getElementById(chatType === 'group' ? 'groupVoiceBtn' : 'voiceBtn');
    if (btn) { btn.classList.remove('recording'); btn.title = 'Voice message'; btn.innerHTML = window.Icons ? window.Icons.get('mic', 20) : '[mic]'; }

    const timerEl = document.getElementById(chatType === 'group' ? 'groupVoiceTimer' : 'voiceTimer');
    if (timerEl) { timerEl.style.display = 'none'; timerEl.textContent = '00:00'; }
}

async function uploadAndSendVoice(blob, duration, chatType) {
    try {
        const storage = firebase.storage ? firebase.storage() : null;
        let audioUrl  = '';

        if (storage) {
            const fileName = `voice_${currentUser.uid}_${Date.now()}.webm`;
            const ref      = storage.ref(`voice/${fileName}`);
            await ref.put(blob);
            audioUrl = await ref.getDownloadURL();
        } else {
            audioUrl = await new Promise(res => {
                const reader    = new FileReader();
                reader.onload   = () => res(reader.result);
                reader.readAsDataURL(blob);
            });
        }

        if (chatType === 'group') {
            await db.collection('groupMessages').add({
                groupId: groupChatID, sender: currentUser.uid,
                senderName: currentUserData?.name || 'User',
                type: 'voice', audioUrl, audioDuration: duration,
                time: new Date(), delivered: true, seenBy: []
            });
            if (replyingTo) cancelReply('groupReplyBar');
        } else {
            const chatId = generateChatId(currentUser.uid, chatWithUID);
            await db.collection('messages').add({
                chatId, participants: [currentUser.uid, chatWithUID],
                sender: currentUser.uid, type: 'voice', audioUrl,
                audioDuration: duration, time: new Date(), delivered: true, seenBy: []
            });
            await db.collection('users').doc(chatWithUID).update({
                [`unreadCounts.${chatId}`]: firebase.firestore.FieldValue.increment(1)
            });
        }
    } catch (e) {
        console.error('Voice upload error:', e);
        modalManager.showModal('Error', 'Failed to send voice message', 'error');
    }
}

// ── Mark as read ─────────────────────────────────────────────
function markChatAsRead(chatId) {
    if (unreadMap[chatId]) {
        unreadMap[chatId] = 0;
        db.collection('users').doc(currentUser.uid).update({
            [`unreadCounts.${chatId}`]: 0
        }).catch(console.error);
        loadFriendsList();
    }
}

// ============================================================
//  FEATURE: Link Preview
// ============================================================
const URL_REGEX = /(https?:\/\/[^\s<>"]+)/g;

async function fetchLinkPreview(url) {
    try {
        // Use allorigins proxy to avoid CORS
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        const res = await fetch(proxyUrl);
        const data = await res.json();
        const html = data.contents || '';
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const getMeta = (prop) =>
            doc.querySelector(`meta[property="${prop}"]`)?.content ||
            doc.querySelector(`meta[name="${prop}"]`)?.content || '';

        const title = getMeta('og:title') || doc.title || '';
        const description = getMeta('og:description') || getMeta('description') || '';
        const image = getMeta('og:image') || '';
        const siteName = getMeta('og:site_name') || new URL(url).hostname;

        if (!title && !description) return null;
        return { url, title, description, image, siteName };
    } catch (e) {
        return null;
    }
}

function renderLinkPreview(preview) {
    if (!preview) return '';
    return `
        <a class="link-preview" href="${escapeAttribute(preview.url)}" target="_blank" rel="noopener">
            ${preview.image ? `<img class="link-preview-img" src="${escapeAttribute(preview.image)}" alt="" onerror="this.style.display='none'">` : ''}
            <div class="link-preview-body">
                <span class="link-preview-site">${escapeHTML(preview.siteName)}</span>
                <span class="link-preview-title">${escapeHTML(preview.title)}</span>
                ${preview.description ? `<span class="link-preview-desc">${escapeHTML(preview.description.substring(0, 100))}</span>` : ''}
            </div>
        </a>
    `;
}

// Cache previews in memory to avoid refetching
const _previewCache = {};

// URLs that must never go through the CORS proxy / link-preview
const _SKIP_PREVIEW_HOSTS = [
    'maps.google.com',
    'www.google.com',   // covers /maps paths
    'goo.gl',
    'maps.app.goo.gl',
];

function _shouldSkipLinkPreview(url) {
    try {
        const { hostname, pathname } = new URL(url);
        if (_SKIP_PREVIEW_HOSTS.includes(hostname)) return true;
        // catch google.com/maps/* even if hostname differs slightly
        if (hostname.endsWith('google.com') && pathname.startsWith('/maps')) return true;
    } catch (_) { /* ignore bad URLs */ }
    return false;
}

async function attachLinkPreviews(container) {
    const msgEls = container.querySelectorAll('.message-text[data-links]');
    for (const el of msgEls) {
        const urls = JSON.parse(el.dataset.links || '[]');
        if (!urls.length) continue;
        // Pick the first URL that is safe to preview
        const url = urls.find(u => !_shouldSkipLinkPreview(u));
        if (!url) continue;
        if (!_previewCache[url]) {
            _previewCache[url] = await fetchLinkPreview(url);
        }
        const preview = _previewCache[url];
        if (preview) {
            const previewEl = document.createElement('div');
            previewEl.innerHTML = renderLinkPreview(preview);
            el.parentElement.insertBefore(previewEl.firstChild, el.nextSibling);
        }
    }
}

// ============================================================
//  FEATURE: Edit Message (5-min window)
// ============================================================
let editingMsgId = null;
let editingChatType = null;

function canEditOrDelete(msg) {
    if (msg.sender !== currentUser.uid) return false;
    const msgTime = msg.time?.toDate ? msg.time.toDate() : new Date(msg.time);
    return (Date.now() - msgTime.getTime()) < 5 * 60 * 1000; // 5 minutes
}

async function startEditMessage(msg, chatType) {
    if (!canEditOrDelete(msg)) {
        toastManager.show({ icon: null, type: 'info', title: 'Cannot edit', body: 'Messages can only be edited within 5 minutes of sending.', duration: 3000 });
        return;
    }
    editingMsgId = msg.id;
    editingChatType = chatType;

    const inputId = chatType === 'group' ? 'groupMsg' : 'msg';
    const input = document.getElementById(inputId);
    if (!input) return;

    input.value = msg.text || '';
    input.focus();
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';

    // Show edit bar
    const barId = chatType === 'group' ? 'groupEditBar' : 'directEditBar';
    let bar = document.getElementById(barId);
    const containerId = chatType === 'group' ? 'groupMsg' : 'msg';
    if (!bar) {
        const inputArea = document.getElementById(containerId)?.closest('.message-input');
        if (inputArea) {
            bar = document.createElement('div');
            bar.id = barId;
            bar.className = 'edit-bar';
            bar.innerHTML = `
                <div class="edit-bar-inner">
                    <span class="edit-bar-icon">${window.Icons ? window.Icons.get('edit', 16) : '✏️'}</span>
                    <span class="edit-bar-label">Editing message</span>
                    <button class="edit-bar-cancel" id="${barId}Cancel">${window.Icons ? window.Icons.get('close', 16) : '✕'}</button>
                </div>
            `;
            inputArea.insertBefore(bar, inputArea.firstChild);
            document.getElementById(barId + 'Cancel').onclick = () => cancelEdit(barId, inputId);
        }
    } else {
        bar.style.display = '';
    }
}

function cancelEdit(barId, inputId) {
    editingMsgId = null;
    editingChatType = null;
    const bar = document.getElementById(barId);
    if (bar) bar.style.display = 'none';
    const input = document.getElementById(inputId);
    if (input) { input.value = ''; }
}

async function saveEditedMessage(text, chatType) {
    if (!editingMsgId) return false;
    const collection = chatType === 'group' ? 'groupMessages' : 'messages';
    try {
        let updateData = { text, editedAt: new Date(), edited: true };

        // ── E2EE: Encrypt edited text ─────────────────────────
        if (window.E2EE) {
            if (chatType === 'direct' && chatWithUID) {
                const enc = await window.E2EE.encryptDirect(text, chatWithUID);
                if (enc) {
                    updateData.encryptedText = enc.encryptedText;
                    updateData.iv            = enc.iv;
                    delete updateData.text;
                }
            } else if (chatType === 'group' && groupChatID) {
                try {
                    const groupDoc   = await db.collection('groups').doc(groupChatID).get();
                    const memberUids = groupDoc.data()?.members || [];
                    const enc        = await window.E2EE.encryptGroup(text, memberUids);
                    if (enc) {
                        updateData.encryptedText = enc.encryptedText;
                        updateData.iv            = enc.iv;
                        updateData.encryptedKeys = enc.encryptedKeys;
                        delete updateData.text;
                    }
                } catch (e) { /* fall back to plaintext */ }
            }
        }
        // ─────────────────────────────────────────────────────

        await db.collection(collection).doc(editingMsgId).update(updateData);
        const barId = chatType === 'group' ? 'groupEditBar' : 'directEditBar';
        const inputId = chatType === 'group' ? 'groupMsg' : 'msg';
        cancelEdit(barId, inputId);
        toastManager.show({ icon: null, type: 'success', title: 'Message edited', body: '', duration: 2000 });
        return true;
    } catch (e) {
        console.error('Edit error:', e);
        return false;
    }
}

// ============================================================
//  FEATURE: Schedule Message
// ============================================================
let scheduleForChatType = null;

function showScheduleModal(chatType) {
    scheduleForChatType = chatType;
    const inputId = chatType === 'group' ? 'groupMsg' : 'msg';
    const text = document.getElementById(inputId)?.value?.trim();

    if (!text) {
        toastManager.show({ icon: null, type: 'info', title: 'Type a message first', body: 'Write your message before scheduling.', duration: 2500 });
        return;
    }

    // Min datetime = now + 1 min
    const minDate = new Date(Date.now() + 60000);
    const minStr = minDate.toISOString().slice(0, 16);

    const overlay = document.createElement('div');
    overlay.className = 'delete-overlay';
    overlay.id = 'scheduleOverlay';
    overlay.innerHTML = `
        <div class="delete-sheet schedule-sheet">
            <p class="delete-sheet-title">Schedule Message</p>
            <div class="schedule-preview">${escapeHTML(text.substring(0, 80))}${text.length > 80 ? '…' : ''}</div>
            <label class="schedule-label">Send at</label>
            <input type="datetime-local" id="scheduleTime" class="schedule-input" min="${minStr}" value="${minStr}">
            <button class="delete-opt" id="confirmScheduleBtn" style="background:var(--accent);color:#fff;margin-top:12px;">Schedule</button>
            <button class="delete-opt delete-cancel">Cancel</button>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('confirmScheduleBtn').onclick = () => confirmScheduleMessage(text, chatType);
    overlay.querySelector('.delete-cancel').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

async function confirmScheduleMessage(text, chatType) {
    const timeInput = document.getElementById('scheduleTime');
    if (!timeInput?.value) return;

    const scheduledAt = new Date(timeInput.value);
    if (scheduledAt <= new Date()) {
        toastManager.show({ icon: null, type: 'info', title: 'Choose a future time', body: '', duration: 2000 });
        return;
    }

    const scheduledMsg = {
        text,
        chatType,
        scheduledAt: scheduledAt.getTime(),
        sender: currentUser.uid,
        createdAt: Date.now(),
        // BUG FIX 3: The document was saved WITHOUT a `sent` field, but
        // restoreScheduledMessages() queries for `.where('sent', '==', false)`.
        // Firestore does not match documents where a field is absent — only
        // documents where the field exists and equals false. So every scheduled
        // message was orphaned on page reload and never dispatched.
        sent: false
    };

    if (chatType === 'group') {
        scheduledMsg.groupId = groupChatID;
        scheduledMsg.senderName = currentUserData?.name || 'User';
    } else {
        scheduledMsg.chatWithUID = chatWithUID;
        scheduledMsg.chatId = generateChatId(currentUser.uid, chatWithUID);
    }

    // Save to Firestore scheduled_messages collection
    await db.collection('scheduled_messages').add(scheduledMsg);

    // Clear input
    const inputId = chatType === 'group' ? 'groupMsg' : 'msg';
    const input = document.getElementById(inputId);
    if (input) { input.value = ''; input.style.height = 'auto'; }

    document.getElementById('scheduleOverlay')?.remove();

    const timeStr = scheduledAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    toastManager.show({ icon: null, type: 'success', title: 'Message scheduled!', body: `Will send at ${timeStr}`, duration: 3500 });

    // Start local scheduler to fire at the right time
    const delay = scheduledAt.getTime() - Date.now();
    setTimeout(() => dispatchScheduledMessage(scheduledMsg), delay);
}

async function dispatchScheduledMessage(msg) {
    try {
        if (msg.chatType === 'group') {
            await db.collection('groupMessages').add({
                groupId: msg.groupId,
                sender: msg.sender,
                senderName: msg.senderName,
                text: msg.text,
                time: new Date(),
                type: 'text',
                delivered: true,
                seenBy: []
            });
        } else {
            await db.collection('messages').add({
                chatId: msg.chatId,
                participants: [msg.sender, msg.chatWithUID],
                sender: msg.sender,
                text: msg.text,
                time: new Date(),
                type: 'text',
                delivered: true,
                seenBy: []
            });
            await db.collection('users').doc(msg.chatWithUID).update({
                [`unreadCounts.${msg.chatId}`]: firebase.firestore.FieldValue.increment(1)
            });
        }
        // Mark as sent in Firestore
        await db.collection('scheduled_messages')
            .where('chatId', '==', msg.chatId || '')
            .where('scheduledAt', '==', msg.scheduledAt)
            .get().then(snap => snap.forEach(d => d.ref.update({ sent: true })));
    } catch (e) {
        console.error('Scheduled message dispatch error:', e);
    }
}

// Re-register pending scheduled messages on page load
async function restoreScheduledMessages() {
    try {
        const snap = await db.collection('scheduled_messages')
            .where('sender', '==', currentUser.uid)
            .where('sent', '==', false)
            .get();
        snap.forEach(doc => {
            const msg = doc.data();
            const delay = msg.scheduledAt - Date.now();
            if (delay > 0) {
                setTimeout(() => dispatchScheduledMessage(msg), delay);
            } else {
                // Overdue — send immediately
                dispatchScheduledMessage(msg);
            }
        });
    } catch (e) { /* collection may not exist yet */ }
}

window.showScheduleModal = showScheduleModal;
window.startEditMessage  = startEditMessage;
window.cancelEdit        = cancelEdit;


// ── Expose ───────────────────────────────────────────────────
window.displayMessages       = displayMessages;
window.displayGroupMessages  = displayGroupMessages;
window.markGroupMessagesAsSeen = markGroupMessagesAsSeen;
window.loadMessages          = loadMessages;
window.loadGroupMessages     = loadGroupMessages;
window.loadOlderDirectMessages = loadOlderDirectMessages;
window.loadOlderGroupMessages  = loadOlderGroupMessages;
window.sendMessage           = sendMessage;
window.sendGroupMessage      = sendGroupMessage;
window.setReply              = setReply;
window.cancelReply           = cancelReply;
window.showDeleteMenu        = showDeleteMenu;
// ── One Time View — open & delete ───────────────────────────
async function openOneTimeViewMessage(msgId, chatType) {
    if (!msgId || !currentUser) return;
    const collection = chatType === 'group' ? 'groupMessages' : 'messages';
    // BUG FIX 2: `I` (Icons) was used inside this function but never defined
    // locally. All other functions that use Icons define `const I = window.Icons`
    // at the top. Without it, the OTV modal header showed a JS ReferenceError
    // instead of the eye icon, and on some browsers silently failed to open.
    const I = window.Icons;
    try {
        // 1. Mark as opened immediately so UI updates
        await db.collection(collection).doc(msgId).update({ oneTimeViewOpened: true });

        // 2. Fetch the message to show content in a modal overlay
        const snap = await db.collection(collection).doc(msgId).get();
        const data = snap.data();
        if (!data) return;

        // ── E2EE: Decrypt before showing ─────────────────────
        if (window.E2EE && data.encryptedText && data.iv) {
            try {
                if (chatType === 'group') {
                    data.text = await window.E2EE.decryptGroup(data, data.sender);
                } else {
                    // peerUid = the other person (sender, since receiver is opening)
                    const peerUid = data.sender === currentUser.uid ? chatWithUID : data.sender;
                    data.text = await window.E2EE.decryptDirect(data, peerUid);
                }
            } catch (e) {
                console.warn('[OTV] E2EE decrypt failed:', e);
                data.text = '';
            }
        }
        // ─────────────────────────────────────────────────────

        // Determine if this is a file/image (non-text) message
        const isFileOrImage = data.type === 'file' || data.type === 'image' ||
            (data.fileMime && data.fileMime.length > 0) ||
            (data.fileUrl && data.fileUrl.length > 0);

        // Build modal body content
        let modalBodyHtml;
        if (isFileOrImage && window.driveShare) {
            modalBodyHtml = window.driveShare.renderFileMessage(data, false);
        } else {
            modalBodyHtml = `<p class="otv-text-content">${escapeHTML(data.text || '')}</p>`;
        }

        // For text: show close button, no auto-timer
        // For files/images: 10s forced countdown, close button disabled until expired
        const TIMER_SECS = 10;

        const footerHtml = isFileOrImage
            ? `<span class="otv-countdown" id="otvCountdown">Closes in ${TIMER_SECS}s…</span>
               <button class="otv-close-btn" id="otvCloseBtn" disabled style="opacity:0.4;cursor:not-allowed">Please wait…</button>`
            : `<span class="otv-countdown" id="otvCountdown"></span>
               <button class="otv-close-btn" id="otvCloseBtn" onclick="this.closest('.otv-overlay').dispatchEvent(new Event('otvclose'))">Close</button>`;

        // Show fullscreen overlay
        const overlay = document.createElement('div');
        overlay.className = 'otv-overlay';
        overlay.innerHTML = `
            <div class="otv-modal">
                <div class="otv-modal-header"><span class="otv-eye-icon" style="display:inline-flex;vertical-align:middle">${I ? I.get('eyeView', 28) : ''}</span> One-Time View</div>
                <div class="otv-modal-body">${modalBodyHtml}</div>
                <div class="otv-modal-footer">
                    ${footerHtml}
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const countEl  = overlay.querySelector('#otvCountdown');
        const closeBtn = overlay.querySelector('#otvCloseBtn');

        function deleteAndClose() {
            overlay.remove();
            db.collection(collection).doc(msgId).update({ deletedForAll: true })
                .catch(e => console.error('OTV delete error:', e));
        }

        if (isFileOrImage) {
            // Forced 10s countdown — close button unlocks only after timer ends
            let secs = TIMER_SECS;
            const timer = setInterval(() => {
                secs--;
                if (countEl) countEl.textContent = secs > 0 ? `Closes in ${secs}s…` : 'Deleted!';
                if (secs <= 0) {
                    clearInterval(timer);
                    deleteAndClose();
                }
            }, 1000);
        } else {
            // Text messages — no auto-close, user must manually close
            overlay.addEventListener('otvclose', deleteAndClose);
        }
    } catch (e) {
        console.error('OTV open error:', e);
    }
}

// ── One Time View toggle state ───────────────────────────────
window._oneTimeViewEnabled = false;
function toggleOneTimeView(btn) {
    window._oneTimeViewEnabled = !window._oneTimeViewEnabled;
    if (btn) {
        btn.classList.toggle('otv-active', window._oneTimeViewEnabled);
        btn.title = window._oneTimeViewEnabled ? 'One-time view ON — click to turn off' : 'One-time view';
    }
}

window.openOneTimeViewMessage = openOneTimeViewMessage;
window.toggleOneTimeView      = toggleOneTimeView;
window.showForwardModal      = showForwardModal;
window.togglePinMessage      = togglePinMessage;
window.renderPinnedBanner    = renderPinnedBanner;
window.startVoiceRecording   = startVoiceRecording;
window.stopVoiceRecording    = stopVoiceRecording;
window.markChatAsRead        = markChatAsRead;
window.listenTypingIndicator = listenTypingIndicator;
window.onTypingInput         = onTypingInput;
window.clearTypingIndicator  = clearTypingIndicator;
window.injectArchiveButton   = injectArchiveButton;
window.scrollToBottom        = scrollToBottom;
window.showScheduleModal     = showScheduleModal;
window.startEditMessage      = startEditMessage;
window.cancelEdit            = cancelEdit;

// Restore pending scheduled messages on page load.
// BUG FIX 4: Was listening to 'authReady' on document, but app.js dispatches
// 'appInitialized' on window. Scheduled messages were silently lost on reload.
if (window.currentUser) {
    restoreScheduledMessages();
} else {
    window.addEventListener('appInitialized', () => restoreScheduledMessages(), { once: true });
}

// ── Contact phone: click to copy ─────────────────────────────
document.addEventListener('click', (e) => {
    const el = e.target.closest('.contact-phone-copy');
    if (!el) return;
    const phone = el.dataset.phone || el.textContent.trim();
    if (!phone) return;
    navigator.clipboard.writeText(phone).then(() => {
        const orig = el.innerHTML;
        el.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:4px;vertical-align:middle;"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        el.style.color = 'var(--color-primary, #4caf50)';
        setTimeout(() => {
            el.innerHTML = orig;
            el.style.color = '';
        }, 1800);
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = phone;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    });
});

console.log('messaging.js loaded');
