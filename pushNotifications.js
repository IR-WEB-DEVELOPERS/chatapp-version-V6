// ============================================================
//  pushNotifications.js — Real Push Notifications
//
//  METHOD: Web Push API (VAPID) + Firestore fallback
//
//  HOW IT WORKS:
//  1. On login → subscribe browser to Web Push using your VAPID key
//  2. FCM token saved to Firestore under users/{uid}/fcmTokens
//  3. When sending a message → write to notifications/{uid}/pending/
//  4. sw.js listens via Firestore (when browser open/minimised)
//     AND via Web Push push event (works even when browser is CLOSED)
//  5. Tapping notification → app opens to the right chat
//
//  Works on: Android Chrome, Desktop Chrome/Firefox/Edge
//  Browser closed: ✅ YES (via Web Push)
// ============================================================

// VAPID public key is fetched from the server so it never needs to be
// hardcoded here. Rotating the key only requires updating the env var.
let VAPID_PUBLIC_KEY = null;
async function getVapidPublicKey() {
    if (VAPID_PUBLIC_KEY) return VAPID_PUBLIC_KEY;
    try {
        const res = await fetch('/vapid-public-key');
        if (!res.ok) throw new Error('Server returned ' + res.status);
        const data = await res.json();
        VAPID_PUBLIC_KEY = data.key;
        return VAPID_PUBLIC_KEY;
    } catch (err) {
        console.error('Failed to fetch VAPID public key from server:', err);
        return null;
    }
}

// ── Convert VAPID key from base64url to Uint8Array ───────────
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData  = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// ── Save FCM/push subscription token to Firestore ────────────
async function savePushSubscription(subscription) {
    if (!db || !window.currentUser) return;
    try {
        const subJSON = subscription.toJSON();
        await db.collection('users')
            .doc(window.currentUser.uid)
            .collection('pushSubscriptions')
            .doc(btoa(subJSON.endpoint).slice(0, 100)) // stable doc id per device
            .set({
                endpoint:  subJSON.endpoint,
                keys:      subJSON.keys,
                updatedAt: new Date(),
                userAgent: navigator.userAgent.slice(0, 200)
            }, { merge: true });
        console.log('✅ Push subscription saved to Firestore');
    } catch (err) {
        console.error('savePushSubscription error:', err);
    }
}

// ── Initialize push notifications ───────────────────────────
async function initPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log('Web Push not supported in this browser');
        return false;
    }

    try {
        // 1. Request permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            console.log('Notification permission denied');
            return false;
        }

        // 2. Wait for SW to be ready
        const registration = await navigator.serviceWorker.ready;

        // 3. Subscribe to Web Push with VAPID key (fetched from server)
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            const vapidKey = await getVapidPublicKey();
            if (!vapidKey) {
                console.error('Cannot subscribe to push — VAPID key unavailable');
                return false;
            }
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly:      true,
                applicationServerKey: urlBase64ToUint8Array(vapidKey)
            });
            console.log('✅ New Web Push subscription created');
        } else {
            console.log('✅ Existing Web Push subscription found');
        }

        // 4. Save subscription to Firestore (so other users can push to you)
        await savePushSubscription(subscription);

        // 5. Listen for messages FROM the SW (notification clicked)
        navigator.serviceWorker.addEventListener('message', handleSWMessage);

        console.log('✅ Push notifications fully ready (works even when browser is closed)');
        return true;

    } catch (err) {
        console.error('Push notification init error:', err);
        return false;
    }
}

