// ============================================================
//  e2ee.js — End-to-End Encryption (ECDH + AES-GCM)
//
//  HOW IT WORKS:
//  ─────────────
//  1. On first load, each user generates an ECDH key pair
//     (P-256 curve). The PUBLIC key is stored in Firestore
//     under users/{uid}/e2eePublicKey (base64).
//     The PRIVATE key is stored ONLY in IndexedDB on the
//     user's device — it never leaves the browser.
//
//  2. When Alice sends a message to Bob:
//     a. Alice fetches Bob's public key from Firestore.
//     b. Alice derives a shared AES-GCM key via ECDH.
//     c. Alice encrypts the plaintext with that key,
//        producing  { iv, ciphertext }  (both base64).
//     d. The Firestore document stores { encryptedText, iv }
//        instead of { text }.
//
//  3. When Bob receives/renders the message:
//     a. Bob fetches Alice's public key from Firestore.
//     b. Bob derives the same shared key via ECDH.
//     c. Bob decrypts and shows the plaintext.
//
//  For GROUP messages:
//     Each message is encrypted with a per-message random
//     AES-GCM key. That key is then ECDH-wrapped for every
//     group member and stored as encryptedKeys:{ uid: wrappedKey }.
//
//  NON-TEXT content (voice, files, images):
//     URLs are stored as-is (Firebase Storage already uses
//     HTTPS + short-lived signed URLs). Only the `text` field
//     and `replyTo.text` are encrypted.
// ============================================================

