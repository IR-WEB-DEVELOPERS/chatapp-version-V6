// ============================================================
//  ui.js — Modal, Toast, Badge managers + Dark mode
// ============================================================

// ── Modal System ─────────────────────────────────────────────
const modalManager = {
    showModal(title, message, type = 'info', confirmText = 'OK', cancelText = null) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            const safeTitle       = escapeHTML(title);
            const safeMessage     = escapeHTML(message);
            const safeConfirmText = escapeHTML(confirmText);
            const safeCancelText  = cancelText ? escapeHTML(cancelText) : null;
            modal.innerHTML = `
                <div class="modal">
                    <div class="modal-header">
                        <h3>${safeTitle}</h3>
                        <button class="modal-close">&times;</button>
                    </div>
                    <div class="modal-body"><p>${safeMessage}</p></div>
                    <div class="modal-footer">
                        ${safeCancelText ? `<button class="btn-secondary modal-cancel">${safeCancelText}</button>` : ''}
                        <button class="btn-primary modal-confirm">${safeConfirmText}</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const confirmBtn = modal.querySelector('.modal-confirm');
            const cancelBtn  = modal.querySelector('.modal-cancel');
            const closeBtn   = modal.querySelector('.modal-close');

            const closeModal = (result) => {
                if (document.body.contains(modal)) document.body.removeChild(modal);
                resolve(result);
            };

            confirmBtn.onclick = () => closeModal(true);
            if (cancelBtn) cancelBtn.onclick = () => closeModal(false);
            closeBtn.onclick   = () => closeModal(false);
            modal.onclick = (e) => { if (e.target === modal) closeModal(false); };
        });
    },

    showPrompt(title, defaultValue = '') {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.innerHTML = `
                <div class="modal">
                    <div class="modal-header">
                        <h3>${escapeHTML(title)}</h3>
                        <button class="modal-close">&times;</button>
                    </div>
                    <div class="modal-body">
                        <input type="text" class="modal-input" value="${escapeAttribute(defaultValue)}" placeholder="Enter message...">
                    </div>
                    <div class="modal-footer">
                        <button class="btn-secondary modal-cancel">Cancel</button>
                        <button class="btn-primary modal-confirm">OK</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const input      = modal.querySelector('.modal-input');
            const confirmBtn = modal.querySelector('.modal-confirm');
            const cancelBtn  = modal.querySelector('.modal-cancel');
            const closeBtn   = modal.querySelector('.modal-close');

            const closeModal = (result) => {
                if (document.body.contains(modal)) document.body.removeChild(modal);
                resolve(result);
            };

            confirmBtn.onclick = () => closeModal(input.value);
            cancelBtn.onclick  = () => closeModal(null);
            closeBtn.onclick   = () => closeModal(null);
            modal.onclick = (e) => { if (e.target === modal) closeModal(null); };

            if (input) { input.focus(); input.select(); }
        });
    }
};

