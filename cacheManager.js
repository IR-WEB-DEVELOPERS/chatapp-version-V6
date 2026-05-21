class CacheManager {
    constructor() {
        this.dbName = 'EduChatCache';
        this.version = 1;
        this.db = null;
        this.init();
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Create object stores for different types of data
                if (!db.objectStoreNames.contains('messages')) {
                    const messageStore = db.createObjectStore('messages', { keyPath: ['chatId', 'timestamp', 'sender'] });
                    messageStore.createIndex('chatId', 'chatId', { unique: false });
                    messageStore.createIndex('timestamp', 'timestamp', { unique: false });
                }
                
                if (!db.objectStoreNames.contains('users')) {
                    const userStore = db.createObjectStore('users', { keyPath: 'uid' });
                    userStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
                }
                
                if (!db.objectStoreNames.contains('groups')) {
                    const groupStore = db.createObjectStore('groups', { keyPath: 'groupId' });
                }
            };
        });
    }

    // Message caching with automatic cleanup
    async cacheMessages(chatId, messages) {
        if (!this.db) await this.init();
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['messages'], 'readwrite');
            const store = transaction.objectStore('messages');
            
            // Add new messages — FIX: full message object store చేయాలి (text మాత్రమే కాదు)
            messages.forEach(message => {
                const messageTime = message.time?.toDate ? message.time.toDate().getTime() : new Date().getTime();
                // Firestore Timestamp objects serializable కాదు — plain value కి convert చేయాలి
                const cacheItem = {
                    ...message,
                    chatId,
                    timestamp: messageTime,
                    time: messageTime,   // Timestamp → number
                    cachedAt: Date.now()
                };
                store.put(cacheItem);
            });

            transaction.oncomplete = async () => {
                // Clean up old messages for this chat (keep last 100)
                await this.cleanupChatMessages(chatId);
                resolve();
            };
            
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async getCachedMessages(chatId, limit = 100) {
        if (!this.db) await this.init();
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['messages'], 'readonly');
            const store = transaction.objectStore('messages');
            const index = store.index('chatId');
            const range = IDBKeyRange.only(chatId);
            
            const request = index.openCursor(range, 'prev'); // Get latest first
            const messages = [];
            let count = 0;

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor && count < limit) {
                    messages.push(cursor.value);
                    count++;
                    cursor.continue();
                } else {
                    // Sort by timestamp (oldest first)
                    messages.sort((a, b) => a.timestamp - b.timestamp);
                    resolve(messages);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    async cleanupChatMessages(chatId, keepCount = 100) {
        if (!this.db) await this.init();
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['messages'], 'readwrite');
            const store = transaction.objectStore('messages');
            const index = store.index('chatId');
            const range = IDBKeyRange.only(chatId);
            
            const allMessages = [];
            const request = index.openCursor(range);

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    allMessages.push({ key: cursor.primaryKey, timestamp: cursor.value.timestamp });
                    cursor.continue();
                } else {
                    // Sort by timestamp and remove oldest beyond keepCount
                    allMessages.sort((a, b) => b.timestamp - a.timestamp); // newest first
                    
                    const messagesToDelete = allMessages.slice(keepCount);
                    messagesToDelete.forEach(msg => {
                        store.delete(msg.key);
                    });
                    
                    resolve(messagesToDelete.length);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    // User data caching
    async cacheUserData(uid, userData) {
        if (!this.db) await this.init();
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['users'], 'readwrite');
            const store = transaction.objectStore('users');
            
            const cacheItem = {
                uid,
                ...userData,
                lastAccessed: Date.now()
            };
            
            store.put(cacheItem);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async getCachedUserData(uid) {
        if (!this.db) await this.init();
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['users'], 'readonly');
            const store = transaction.objectStore('users');
            const request = store.get(uid);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // General cache cleanup
    async cleanupOldData(maxAge = 7 * 24 * 60 * 60 * 1000) { // 7 days
        if (!this.db) await this.init();
        
        const cutoffTime = Date.now() - maxAge;
        
        // Clean old users
        await this.cleanupOldUsers(cutoffTime);
        
        // Clean old messages (beyond 30 days)
        await this.cleanupOldMessages(30 * 24 * 60 * 60 * 1000);
    }

    async cleanupOldUsers(cutoffTime) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['users'], 'readwrite');
            const store = transaction.objectStore('users');
            const index = store.index('lastAccessed');
            const range = IDBKeyRange.upperBound(cutoffTime);
            
            const request = index.openCursor(range);
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    async cleanupOldMessages(maxAge) {
        const cutoffTime = Date.now() - maxAge;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['messages'], 'readwrite');
            const store = transaction.objectStore('messages');
            const index = store.index('timestamp');
            const range = IDBKeyRange.upperBound(cutoffTime);
            
            const request = index.openCursor(range);
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    // Get cache statistics
    async getCacheStats() {
        if (!this.db) await this.init();
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['messages', 'users'], 'readonly');
            const messageStore = transaction.objectStore('messages');
            const userStore = transaction.objectStore('users');
            
            const messageCountRequest = messageStore.count();
            const userCountRequest = userStore.count();

            transaction.oncomplete = async () => {
                const stats = {
                    totalMessages: messageCountRequest.result || 0,
                    totalUsers: userCountRequest.result || 0,
                    estimatedSize: await this.estimateSize(),
                    lastCleanup: localStorage.getItem('lastCacheCleanup') || 'Never'
                };

                resolve(stats);
            };

            transaction.onerror = () => reject(transaction.error);
        });
    }

    async estimateSize() {
        // IndexedDB doesn't provide direct size info, but we can estimate
        if (!navigator.storage || !navigator.storage.estimate) {
            return 'Unknown';
        }
        
        try {
            const estimate = await navigator.storage.estimate();
            return {
                used: Math.round(estimate.usage / (1024 * 1024) * 100) / 100,
                quota: Math.round(estimate.quota / (1024 * 1024) * 100) / 100
            };
        } catch (error) {
            return 'Unknown';
        }
    }
}

// Singleton instance
const cacheManager = new CacheManager();