window.E2EE = (() => {

    // ── Constants ─────────────────────────────────────────────
    const DB_NAME    = 'e2ee_keys';
    const DB_VERSION = 1;
    const STORE_NAME = 'keys';
    const KEY_ID     = 'myKeyPair';
    const PUB_CACHE  = {};      // uid → CryptoKey (in-memory cache)

    // ── IndexedDB helpers ─────────────────────────────────────
    function _openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = e => {
                e.target.result.createObjectStore(STORE_NAME);
            };
            req.onsuccess = e => resolve(e.target.result);
            req.onerror   = e => reject(e.target.error);
        });
    }

    async function _dbGet(key) {
        const db = await _openDB();
        return new Promise((resolve, reject) => {
            const tx  = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror   = e => reject(e.target.error);
        });
    }

    async function _dbPut(key, value) {
        const db = await _openDB();
        return new Promise((resolve, reject) => {
            const tx  = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror   = e => reject(e.target.error);
        });
    }

    // ── Base64 helpers ────────────────────────────────────────
    function _ab2b64(buf) {
        return btoa(String.fromCharCode(...new Uint8Array(buf)));
    }
    function _b642ab(b64) {
        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
    }

    // ── Key generation / storage ──────────────────────────────
    let _myKeyPair = null;  // { privateKey, publicKey } CryptoKey objects

    async function _loadOrGenerateKeyPair() {
        if (_myKeyPair) return _myKeyPair;

        // Try loading from IndexedDB first
        const stored = await _dbGet(KEY_ID);
        if (stored) {
            const privateKey = await crypto.subtle.importKey(
                'pkcs8', _b642ab(stored.privateKey),
                { name: 'ECDH', namedCurve: 'P-256' },
                false, ['deriveKey']
            );
            const publicKey = await crypto.subtle.importKey(
                'spki', _b642ab(stored.publicKey),
                { name: 'ECDH', namedCurve: 'P-256' },
                true, []
            );
            _myKeyPair = { privateKey, publicKey };
            return _myKeyPair;
        }

        // Generate new key pair
        const kp = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveKey']
        );

        // Export and persist
        const privBuf = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
        const pubBuf  = await crypto.subtle.exportKey('spki',  kp.publicKey);
        await _dbPut(KEY_ID, {
            privateKey: _ab2b64(privBuf),
            publicKey:  _ab2b64(pubBuf)
        });

        _myKeyPair = kp;
        return _myKeyPair;
    }

    // ── Publish public key to Firestore ───────────────────────
    async function _publishPublicKey(uid) {
        const kp     = await _loadOrGenerateKeyPair();
        const pubBuf = await crypto.subtle.exportKey('spki', kp.publicKey);
        const pubB64 = _ab2b64(pubBuf);

        try {
            const userRef = db.collection('users').doc(uid);
            await userRef.update({ e2eePublicKey: pubB64 });
        } catch (e) {
            // If update fails (doc doesn't exist yet), use set with merge
            await db.collection('users').doc(uid).set(
                { e2eePublicKey: _ab2b64(
                    await crypto.subtle.exportKey('spki', kp.publicKey)) },
                { merge: true }
            );
        }
        console.log('[E2EE] Public key published to Firestore');
    }

    // ── Fetch & import another user's public key ──────────────
    async function _getPeerPublicKey(uid) {
        if (PUB_CACHE[uid]) return PUB_CACHE[uid];

        const snap = await db.collection('users').doc(uid).get();
        const b64  = snap.data()?.e2eePublicKey;
        if (!b64) return null;

        const key = await crypto.subtle.importKey(
            'spki', _b642ab(b64),
            { name: 'ECDH', namedCurve: 'P-256' },
            false, []
        );
        PUB_CACHE[uid] = key;
        return key;
    }

    // ── Derive shared AES-GCM key between me and peer ─────────
    async function _deriveSharedKey(peerPublicKey) {
        const kp = await _loadOrGenerateKeyPair();
        return crypto.subtle.deriveKey(
            { name: 'ECDH', public: peerPublicKey },
            kp.privateKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    // ── Encrypt plaintext for a peer (direct chat) ───────────
    async function _encryptForPeer(plaintext, peerUid) {
        const peerKey   = await _getPeerPublicKey(peerUid);
        if (!peerKey) return null;   // peer has no E2EE key yet → send unencrypted

        const sharedKey = await _deriveSharedKey(peerKey);
        const iv        = crypto.getRandomValues(new Uint8Array(12));
        const enc       = new TextEncoder();
        const cipherBuf = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            sharedKey,
            enc.encode(plaintext)
        );
        return {
            encryptedText: _ab2b64(cipherBuf),
            iv:            _ab2b64(iv.buffer)
        };
    }

    // ── Decrypt ciphertext from a peer (direct chat) ──────────
    async function _decryptFromPeer(encryptedText, ivB64, peerUid) {
        const peerKey   = await _getPeerPublicKey(peerUid);
        if (!peerKey) throw new Error('No public key for peer');

        const sharedKey = await _deriveSharedKey(peerKey);
        const iv        = new Uint8Array(_b642ab(ivB64));
        const plainBuf  = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            sharedKey,
            _b642ab(encryptedText)
        );
        return new TextDecoder().decode(plainBuf);
    }

    // ── Group encryption helpers ──────────────────────────────
    // Generates a random AES-GCM key, encrypts plaintext with it,
    // then wraps that key for each member using their ECDH pub key.

    async function _encryptForGroup(plaintext, memberUids) {
        // 1. Random message key
        const msgKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
        );
        const iv = crypto.getRandomValues(new Uint8Array(12));

        // 2. Encrypt message
        const cipherBuf = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            msgKey,
            new TextEncoder().encode(plaintext)
        );

        // 3. Export raw message key for wrapping
        const rawMsgKey = await crypto.subtle.exportKey('raw', msgKey);

        // 4. Wrap message key for each member
        const encryptedKeys = {};
        await Promise.all(memberUids.map(async uid => {
            const peerKey = await _getPeerPublicKey(uid);
            if (!peerKey) return;  // skip members without E2EE key

            const wrappingKey = await _deriveSharedKey(peerKey);
            const wrapIv      = crypto.getRandomValues(new Uint8Array(12));
            const wrappedKey  = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: wrapIv },
                wrappingKey,
                rawMsgKey
            );
            encryptedKeys[uid] = {
                wrappedKey: _ab2b64(wrappedKey),
                wrapIv:     _ab2b64(wrapIv.buffer)
            };
        }));

        return {
            encryptedText: _ab2b64(cipherBuf),
            iv:            _ab2b64(iv.buffer),
            encryptedKeys  // { uid: { wrappedKey, wrapIv } }
        };
    }

    async function _decryptFromGroup(encryptedText, ivB64, encryptedKeys, senderUid) {
        const myUid  = window.currentUser?.uid;
        const mySlot = encryptedKeys?.[myUid];
        if (!mySlot) throw new Error('No key slot for current user');

        // Determine who to derive from: sender's pub key
        const peerKey = await _getPeerPublicKey(senderUid);
        if (!peerKey) throw new Error('No public key for sender');

        const wrappingKey = await _deriveSharedKey(peerKey);

        // Unwrap the message key
        const wrapIv  = new Uint8Array(_b642ab(mySlot.wrapIv));
        const rawKey  = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: wrapIv },
            wrappingKey,
            _b642ab(mySlot.wrappedKey)
        );
        const msgKey  = await crypto.subtle.importKey(
            'raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
        );

        // Decrypt the message
        const iv       = new Uint8Array(_b642ab(ivB64));
        const plainBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            msgKey,
            _b642ab(encryptedText)
        );
        return new TextDecoder().decode(plainBuf);
    }

    // ── Public API ────────────────────────────────────────────

    /**
     * Call once after Firebase Auth signs in.
     * Generates keys if needed and publishes the public key.
     */
    async function init(uid) {
        try {
            await _loadOrGenerateKeyPair();
            await _publishPublicKey(uid);
            console.log('[E2EE] Initialized ✓');
        } catch (e) {
            console.error('[E2EE] Init failed:', e);
        }
    }

    /**
     * Encrypt a direct message text before saving to Firestore.
     * Returns { encryptedText, iv } or null if peer has no E2EE key.
     */
    async function encryptDirect(plaintext, peerUid) {
        try {
            return await _encryptForPeer(plaintext, peerUid);
        } catch (e) {
            console.error('[E2EE] encryptDirect error:', e);
            return null;
        }
    }

    /**
     * Decrypt a direct message.
     * @param {object} msg  Firestore message doc data
     * @param {string} peerUid  The other user's UID
     * @returns {string} plaintext
     */
    async function decryptDirect(msg, peerUid) {
        if (!msg.encryptedText || !msg.iv) return msg.text || '';
        try {
            return await _decryptFromPeer(msg.encryptedText, msg.iv, peerUid);
        } catch (e) {
            console.warn('[E2EE] decryptDirect failed:', e);
            return '🔒 [Encrypted message — decryption failed]';
        }
    }

    /**
     * Encrypt a group message.
     * @param {string} plaintext
     * @param {string[]} memberUids  All group member UIDs (including sender)
     */
    async function encryptGroup(plaintext, memberUids) {
        try {
            return await _encryptForGroup(plaintext, memberUids);
        } catch (e) {
            console.error('[E2EE] encryptGroup error:', e);
            return null;
        }
    }

    /**
     * Decrypt a group message.
     * @param {object} msg  Firestore message doc data
     * @param {string} senderUid
     */
    async function decryptGroup(msg, senderUid) {
        if (!msg.encryptedText || !msg.iv || !msg.encryptedKeys) return msg.text || '';
        try {
            return await _decryptFromGroup(
                msg.encryptedText, msg.iv, msg.encryptedKeys, senderUid
            );
        } catch (e) {
            console.warn('[E2EE] decryptGroup failed:', e);
            return '🔒 [Encrypted message — decryption failed]';
        }
    }

    /**
     * Check if a peer has E2EE enabled (has a public key in Firestore).
     */
    async function peerHasE2EE(uid) {
        try {
            const snap = await db.collection('users').doc(uid).get();
            return !!snap.data()?.e2eePublicKey;
        } catch { return false; }
    }

    return { init, encryptDirect, decryptDirect, encryptGroup, decryptGroup, peerHasE2EE };

})();