// ── Toast System ─────────────────────────────────────────────
const toastManager = {
    show({ icon = null, title, body, type = 'message', duration = 4500, onClick = null }) {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const I = window.Icons;
        // Build icon HTML: prefer SVG, fall back to passed string
        const iconMap = {
            message: I ? I.get('chat', 16) : '💬',
            success: I ? I.get('success', 16) : '✓',
            error:   I ? I.get('errorCircle', 16) : '✕',
            info:    I ? I.get('info', 16) : 'i',
            warning: I ? I.get('warning', 16) : '!',
        };
        const iconHtml = (icon && !I) ? icon : (iconMap[type] || iconMap.message);

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <div class="toast-icon">${iconHtml}</div>
            <div class="toast-content">
                <div class="toast-title">${escapeHTML(title)}</div>
                <div class="toast-body">${escapeHTML(body)}</div>
            </div>
            <button class="toast-close" title="Dismiss">${I ? I.get('close', 14) : '✕'}</button>
        `;
        container.appendChild(toast);

        const dismiss = () => {
            toast.classList.add('removing');
            setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 280);
        };

        toast.querySelector('.toast-close').onclick = (e) => { e.stopPropagation(); dismiss(); };
        toast.onclick = () => { if (onClick) onClick(); dismiss(); };

        const timer = setTimeout(dismiss, duration);
        toast.addEventListener('mouseenter', () => clearTimeout(timer));

        return { dismiss };
    }
};

// Expose simple showToast helper for all modules
window.toastManager = toastManager;
window.showToast    = function showToast(msg, type = 'info') {
    const icons = { success: 'success', error: 'error', info: 'info', warning: 'warning' };
    toastManager.show({ icon: null, title: msg, body: '', type: icons[type] ? type : 'message', duration: 3500 });
};
// Legacy alias used by driveFileShare.js
window._showToast = window.showToast;

// ── Badge Manager ────────────────────────────────────────────
const badgeManager = {
    counts: { friends: 0, groups: 0, requests: 0, total: 0 },

    updateBadge(type, count) {
        this.counts[type] = count;
        this.counts.total = Object.values(this.counts).reduce((a, b) => a + b, 0);
        this.updateUI();
    },

    incrementBadge(type) {
        this.counts[type]++;
        this.counts.total++;
        this.updateUI();
        this.playNotificationSound();
    },

    resetBadge(type) {
        this.counts[type] = 0;
        this.counts.total = Object.values(this.counts).reduce((a, b) => a + b, 0);
        this.updateUI();
    },

    updateUI() {
        const requestsBadge = document.getElementById('requestsBadge');
        if (requestsBadge) {
            requestsBadge.textContent   = this.counts.requests > 0 ? this.counts.requests : '';
            requestsBadge.style.display = this.counts.requests > 0 ? 'inline-block' : 'none';
        }

        this.updateTabBadge('chats',   this.counts.friends);
        this.updateTabBadge('friends', this.counts.requests);
        this.updateTabBadge('groups',  this.counts.groups);

        const mainBadge = document.getElementById('notifBadge');
        if (mainBadge) {
            mainBadge.textContent   = this.counts.total > 0 ? this.counts.total : '';
            mainBadge.style.display = this.counts.total > 0 ? 'inline-block' : 'none';
        }
    },

    updateTabBadge(tabName, count) {
        const tabBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
        if (!tabBtn) return;
        let badge = tabBtn.querySelector('.tab-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tab-badge';
            tabBtn.appendChild(badge);
        }
        badge.textContent   = count > 0 ? count : '';
        badge.style.display = count > 0 ? 'inline-block' : 'none';
    },

    playNotificationSound() {
        try {
            const sound = document.getElementById('notifSound');
            if (sound) {
                sound.volume = 0.3;
                sound.play().catch(() => this.fallbackBeep());
            } else {
                this.fallbackBeep();
            }
        } catch (e) { this.fallbackBeep(); }
    },

    fallbackBeep() {
        try {
            const ctx        = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = ctx.createOscillator();
            const gainNode   = ctx.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);
            oscillator.frequency.value = 800;
            oscillator.type            = 'sine';
            gainNode.gain.value        = 0.1;
            oscillator.start();
            setTimeout(() => oscillator.stop(), 200);
        } catch (e) { /* silent */ }
    }
};

// ── Dark Mode — delegates to ThemeManager if available ───────
function initializeDarkMode() {
    if (window.ThemeManager) { ThemeManager.init(); return; }
    if (localStorage.getItem('darkMode') === 'true') {
        document.body.classList.add('dark');
    }
}

function toggleDarkMode() {
    if (window.ThemeManager) { ThemeManager.toggleDark(); return; }
    document.body.classList.toggle('dark');
    localStorage.setItem('darkMode', document.body.classList.contains('dark'));
    _syncThemeDropdownLabel();
}

function _syncThemeDropdownLabel() {
    if (window.ThemeManager) return; // ThemeManager handles its own label
    const isDark = document.body.classList.contains('dark');
    const icon   = document.getElementById('themeIcon');
    const label  = document.getElementById('themeLabel');
    if (icon) {
        const I = window.Icons;
        icon.innerHTML = isDark ? (I ? I.get('sun', 18) : '☀') : (I ? I.get('moon', 18) : '☾');
    }
    if (label) label.textContent = isDark ? 'Light Mode' : 'Dark Mode';
}
window._syncThemeDropdownLabel = _syncThemeDropdownLabel;

function requestNotificationPermission() {
    if (!notificationPermissionRequested && 'Notification' in window) {
        Notification.requestPermission().then(() => {
            notificationPermissionRequested = true;
        });
    }
}

// ── Expose ───────────────────────────────────────────────────
window.modalManager  = modalManager;
window.badgeManager  = badgeManager;
window.initializeDarkMode = initializeDarkMode;
window.toggleDarkMode     = toggleDarkMode;

console.log('ui.js loaded');
