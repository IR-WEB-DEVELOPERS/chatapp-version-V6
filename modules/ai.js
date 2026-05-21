// ============================================================
//  ai.js — AI Assistant Chat Module
//  - AI Assistant "contact" chats list lo top lo kanipisthundi
//  - User ela matladina sare, AI always manchiga respond avthundi
// ============================================================

(function () {
    const AI_UID      = '__ai_assistant__';
    const AI_NAME     = '🤖 AI Assistant';
    const AI_AVATAR   = '🤖';
    const STORAGE_KEY = 'aiChatHistory_v1';
    const MAX_HISTORY = 40; // last N messages to send as context

    // ── System prompt: always be kind ────────────────────────
    const SYSTEM_PROMPT = `You are a friendly, warm AI assistant embedded in a chat app.
No matter what the user says — even if they are rude, angry, abusive, or use bad language —
you MUST always respond calmly, kindly, and helpfully. Never mirror negative language.
Never refuse to help just because the user is being rude. Instead, gently acknowledge their
frustration and offer genuine help. Keep responses conversational and concise (1-4 sentences
usually). You can use emojis sparingly to keep the tone warm. Speak in whatever language the
user is speaking (Telugu, Hindi, English, etc.).`;

    // ── Load / save chat history from localStorage ────────────
    function loadHistory() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
        catch { return []; }
    }
    function saveHistory(hist) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(hist.slice(-MAX_HISTORY))); }
        catch {}
    }

    // ── Call Claude via server proxy (keeps API key off browser) ─────────
    async function callClaude(history) {
        const messages = history.map(m => ({
            role: m.role,
            content: m.content
        }));

        const res = await fetch('/api/ai-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system: SYSTEM_PROMPT, messages })
        });

        if (!res.ok) throw new Error(`Proxy error ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data.text || '...';
    }

    // ── Escape helpers (reuse app's if available) ─────────────
    const esc = t => {
        if (window.escapeHTML) return window.escapeHTML(t);
        return String(t)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    };

    // ── Format time ───────────────────────────────────────────
    function fmtTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // ── Render a single message bubble ────────────────────────
    function bubbleHTML(msg) {
        const cls = msg.role === 'user' ? 'sent' : 'received';
        return `
        <div class="message ${cls}" data-ai-msg>
            <div class="message-bubble">
                <p class="message-text">${esc(msg.content)}</p>
                <span class="message-time">${fmtTime(msg.ts || Date.now())}</span>
            </div>
        </div>`;
    }

    // ── Typing indicator ──────────────────────────────────────
    function showTyping(chatEl) {
        const el = document.createElement('div');
        el.className = 'message received';
        el.id = 'aiTypingIndicator';
        el.setAttribute('data-ai-msg', '');
        el.innerHTML = `
        <div class="message-bubble" style="padding:10px 14px;">
            <div class="typing-dots" style="display:flex;gap:4px;align-items:center;">
                <span style="width:7px;height:7px;background:currentColor;border-radius:50%;opacity:.5;animation:aiDot 1s infinite 0s;"></span>
                <span style="width:7px;height:7px;background:currentColor;border-radius:50%;opacity:.5;animation:aiDot 1s infinite .2s;"></span>
                <span style="width:7px;height:7px;background:currentColor;border-radius:50%;opacity:.5;animation:aiDot 1s infinite .4s;"></span>
            </div>
        </div>`;
        chatEl.appendChild(el);
        chatEl.scrollTop = chatEl.scrollHeight;
    }
    function hideTyping() {
        document.getElementById('aiTypingIndicator')?.remove();
    }

    // inject keyframe if not already there
    function ensureKeyframe() {
        if (document.getElementById('aiDotStyle')) return;
        const s = document.createElement('style');
        s.id = 'aiDotStyle';
        s.textContent = `@keyframes aiDot{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}`;
        document.head.appendChild(s);
    }

    // ── Open the AI chat pane ─────────────────────────────────
    function openAIChat() {
        const defaultChat        = document.getElementById('defaultChat');
        const individualChat     = document.getElementById('individualChat');
        const groupChatContainer = document.getElementById('groupChatContainer');

        if (defaultChat)        defaultChat.style.display        = 'none';
        if (individualChat)     individualChat.style.display     = 'none';
        if (groupChatContainer) groupChatContainer.style.display = 'none';

        // Hide sidebar on mobile
        if (window._hideSidebarOnMobile) window._hideSidebarOnMobile();

        // Build or show the AI chat pane
        let pane = document.getElementById('aiChatPane');
        if (!pane) {
            pane = buildAIPaneDOM();
            // Insert inside chat-area (same parent as other chat containers)
            const chatArea = document.querySelector('.chat-area');
            if (chatArea) {
                chatArea.appendChild(pane);
            } else {
                const ref = individualChat || groupChatContainer;
                ref?.parentNode?.appendChild(pane);
            }
        }
        pane.style.display = 'flex';

        // Render existing history
        renderHistory();
    }

    // ── Build the AI pane DOM ─────────────────────────────────
    function buildAIPaneDOM() {
        ensureKeyframe();
        const pane = document.createElement('div');
        pane.id = 'aiChatPane';
        pane.className = 'chat-container';
        // Let chat-container CSS handle layout; only override display
        pane.style.cssText = 'display:flex;overflow:hidden;';

        pane.innerHTML = `
        <div class="chat-header">
            <button class="mobile-back-btn" id="aiBackBtn">&#8592;</button>
            <div class="chat-partner">
                <div class="chat-avatar" style="font-size:1.6rem;display:flex;align-items:center;justify-content:center;">🤖</div>
                <div class="partner-info">
                    <h4>${esc(AI_NAME)}</h4>
                    <span class="status-online" style="font-size:.75rem;">Always here for you ✨</span>
                </div>
            </div>
            <button id="aiClearBtn" title="Clear Chat" style="margin-left:auto;background:none;border:none;cursor:pointer;padding:6px 10px;border-radius:8px;font-size:.8rem;color:var(--text-secondary,#888);display:flex;align-items:center;gap:4px;opacity:.8;transition:opacity .2s;">
                🗑️ Clear
            </button>
        </div>
        <div id="aiMessages" class="chat-messages"></div>
        <div class="message-input">
            <div class="message-input-container">
                <textarea id="aiMsgInput" placeholder="Type a message..." rows="1"></textarea>
                <button id="aiSendBtn" class="send-btn" title="Send">
                    ${window.Icons ? window.Icons.get('send', 20) : '➤'}
                </button>
            </div>
        </div>`;

        // Clear chat button
        pane.querySelector('#aiClearBtn').addEventListener('click', () => {
            if (confirm('Chat history clear చేయాలా?')) {
                localStorage.removeItem(STORAGE_KEY);
                renderHistory();
            }
        });

        // Back button
        pane.querySelector('#aiBackBtn').addEventListener('click', () => {
            pane.style.display = 'none';
            const defaultChat = document.getElementById('defaultChat');
            if (defaultChat) defaultChat.style.display = '';
            if (window._showSidebarOnMobile) window._showSidebarOnMobile();
        });

        // Send on button click
        pane.querySelector('#aiSendBtn').addEventListener('click', handleAISend);

        // Send on Enter (Shift+Enter = newline)
        pane.querySelector('#aiMsgInput').addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleAISend();
            }
        });

        // Auto-grow textarea
        pane.querySelector('#aiMsgInput').addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });

        return pane;
    }

    // ── Render all history into #aiMessages ───────────────────
    function renderHistory() {
        const chatEl = document.getElementById('aiMessages');
        if (!chatEl) return;
        const hist = loadHistory();
        if (hist.length === 0) {
            chatEl.innerHTML = `<div style="text-align:center;opacity:.5;margin-top:40px;font-size:.9rem;">👋 Nenu mee AI Assistant!<br>Emaina adugandi — ela matladina sare manchiga cheppanu. 😊</div>`;
        } else {
            chatEl.innerHTML = hist.map(bubbleHTML).join('');
        }
        chatEl.scrollTop = chatEl.scrollHeight;
    }

    // ── Handle send ───────────────────────────────────────────
    async function handleAISend() {
        const input  = document.getElementById('aiMsgInput');
        const chatEl = document.getElementById('aiMessages');
        if (!input || !chatEl) return;

        const text = input.value.trim();
        if (!text) return;

        input.value = '';
        input.style.height = 'auto';

        // Add user message
        const hist = loadHistory();
        const userMsg = { role: 'user', content: text, ts: Date.now() };
        hist.push(userMsg);
        saveHistory(hist);

        // Clear placeholder and show message
        chatEl.innerHTML = hist.map(bubbleHTML).join('');
        chatEl.scrollTop = chatEl.scrollHeight;

        // Show typing
        showTyping(chatEl);

        try {
            // Send only role+content to API (no ts field)
            const apiHistory = hist.map(m => ({ role: m.role, content: m.content }));
            const reply = await callClaude(apiHistory);

            hideTyping();

            const aiMsg = { role: 'assistant', content: reply, ts: Date.now() };
            hist.push(aiMsg);
            saveHistory(hist);

            // Append AI bubble
            const bubble = document.createElement('div');
            bubble.setAttribute('data-ai-msg', '');
            bubble.innerHTML = bubbleHTML(aiMsg);
            chatEl.appendChild(bubble.firstElementChild);
            chatEl.scrollTop = chatEl.scrollHeight;

        } catch (err) {
            hideTyping();
            console.error('AI chat error:', err);
            const errMsg = { role: 'assistant', content: 'Oops! Oka chinna problem vasindi. Konchem try chesaanu, maafi chesukoddi 🙏', ts: Date.now() };
            const hist2 = loadHistory();
            hist2.push(errMsg);
            saveHistory(hist2);

            const bubble = document.createElement('div');
            bubble.setAttribute('data-ai-msg', '');
            bubble.innerHTML = bubbleHTML(errMsg);
            chatEl.appendChild(bubble.firstElementChild);
            chatEl.scrollTop = chatEl.scrollHeight;
        }
    }

    // ── Inject AI entry into the friends/chats list ───────────
    function injectAIIntoFriendsList() {
        const friendsList = document.getElementById('friendsList');
        if (!friendsList) return;
        if (friendsList.querySelector('[data-ai-uid]')) return; // already injected

        const btn = document.createElement('button');
        btn.className = 'chat-item';
        btn.setAttribute('data-ai-uid', AI_UID);
        btn.style.cssText = 'border-top: 2px solid var(--accent,#6c63ff); margin-bottom:4px;';
        btn.innerHTML = `
            <div class="chat-avatar" style="font-size:1.5rem;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#6c63ff22,#a78bfa22);border-radius:50%;width:44px;height:44px;">🤖</div>
            <div class="chat-info">
                <div class="chat-item-top">
                    <h4 style="color:var(--accent,#6c63ff);">${esc(AI_NAME)}</h4>
                    <span class="chat-item-time" style="color:var(--accent,#6c63ff);font-size:.7rem;">AI</span>
                </div>
                <div class="chat-item-bottom">
                    <p class="chat-item-preview">Emaina adugandi 😊</p>
                </div>
            </div>`;
        btn.addEventListener('click', openAIChat);

        // Prepend at top
        friendsList.insertBefore(btn, friendsList.firstChild);
    }

    // ── Hook into _renderFriendsList so AI is always re-injected ──
    function hookRenderFriendsList() {
        const original = window._renderFriendsList;
        if (!original || original.__aiHooked) return false;
        const hooked = function () {
            original.apply(this, arguments);
            setTimeout(injectAIIntoFriendsList, 50);
        };
        hooked.__aiHooked = true;
        window._renderFriendsList = hooked;
        return true;
    }

    // ── MutationObserver fallback ─────────────────────────────
    function watchWithObserver() {
        const friendsList = document.getElementById('friendsList');
        if (!friendsList) return false;
        const obs = new MutationObserver(() => {
            if (!friendsList.querySelector('[data-ai-uid]')) {
                injectAIIntoFriendsList();
            }
        });
        obs.observe(friendsList, { childList: true });
        return true;
    }

    // ── Init ──────────────────────────────────────────────────
    function init() {
        hookRenderFriendsList();
        watchWithObserver();
        // Inject immediately if list already has items
        injectAIIntoFriendsList();

        // Keep retrying for a few seconds in case list renders late
        let tries = 0;
        const retry = setInterval(() => {
            hookRenderFriendsList();
            watchWithObserver();
            injectAIIntoFriendsList();
            if (++tries >= 20) clearInterval(retry);
        }, 500);
    }

    setTimeout(init, 800);

    // Expose for debug
    window.aiAssistant = { openAIChat, clearHistory: () => { localStorage.removeItem(STORAGE_KEY); renderHistory(); } };
})();
