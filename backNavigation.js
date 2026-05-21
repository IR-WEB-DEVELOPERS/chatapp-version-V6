// ============================================================
//  backNavigation.js — Hash-based Mobile Back Navigation
//
//  Chat open  → location.hash = '#chat'
//  Modal open → location.hash = '#modal'
//  Home       → location.hash = '' (or #home)
//
//  Android back button changes hash → hashchange event fires
//  → we close whatever is open. Simple, reliable, no pushState tricks.
// ============================================================

(function () {

    // ── Go back to home view ───────────────────────────────────
    function goHome() {
        document.getElementById('individualChat')    && (document.getElementById('individualChat').style.display    = 'none');
        document.getElementById('groupChatContainer')&& (document.getElementById('groupChatContainer').style.display= 'none');
        document.getElementById('aiChatPane')        && (document.getElementById('aiChatPane').style.display        = 'none');
        document.getElementById('defaultChat')       && (document.getElementById('defaultChat').style.display       = 'flex');

        window._showSidebarOnMobile?.();

        if (typeof window.unsubscribeDirectMessages === 'function') {
            window.unsubscribeDirectMessages(); window.unsubscribeDirectMessages = null;
        }
        if (typeof window.unsubscribeGroupMessages === 'function') {
            window.unsubscribeGroupMessages(); window.unsubscribeGroupMessages = null;
        }
        window.chatWithUID = null;
        window.groupChatID = null;
    }

    // ── Close topmost overlay/modal ────────────────────────────
    function closeTopLayer() {
        // friendProfile
        const fp = document.querySelector('.fp-overlay');
        if (fp) { window.friendProfileViewer?.close?.(); return true; }

        // QR scanner
        const qr = document.getElementById('qrScannerOverlay');
        if (qr) { window.QRManager?.closeScannerModal?.(); return true; }

        // OTV modal
        const otv = document.querySelector('.otv-overlay');
        if (otv) { otv.remove(); return true; }

        // Media lightbox
        const lb = document.querySelector('.mlb-overlay, #mediaLightbox, .media-lightbox-overlay');
        if (lb) { window.mediaLightbox?.close?.(); lb.isConnected && lb.remove(); return true; }

        // Any visible modal-overlay
        const modals = Array.from(document.querySelectorAll('.modal-overlay'))
            .filter(m => m.style.display !== 'none' && m.offsetParent !== null);
        if (modals.length) {
            const top = modals[modals.length - 1];
            const btn = top.querySelector('.modal-close, [data-action="cancel"]');
            btn ? btn.click() : (top.style.display = 'none');
            return true;
        }

        // Theme panel
        if (window.ThemeManager?.isPanelOpen?.()) { window.ThemeManager.closePanel?.(); return true; }

        // Sidebar dropdown
        const dd = document.getElementById('sidebarDropdown');
        if (dd?.classList.contains('open')) { dd.classList.remove('open'); return true; }

        // Emoji picker
        if (window.emojiPicker?.isOpen?.()) { window.emojiPicker.close?.(); return true; }

        // Sidebar backdrop
        const bd = document.getElementById('sidebarBackdrop');
        if (bd?.offsetParent !== null) { bd.click(); return true; }

        return false;
    }

    function isChatOpen() {
        const i = document.getElementById('individualChat');
        const g = document.getElementById('groupChatContainer');
        return (i && i.style.display !== 'none') || (g && g.style.display !== 'none');
    }

    // ── hashchange fires reliably on Android back ──────────────
    window.addEventListener('hashchange', function (e) {
        const from = new URL(e.oldURL).hash;
        const to   = new URL(e.newURL).hash;

        // Only handle back navigation (going from deeper → shallower)
        // i.e. hash was removed or went to #home
        if (to === '' || to === '#home') {
            // First try closing overlays
            if (closeTopLayer()) {
                // Still in chat → keep #chat hash
                if (isChatOpen()) {
                    history.replaceState(null, '', '#chat');
                } else {
                    history.replaceState(null, '', '#home');
                }
                return;
            }
            // No overlay → close chat
            if (isChatOpen()) {
                goHome();
                history.replaceState(null, '', '#home');
                return;
            }
        }

        if (to === '#chat' && from === '#modal') {
            // Came back from modal → close the modal, stay in chat
            closeTopLayer();
            history.replaceState(null, '', '#chat');
        }
    });

    // ── Public API ─────────────────────────────────────────────
    window.BackNavigation = {
        // Call when opening a chat
        onChatOpen() {
            location.hash = 'chat';
        },
        // Call when opening any modal/overlay
        onOverlayOpen() {
            // Only push #modal if we're in a chat (so back goes #modal → #chat → #home)
            if (isChatOpen()) {
                location.hash = 'modal';
            }
        },
        // Call when closing a modal normally (not via back button)
        onOverlayClose() {
            if (location.hash === '#modal' && isChatOpen()) {
                history.replaceState(null, '', '#chat');
            }
        },
        registerSidebarFns(showFn, hideFn) {
            window._showSidebarOnMobile = showFn;
            window._hideSidebarOnMobile = hideFn;
        }
    };

    // Seed home hash on load
    if (!location.hash || location.hash === '#') {
        history.replaceState(null, '', '#home');
    }

    console.log('backNavigation.js loaded (hash-based)');
})();
