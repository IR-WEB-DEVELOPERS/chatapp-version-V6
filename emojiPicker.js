class EmojiPicker {
    constructor() {
        this.emojiCategories = {
            'Smileys & Emotion': ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕'],
            'People & Body': ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄'],
            'Animals & Nature': ['🐵', '🐒', '🦍', '🦧', '🐶', '🐕', '🦮', '🐕‍🦺', '🐩', '🐺', '🦊', '🦝', '🐱', '🐈', '🐈‍⬛', '🦁', '🐯', '🐅', '🐆', '🐴', '🐎', '🦄', '🦓', '🦌', '🐮', '🐂', '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏', '🐑', '🐐', '🐪', '🐫', '🦙', '🦒', '🐘', '🦏', '🦛', '🐭', '🐁', '🐀', '🐹', '🐰', '🐇', '🐿️', '🦫', '🦔', '🦇', '🐻', '🐻‍❄️', '🐨', '🐼', '🦥', '🦦', '🦨', '🦘', '🦡', '🐾', '🦃', '🐔', '🐓', '🐣', '🐤', '🐥', '🐦', '🐧', '🕊️', '🦅', '🦆', '🦢', '🦉', '🦤', '🪶', '🦩', '🦚', '🦜', '🐸', '🐊', '🐢', '🦎', '🐍', '🐲', '🐉', '🦕', '🦖', '🐳', '🐋', '🐬', '🦭', '🐟', '🐠', '🐡', '🦈', '🐙', '🐚', '🐌', '🦋', '🐛', '🐜', '🐝', '🪲', '🐞', '🦗', '🪳', '🕷️', '🕸️', '🦂', '🦟', '🪰', '🪱', '🦠', '💐', '🌸', '💮', '🏵️', '🌹', '🥀', '🌺', '🌻', '🌼', '🌷', '🌱', '🪴', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃'],
            'Food & Drink': ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '🫖', '☕', '🍵', '🧃', '🥤', '🧋', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾', '🧊', '🥄', '🍴', '🍽️', '🥣', '🥡', '🥢'],
            'Activities': ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️', '🎪', '🤹', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🪘', '🎷', '🎺', '🎸', '🪕', '🎻', '🎲', '♟️', '🎯', '🎳', '🎮', '🎰']
        };
        this.isOpen = false;
        this.currentInput = null;
        this.init();
    }

    init() {
        this.createPicker();
        this.addEventListeners();
    }

    createPicker() {
        const pickerHTML = `
            <div id="emojiPicker" class="emoji-picker" style="display: none;">
                <div class="emoji-picker-header">
                    <div class="emoji-categories">
                        ${Object.keys(this.emojiCategories).map(category => 
                            `<button class="emoji-category-btn" data-category="${category}">${this.getCategoryIcon(category)}</button>`
                        ).join('')}
                    </div>
                    <button class="emoji-picker-close">✕</button>
                </div>
                <div class="emoji-picker-body">
                    ${Object.entries(this.emojiCategories).map(([category, emojis]) => `
                        <div class="emoji-category" data-category="${category}">
                            <h4>${category}</h4>
                            <div class="emoji-grid">
                                ${emojis.map(emoji => `
                                    <button class="emoji-btn" data-emoji="${emoji}">${emoji}</button>
                                `).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', pickerHTML);
        this.picker = document.getElementById('emojiPicker');
    }

    getCategoryIcon(category) {
        const icons = {
            'Smileys & Emotion': '😀',
            'People & Body': '👋',
            'Animals & Nature': '🐶',
            'Food & Drink': '🍎',
            'Activities': '⚽'
        };
        return icons[category] || '😀';
    }

    addEventListeners() {
        // Category buttons
        document.querySelectorAll('.emoji-category-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const category = e.target.dataset.category;
                this.showCategory(category);
            });
        });

        // Emoji buttons
        document.querySelectorAll('.emoji-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const emoji = e.target.dataset.emoji;
                this.insertEmoji(emoji);
            });
        });

        // Close button
        document.querySelector('.emoji-picker-close').addEventListener('click', () => {
            this.hide();
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (this.isOpen && !this.picker.contains(e.target) && !e.target.closest('.emoji-toggle')) {
                this.hide();
            }
        });
    }

    showCategory(category) {
        // Hide all categories
        document.querySelectorAll('.emoji-category').forEach(cat => {
            cat.style.display = 'none';
        });
        
        // Show selected category
        const targetCategory = document.querySelector(`.emoji-category[data-category="${category}"]`);
        if (targetCategory) {
            targetCategory.style.display = 'block';
        }
        
        // Update active category button
        document.querySelectorAll('.emoji-category-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`.emoji-category-btn[data-category="${category}"]`).classList.add('active');
    }

    insertEmoji(emoji) {
        if (this.currentInput) {
            const start = this.currentInput.selectionStart;
            const end = this.currentInput.selectionEnd;
            const text = this.currentInput.value;
            this.currentInput.value = text.substring(0, start) + emoji + text.substring(end);
            this.currentInput.focus();
            this.currentInput.selectionStart = this.currentInput.selectionEnd = start + emoji.length;
            
            // Trigger input event for any listeners
            this.currentInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    toggle(inputElement) {
        this.currentInput = inputElement;
        
        if (this.isOpen) {
            this.hide();
        } else {
            this.show();
        }
    }

    show() {
        if (!this.picker) return;
        
        this.picker.style.display = 'block';
        this.isOpen = true;
        
        // Position near the input
        if (this.currentInput) {
            const rect = this.currentInput.getBoundingClientRect();
            this.picker.style.position = 'fixed';
            this.picker.style.bottom = '80px';
            this.picker.style.left = '50%';
            this.picker.style.transform = 'translateX(-50%)';
            this.picker.style.zIndex = '1000';
        }
        
        // Show first category by default
        this.showCategory(Object.keys(this.emojiCategories)[0]);
    }

    hide() {
        if (!this.picker) return;
        
        this.picker.style.display = 'none';
        this.isOpen = false;
        this.currentInput = null;
    }
}

// Initialize emoji picker
const emojiPicker = new EmojiPicker();
window.emojiPicker = emojiPicker;