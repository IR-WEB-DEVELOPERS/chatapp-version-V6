class MemoryCache {
    constructor(maxSize = 100) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.accessOrder = [];
    }

    set(key, value) {
        // If key exists, remove from access order
        if (this.cache.has(key)) {
            this.accessOrder = this.accessOrder.filter(k => k !== key);
        }
        
        // Add to cache and access order
        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
        this.accessOrder.push(key);
        
        // Enforce size limit
        if (this.cache.size > this.maxSize) {
            const oldestKey = this.accessOrder.shift();
            this.cache.delete(oldestKey);
        }
    }

    get(key) {
        if (!this.cache.has(key)) return null;
        
        // Update access order
        this.accessOrder = this.accessOrder.filter(k => k !== key);
        this.accessOrder.push(key);
        
        return this.cache.get(key).value;
    }

    delete(key) {
        this.cache.delete(key);
        this.accessOrder = this.accessOrder.filter(k => k !== key);
    }

    clear() {
        this.cache.clear();
        this.accessOrder = [];
    }

    size() {
        return this.cache.size;
    }

    keys() {
        return Array.from(this.cache.keys());
    }
}

const memoryCache = new MemoryCache(200); // Cache 200 items in memory