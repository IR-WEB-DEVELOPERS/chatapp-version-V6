class WebRTCManager {
    constructor() {
        this.peerConnection = null;
        this.localStream = null;
        this.remoteStream = null;
        this.dataChannel = null;
        this.isCaller = false;
        this.currentCallId = null;
        this.callTarget = null;
        this.callTimer = null;
        this.isVideoCall = true;
        this.screenStream = null;        // screen share stream
        this.isScreenSharing = false;    // screen share active flag

        // Audio output routing (earpiece vs loudspeaker)
        // Mobile audio calls default to earpiece; video calls use speaker
        this._audioOutputMode = 'earpiece'; // 'earpiece' | 'speaker'
        this._audioOutputDeviceId = null;   // null = system default (earpiece)
        
        // FIX: Call duration timer - only starts when connected
        this.callDurationTimer = null;
        this.callDurationStartTime = null;
        this.callLogSaved = false;
        
        // State management
        this.signalingState = 'stable';
        this.pendingAnswer = null;
        this.isSettingRemoteDescription = false;
        
        // Better ICE servers configuration
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ],
            iceCandidatePoolSize: 10
        };
        
        this.mediaConstraints = {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24 }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
            }
        };
        
        this.pendingICECandidates = [];
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        console.log('WebRTCManager initialized with better state management');
    }

    setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.currentCallId) {
                this.endCall();
            }
        });
    }

    async startCall(targetUID, isVideoCall = true) {
        try {
            console.log(`🚀 Starting ${isVideoCall ? 'video' : 'voice'} call to:`, targetUID);
            
            if (!this.checkWebRTCSupport()) {
                throw new Error('WebRTC not supported in this browser');
            }
            
            if (!window.signalingManager) {
                throw new Error('Signaling system not ready');
            }

            this.callTarget = targetUID;
            this.isCaller = true;
            this.isVideoCall = isVideoCall;
            this.currentCallId = this.generateCallId();
            this.pendingICECandidates = [];
            this.signalingState = 'have-local-offer';
            
            // Get user media with better error handling
            try {
                const constraints = isVideoCall ? {
                    audio: this.mediaConstraints.audio,
                    video: {
                        width: { ideal: 640, max: 1280 },
                        height: { ideal: 480, max: 720 },
                        frameRate: { ideal: 24, max: 30 }
                    }
                } : { audio: true, video: false };
                
                console.log('Requesting media with constraints:', constraints);
                
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                console.log('✅ Media access granted:', {
                    audio: this.localStream.getAudioTracks().length > 0,
                    video: this.localStream.getVideoTracks().length > 0
                });
            } catch (mediaError) {
                console.error('Media access error:', mediaError);
                throw new Error(`Media access failed: ${mediaError.message}`);
            }

            // Create peer connection
            this.createPeerConnection();
            
            // Add local tracks to connection
            this.localStream.getTracks().forEach(track => {
                console.log(`Adding track: ${track.kind}`, track);
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Create data channel for call metadata
            this.dataChannel = this.peerConnection.createDataChannel('callData', {
                ordered: true
            });
            this.setupDataChannel();

            // Create and send offer
            const offer = await this.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: isVideoCall
            });
            
            await this.peerConnection.setLocalDescription(offer);
            console.log('✅ Local description set, signaling state:', this.peerConnection.signalingState);

            // Send offer via signaling
            await window.signalingManager.sendOffer(this.currentCallId, offer, targetUID, isVideoCall);
            console.log('✅ Offer sent via signaling');

            // FIX: Push notification పంపాలి — browser closed అయినా ring అవ్వాలి
            if (window.pushNotifications) {
                const callerName = window.currentUserData?.name || 'Someone';
                window.pushNotifications.notifyIncomingCall({
                    toUID:    targetUID,
                    fromName: callerName,
                    isVideo:  isVideoCall,
                    callId:   this.currentCallId  // FIX: callId pass చేయాలి — decline/answer notification కి కావాలి
                });
            }

            // Show call interface
            this.showCallInterface(true, isVideoCall);
            
            return this.currentCallId;
            
        } catch (error) {
            console.error('❌ Error starting call:', error);
            this.handleCallError('Failed to start call: ' + error.message);
            this.cleanup();
            throw error;
        }
    }

    async acceptCall(callId, offer, callerUID, isVideoCall = true) {
        try {
            console.log(`✅ Accepting ${isVideoCall ? 'video' : 'voice'} call from:`, callerUID);
            
            this.currentCallId = callId;
            this.callTarget = callerUID;
            this.isCaller = false;
            this.isVideoCall = isVideoCall;
            this.pendingICECandidates = [];
            this.signalingState = 'have-remote-offer';

            // Get user media
            try {
                const constraints = isVideoCall ? {
                    audio: this.mediaConstraints.audio,
                    video: {
                        width: { ideal: 640, max: 1280 },
                        height: { ideal: 480, max: 720 },
                        frameRate: { ideal: 24, max: 30 }
                    }
                } : { audio: true, video: false };
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                console.log('✅ Media access granted for answer');
            } catch (mediaError) {
                console.error('Media access error:', mediaError);
                throw new Error(`Media access failed: ${mediaError.message}`);
            }

            // Create peer connection
            this.createPeerConnection();
            
            // Add local tracks
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Setup data channel handler
            this.peerConnection.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.setupDataChannel();
            };

            // Set remote description FIRST
            console.log('🔄 Setting remote description (offer)...');
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            console.log('✅ Remote description set, signaling state:', this.peerConnection.signalingState);

            // Create and send answer
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
            console.log('✅ Answer created and local description set');

            // Send answer via signaling
            await window.signalingManager.sendAnswer(callId, answer);
            console.log('✅ Answer sent via signaling');

            // Clear signaling dedup set so any callerCandidates that arrived before
            // accept (queued without dedup) get properly re-processed on next snapshot
            window.signalingManager?._processedCandidates?.clear();

            // Process any pending ICE candidates
            await this.processPendingICECandidates();

            // Show call interface
            this.showCallInterface(false, isVideoCall);
            
        } catch (error) {
            console.error('❌ Error accepting call:', error);
            this.handleCallError('Failed to accept call: ' + error.message);
            this.cleanup();
            throw error;
        }
    }

    createPeerConnection() {
        try {
            this.peerConnection = new RTCPeerConnection(this.iceServers);
            console.log('✅ Peer connection created');

            // Track signaling state changes
            this.peerConnection.onsignalingstatechange = () => {
                if (this.peerConnection) {
                    this.signalingState = this.peerConnection.signalingState;
                    console.log('📡 Signaling state changed:', this.signalingState);
                    
                    // Process pending answer when state becomes stable
                    if (this.signalingState === 'stable' && this.pendingAnswer) {
                        console.log('🔄 Processing pending answer now that state is stable');
                        this.processPendingAnswer();
                    }
                }
            };

            // ICE candidate handler
            this.peerConnection.onicecandidate = (event) => {
                if (event.candidate && this.currentCallId) {
                    console.log('📨 Sending ICE candidate, isCaller:', this.isCaller);
                    window.signalingManager.sendICECandidate(this.currentCallId, event.candidate, this.isCaller);
                }
            };

            // Track handler — handles both audio-only (voice) and video calls
            this.peerConnection.ontrack = (event) => {
                console.log('🎬 Remote track received:', event.track.kind, event.streams);

                if (event.streams && event.streams[0]) {
                    this.remoteStream = event.streams[0];
                }

                if (event.track.kind === 'audio' && !this.isVideoCall) {
                    // Voice call: pipe audio to a dedicated <audio> element
                    let remoteAudio = document.getElementById('remoteCallAudio');
                    if (!remoteAudio) {
                        remoteAudio = document.createElement('audio');
                        remoteAudio.id = 'remoteCallAudio';
                        remoteAudio.autoplay = true;
                        remoteAudio.style.display = 'none';
                        document.body.appendChild(remoteAudio);
                    }
                    remoteAudio.srcObject = this.remoteStream || new MediaStream([event.track]);
                    remoteAudio.play().catch(e => console.error('Remote audio play error:', e));
                    console.log('🔊 Remote audio element connected for voice call');
                } else {
                    // Video call: use the video element
                    this.updateRemoteVideo();
                    setTimeout(() => {
                        const remoteVideo = document.getElementById('remoteVideo');
                        if (remoteVideo) {
                            remoteVideo.play().catch(e => console.log('Remote video play error:', e));
                        }
                    }, 500);
                }
            };

            // Connection state monitoring
            this.peerConnection.onconnectionstatechange = () => {
                if (!this.peerConnection) return;
                
                const state = this.peerConnection.connectionState;
                console.log('🔗 Connection state:', state);
                
                switch (state) {
                    case 'connected':
                        this.handleCallConnected();
                        break;
                    case 'disconnected':
                    case 'failed':
                        console.log('❌ Connection failed/disconnected');
                        this.handleCallDisconnected();
                        break;
                    case 'closed':
                        this.cleanup();
                        break;
                }
            };

            // ICE connection state
            this.peerConnection.oniceconnectionstatechange = () => {
                if (!this.peerConnection) return;
                console.log('🧊 ICE connection state:', this.peerConnection.iceConnectionState);
            };

        } catch (error) {
            console.error('❌ Error creating peer connection:', error);
            throw error;
        }
    }

    setupDataChannel() {
        if (this.dataChannel) {
            this.dataChannel.onopen = () => {
                console.log('Data channel opened');
                this.sendCallMetadata();
            };
            
            this.dataChannel.onmessage = (event) => {
                this.handleDataChannelMessage(event.data);
            };
            
            this.dataChannel.onclose = () => {
                console.log('Data channel closed');
            };
            
            this.dataChannel.onerror = (error) => {
                console.error('Data channel error:', error);
            };
        }
    }

    async handleOffer(callId, offer, callerUID, isVideoCall) {
        console.log('📞 Handling incoming call offer:', callId);
        this.showIncomingCallUI(callId, offer, callerUID, isVideoCall);
    }

    async handleAnswer(answer) {
        console.log('✅ Handling answer, current signaling state:', this.signalingState);
        
        if (!this.peerConnection) {
            console.error('❌ No peer connection available for answer');
            return;
        }
        
        // Check if we're in the right state to set remote description
        if (this.signalingState !== 'have-local-offer') {
            console.warn('⚠️ Not in correct state for answer. Current state:', this.signalingState);
            console.log('📥 Queueing answer for later processing');
            this.pendingAnswer = answer;
            return;
        }
        
        if (this.isSettingRemoteDescription) {
            console.log('⏳ Already setting remote description, queuing answer');
            this.pendingAnswer = answer;
            return;
        }
        
        try {
            this.isSettingRemoteDescription = true;
            console.log('🔄 Setting remote description (answer)...');
            
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            console.log('✅ Remote description set successfully, new signaling state:', this.peerConnection.signalingState);
            
            // Process any pending ICE candidates
            await this.processPendingICECandidates();
            
            this.pendingAnswer = null;
            
        } catch (error) {
            console.error('❌ Error setting remote description:', error);
            
            if (error.toString().includes('wrong state') || error.toString().includes('stable')) {
                console.log('🔄 Answer arrived too late, connection already established');
                // This is often not a critical error - the connection might already be working
            } else {
                throw error;
            }
        } finally {
            this.isSettingRemoteDescription = false;
        }
    }

    async processPendingAnswer() {
        if (this.pendingAnswer && this.peerConnection) {
            console.log('🔄 Processing queued answer');
            try {
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(this.pendingAnswer));
                console.log('✅ Queued answer processed successfully');
                this.pendingAnswer = null;
            } catch (error) {
                console.error('❌ Error processing queued answer:', error);
            }
        }
    }

    async handleICECandidate(candidate) {
        if (!this.peerConnection) {
            console.warn('❌ No peer connection for ICE candidate');
            this.pendingICECandidates.push(candidate);
            return;
        }
        
        try {
            // Wait a bit if we're currently setting remote description
            if (this.isSettingRemoteDescription) {
                console.log('⏳ Delaying ICE candidate due to ongoing remote description setting');
                setTimeout(() => this.handleICECandidate(candidate), 100);
                return;
            }
            
            await this.peerConnection.addIceCandidate(candidate);
            console.log('✅ ICE candidate added');
            
        } catch (error) {
            console.error('❌ Error adding ICE candidate:', error);
            
            // If we get a "remote description not set" error, queue the candidate
            if (error.toString().includes('remote description') || !this.peerConnection.remoteDescription) {
                console.log('📥 Queuing ICE candidate (remote description not ready)');
                this.pendingICECandidates.push(candidate);
            }
        }
    }

    async processPendingICECandidates() {
        if (!this.peerConnection || !this.pendingICECandidates.length) return;
        
        console.log(`🔄 Processing ${this.pendingICECandidates.length} pending ICE candidates`);
        
        const candidatesToProcess = [...this.pendingICECandidates];
        this.pendingICECandidates = [];
        
        for (const candidate of candidatesToProcess) {
            try {
                await this.peerConnection.addIceCandidate(candidate);
                console.log('✅ Processed queued ICE candidate');
            } catch (error) {
                console.error('❌ Error processing queued ICE candidate:', error);
                // Don't re-queue failed candidates to avoid infinite loops
            }
        }
    }

    // Media control methods
    toggleVideo() {
        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                this.updateLocalVideo();
                return videoTrack.enabled;
            }
        }
        return false;
    }

    toggleAudio() {
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                return audioTrack.enabled;
            }
        }
        return false;
    }

    async switchCamera() {
        if (!this.localStream) return;
        
        try {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (!videoTrack) {
                console.warn('No video track available');
                this.showModal('Info', 'No camera available on this device', 'info');
                return;
            }
            
            // Check available video input devices
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(device => device.kind === 'videoinput');
            
            if (videoDevices.length < 2) {
                console.warn('Only one camera available on this device');
                this.showModal('Info', 'Only one camera available on this device', 'info');
                return;
            }
            
            const currentFacingMode = videoTrack.getSettings().facingMode;
            const newFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
            
            const constraints = {
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 24 },
                    facingMode: { exact: newFacingMode }
                },
                audio: this.mediaConstraints.audio
            };
            
            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            const newVideoTrack = newStream.getVideoTracks()[0];
            
            if (!newVideoTrack) {
                throw new Error('Failed to get new video track');
            }
            
            const sender = this.peerConnection?.getSenders().find(s => 
                s.track && s.track.kind === 'video'
            );
            
            if (sender && this.peerConnection) {
                await sender.replaceTrack(newVideoTrack);
            }
            
            // Stop old video track
            this.localStream.getVideoTracks().forEach(track => {
                if (track !== newVideoTrack) {
                    track.stop();
                }
            });
            
            // Remove old video tracks and add new one
            this.localStream.getTracks().forEach(track => {
                if (track.kind === 'video' && track !== newVideoTrack) {
                    this.localStream.removeTrack(track);
                }
            });
            
            if (!this.localStream.getVideoTracks().some(t => t === newVideoTrack)) {
                this.localStream.addTrack(newVideoTrack);
            }
            
            this.updateLocalVideo();
            console.log('✅ Camera switched successfully');
            
        } catch (error) {
            console.error('❌ Error switching camera:', error);
            let errorMsg = error.message;
            
            if (error.name === 'NotFoundError' || error.name === 'PermissionDenied') {
                errorMsg = 'Camera not found or permission denied. Make sure you have at least 2 cameras.';
            } else if (error.name === 'NotAllowedError') {
                errorMsg = 'Camera permission denied by user';
            }
            
            this.showModal('Camera Switch Failed', errorMsg, 'error');
        }
    }

    // ── Screen Sharing ──────────────────────────────────────
    isMobileDevice() {
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
               (navigator.maxTouchPoints > 1 && !window.matchMedia('(pointer: fine)').matches);
    }

    async toggleScreenShare() {
        if (!this.isVideoCall) {
            window.showToast?.('Screen sharing is only available during video calls', 'info');
            return false;
        }

        // Mobile browsers don't support getDisplayMedia — OS level restriction
        if (this.isMobileDevice() || typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
            window.showToast?.('Screen sharing is not supported on mobile devices', 'info');
            return false;
        }

        if (this.isScreenSharing) {
            // ── Stop screen share, restore camera ──────────
            try {
                if (this.screenStream) {
                    this.screenStream.getTracks().forEach(t => t.stop());
                    this.screenStream = null;
                }

                // Restore original camera track
                const cameraTrack = this.localStream?.getVideoTracks()[0];
                if (cameraTrack) {
                    const sender = this.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
                    if (sender) await sender.replaceTrack(cameraTrack);
                }

                this.isScreenSharing = false;
                this.updateLocalVideo();

                // Update button UI
                const btn = document.querySelector('.screen-share');
                if (btn) {
                    btn.style.background = '#718096';
                    btn.title = 'Share Screen';
                    btn.innerHTML = window.Icons ? window.Icons.get('monitor', 22) : '⬜';
                }
                window.showToast?.('Screen sharing stopped', 'info');
                return false;
            } catch (err) {
                console.error('Error stopping screen share:', err);
                return false;
            }
        } else {
            // ── Start screen share ─────────────────────────
            try {
                this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: 'always' },
                    audio: false
                });

                const screenTrack = this.screenStream.getVideoTracks()[0];

                // Replace video track in peer connection
                const sender = this.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
                if (sender) await sender.replaceTrack(screenTrack);

                // Show screen in local preview
                const localVideo = document.getElementById('localVideo');
                if (localVideo) localVideo.srcObject = this.screenStream;

                // Auto-stop when user clicks browser's "Stop sharing"
                screenTrack.addEventListener('ended', () => {
                    this.isScreenSharing = true; // set true so toggleScreenShare stops it
                    this.toggleScreenShare();
                });

                this.isScreenSharing = true;

                // Update button UI
                const btn = document.querySelector('.screen-share');
                if (btn) {
                    btn.style.background = '#38a169';
                    btn.title = 'Stop Sharing';
                    btn.innerHTML = window.Icons ? window.Icons.get('stopShare', 22) : '⬜';
                }
                window.showToast?.('Screen sharing started', 'success');
                return true;
            } catch (err) {
                if (err.name === 'NotAllowedError') {
                    console.log('Screen share cancelled by user');
                } else {
                    console.error('Screen share error:', err);
                    window.showToast?.('Screen sharing failed: ' + err.message, 'error');
                }
                return false;
            }
        }
    }

    // UI Methods (same as before, but included for completeness)
    showCallInterface(isCaller, isVideoCall) {
        this.cleanupCallUI();
        
        const callHTML = `
            <div id="callContainer" class="call-container">
                <div class="call-header">
                    <h3>${isVideoCall ? 'Video Call' : 'Voice Call'} with ${this.getUserName(this.callTarget)}</h3>
                    <div class="call-timer">00:00</div>
                    <div class="call-status">${isCaller ? 'Calling...' : 'Connecting...'}</div>
                </div>
                
                <div class="video-container">
                    ${isVideoCall ? `
                        <video id="remoteVideo" class="remote-video" autoplay playsinline></video>
                        <video id="localVideo" class="local-video" autoplay playsinline muted></video>
                    ` : `
                        <div class="voice-call-display">
                            <div class="user-avatar large">${this.getUserAvatar(this.callTarget)}</div>
                            <h4>${this.getUserName(this.callTarget)}</h4>
                            <div class="call-status">${isCaller ? 'Calling...' : 'Connecting...'}</div>
                        </div>
                    `}
                </div>
                
                <div class="call-controls">
                    <button class="call-btn mute-audio" title="Mute Audio">${window.Icons.get('micFill', 24)}</button>
                    ${isVideoCall ? `<button class="call-btn mute-video" title="Mute Video">${window.Icons.get('videoFill', 24)}</button>` : ''}
                    ${isVideoCall && !this.isMobileDevice() ? `<button class="call-btn screen-share" title="Share Screen">${window.Icons.get('monitor', 24)}</button>` : ''}
                    ${isVideoCall ? `<button class="call-btn switch-camera" title="Switch Camera">${window.Icons.get('switchCam', 24)}</button>` : ''}
                    ${!this.isMobileDevice() ? `<button class="call-btn speaker-toggle" id="speakerToggleBtn" title="Switch Audio Output">${window.Icons.get('speakerLoud', 24)}</button>` : ''}
                    <button class="call-btn add-member" title="Add Person to Call">${window.Icons.get('addUser', 24) || '➕'}</button>
                    <button class="call-btn end-call" title="End Call">${window.Icons.get('phoneEnd', 24)}</button>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', callHTML);
        this.setupCallUIEventListeners();
        this.updateLocalVideo();

        // NOTE: Timer is NOT started here — it starts in handleCallConnected() when peer connects
        console.log('✅ Call interface shown');
    }

    showIncomingCallUI(callId, offer, callerUID, isVideoCall) {
        const existingCall = document.getElementById('incomingCall');
        if (existingCall) existingCall.remove();

        // Play ring.mp3 (loops) — with AudioContext unlock for autoplay policy
        this._ringInterval = null;
        const ringAudio = document.getElementById('ringSound');

        const tryPlayRing = () => {
            if (!ringAudio) return;
            ringAudio.currentTime = 0;
            ringAudio.play().then(() => {
                console.log('🔔 Ring started successfully');
            }).catch((err) => {
                console.warn('⚠️ Ring play blocked, trying AudioContext unlock:', err);
                // AudioContext unlock trick — works even without recent user gesture
                // if audio was pre-unlocked on first interaction
                const audioCtx = window._unlockedAudioContext;
                if (audioCtx && audioCtx.state === 'running') {
                    // Resume and retry
                    audioCtx.resume().then(() => {
                        ringAudio.play().catch(() => {
                            // Final fallback: ping.mp3 on repeat
                            const ping = document.getElementById('notifSound');
                            if (ping) {
                                const pingLoop = () => { ping.currentTime = 0; ping.play().catch(() => {}); };
                                pingLoop();
                                this._ringInterval = setInterval(pingLoop, 2500);
                            }
                        });
                    });
                } else {
                    // Fallback: ping.mp3 on repeat
                    const ping = document.getElementById('notifSound');
                    if (ping) {
                        const pingLoop = () => { ping.currentTime = 0; ping.play().catch(() => {}); };
                        pingLoop();
                        this._ringInterval = setInterval(pingLoop, 2500);
                    }
                }
            });
        };

        // If AudioContext exists and is suspended, resume first then play
        if (window._unlockedAudioContext && window._unlockedAudioContext.state === 'suspended') {
            window._unlockedAudioContext.resume().then(tryPlayRing);
        } else {
            tryPlayRing();
        }
        
        const incomingCallHTML = `
            <div id="incomingCall" class="incoming-call-overlay">
                <div class="incoming-call-modal">
                    <div class="caller-info">
                        <div class="caller-avatar large">${this.getUserAvatar(callerUID)}</div>
                        <h3>${this.getUserName(callerUID)}</h3>
                        <p>Incoming ${isVideoCall ? 'Video' : 'Voice'} Call</p>
                    </div>
                    <div class="incoming-call-controls">
                        <button class="call-btn accept-call">${window.Icons.get('phoneAccept', 24)}</button>
                        <button class="call-btn decline-call">${window.Icons.get('phoneEnd', 24)}</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', incomingCallHTML);

        const acceptBtn = document.querySelector('.accept-call');
        const declineBtn = document.querySelector('.decline-call');
        
        const stopRing = () => {
            const ringAudio = document.getElementById('ringSound');
            if (ringAudio) { ringAudio.pause(); ringAudio.currentTime = 0; }
            if (this._ringInterval) { clearInterval(this._ringInterval); this._ringInterval = null; }
        };

        if (acceptBtn) {
            acceptBtn.onclick = () => {
                stopRing();
                this.acceptCall(callId, offer, callerUID, isVideoCall);
                const incomingCall = document.getElementById('incomingCall');
                if (incomingCall) incomingCall.remove();
            };
        }
        
        if (declineBtn) {
            declineBtn.onclick = () => {
                stopRing();
                this.declineCall(callId);
                const incomingCall = document.getElementById('incomingCall');
                if (incomingCall) incomingCall.remove();
            };
        }
        
        // Auto decline after 45 seconds
        setTimeout(() => {
            const incomingCall = document.getElementById('incomingCall');
            if (incomingCall) {
                stopRing();
                this.declineCall(callId);
                incomingCall.remove();
            }
        }, 45000);
    }

    generateCallId() {
        return `call_${currentUser.uid}_${Date.now()}`;
    }

    updateRemoteVideo() {
        const remoteVideo = document.getElementById('remoteVideo');
        const voiceDisplay = document.querySelector('.voice-call-display');
        
        if (this.remoteStream && remoteVideo) {
            console.log('🎥 Setting remote video source');
            remoteVideo.srcObject = this.remoteStream;
            
            // Ensure video plays
            remoteVideo.play().catch(e => {
                console.error('Remote video play failed:', e);
            });
            
            // Hide voice display if this is a video call
            if (voiceDisplay && this.isVideoCall) {
                voiceDisplay.style.display = 'none';
            }
        } else if (!this.isVideoCall && voiceDisplay) {
            // Show voice call UI
            voiceDisplay.style.display = 'block';
        }
    }

    updateLocalVideo() {
        const localVideo = document.getElementById('localVideo');
        if (localVideo && this.localStream) {
            console.log('📹 Setting local video source');
            localVideo.srcObject = this.localStream;
            localVideo.play().catch(e => console.log('Local video play error:', e));
        }
    }

    startCallTimer() {
        // Timer now starts in handleCallConnected() when the peer actually connects.
        // This method is kept for compatibility but does nothing.
        console.log('⏱️ Timer will start when call connects.');
    }

    async endCall(sendSignal = true) {
        console.log('📞 Ending call');

        // Save call log — only once, only by the caller
        try {
            const db = window.db;
            const currentUser = window.currentUser;
            const target = this.callTarget;
            const isVideo = this.isVideoCall;

            if (db && currentUser && target && this.isCaller && !this.callLogSaved) {
                this.callLogSaved = true;
                let durationStr = null;
                if (this.callDurationStartTime) {
                    const secs = Math.floor((Date.now() - this.callDurationStartTime) / 1000);
                    if (secs >= 1) {
                        const m = Math.floor(secs / 60);
                        const s = secs % 60;
                        durationStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
                    }
                }
                const missed = !this.callDurationStartTime;
                const chatId = [currentUser.uid, target].sort().join('_');

                await db.collection('messages').add({
                    chatId,
                    participants: [currentUser.uid, target],
                    sender: currentUser.uid,
                    text: isVideo ? 'Video call' : 'Voice call',
                    callType: isVideo ? 'video' : 'voice',
                    duration: durationStr,
                    missed,
                    time: new Date(),
                    type: 'call'
                });
            }
        } catch (err) {
            console.error('Error saving call log:', err);
        }
        
        if (sendSignal && this.currentCallId && window.signalingManager) {
            try {
                await window.signalingManager.sendCallEnd(this.currentCallId);
            } catch (error) {
                console.error('❌ Error sending call end:', error);
            }
        }
        
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                track.stop();
                track.enabled = false;
            });
        }

        // Clean up screen share stream if active
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
        }
        this.isScreenSharing = false;
        
        if (this.peerConnection) {
            try {
                this.peerConnection.close();
            } catch (error) {
                console.error('❌ Error closing peer connection:', error);
            }
        }
        
        this.cleanupCallUI();
        this.cleanup();
    }

    cleanup() {
        if (this.callTimer) {
            clearInterval(this.callTimer);
            this.callTimer = null;
        }
        
        // FIX: Clean up duration timer
        if (this.callDurationTimer) {
            clearInterval(this.callDurationTimer);
            this.callDurationTimer = null;
        }
        this.callDurationStartTime = null;
        this.callLogSaved = false;
        
        // Remove remote audio element for voice calls
        const remoteAudio = document.getElementById('remoteCallAudio');
        if (remoteAudio) remoteAudio.remove();

        // Clean up AudioContext if used for output routing
        if (this._audioCtx) {
            this._audioCtx.close().catch(() => {});
            this._audioCtx = null;
            this._audioSource = null;
        }

        this.peerConnection = null;
        this.localStream = null;
        this.remoteStream = null;
        this.dataChannel = null;
        this.currentCallId = null;
        this.callTarget = null;
        this.pendingICECandidates = [];
        this.pendingAnswer = null;
        this.isSettingRemoteDescription = false;
        this.signalingState = 'stable';
        
        console.log('🧹 WebRTC cleanup completed');
    }

    cleanupCallUI() {
        const callContainer = document.getElementById('callContainer');
        if (callContainer) {
            callContainer.remove();
        }
        
        const incomingCall = document.getElementById('incomingCall');
        if (incomingCall) {
            incomingCall.remove();
        }

        // Stop ring audio
        const ringAudio = document.getElementById('ringSound');
        if (ringAudio) { ringAudio.pause(); ringAudio.currentTime = 0; }
        if (this._ringInterval) { clearInterval(this._ringInterval); this._ringInterval = null; }
    }

    handleCallConnected() {
        console.log('✅ Call connected successfully!');
        
        // Start duration timer only once when actually connected
        if (!this.callDurationTimer && !this.callDurationStartTime) {
            this.callDurationStartTime = Date.now();
            console.log('⏱️ Starting call duration timer');
            
            this.callDurationTimer = setInterval(() => {
                if (this.callDurationStartTime) {
                    const elapsed = Math.floor((Date.now() - this.callDurationStartTime) / 1000);
                    const mins = Math.floor(elapsed / 60);
                    const secs = elapsed % 60;
                    const display = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                    
                    const timerElement = document.querySelector('.call-timer');
                    if (timerElement) timerElement.textContent = display;
                }
            }, 1000);
        }
        
        const statusElement = document.querySelector('.call-status');
        if (statusElement) {
            statusElement.textContent = 'Connected ✓';
            statusElement.style.color = '#48bb78';
        }
        
        // Ensure videos are playing
        this.updateRemoteVideo();
        this.updateLocalVideo();

        // Apply initial audio output routing (earpiece for voice on mobile, speaker otherwise)
        this._initAudioOutput();
    }

    handleCallDisconnected() {
        console.log('❌ Call disconnected');
        // Guard: if already cleaned up, skip
        if (!this.currentCallId && !this.peerConnection) return;
        this.endCall(false);
    }

    handleCallError(message) {
        console.error('❌ Call error:', message);
        this.showModal('Call Error', message, 'error');
        this.cleanup();
    }

    checkWebRTCSupport() {
        return !!(navigator.mediaDevices && 
                  navigator.mediaDevices.getUserMedia && 
                  window.RTCPeerConnection);
    }

    async declineCall(callId) {
        try {
            if (window.signalingManager) {
                await window.signalingManager.declineCall(callId);
            }
            this.cleanup();
        } catch (error) {
            console.error('❌ Error declining call:', error);
        }
    }

    getUserName(uid) {
        const cached = window.enhancedCache?.get(`user_${uid}`);
        if (cached?.name) return cached.name;
        // Async fetch — when it resolves, patch the call header if still visible
        if (window.db && uid) {
            window.db.collection('users').doc(uid).get().then(doc => {
                if (doc.exists) {
                    const data = doc.data();
                    window.enhancedCache?.set(`user_${uid}`, data, 30 * 60 * 1000);
                    // Patch call header name if the call is still active
                    const header = document.querySelector('#callContainer .call-header h3');
                    if (header && this.callTarget === uid) {
                        header.textContent = `${this.isVideoCall ? 'Video Call' : 'Voice Call'} with ${data.name || 'User'}`;
                    }
                    // Patch incoming call UI
                    const callerNameEl = document.querySelector('#incomingCall .caller-info h3');
                    if (callerNameEl && callerNameEl.textContent === 'User') {
                        callerNameEl.textContent = data.name || 'User';
                    }
                }
            }).catch(() => {});
        }
        return 'User';
    }

    getUserAvatar(uid) {
        const cached = window.enhancedCache?.get(`user_${uid}`);
        if (cached?.photoURL) {
            return `<img src="${cached.photoURL}" alt="${(cached.name||'U').charAt(0)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
        }
        return cached?.name?.charAt(0)?.toUpperCase() || 'U';
    }

    showModal(title, message, type = 'info') {
        if (window.modalManager) {
            window.modalManager.showModal(title, message, type);
        } else {
            alert(`${title}: ${message}`);
        }
    }

    setupCallUIEventListeners() {
        const muteAudioBtn    = document.querySelector('.mute-audio');
        const muteVideoBtn    = document.querySelector('.mute-video');
        const screenShareBtn  = document.querySelector('.screen-share');
        const switchCameraBtn = document.querySelector('.switch-camera');
        const speakerBtn      = document.querySelector('.speaker-toggle');
        const addMemberBtn    = document.querySelector('.add-member');
        const endCallBtn      = document.querySelector('.end-call');

        if (muteAudioBtn) {
            muteAudioBtn.addEventListener('click', () => {
                const isMuted = !this.toggleAudio();
                muteAudioBtn.style.background = isMuted ? '#e53e3e' : '#718096';
                muteAudioBtn.title = isMuted ? 'Unmute Audio' : 'Mute Audio';
            });
        }

        if (muteVideoBtn) {
            muteVideoBtn.addEventListener('click', () => {
                const isVideoMuted = !this.toggleVideo();
                muteVideoBtn.style.background = isVideoMuted ? '#e53e3e' : '#718096';
                muteVideoBtn.title = isVideoMuted ? 'Enable Video' : 'Disable Video';
            });
        }

        if (screenShareBtn) {
            screenShareBtn.addEventListener('click', () => {
                this.toggleScreenShare();
            });
        }

        if (switchCameraBtn) {
            switchCameraBtn.addEventListener('click', () => {
                this.switchCamera();
            });
        }

        if (addMemberBtn) {
            addMemberBtn.addEventListener('click', () => {
                this.openAddMemberSheet();
            });
        }

        if (speakerBtn) {
            speakerBtn.addEventListener('click', () => {
                this.toggleAudioOutput(speakerBtn);
            });
        }

        if (endCallBtn) {
            endCallBtn.addEventListener('click', () => {
                this.endCall();
            });
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  AUDIO OUTPUT ROUTING — Earpiece / Loudspeaker switcher
    //  Works on mobile (setSinkId where supported) and desktop
    //  (enumerateDevices to find output devices).
    //  Audio calls default to earpiece on mobile.
    //  Video calls / desktop default to loudspeaker.
    // ══════════════════════════════════════════════════════════════

    async toggleAudioOutput(btn) {
        const isMobile = this.isMobileDevice();

        // Toggle mode
        if (this._audioOutputMode === 'earpiece') {
            this._audioOutputMode = 'speaker';
        } else {
            this._audioOutputMode = 'earpiece';
        }

        const goingSpeaker = this._audioOutputMode === 'speaker';

        // Update button icon + title + CSS class
        if (btn) {
            btn.innerHTML = window.Icons
                ? window.Icons.get(goingSpeaker ? 'speakerLoud' : 'speakerEar', 24)
                : (goingSpeaker ? '🔊' : '🔉');
            btn.title = goingSpeaker
                ? (isMobile ? 'Switch to Earpiece' : 'Using Loudspeaker')
                : (isMobile ? 'Switch to Loudspeaker' : 'Using Headphones/Default');
            btn.classList.toggle('earpiece-mode', !goingSpeaker);
        }

        await this._applyAudioOutput();

        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (isIOS) {
            window.showToast?.(
                goingSpeaker
                    ? 'Speaker preferred — iOS routes audio automatically'
                    : 'Earpiece preferred — iOS routes audio automatically',
                'info'
            );
        } else {
            window.showToast?.(
                goingSpeaker ? 'Switched to Speaker' : (isMobile ? 'Switched to Earpiece' : 'Switched to Default Output'),
                'info'
            );
        }
    }

    async _applyAudioOutput() {
        const goingSpeaker = this._audioOutputMode === 'speaker';
        const isMobile = this.isMobileDevice();

        const elements = [
            document.getElementById('remoteCallAudio'),
            document.getElementById('remoteVideo'),
        ].filter(Boolean);

        // ── Strategy 1: setSinkId — works on desktop Chrome and some Android Chrome ──
        // Check setSinkId on HTMLMediaElement prototype, not just the first element
        // (element may not exist yet when this is called early).
        const sinkIdSupported = typeof HTMLMediaElement.prototype.setSinkId === 'function';

        if (sinkIdSupported && elements.length) {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const outputs = devices.filter(d => d.kind === 'audiooutput');

                let targetDevice = null;
                if (goingSpeaker) {
                    targetDevice = outputs.find(d => /speaker|loudspeaker/i.test(d.label))
                                || outputs.find(d => d.deviceId === 'default')
                                || outputs[0];
                } else {
                    targetDevice = outputs.find(d => /earpiece|ear|receiver/i.test(d.label))
                                || outputs.find(d => /communications|headset/i.test(d.label))
                                || outputs.find(d => d.deviceId === 'default')
                                || outputs[0];
                }

                if (targetDevice) {
                    for (const el of elements) {
                        await el.setSinkId(targetDevice.deviceId).catch(e =>
                            console.warn('setSinkId failed for element:', e)
                        );
                    }
                    this._audioOutputDeviceId = targetDevice.deviceId;
                    console.log('🔊 Audio output set via setSinkId:', targetDevice.label || targetDevice.deviceId);
                    return; // done
                }
            } catch (e) {
                console.warn('setSinkId strategy failed:', e);
            }
        }

        // ── Strategy 2: AudioContext routing (Android Chrome without setSinkId) ──
        // Route the remote stream through an AudioContext so the OS audio session
        // picks up the correct output. Does NOT work on iOS Safari — handled below.
        if (!isMobile || /Android/i.test(navigator.userAgent)) {
            try {
                const audioEl = document.getElementById('remoteCallAudio');
                const srcEl   = audioEl || document.getElementById('remoteVideo');
                if (srcEl?.srcObject) {
                    // Tear down old AudioContext if any
                    if (this._audioCtx) {
                        this._audioCtx.close().catch(() => {});
                        this._audioCtx = null;
                        this._audioSource = null;
                    }

                    const ctx    = new (window.AudioContext || window.webkitAudioContext)();
                    const source = ctx.createMediaStreamSource(srcEl.srcObject);
                    source.connect(ctx.destination);
                    this._audioCtx    = ctx;
                    this._audioSource = source;

                    // Mute the element itself to avoid double playback
                    srcEl.muted = true;
                    console.log('🔊 Audio routed via AudioContext');
                    return;
                }
            } catch (e) {
                console.warn('AudioContext routing failed:', e);
            }
        }

        // ── Strategy 3: iOS Safari — no programmatic earpiece/speaker control ──
        // iOS Safari does not expose setSinkId or allow AudioContext output routing.
        // The OS routes audio automatically: earpiece for voice calls, speaker for video.
        // There is nothing the web app can do to override this per Apple's WebKit policy.
        // We log and let the toast inform the user.
        if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
            console.log('ℹ️ iOS Safari: audio output routing not available from web — OS controls routing.');
        }
    }

    // Call this after remote stream is attached so the initial audio routing is applied
    _initAudioOutput() {
        const btn = document.querySelector('.speaker-toggle');
        const isMobile = this.isMobileDevice();
        if (btn) {
            const isSpeaker = this._audioOutputMode === 'speaker';
            btn.innerHTML = window.Icons
                ? window.Icons.get(isSpeaker ? 'speakerLoud' : 'speakerEar', 24)
                : (isSpeaker ? '🔊' : '🔉');
            btn.title = isSpeaker
                ? (isMobile ? 'Switch to Earpiece' : 'Using Loudspeaker')
                : (isMobile ? 'Switch to Loudspeaker' : 'Using Default Output');
            btn.classList.toggle('earpiece-mode', !isSpeaker);
        }
        this._applyAudioOutput();
    }

    sendCallMetadata() {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(JSON.stringify({
                type: 'metadata',
                user: currentUserData?.name || 'User',
                timestamp: new Date().toISOString()
            }));
        }
    }

    handleDataChannelMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('Data channel message:', message);

            // Handle group call migration signal
            if (message.type === 'group_migrate' && message.roomId) {
                this.handleGroupMigrationSignal(message.roomId, message.isVideo);
            }
        } catch (error) {
            console.error('Error parsing data channel message:', error);
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  ADD PERSON TO CALL — Friend Picker + Group Call Upgrade
    // ══════════════════════════════════════════════════════════════

    /**
     * Opens the bottom-sheet friend picker.
     * Uses styles already in call-styles.css:
     *   .add-member-overlay, .add-member-sheet, .am-friend-item, etc.
     */
    async openAddMemberSheet() {
        // Remove any existing sheet
        const existing = document.getElementById('addMemberOverlay');
        if (existing) { existing.remove(); return; }

        const overlay = document.createElement('div');
        overlay.id = 'addMemberOverlay';
        overlay.className = 'add-member-overlay';
        overlay.innerHTML = `
            <div class="add-member-sheet" id="addMemberSheet">
                <div class="add-member-header">
                    <h3>Add Person to Call</h3>
                    <button class="add-member-close" id="amCloseBtn" title="Close">✕</button>
                </div>
                <div class="add-member-search">
                    <input type="text" id="amSearchInput" placeholder="Search friends…" autocomplete="off">
                </div>
                <div class="add-member-list" id="amFriendList">
                    <div class="add-member-empty">Loading friends…</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // Close on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        document.getElementById('amCloseBtn').addEventListener('click', () => overlay.remove());

        // Search filter
        document.getElementById('amSearchInput').addEventListener('input', (e) => {
            this._renderFriendList(this._amFriends || [], e.target.value.toLowerCase());
        });

        // Load friends
        await this._loadFriendsForAddMember();
    }

    async _loadFriendsForAddMember() {
        const listEl = document.getElementById('amFriendList');
        if (!listEl) return;

        try {
            const db = window.db;
            const currentUser = window.currentUser;
            if (!db || !currentUser) {
                listEl.innerHTML = '<div class="add-member-empty">Not signed in.</div>';
                return;
            }

            // Friends are stored as a UID array in users/{uid}.friends
            const friendUIDs = (window.currentUserData?.friends || [])
                .filter(uid => uid && uid !== this.callTarget);

            if (friendUIDs.length === 0) {
                this._amFriends = [];
                this._amInvited = new Set();
                this._renderFriendList([], '');
                return;
            }

            // Fetch names/photos — use cache first, then batch-fetch missing ones
            const friends = [];
            const toFetch = [];

            for (const uid of friendUIDs) {
                const cached = window.enhancedCache?.get(`user_${uid}`);
                if (cached?.name) {
                    friends.push({ uid, name: cached.name, photo: cached.photoURL || '' });
                } else {
                    toFetch.push(uid);
                }
            }

            // Batch fetch uncached users (Firestore 'in' supports up to 30 per query)
            const CHUNK = 30;
            for (let i = 0; i < toFetch.length; i += CHUNK) {
                const chunk = toFetch.slice(i, i + CHUNK);
                const snap = await db.collection('users')
                    .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
                    .get();
                snap.forEach(doc => {
                    const d = doc.data();
                    window.enhancedCache?.set(`user_${doc.id}`, d, 30 * 60 * 1000);
                    friends.push({ uid: doc.id, name: d.name || doc.id.slice(0, 8), photo: d.photoURL || '' });
                });
            }

            // Sort by name
            friends.sort((a, b) => a.name.localeCompare(b.name));

            this._amFriends = friends;
            this._amInvited = new Set();
            this._renderFriendList(friends, '');
        } catch (err) {
            console.error('Error loading friends for add-member:', err);
            if (document.getElementById('amFriendList')) {
                document.getElementById('amFriendList').innerHTML =
                    '<div class="add-member-empty">Could not load friends.</div>';
            }
        }
    }

    _renderFriendList(friends, query) {
        const listEl = document.getElementById('amFriendList');
        if (!listEl) return;

        const filtered = query
            ? friends.filter(f => f.name.toLowerCase().includes(query))
            : friends;

        if (!filtered.length) {
            listEl.innerHTML = '<div class="add-member-empty">No friends found.</div>';
            return;
        }

        listEl.innerHTML = filtered.map(f => {
            const invited = this._amInvited?.has(f.uid);
            const avatarHTML = f.photo
                ? `<img src="${f.photo}" alt="${this._escHTML(f.name)}">`
                : this._escHTML((f.name[0] || '?').toUpperCase());
            return `
                <button class="am-friend-item" data-uid="${f.uid}" ${invited ? 'disabled' : ''}>
                    <div class="am-avatar">${avatarHTML}</div>
                    <div class="am-info">
                        <div class="am-name">${this._escHTML(f.name)}</div>
                        <div class="am-status">${invited ? 'Invite sent' : 'Tap to invite'}</div>
                    </div>
                    <span class="${invited ? 'am-invited-badge' : 'am-invite-badge'}">
                        ${invited ? 'Invited' : 'Invite'}
                    </span>
                </button>`;
        }).join('');

        // Attach click listeners
        listEl.querySelectorAll('.am-friend-item:not([disabled])').forEach(btn => {
            btn.addEventListener('click', () => {
                const uid = btn.dataset.uid;
                const friend = friends.find(f => f.uid === uid);
                if (friend) this._invitePersonToCall(uid, friend.name, btn);
            });
        });
    }

    /**
     * Core logic: upgrades the 1-to-1 call to a group call room,
     * then sends a Firestore invite to the chosen friend.
     *
     * Flow:
     *  1. If GroupCallManager not already active → migrate this 1-1 call into a group room
     *  2. Send groupCallInvite doc → friend's listener picks it up and shows incoming call UI
     *  3. Show "Invited" badge on the button
     */
    async _invitePersonToCall(targetUID, targetName, btnEl) {
        if (!this.currentCallId) return;

        // Disable button immediately to prevent double-tap
        btnEl.disabled = true;
        btnEl.querySelector('.am-invite-badge').textContent = 'Sending…';

        try {
            // ── Step 1: Migrate 1-1 call to group call room ──────────
            // Use the existing callId as the group room ID so both
            // the current caller and callee can join the same mesh.
            const roomId = this.currentCallId;

            if (!window.GroupCallManager?.isActive()) {
                console.log('🔄 Migrating 1-1 call to group room:', roomId);

                // Tell the remote peer (callee of the original 1-1 call) to
                // also join the group room via signaling custom message.
                // We piggy-back on the data channel if open, otherwise
                // send a Firestore migration signal.
                await this._sendGroupMigrationSignal(roomId);

                // Start GroupCallManager on this side with the same room
                // (carries over the existing local stream concept but opens new mesh)
                await window.GroupCallManager.startCall(roomId, this.isVideoCall);
            }

            // ── Step 2: Send invite to the new person ────────────────
            const sent = await window.GroupCallManager.inviteToRoom(targetUID, roomId, this.isVideoCall);

            if (sent) {
                if (!this._amInvited) this._amInvited = new Set();
                this._amInvited.add(targetUID);

                // Update button UI
                btnEl.querySelector('.am-invite-badge').textContent = 'Invited';
                btnEl.querySelector('.am-status').textContent = 'Invite sent';
                btnEl.classList.add('am-invited');

                window.showToast?.(`Invite sent to ${targetName}`, 'success');
                console.log(`✅ Group call invite sent to ${targetName}`);

                // Close the sheet after a short delay
                setTimeout(() => {
                    const overlay = document.getElementById('addMemberOverlay');
                    if (overlay) overlay.remove();
                }, 900);
            } else {
                throw new Error('inviteToRoom returned false');
            }
        } catch (err) {
            console.error('❌ Error inviting person to call:', err);
            btnEl.disabled = false;
            btnEl.querySelector('.am-invite-badge').textContent = 'Retry';
            window.showToast?.('Could not send invite: ' + err.message, 'error');
        }
    }

    /**
     * Sends a migration signal to the existing 1-1 call peer so they
     * know to also join the group room.  We try the data channel first,
     * then fall back to a Firestore signal doc.
     */
    async _sendGroupMigrationSignal(roomId) {
        const payload = JSON.stringify({ type: 'group_migrate', roomId, isVideo: this.isVideoCall });

        // Try data channel (fast path)
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(payload);
            console.log('📡 Migration signal sent via data channel');
            return;
        }

        // Fallback: Firestore signal doc
        try {
            const db = window.db;
            const currentUser = window.currentUser;
            if (db && currentUser && this.callTarget) {
                await db.collection('groupCallMigrations').add({
                    from:    currentUser.uid,
                    to:      this.callTarget,
                    roomId,
                    isVideo: this.isVideoCall,
                    callId:  this.currentCallId,
                    created: new Date()
                });
                console.log('📡 Migration signal sent via Firestore');
            }
        } catch (e) {
            console.warn('Migration signal send failed (non-critical):', e);
        }
    }

    /**
     * Called by the data channel message handler when a 'group_migrate'
     * message is received — the callee side auto-joins the group room.
     */
    async handleGroupMigrationSignal(roomId, isVideo) {
        console.log('📥 Received group migration signal, joining room:', roomId);
        try {
            if (!window.GroupCallManager?.isActive()) {
                await window.GroupCallManager.joinExistingCall(roomId, isVideo);
                window.showToast?.('Joined group call', 'info');
            }
        } catch (err) {
            console.error('Error joining group call via migration:', err);
        }
    }

    _escHTML(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}

window.webRTCManager = new WebRTCManager();
