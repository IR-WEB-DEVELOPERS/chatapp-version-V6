class SessionCache {
    constructor() {
        this.prefix = 'educhat_';
    }

    set(key, data, ttl = 60 * 60 * 1000) { // 1 hour default
        const item = {
            data,
            expiry: Date.now() + ttl
        };
        sessionStorage.setItem(this.prefix + key, JSON.stringify(item));
    }

    get(key) {
        const item = sessionStorage.getItem(this.prefix + key);
        if (!item) return null;

        const parsed = JSON.parse(item);
        if (Date.now() > parsed.expiry) {
            this.remove(key);
            return null;
        }

        return parsed.data;
    }

    remove(key) {
        sessionStorage.removeItem(this.prefix + key);
    }

    clear() {
        Object.keys(sessionStorage)
            .filter(key => key.startsWith(this.prefix))
            .forEach(key => sessionStorage.removeItem(key));
    }
}

const sessionCache = new SessionCache();