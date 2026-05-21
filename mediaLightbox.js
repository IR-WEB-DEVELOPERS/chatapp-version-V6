// ============================================================
//  mediaLightbox.js — Full-screen image/video lightbox
//
//  Usage:
//    window.mediaLightbox.open(items, startIndex)
//
//  items = [{ src, thumb, caption, downloadUrl }]
//
//  Auto-wired to:
//    • .file-msg-image        (chat inline images)
//    • .fp-img-thumb          (profile media grid thumbnails)
//  via delegated listeners added in init().
// ============================================================

window.mediaLightbox = (() => {

    let _items   = [];
    let _idx     = 0;
    let _el      = null;   // root DOM element
    let _onKey   = null;

    // ── Build DOM (once) ──────────────────────────────────────
    function _ensureDOM() {
        if (_el) return;

        _el = document.createElement('div');
        _el.id        = 'mediaLightbox';
        _el.className = 'mlb-root';
        _el.innerHTML = `
            <div class="mlb-backdrop"></div>
            <div class="mlb-container">
                <button class="mlb-btn mlb-close" id="mlbClose" aria-label="Close">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
                <button class="mlb-btn mlb-nav mlb-prev" id="mlbPrev" aria-label="Previous">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="15 18 9 12 15 6"/>
                    </svg>
                </button>
                <div class="mlb-stage" id="mlbStage">
                    <div class="mlb-spinner" id="mlbSpinner"></div>
                    <img class="mlb-img" id="mlbImg" alt="" draggable="false">
                    <video class="mlb-video" id="mlbVideo" controls playsinline></video>
                    <iframe class="mlb-iframe" id="mlbIframe" allowfullscreen></iframe>
                </div>
                <button class="mlb-btn mlb-nav mlb-next" id="mlbNext" aria-label="Next">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </button>
                <div class="mlb-footer">
                    <span class="mlb-caption" id="mlbCaption"></span>
                    <div class="mlb-footer-right">
                        <span class="mlb-counter" id="mlbCounter"></span>
                        <a class="mlb-download" id="mlbDownload" download title="Download">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                        </a>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(_el);

        // Events
        _el.querySelector('.mlb-backdrop').addEventListener('click', close);
        _el.querySelector('#mlbClose').addEventListener('click', close);
        _el.querySelector('#mlbPrev').addEventListener('click', () => go(_idx - 1));
        _el.querySelector('#mlbNext').addEventListener('click', () => go(_idx + 1));

        // Swipe support
        let _tx = 0;
        const stage = _el.querySelector('#mlbStage');
        stage.addEventListener('touchstart', e => { _tx = e.touches[0].clientX; }, { passive: true });
        stage.addEventListener('touchend',   e => {
            const dx = e.changedTouches[0].clientX - _tx;
            if (Math.abs(dx) > 50) go(dx < 0 ? _idx + 1 : _idx - 1);
        });

        // Zoom on double-tap / double-click
        let _lastTap = 0;
        const img = _el.querySelector('#mlbImg');
        img.addEventListener('dblclick', () => {
            img.classList.toggle('mlb-zoomed');
        });
        img.addEventListener('touchend', e => {
            const now = Date.now();
            if (now - _lastTap < 300) img.classList.toggle('mlb-zoomed');
            _lastTap = now;
        });
    }

    // ── Navigate ──────────────────────────────────────────────
    function go(i) {
        if (!_items.length) return;
        _idx = (_items.length + i) % _items.length;
        _render();
    }

    // ── Render current item ───────────────────────────────────
    function _render() {
        const item = _items[_idx];
        if (!item) return;

        const img     = _el.querySelector('#mlbImg');
        const video   = _el.querySelector('#mlbVideo');
        const iframe  = _el.querySelector('#mlbIframe');
        const spinner = _el.querySelector('#mlbSpinner');
        const caption = _el.querySelector('#mlbCaption');
        const counter = _el.querySelector('#mlbCounter');
        const dl      = _el.querySelector('#mlbDownload');
        const prev    = _el.querySelector('#mlbPrev');
        const next    = _el.querySelector('#mlbNext');

        img.classList.remove('mlb-zoomed');
        prev.style.display = next.style.display = _items.length > 1 ? '' : 'none';
        counter.textContent = _items.length > 1 ? `${_idx + 1} / ${_items.length}` : '';
        caption.textContent = item.caption || '';
        dl.href             = item.downloadUrl || item.src || '#';

        // Hide all content elements first
        img.style.display    = 'none';
        video.style.display  = 'none';
        iframe.style.display = 'none';
        spinner.style.display = 'none';
        video.src  = '';
        iframe.src = '';

        const type = item.type || 'image';

        if (type === 'embed' || type === 'video-embed' || type === 'pdf-embed') {
            // Drive iframe embed — works for PDF, Docs, Sheets, Slides, video, images
            spinner.style.display = 'block';
            iframe.style.display  = 'block';
            iframe.onload = () => { spinner.style.display = 'none'; };
            iframe.src    = item.src;

        } else if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(item.src || '')) {
            video.style.display = 'block';
            video.src = item.src;
            video.play().catch(() => {});

        } else {
            // Image
            spinner.style.display = 'block';
            const tmp = new Image();
            tmp.onload = () => {
                img.src           = item.src;
                img.alt           = item.caption || '';
                img.style.display = 'block';
                spinner.style.display = 'none';
            };
            tmp.onerror = () => {
                img.src           = item.src;
                img.style.display = 'block';
                spinner.style.display = 'none';
            };
            tmp.src = item.src;
        }
    }

    // ── Public: open ──────────────────────────────────────────
    function open(items, startIndex = 0) {
        _ensureDOM();
        _items = items || [];
        _idx   = Math.max(0, Math.min(startIndex, _items.length - 1));

        _el.classList.add('mlb-visible');
        document.body.style.overflow = 'hidden';

        // Keyboard
        if (_onKey) document.removeEventListener('keydown', _onKey);
        _onKey = e => {
            if (!_el.classList.contains('mlb-visible')) return;
            if (e.key === 'ArrowLeft')  go(_idx - 1);
            if (e.key === 'ArrowRight') go(_idx + 1);
            if (e.key === 'Escape')     close();
        };
        document.addEventListener('keydown', _onKey);

        _render();
    }

    // ── Public: close ─────────────────────────────────────────
    function close() {
        if (!_el) return;
        _el.classList.remove('mlb-visible');
        document.body.style.overflow = '';
        const video  = _el.querySelector('#mlbVideo');
        const iframe = _el.querySelector('#mlbIframe');
        if (video)  { video.pause(); video.src = ''; }
        if (iframe) { iframe.src = ''; }
        if (_onKey) { document.removeEventListener('keydown', _onKey); _onKey = null; }
    }

    // ── Init: wire delegated click handlers ───────────────────
    function init() {
        // ── Chat inline images (.file-msg-image) ─────────────
        document.addEventListener('click', e => {
            const img = e.target.closest('.file-msg-image');
            if (!img) return;
            // NOTE: do NOT call e.preventDefault() here — it blocks mobile tap

            const container = img.closest('#chat, #groupChat') || document;
            const allImgs   = [...container.querySelectorAll('.file-msg-image')];
            const idx       = allImgs.indexOf(img);

            const items = allImgs.map(el => ({
                src:         el.dataset.full  || el.dataset.thumb || el.src,
                downloadUrl: el.dataset.download || el.dataset.full || el.src,
                caption:     el.dataset.caption || el.alt || ''
            }));

            open(items, idx < 0 ? 0 : idx);
        });

        // ── View buttons on file/image messages (.mlb-open-btn) ─
        document.addEventListener('click', e => {
            const btn = e.target.closest('.mlb-open-btn');
            if (!btn) return;
            // NOTE: do NOT call e.preventDefault() — blocks mobile tap

            const type = btn.dataset.type || 'image';
            const src  = btn.dataset.src || btn.dataset.full || btn.dataset.thumb || '';

            open([{
                src,
                type,
                downloadUrl: btn.dataset.download || src,
                caption:     btn.dataset.caption  || ''
            }], 0);
        });

        // ── Profile media grid (.fp-img-thumb) ────────────────
        document.addEventListener('click', e => {
            const thumb = e.target.closest('.fp-img-thumb');
            if (!thumb) return;
            e.preventDefault();

            const grid    = thumb.closest('.fp-img-grid');
            if (!grid) return;
            const allThumbs = [...grid.querySelectorAll('.fp-img-thumb')];
            const idx       = allThumbs.indexOf(thumb);

            const items = allThumbs.map(t => {
                const img = t.querySelector('img');
                // data-full on the <a> = large thumbnail (embeddable)
                // data-thumb on the <a> = small thumbnail
                // img.src = already the small thumbnail
                return {
                    src:         t.dataset.full  || t.dataset.thumb || img?.src || '',
                    downloadUrl: t.dataset.full  || img?.src || '',
                    caption:     img?.alt || ''
                };
            });

            open(items, idx < 0 ? 0 : idx);
        });
    }

    return { open, close, init };

})();

// Auto-init on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.mediaLightbox.init());
} else {
    window.mediaLightbox.init();
}
