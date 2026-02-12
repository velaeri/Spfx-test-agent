import { Logger } from './Logger';

/**
 * Simple in-memory cache service for configuration and frequently accessed data
 */
export class CacheService {
    private static instance: CacheService;
    private cache: Map<string, { value: any; expiry: number }>;
    private logger: Logger;

    private constructor() {
        this.cache = new Map();
        this.logger = Logger.getInstance();
    }

    public static getInstance(): CacheService {
        if (!CacheService.instance) {
            CacheService.instance = new CacheService();
        }
        return CacheService.instance;
    }

    /**
     * Set a cache entry with optional TTL
     */
    public set<T>(key: string, value: T, ttlMs: number = 300000): void {
        const expiry = Date.now() + ttlMs;
        this.cache.set(key, { value, expiry });
        this.logger.debug(`Cache set: ${key} (TTL: ${ttlMs}ms)`);
    }

    /**
     * Get a cache entry
     */
    public get<T>(key: string): T | undefined {
        const entry = this.cache.get(key);
        
        if (!entry) {
            return undefined;
        }

        if (Date.now() > entry.expiry) {
            this.cache.delete(key);
            this.logger.debug(`Cache expired: ${key}`);
            return undefined;
        }

        return entry.value as T;
    }

    /**
     * Check if key exists and is not expired
     */
    public has(key: string): boolean {
        const entry = this.cache.get(key);
        
        if (!entry) {
            return false;
        }

        if (Date.now() > entry.expiry) {
            this.cache.delete(key);
            return false;
        }

        return true;
    }

    /**
     * Delete a cache entry
     */
    public delete(key: string): boolean {
        return this.cache.delete(key);
    }

    /**
     * Clear all cache entries
     */
    public clear(): void {
        this.cache.clear();
        this.logger.debug('Cache cleared');
    }

    /**
     * Clear expired entries
     */
    public clearExpired(): number {
        const now = Date.now();
        let clearedCount = 0;

        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiry) {
                this.cache.delete(key);
                clearedCount++;
            }
        }

        if (clearedCount > 0) {
            this.logger.debug(`Cleared ${clearedCount} expired cache entries`);
        }

        return clearedCount;
    }

    /**
     * Get cache stats
     */
    public getStats(): { size: number; keys: string[] } {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys())
        };
    }
}
