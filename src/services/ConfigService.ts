import * as vscode from 'vscode';
import { CacheService } from './CacheService';

/**
 * Configuration interface for the extension
 */
export interface ExtensionConfig {
    maxHealingAttempts: number;
    initialBackoffMs: number;
    maxRateLimitRetries: number;
    maxTokensPerError: number;
    testFilePattern: string;
    jestCommand: string;
    llmProvider: 'copilot' | 'azure-openai';
    llmVendor: string;
    llmFamily: string;
    enableTelemetry: boolean;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    azureOpenAI?: {
        endpoint: string;
        apiKey: string;
        deploymentName: string;
    };
    telemetryEnabled: boolean;
}

/**
 * Configuration service to access VS Code settings with caching
 */
export class ConfigService {
    private static readonly CONFIG_SECTION = 'test-agent';
    private static readonly CACHE_KEY = 'extension_config';
    private static readonly CACHE_TTL_MS = 5000; // 5 seconds
    private static instance: ConfigService;
    private cache: CacheService;

    private constructor() {
        this.cache = CacheService.getInstance();
        this.setupConfigWatcher();
    }

    public static getInstance(): ConfigService {
        if (!ConfigService.instance) {
            ConfigService.instance = new ConfigService();
        }
        return ConfigService.instance;
    }

    /**
     * Setup watcher to invalidate cache on config changes
     */
    private setupConfigWatcher(): void {
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(ConfigService.CONFIG_SECTION)) {
                this.cache.delete(ConfigService.CACHE_KEY);
            }
        });
    }

    /**
     * Get the current configuration (with caching)
     */
    public getConfig(): ExtensionConfig {
        // Try to get from cache first
        const cached = this.cache.get<ExtensionConfig>(ConfigService.CACHE_KEY);
        if (cached) {
            return cached;
        }

        // Load from VS Code settings
        const config = vscode.workspace.getConfiguration(ConfigService.CONFIG_SECTION);

        const extensionConfig: ExtensionConfig = {
            maxHealingAttempts: config.get<number>('maxHealingAttempts', 3),
            initialBackoffMs: config.get<number>('initialBackoffMs', 1000),
            maxRateLimitRetries: config.get<number>('maxRateLimitRetries', 5),
            maxTokensPerError: config.get<number>('maxTokensPerError', 1500),
            testFilePattern: config.get<string>('testFilePattern', '${fileName}.test.${ext}'),
            jestCommand: config.get<string>('jestCommand', 'npx jest'),
            llmProvider: config.get<'copilot' | 'azure-openai'>('llmProvider', 'copilot'),
            llmVendor: config.get<string>('llmVendor', 'copilot'),
            llmFamily: config.get<string>('llmFamily', ''), // Empty = use user's default model
            enableTelemetry: config.get<boolean>('enableTelemetry', false),
            logLevel: config.get<'debug' | 'info' | 'warn' | 'error'>('logLevel', 'info'),
            azureOpenAI: config.get('azureOpenAI'),
            telemetryEnabled: config.get<boolean>('enableTelemetry', false)
        };

        // Cache for future use
        this.cache.set(ConfigService.CACHE_KEY, extensionConfig, ConfigService.CACHE_TTL_MS);

        return extensionConfig;
    }

    /**
     * Static method for backward compatibility
     * Gets config through singleton instance
     */
    public static getConfig(): ExtensionConfig {
        return ConfigService.getInstance().getConfig();
    }

    /**
     * Get a specific configuration value
     */
    public static get<T>(key: keyof ExtensionConfig, defaultValue: T): T {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        return config.get<T>(key, defaultValue);
    }

    /**
     * Update a configuration value
     */
    public static async set<T>(
        key: keyof ExtensionConfig, 
        value: T, 
        target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
        await config.update(key, value, target);
    }

    /**
     * Watch for configuration changes
     */
    public static onDidChangeConfiguration(
        callback: (config: ExtensionConfig) => void
    ): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(this.CONFIG_SECTION)) {
                callback(this.getConfig());
            }
        });
    }
}
