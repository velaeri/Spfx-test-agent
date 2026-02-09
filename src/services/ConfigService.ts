import * as vscode from 'vscode';

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
}

/**
 * Configuration service to access VS Code settings
 */
export class ConfigService {
    private static readonly CONFIG_SECTION = 'spfx-tester';

    /**
     * Get the current configuration
     */
    public static getConfig(): ExtensionConfig {
        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);

        return {
            maxHealingAttempts: config.get<number>('maxHealingAttempts', 3),
            initialBackoffMs: config.get<number>('initialBackoffMs', 1000),
            maxRateLimitRetries: config.get<number>('maxRateLimitRetries', 5),
            maxTokensPerError: config.get<number>('maxTokensPerError', 1500),
            testFilePattern: config.get<string>('testFilePattern', '${fileName}.test.${ext}'),
            jestCommand: config.get<string>('jestCommand', 'npx jest'),
            llmProvider: config.get<'copilot' | 'azure-openai'>('llmProvider', 'copilot'),
            llmVendor: config.get<string>('llmVendor', 'copilot'),
            llmFamily: config.get<string>('llmFamily', 'gpt-4'),
            enableTelemetry: config.get<boolean>('enableTelemetry', false),
            logLevel: config.get<'debug' | 'info' | 'warn' | 'error'>('logLevel', 'info')
        };
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
