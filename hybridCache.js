class HybridCache {
    constructor() {
        this.memoryCache = new MemoryCache(100);
        this.sessionCache = new SessionCache();
        this.indexedDBAvailable = 'indexedDB' in window;
    }

    async setMessages(chatId, messages) {
        // Store in memory for immediate access
        this.memoryCache.set(`messages_${chatId}`, messages);
        
        // Store in session storage for tab persistence
        this.sessionCache.set(`messages_${chatId}`, messages, 2 * 60 * 60 * 1000); // 2 hours
        
        // Store in IndexedDB for long-term persistence
        if (this.indexedDBAvailable) {
            await cacheManager.cacheMessages(chatId, messages);
        }
    }

    async getMessages(chatId) {
        // Try memory cache first (fastest)
        let messages = this.memoryCache.get(`messages_${chatId}`);
        if (messages) return messages;
        
        // Try session storage second
        messages = this.sessionCache.get(`messages_${chatId}`);
        if (messages) {
            // Populate memory cache
            this.memoryCache.set(`messages_${chatId}`, messages);
            return messages;
        }
        
        // Try IndexedDB last
        if (this.indexedDBAvailable) {
            messages = await cacheManager.getCachedMessages(chatId);
            if (messages && messages.length > 0) {
                // Populate both caches
                this.memoryCache.set(`messages_${chatId}`, messages);
                this.sessionCache.set(`messages_${chatId}`, messages, 2 * 60 * 60 * 1000);
                return messages;
            }
        }
        
        return null;
    }

    setUserData(uid, userData) {
        this.memoryCache.set(`user_${uid}`, userData);
        this.sessionCache.set(`user_${uid}`, userData, 30 * 60 * 1000); // 30 minutes
        
        if (this.indexedDBAvailable) {
            cacheManager.cacheUserData(uid, userData);
        }
    }

    async getUserData(uid) {
        let userData = this.memoryCache.get(`user_${uid}`);
        if (userData) return userData;
        
        userData = this.sessionCache.get(`user_${uid}`);
        if (userData) {
            this.memoryCache.set(`user_${uid}`, userData);
            return userData;
        }
        
        if (this.indexedDBAvailable) {
            userData = await cacheManager.getCachedUserData(uid);
            if (userData) {
                this.memoryCache.set(`user_${uid}`, userData);
                this.sessionCache.set(`user_${uid}`, userData, 30 * 60 * 1000);
                return userData;
            }
        }
        
        return null;
    }

    // Periodic cleanup
    async performCleanup() {
        // Clean memory cache (handled automatically by LRU)
        
        // Clean session storage (expired items auto-removed on access)
        
        // Clean IndexedDB
        if (this.indexedDBAvailable) {
            await cacheManager.cleanupOldData();
            localStorage.setItem('lastCacheCleanup', new Date().toISOString());
        }
    }

    // Get cache statistics
    async getStats() {
        const stats = {
            memory: {
                size: this.memoryCache.size(),
                keys: this.memoryCache.keys().length
            },
            session: {
                size: Object.keys(sessionStorage)
                    .filter(key => key.startsWith('educhat_'))
                    .length
            }
        };
        
        if (this.indexedDBAvailable) {
            stats.indexedDB = await cacheManager.getCacheStats();
        }
        
        return stats;
    }
}

const hybridCache = new HybridCache();