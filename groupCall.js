// ============================================================
//  groupCall.js — Group Video/Voice Conference (Mesh WebRTC)
//  Each participant connects peer-to-peer with every other.
//  Firestore collection: groupCalls/{roomId}/peers/{uid}
// ============================================================

const GroupCallManager = (() => {

    const ICE_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
        ],
        iceCandidatePoolSize: 10
    };

    // ── State ────────────────────────────────────────────────
    let _roomId          = null;
    let _localStream     = null;
    let _peers           = {};      // uid → { pc, stream, _pendingCandidates }
    let _unsubPeers      = null;
    let _unsubSignals    = null;
    let _isVideoCall     = true;
    let _myUID           = null;
    let _myName          = null;
    let _audioMuted      = false;
    let _videoMuted      = false;
    let _active          = false;
    let _isScreenSharing = false;
    let _screenStream    = null;
    let _facingMode      = 'user';
    let _timerInterval   = null;
    let _timerSeconds    = 0;
    let _gcFriends       = null;
    let _gcInvited       = new Set();

    // ── Helpers ──────────────────────────────────────────────
    function _esc(str) {
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const _peersRef = () => window.db.collection('groupCalls').doc(_roomId).collection('peers');

    async function _sendSignal(targetUID, data) {
        try {
            await _peersRef().doc(targetUID).collection('signals').add({
                ...data, created: new Date()
            });
        } catch (e) { console.error('Signal send error:', e); }
    }

    // ─────────────────────────────────────────────────────────
    //  PUBLIC: Start a group call
    // ─────────────────────────────────────────────────────────
    async function startCall(groupId, isVideo = true) {
        if (_active) { console.warn('Group call already active'); return; }

        _roomId      = groupId;
        _isVideoCall = isVideo;
        _myUID       = window.currentUser.uid;
        _myName      = window.currentUserData?.name || 'Me';
        _audioMuted  = false;
        _videoMuted  = false;
        _facingMode  = 'user';

        try {
            _localStream = await navigator.mediaDevices.getUserMedia({
                video: isVideo ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });

            // Register myself BEFORE listening so other peers see me immediately
            await _peersRef().doc(_myUID).set({
                uid: _myUID, name: _myName, isVideo, joined: new Date(), active: true
            });

            _active = true;
            _showCallUI();
            _listenMySignals();  // listen for signals FIRST
            _listenPeers();      // then watch peer list
            _startTimer();

            console.log('✅ Group call started, room:', _roomId);
        } catch (err) {
            console.error('Group call start error:', err);
            window.showToast?.('Camera/Mic access denied: ' + err.message, 'error');
            await _cleanup();
        }
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Watch peer list
    // ─────────────────────────────────────────────────────────
    function _listenPeers() {
        _unsubPeers = _peersRef().onSnapshot(snap => {
            snap.docChanges().forEach(async change => {
                const uid  = change.doc.id;
                const data = change.doc.data();
                if (uid === _myUID) return;

                if (change.type === 'added' && data.active) {
                    console.log('👤 Peer joined:', uid);
                    _addPeerTile(uid, data.name || uid.slice(0, 8));
                    // Only lower UID initiates — avoids dual-offer race condition
                    await _connectToPeer(uid, _myUID < uid);

                } else if ((change.type === 'modified' && !data.active) || change.type === 'removed') {
                    console.log('👤 Peer left:', uid);
                    _removePeer(uid);
                }
            });
        });
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Listen for signals addressed to me
    // ─────────────────────────────────────────────────────────
    function _listenMySignals() {
        _unsubSignals = _peersRef().doc(_myUID).collection('signals')
            .orderBy('created')
            .onSnapshot(snap => {
                snap.docChanges().forEach(async change => {
                    if (change.type !== 'added') return;
                    const sig     = change.doc.data();
                    const fromUID = sig.from;
                    if (!fromUID) return;

                    console.log(`📩 Signal from ${fromUID}: ${sig.type}`);

                    if      (sig.type === 'offer')     await _handleOffer(fromUID, sig);
                    else if (sig.type === 'answer')    await _handleAnswer(fromUID, sig);
                    else if (sig.type === 'candidate') await _handleCandidate(fromUID, sig);

                    change.doc.ref.delete().catch(() => {});
                });
            });
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Create RTCPeerConnection
    // ─────────────────────────────────────────────────────────
    async function _connectToPeer(uid, initiator) {
        const existing = _peers[uid]?.pc;
        if (existing) {
            const s = existing.connectionState;
            if (s === 'connected' || s === 'connecting' || s === 'new') {
                console.log('Peer', uid, 'already active, state:', s);
                return;
            }
            existing.close();
            delete _peers[uid];
        }

        const pc = new RTCPeerConnection(ICE_CONFIG);
        _peers[uid] = { pc, stream: null, _pendingCandidates: [] };

        // Add all local tracks to this peer connection
        _localStream.getTracks().forEach(track => pc.addTrack(track, _localStream));

        // Send ICE candidates
        pc.onicecandidate = async ({ candidate }) => {
            if (candidate) {
                await _sendSignal(uid, { type: 'candidate', from: _myUID, candidate: candidate.toJSON() });
            }
        };

        // Handle incoming tracks — build MediaStream manually for reliability
        pc.ontrack = (event) => {
            console.log(`🎬 Track from ${uid}: kind=${event.track.kind}`);
            if (!_peers[uid]) return;

            if (!_peers[uid].stream) _peers[uid].stream = new MediaStream();

            // Avoid adding duplicate tracks
            const alreadyHas = _peers[uid].stream.getTracks().some(t => t.id === event.track.id);
            if (!alreadyHas) _peers[uid].stream.addTrack(event.track);

            // Reattach every time — ensures audio+video both connect as tracks arrive
            _attachStream(uid, _peers[uid].stream);
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log(`Peer ${uid} → ${state}`);
            if (state === 'failed') {
                _iceRestart(uid);
            } else if (state === 'disconnected') {
                setTimeout(() => {
                    if (_peers[uid]?.pc?.connectionState === 'disconnected') _removePeer(uid);
                }, 5000);
            }
        };

        if (initiator) {
            try {
                const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: _isVideoCall });
                await pc.setLocalDescription(offer);
                await _sendSignal(uid, { type: 'offer', from: _myUID, sdp: offer.sdp });
                console.log(`📤 Offer sent to ${uid}`);
            } catch (e) {
                console.error(`Offer error for ${uid}:`, e);
            }
        }
    }

    async function _iceRestart(uid) {
        const pc = _peers[uid]?.pc;
        if (!pc) return;
        try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            await _sendSignal(uid, { type: 'offer', from: _myUID, sdp: offer.sdp });
        } catch (e) {
            console.warn(`ICE restart failed for ${uid}:`, e);
            _removePeer(uid);
        }
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Signal handlers
    // ─────────────────────────────────────────────────────────
    async function _handleOffer(fromUID, sig) {
        // Create PC for this peer if not already existing
        if (!_peers[fromUID]?.pc) {
            await _connectToPeer(fromUID, false);
        }
        const pc = _peers[fromUID]?.pc;
        if (!pc) return;

        try {
            if (pc.signalingState !== 'stable') {
                console.warn(`Wrong state ${pc.signalingState} for offer — recreating`);
                await _connectToPeer(fromUID, false);
                return _handleOffer(fromUID, sig);
            }
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sig.sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await _sendSignal(fromUID, { type: 'answer', from: _myUID, sdp: answer.sdp });
            console.log(`📤 Answer sent to ${fromUID}`);
            await _flushCandidates(fromUID);
        } catch (e) {
            console.error(`handleOffer error from ${fromUID}:`, e);
        }
    }

    async function _handleAnswer(fromUID, sig) {
        const pc = _peers[fromUID]?.pc;
        if (!pc || pc.signalingState !== 'have-local-offer') return;
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sig.sdp }));
            console.log(`✅ Answer from ${fromUID} applied`);
            await _flushCandidates(fromUID);
        } catch (e) {
            console.error(`handleAnswer error from ${fromUID}:`, e);
        }
    }

    async function _handleCandidate(fromUID, sig) {
        if (!sig.candidate) return;
        if (!_peers[fromUID]) _peers[fromUID] = { pc: null, stream: null, _pendingCandidates: [] };
        const peer = _peers[fromUID];
        if (!peer.pc?.remoteDescription) {
            peer._pendingCandidates.push(sig.candidate);
            return;
        }
        try {
            await peer.pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
        } catch (e) {
            console.warn(`ICE candidate error from ${fromUID}:`, e);
        }
    }

    async function _flushCandidates(uid) {
        const peer = _peers[uid];
        if (!peer?.pc || !peer._pendingCandidates?.length) return;
        const list = [...peer._pendingCandidates];
        peer._pendingCandidates = [];
        for (const c of list) {
            try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); }
            catch (e) { console.warn('Flush candidate error:', e); }
        }
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Remove a peer
    // ─────────────────────────────────────────────────────────
    function _removePeer(uid) {
        if (_peers[uid]) { _peers[uid].pc?.close(); delete _peers[uid]; }
        document.getElementById(`gc-tile-${uid}`)?.remove();
        const aud = document.getElementById(`gc-audio-${uid}`);
        if (aud) { aud.srcObject = null; aud.remove(); }
        _updateLayout();
    }

    // ─────────────────────────────────────────────────────────
    //  UI: Show group call overlay
    // ─────────────────────────────────────────────────────────
    function _showCallUI() {
        const I        = window.Icons;
        const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

        const overlay = document.createElement('div');
        overlay.id        = 'groupCallOverlay';
        overlay.className = 'gc-overlay';
        overlay.innerHTML = `
            <div class="gc-header">
                <span class="gc-title">Group ${_isVideoCall ? 'Video' : 'Voice'} Call</span>
                <span class="gc-timer" id="gcTimer">00:00</span>
            </div>
            <div class="gc-grid gc-grid-1" id="gcGrid">
                <div class="gc-tile gc-tile-local" id="gc-tile-local">
                    ${_isVideoCall
                        ? `<video id="gcLocalVideo" class="gc-video" autoplay playsinline muted></video>`
                        : `<div class="gc-avatar-placeholder"><span class="gc-initials">${_esc((_myName[0]||'M').toUpperCase())}</span></div>`
                    }
                    <div class="gc-tile-name">You</div>
                    <div class="gc-tile-mute-icon" id="gc-mute-local" style="display:none">${I ? I.get('micStop', 16) : '🔇'}</div>
                </div>
            </div>
            <div class="gc-controls">
                <button class="gc-btn gc-btn-mute" id="gcMuteBtn" title="Mute">
                    ${I ? I.get('micFill', 24) : '🎤'}
                </button>
                ${_isVideoCall ? `
                <button class="gc-btn gc-btn-video" id="gcVideoBtn" title="Camera">
                    ${I ? I.get('videoFill', 24) : '📹'}
                </button>
                <button class="gc-btn gc-btn-cam" id="gcCamBtn" title="Switch Camera">
                    ${I ? I.get('switchCam', 24) : '🔄'}
                </button>
                ${!isMobile ? `<button class="gc-btn gc-btn-screen" id="gcScreenBtn" title="Share Screen">
                    ${I ? I.get('monitor', 24) : '🖥️'}
                </button>` : ''}` : ''}
                ${!isMobile ? `<button class="gc-btn gc-btn-speaker" id="gcSpeakerBtn" title="Audio Output">
                    ${I ? I.get('speakerLoud', 24) : '🔊'}
                </button>` : ''}
                <button class="gc-btn gc-btn-add" id="gcAddBtn" title="Add Participant">
                    ${I ? I.get('addUser', 24) : '➕'}
                </button>
                <button class="gc-btn gc-btn-end" id="gcEndBtn" title="End Call">
                    ${I ? I.get('phoneEnd', 24) : '📵'}
                </button>
            </div>
        `;
        document.body.appendChild(overlay);

        if (_isVideoCall) {
            const lv = document.getElementById('gcLocalVideo');
            if (lv) lv.srcObject = _localStream;
        }

        document.getElementById('gcMuteBtn').addEventListener('click', _toggleAudio);
        if (_isVideoCall) {
            document.getElementById('gcVideoBtn').addEventListener('click', _toggleVideo);
            document.getElementById('gcCamBtn').addEventListener('click', _switchCamera);
            document.getElementById('gcScreenBtn')?.addEventListener('click', _toggleScreenShare);
        }
        document.getElementById('gcSpeakerBtn')?.addEventListener('click', _toggleSpeaker);
        document.getElementById('gcAddBtn').addEventListener('click', _openAddParticipant);
        document.getElementById('gcEndBtn').addEventListener('click', endCall);
    }

    // ─────────────────────────────────────────────────────────
    //  UI: Peer tile
    // ─────────────────────────────────────────────────────────
    function _addPeerTile(uid, name) {
        const grid = document.getElementById('gcGrid');
        if (!grid || document.getElementById(`gc-tile-${uid}`)) return;

        const I    = window.Icons;
        const tile = document.createElement('div');
        tile.className = 'gc-tile';
        tile.id        = `gc-tile-${uid}`;
        tile.innerHTML = `
            <video  class="gc-video" id="gc-video-${uid}" autoplay playsinline style="display:none"></video>
            <audio  class="gc-audio" id="gc-audio-${uid}" autoplay style="display:none"></audio>
            <div class="gc-avatar-placeholder" id="gc-avatar-${uid}" style="display:flex">
                <span class="gc-initials">${_esc((name[0]||'?').toUpperCase())}</span>
            </div>
            <div class="gc-tile-name">${_esc(name)}</div>
            <div class="gc-tile-mute-icon" id="gc-mute-${uid}" style="display:none">${I ? I.get('micStop', 16) : '🔇'}</div>
        `;
        grid.appendChild(tile);
        _updateLayout();
    }

    // KEY FIX: Separate audio and video into separate elements.
    // Audio goes to <audio> element (always), video goes to <video>.
    // This ensures audio works even if video track arrives later or not at all.
    function _attachStream(uid, stream) {
        if (!stream) return;

        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();

        // Always wire up audio to the dedicated <audio> element
        if (audioTracks.length > 0) {
            const aud = document.getElementById(`gc-audio-${uid}`);
            if (aud) {
                const audioOnly = new MediaStream(audioTracks);
                aud.srcObject   = audioOnly;
                aud.play().catch(e => console.warn(`Audio play error for ${uid}:`, e));
            }
        }

        // Wire up video to the <video> element
        if (_isVideoCall && videoTracks.length > 0) {
            const vid    = document.getElementById(`gc-video-${uid}`);
            const avatar = document.getElementById(`gc-avatar-${uid}`);
            if (vid) {
                const videoOnly  = new MediaStream(videoTracks);
                vid.srcObject    = videoOnly;
                vid.style.display = 'block';
                vid.play().catch(() => {});
            }
            if (avatar) avatar.style.display = 'none';
        }
    }

    function _updateLayout() {
        const grid = document.getElementById('gcGrid');
        if (!grid) return;
        const count = grid.children.length;
        grid.className = 'gc-grid ' + (
            count <= 1 ? 'gc-grid-1' :
            count <= 2 ? 'gc-grid-2' :
            count <= 4 ? 'gc-grid-4' : 'gc-grid-many'
        );
    }

    // ─────────────────────────────────────────────────────────
    //  Controls
    // ─────────────────────────────────────────────────────────
    function _toggleAudio() {
        _audioMuted = !_audioMuted;
        _localStream.getAudioTracks().forEach(t => t.enabled = !_audioMuted);
        const btn = document.getElementById('gcMuteBtn');
        const I   = window.Icons;
        if (btn) {
            btn.innerHTML = I ? I.get(_audioMuted ? 'micStop' : 'micFill', 24) : (_audioMuted ? '🔇' : '🎤');
            btn.classList.toggle('gc-btn-active', _audioMuted);
            btn.title = _audioMuted ? 'Unmute' : 'Mute';
        }
        const icon = document.getElementById('gc-mute-local');
        if (icon) icon.style.display = _audioMuted ? 'flex' : 'none';
    }

    function _toggleVideo() {
        _videoMuted = !_videoMuted;
        _localStream.getVideoTracks().forEach(t => t.enabled = !_videoMuted);
        const btn = document.getElementById('gcVideoBtn');
        const I   = window.Icons;
        if (btn) {
            btn.innerHTML = I ? I.get(_videoMuted ? 'videoOff' : 'videoFill', 24) : (_videoMuted ? '📵' : '📹');
            btn.classList.toggle('gc-btn-active', _videoMuted);
            btn.title = _videoMuted ? 'Enable Camera' : 'Disable Camera';
        }
        const lv  = document.getElementById('gcLocalVideo');
        const lav = document.querySelector('#gc-tile-local .gc-avatar-placeholder');
        if (lv)  lv.style.display  = _videoMuted ? 'none' : 'block';
        if (lav) lav.style.display = _videoMuted ? 'flex'  : 'none';
    }

    async function _switchCamera() {
        if (!_isVideoCall) return;
        _facingMode = _facingMode === 'user' ? 'environment' : 'user';
        try {
            const ns  = await navigator.mediaDevices.getUserMedia({ video: { facingMode: _facingMode } });
            const nvt = ns.getVideoTracks()[0];

            for (const { pc } of Object.values(_peers)) {
                const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) await sender.replaceTrack(nvt).catch(() => {});
            }

            _localStream.getVideoTracks().forEach(t => { t.stop(); _localStream.removeTrack(t); });
            _localStream.addTrack(nvt);
            nvt.enabled = !_videoMuted;

            const lv = document.getElementById('gcLocalVideo');
            if (lv) lv.srcObject = _localStream;
        } catch (e) {
            window.showToast?.('Camera switch failed: ' + e.message, 'error');
        }
    }

    async function _toggleScreenShare() {
        const btn = document.getElementById('gcScreenBtn');
        const I   = window.Icons;

        if (_isScreenSharing) {
            _screenStream?.getTracks().forEach(t => t.stop());
            _screenStream    = null;
            _isScreenSharing = false;

            const cam = _localStream?.getVideoTracks()[0];
            if (cam) {
                for (const { pc } of Object.values(_peers)) {
                    const s = pc.getSenders().find(s => s.track?.kind === 'video');
                    if (s) await s.replaceTrack(cam).catch(() => {});
                }
            }
            const lv = document.getElementById('gcLocalVideo');
            if (lv) lv.srcObject = _localStream;

            if (btn) { btn.innerHTML = I ? I.get('monitor', 24) : '🖥️'; btn.classList.remove('gc-btn-active'); btn.title = 'Share Screen'; }
            window.showToast?.('Screen sharing stopped', 'info');
        } else {
            try {
                _screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
                const st = _screenStream.getVideoTracks()[0];

                for (const { pc } of Object.values(_peers)) {
                    const s = pc.getSenders().find(s => s.track?.kind === 'video');
                    if (s) await s.replaceTrack(st).catch(() => {});
                }

                const lv = document.getElementById('gcLocalVideo');
                if (lv) lv.srcObject = _screenStream;
                _isScreenSharing = true;

                st.addEventListener('ended', () => { _isScreenSharing = true; _toggleScreenShare(); });
                if (btn) { btn.innerHTML = I ? I.get('stopShare', 24) : '⬛'; btn.classList.add('gc-btn-active'); btn.title = 'Stop Sharing'; }
                window.showToast?.('Screen sharing started', 'success');
            } catch (e) {
                if (e.name !== 'NotAllowedError') window.showToast?.('Screen sharing failed: ' + e.message, 'error');
            }
        }
    }

    async function _toggleSpeaker() {
        if (typeof HTMLMediaElement.prototype.setSinkId !== 'function') return;
        const btn = document.getElementById('gcSpeakerBtn');
        const I   = window.Icons;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const outputs = devices.filter(d => d.kind === 'audiooutput');
            const els     = [...document.querySelectorAll('#gcGrid audio.gc-audio')];
            const curId   = els[0]?.sinkId || '';
            const speaker = outputs.find(d => /speaker|loudspeaker/i.test(d.label)) || outputs.find(d => d.deviceId === 'default');
            const targetId = (curId === '' || curId === 'default') && speaker ? speaker.deviceId : '';
            for (const el of els) await el.setSinkId(targetId).catch(() => {});
            const onSpeaker = targetId !== '';
            if (btn) {
                btn.innerHTML = I ? I.get(onSpeaker ? 'speakerLoud' : 'speakerEar', 24) : (onSpeaker ? '🔊' : '🔉');
                btn.title = onSpeaker ? 'Using Speaker' : 'Using Default';
            }
        } catch (e) { console.warn('Speaker toggle error:', e); }
    }

    // ─────────────────────────────────────────────────────────
    //  Add Participant
    // ─────────────────────────────────────────────────────────
    async function _openAddParticipant() {
        const existing = document.getElementById('gcAddParticipantOverlay');
        if (existing) { existing.remove(); return; }

        const overlay = document.createElement('div');
        overlay.id = 'gcAddParticipantOverlay';
        overlay.className = 'gc-add-overlay';
        overlay.innerHTML = `
            <div class="gc-add-sheet">
                <div class="gc-add-header">
                    <h3>Add Participant</h3>
                    <button class="gc-add-close" id="gcAddClose">✕</button>
                </div>
                <div class="gc-add-search">
                    <input type="text" id="gcAddSearch" placeholder="Search friends…" autocomplete="off">
                </div>
                <div class="gc-add-list" id="gcAddList"><div class="gc-add-empty">Loading…</div></div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.getElementById('gcAddClose').addEventListener('click', () => overlay.remove());
        document.getElementById('gcAddSearch').addEventListener('input', e =>
            _renderAddList(_gcFriends || [], e.target.value.toLowerCase())
        );
        await _loadFriendsForAdd();
    }

    async function _loadFriendsForAdd() {
        const listEl = document.getElementById('gcAddList');
        if (!listEl) return;
        try {
            const inCall     = new Set([...Object.keys(_peers), _myUID]);
            const friendUIDs = (window.currentUserData?.friends || []).filter(u => u && !inCall.has(u));
            if (!friendUIDs.length) { _gcFriends = []; _renderAddList([], ''); return; }

            const friends = [], toFetch = [];
            for (const uid of friendUIDs) {
                const c = window.enhancedCache?.get(`user_${uid}`);
                if (c?.name) friends.push({ uid, name: c.name, photo: c.photoURL || '' });
                else toFetch.push(uid);
            }
            for (let i = 0; i < toFetch.length; i += 30) {
                const snap = await window.db.collection('users')
                    .where(firebase.firestore.FieldPath.documentId(), 'in', toFetch.slice(i, i + 30)).get();
                snap.forEach(doc => {
                    const d = doc.data();
                    window.enhancedCache?.set(`user_${doc.id}`, d, 30 * 60 * 1000);
                    friends.push({ uid: doc.id, name: d.name || doc.id.slice(0, 8), photo: d.photoURL || '' });
                });
            }
            friends.sort((a, b) => a.name.localeCompare(b.name));
            _gcFriends = friends; _gcInvited = new Set();
            _renderAddList(friends, '');
        } catch (e) {
            console.error('Load friends error:', e);
            const l = document.getElementById('gcAddList');
            if (l) l.innerHTML = '<div class="gc-add-empty">Could not load friends.</div>';
        }
    }

    function _renderAddList(friends, query) {
        const listEl = document.getElementById('gcAddList');
        if (!listEl) return;
        const filtered = query ? friends.filter(f => f.name.toLowerCase().includes(query)) : friends;
        if (!filtered.length) { listEl.innerHTML = '<div class="gc-add-empty">No friends available.</div>'; return; }

        listEl.innerHTML = filtered.map(f => {
            const inv = _gcInvited.has(f.uid);
            const av  = f.photo ? `<img src="${_esc(f.photo)}" alt="">` : _esc((f.name[0]||'?').toUpperCase());
            return `<button class="gc-add-friend" data-uid="${f.uid}" ${inv ? 'disabled' : ''}>
                <div class="gc-add-avatar">${av}</div>
                <div class="gc-add-info">
                    <div class="gc-add-name">${_esc(f.name)}</div>
                    <div class="gc-add-status">${inv ? 'Invite sent' : 'Tap to invite'}</div>
                </div>
                <span class="gc-add-badge ${inv ? 'gc-invited' : ''}">${inv ? 'Invited' : 'Invite'}</span>
            </button>`;
        }).join('');

        listEl.querySelectorAll('.gc-add-friend:not([disabled])').forEach(btn => {
            btn.addEventListener('click', async () => {
                const uid = btn.dataset.uid;
                const f   = friends.find(x => x.uid === uid);
                if (!f) return;
                btn.disabled = true;
                btn.querySelector('.gc-add-badge').textContent = 'Sending…';
                const sent = await inviteToRoom(uid, _roomId, _isVideoCall);
                if (sent) {
                    _gcInvited.add(uid);
                    btn.querySelector('.gc-add-badge').textContent = 'Invited';
                    btn.querySelector('.gc-add-badge').classList.add('gc-invited');
                    btn.querySelector('.gc-add-status').textContent = 'Invite sent';
                    window.showToast?.(`Invite sent to ${f.name}`, 'success');
                } else {
                    btn.disabled = false;
                    btn.querySelector('.gc-add-badge').textContent = 'Retry';
                    window.showToast?.('Could not send invite', 'error');
                }
            });
        });
    }

    // ─────────────────────────────────────────────────────────
    //  Timer
    // ─────────────────────────────────────────────────────────
    function _startTimer() {
        _timerSeconds  = 0;
        _timerInterval = setInterval(() => {
            _timerSeconds++;
            const m = String(Math.floor(_timerSeconds / 60)).padStart(2, '0');
            const s = String(_timerSeconds % 60).padStart(2, '0');
            const el = document.getElementById('gcTimer');
            if (el) el.textContent = `${m}:${s}`;
        }, 1000);
    }

    // ─────────────────────────────────────────────────────────
    //  PUBLIC: End call
    // ─────────────────────────────────────────────────────────
    async function endCall() { await _cleanup(); }

    async function _cleanup() {
        _active = false;
        clearInterval(_timerInterval); _timerInterval = null; _timerSeconds = 0;

        if (_unsubPeers)   { _unsubPeers();   _unsubPeers   = null; }
        if (_unsubSignals) { _unsubSignals(); _unsubSignals = null; }

        if (_roomId && _myUID) {
            try {
                await _peersRef().doc(_myUID).update({ active: false });
                const sigs = await _peersRef().doc(_myUID).collection('signals').get();
                sigs.forEach(d => d.ref.delete());
            } catch (e) {}
        }

        Object.keys(_peers).forEach(uid => _peers[uid]?.pc?.close());
        _peers = {};

        _localStream?.getTracks().forEach(t => t.stop());  _localStream  = null;
        _screenStream?.getTracks().forEach(t => t.stop()); _screenStream = null;

        document.getElementById('groupCallOverlay')?.remove();
        document.getElementById('gcAddParticipantOverlay')?.remove();

        _roomId = null; _myUID = null; _myName = null;
        _audioMuted = false; _videoMuted = false;
        _facingMode = 'user'; _isScreenSharing = false;
        _gcFriends = null; _gcInvited = new Set();

        console.log('✅ Group call ended');
    }

    // ─────────────────────────────────────────────────────────
    //  PUBLIC: Utilities
    // ─────────────────────────────────────────────────────────
    async function checkActiveCall(groupId) {
        try {
            const snap = await window.db.collection('groupCalls').doc(groupId)
                .collection('peers').where('active', '==', true).get();
            return snap.size;
        } catch (e) { return 0; }
    }

    async function joinExistingCall(roomId, isVideo = true) {
        if (_active) { console.warn('Already in a call'); return; }
        await startCall(roomId, isVideo);
    }

    async function inviteToRoom(targetUID, roomId, isVideo = true) {
        try {
            await window.db.collection('groupCallInvites').add({
                to: targetUID, from: window.currentUser.uid,
                fromName: window.currentUserData?.name || 'Someone',
                roomId, isVideo, status: 'pending', created: new Date()
            });
            return true;
        } catch (e) { console.error('Invite error:', e); return false; }
    }

    function getRoomId() { return _roomId; }
    function isActive()  { return _active; }

    return { startCall, endCall, checkActiveCall, joinExistingCall, inviteToRoom, getRoomId, isActive };

})();

window.GroupCallManager = GroupCallManager;
console.log('✅ groupCall.js loaded');
