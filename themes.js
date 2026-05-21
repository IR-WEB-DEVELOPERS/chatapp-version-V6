// ============================================================
//  themes.js — EduChat Theme System
//  6 accent themes × dark/light mode
// ============================================================

const ThemeManager = (() => {
    const THEMES = [
        { id: 'default',  name: 'Indigo',   dot: 'swatch-default'  },
        { id: 'ocean',    name: 'Ocean',    dot: 'swatch-ocean'    },
        { id: 'forest',   name: 'Forest',   dot: 'swatch-forest'   },
        { id: 'sunset',   name: 'Sunset',   dot: 'swatch-sunset'   },
        { id: 'rose',     name: 'Rose',     dot: 'swatch-rose'     },
        { id: 'midnight', name: 'Midnight', dot: 'swatch-midnight' },
    ];

    const STORAGE_THEME = 'educhat_theme';
    const STORAGE_DARK  = 'darkMode';

    let currentTheme = localStorage.getItem(STORAGE_THEME) || 'default';
    let isDark       = localStorage.getItem(STORAGE_DARK) === 'true';

    function applyTheme(id) {
        currentTheme = id;
        localStorage.setItem(STORAGE_THEME, id);
        // Remove all theme-* classes
        document.body.classList.forEach(c => {
            if (c.startsWith('theme-')) document.body.classList.remove(c);
        });
        if (id !== 'default') document.body.classList.add(`theme-${id}`);
        _syncDropdownLabel();
    }

    function applyDark(dark) {
        isDark = dark;
        localStorage.setItem(STORAGE_DARK, dark);
        document.body.classList.toggle('dark', dark);
        _syncDropdownLabel();
    }

    function toggleDark() {
        applyDark(!isDark);
    }

    function init() {
        applyTheme(currentTheme);
        applyDark(isDark);
    }

    function _syncDropdownLabel() {
        const icon  = document.getElementById('themeIcon');
        const label = document.getElementById('themeLabel');
        const I = window.Icons;
        if (icon) icon.innerHTML = isDark ? (I ? I.get('sun', 18) : '☀') : (I ? I.get('moon', 18) : '☾');
        if (label) label.textContent = 'Themes';
    }

    function openPanel() {
        // Remove any existing panel
        const existing = document.getElementById('themePanelOverlay');
        if (existing) existing.remove();

        const I = window.Icons;
        const overlay = document.createElement('div');
        overlay.id = 'themePanelOverlay';
        overlay.className = 'theme-panel-overlay';

        const swatchesHTML = THEMES.map(t => `
            <button class="theme-swatch ${currentTheme === t.id ? 'active' : ''}"
                    data-theme="${t.id}" title="${t.name}">
                <div class="theme-swatch-dot ${t.dot}">
                    <span class="theme-swatch-check">
                        ${I ? I.get('check2', 16) : '✓'}
                    </span>
                </div>
                <span class="theme-swatch-name">${t.name}</span>
            </button>
        `).join('');

        overlay.innerHTML = `
            <div class="theme-panel" role="dialog" aria-modal="true" aria-label="Theme settings">
                <div class="theme-panel-header">
                    <h3>${I ? I.get('settings', 18) : ''} &nbsp;Appearance</h3>
                    <button class="theme-panel-close" id="themePanelClose" title="Close">
                        ${I ? I.get('close', 16) : '✕'}
                    </button>
                </div>

                <div class="theme-mode-row">
                    <span>${isDark ? I.get('moon', 16) : I.get('sun', 16)} &nbsp;${isDark ? 'Dark Mode' : 'Light Mode'}</span>
                    <label class="theme-toggle-switch" title="Toggle dark mode">
                        <input type="checkbox" id="darkModeToggle" ${isDark ? 'checked' : ''}>
                        <span class="theme-toggle-track"></span>
                    </label>
                </div>

                <div class="theme-section-label">Accent Color</div>
                <div class="theme-swatches">${swatchesHTML}</div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Dark toggle
        overlay.querySelector('#darkModeToggle').addEventListener('change', (e) => {
            applyDark(e.target.checked);
            // Update row text live
            const row = overlay.querySelector('.theme-mode-row span');
            if (row) row.innerHTML = `${isDark ? I.get('moon',16) : I.get('sun',16)} &nbsp;${isDark ? 'Dark Mode' : 'Light Mode'}`;
        });

        // Swatch clicks
        overlay.querySelectorAll('.theme-swatch').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-theme');
                applyTheme(id);
                overlay.querySelectorAll('.theme-swatch').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });

        // Close
        const close = () => { overlay.classList.add('removing'); setTimeout(() => overlay.remove(), 180); };
        overlay.querySelector('#themePanelClose').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
        });
    }

    // Override toggleDarkMode globally so old callers still work
    window.toggleDarkMode = toggleDark;
    window.initializeDarkMode = init;
    window._syncThemeDropdownLabel = _syncDropdownLabel;

    return { init, openPanel, applyTheme, applyDark, toggleDark, THEMES };
})();

window.ThemeManager = ThemeManager;
console.log('themes.js loaded');