// ── Handle messages from Service Worker ─────────────────────
function handleSWMessage(event) {
    const { type, chatId, isGroup, callType, callId } = event.data || {};

    if (type === 'NOTIFICATION_CLICKED') {
        if (callType === 'call_video' || callType === 'call_voice') {
            // FIX: Notification లో Answer button tap — signalingManager pending call document చదివి ring చేస్తుంది
            // కానీ app minimized అయి ఉంటే signaling listener miss అయి ఉండవచ్చు
            // chatId = callId — ఆ call document directly fetch చేసి accept చేయాలి
            console.log('📞 Call notification answered, attempting to accept call:', chatId);
            if (chatId && window.db && window.currentUser) {
                window.db.collection('calls').doc(chatId).get().then(doc => {
                    if (doc.exists) {
                        const callData = doc.data();
                        if (callData.status === 'pending' && window.webRTCManager) {
                            const offer = new RTCSessionDescription({
                                type: callData.offer.type,
                                sdp: callData.offer.sdp
                            });
                            window.webRTCManager.handleOffer(chatId, offer, callData.from, callData.isVideoCall);
                        }
                    }
                }).catch(e => console.warn('Answer from notification error:', e));
            }
            // Signaling listener also runs as fallback
        } else if (chatId) {
            // FIX: openChatById define చేయాలి — app.js లో window.openChatById expose అవుతుంది
            if (window.openChatById) {
                window.openChatById(chatId, isGroup);
            } else {
                // fallback: openChat / openGroupChat directly
                if (isGroup && window.openGroupChat) window.openGroupChat(chatId);
                else if (window.openChat) window.openChat(chatId);
            }
        }
    }

    if (type === 'DECLINE_CALL') {
        // FIX: Notification లో decline button చేసినప్పుడు — Firestore లో decline write చేయాలి
        const targetCallId = callId || chatId;
        if (targetCallId && window.signalingManager) {
            window.signalingManager.declineCall(targetCallId).catch(e =>
                console.warn('Decline call error:', e)
            );
        } else if (targetCallId && window.db && window.currentUser) {
            // signalingManager ready కాకపోతే direct Firestore update
            window.db.collection('calls').doc(targetCallId).update({
                status: 'declined',
                declinedAt: new Date()
            }).catch(e => console.warn('Direct decline error:', e));
        }
    }
}

// ── Write notification to Firestore ─────────────────────────
// The SW's Firestore listener picks this up when app is open/minimised.
// The Web Push path (browser closed) requires a server/Cloud Function
// to call the Web Push API — see README note below.
async function sendPushNotification({ toUID, fromName, messageText, chatId, isGroup, groupName, type }) {
    if (!toUID || toUID === window.currentUser?.uid) return;
    if (!db) return;

    try {
        const notifType = type || 'message';

        let title, body;
        if (notifType === 'call_video') {
            title = '📹 Incoming Video Call';
            body  = `${fromName || 'Someone'} is calling you`;
        } else if (notifType === 'call_voice') {
            title = '📞 Incoming Voice Call';
            body  = `${fromName || 'Someone'} is calling you`;
        } else {
            title = isGroup ? (groupName || 'Group Message') : (fromName || 'New Message');
            const rawBody = isGroup ? `${fromName}: ${messageText}` : messageText;
            body  = rawBody?.length > 80 ? rawBody.substring(0, 77) + '...' : (rawBody || '📎 Attachment');
        }

        // 1. Call server /send-push → delivers to CLOSED browsers via Web Push
        fetch('/send-push', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                uid:     toUID,
                title,
                body,
                icon:    '/icon-192.png',
                chatId:  chatId  || null,
                isGroup: isGroup || false,
                type:    notifType
            })
        }).catch(() => {}); // fire and forget

        // 2. Write to Firestore — SW Firestore listener picks this up (browser open/minimised)
        await db.collection('notifications')
            .doc(toUID)
            .collection('pending')
            .add({
                title,
                body,
                icon:      '/icon-192.png',
                chatId:    chatId  || null,
                isGroup:   isGroup || false,
                type:      notifType,
                fromUID:   window.currentUser?.uid || null,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });

    } catch (err) {
        console.error('sendPushNotification error:', err);
    }
}

// ── Notify new message ───────────────────────────────────────
async function notifyNewMessage({ toUID, fromName, messageText, chatId, isGroup, groupName }) {
    await sendPushNotification({ toUID, fromName, messageText, chatId, isGroup, groupName, type: 'message' });
}

// ── Notify incoming call ─────────────────────────────────────
async function notifyIncomingCall({ toUID, fromName, isVideo, callId }) {
    await sendPushNotification({
        toUID,
        fromName,
        chatId: callId || null,  // FIX: callId ని chatId గా pass చేయాలి — SW notification data లో ఉంటుంది
        type: isVideo ? 'call_video' : 'call_voice'
    });
}

// ── Expose globally ──────────────────────────────────────────
window.pushNotifications = {
    init:              initPushNotifications,
    notifyNewMessage,
    notifyIncomingCall,
};

// Also expose config for SW to use — reads from globals.js to avoid duplication.
// globals.js must be loaded before this file (guaranteed by chat.html load order).
window.firebaseConfig = window._firebaseConfig;

console.log('pushNotifications.js loaded (Web Push + VAPID enabled)');
