import * as vscode from 'vscode';

/**
 * History entry for a test generation
 */
export interface TestGenerationHistory {
    sourceFile: string;
    testFile: string;
    timestamp: Date;
    attempts: number;
    success: boolean;
    errorPatterns: string[];
    model: string;
}

/**
 * Service to manage persistent state across extension sessions
 */
export class StateService {
    private static readonly HISTORY_KEY = 'testGenerationHistory';
    private static readonly MAX_HISTORY_ENTRIES = 50;

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Add a test generation entry to history
     */
    public async addTestGeneration(entry: TestGenerationHistory): Promise<void> {
        const history = await this.getTestHistory();
        
        // Add new entry at the beginning
        history.unshift(entry);

        // Keep only the last N entries
        const trimmedHistory = history.slice(0, StateService.MAX_HISTORY_ENTRIES);

        await this.context.workspaceState.update(StateService.HISTORY_KEY, trimmedHistory);
    }

    /**
     * Get test generation history
     */
    public async getTestHistory(): Promise<TestGenerationHistory[]> {
        const history = this.context.workspaceState.get<TestGenerationHistory[]>(
            StateService.HISTORY_KEY,
            []
        );

        // Convert timestamp strings back to Date objects
        return history.map(entry => ({
            ...entry,
            timestamp: new Date(entry.timestamp)
        }));
    }

    /**
     * Get history for a specific source file
     */
    public async getHistoryForFile(sourceFile: string): Promise<TestGenerationHistory[]> {
        const history = await this.getTestHistory();
        return history.filter(entry => entry.sourceFile === sourceFile);
    }

    /**
     * Get success rate statistics
     */
    public async getStatistics(): Promise<{
        totalGenerations: number;
        successfulGenerations: number;
        successRate: number;
        averageAttempts: number;
    }> {
        const history = await this.getTestHistory();
        
        if (history.length === 0) {
            return {
                totalGenerations: 0,
                successfulGenerations: 0,
                successRate: 0,
                averageAttempts: 0
            };
        }

        const successfulGenerations = history.filter(h => h.success).length;
        const totalAttempts = history.reduce((sum, h) => sum + h.attempts, 0);

        return {
            totalGenerations: history.length,
            successfulGenerations,
            successRate: successfulGenerations / history.length,
            averageAttempts: totalAttempts / history.length
        };
    }

    /**
     * Clear all history
     */
    public async clearHistory(): Promise<void> {
        await this.context.workspaceState.update(StateService.HISTORY_KEY, []);
    }

    /**
     * Get a workspace-specific value
     */
    public get<T>(key: string, defaultValue: T): T {
        return this.context.workspaceState.get<T>(key, defaultValue);
    }

    /**
     * Set a workspace-specific value
     */
    public async set<T>(key: string, value: T): Promise<void> {
        await this.context.workspaceState.update(key, value);
    }

    /**
     * Get a global value (across all workspaces)
     */
    public getGlobal<T>(key: string, defaultValue: T): T {
        return this.context.globalState.get<T>(key, defaultValue);
    }

    /**
     * Set a global value (across all workspaces)
     */
    public async setGlobal<T>(key: string, value: T): Promise<void> {
        await this.context.globalState.update(key, value);
    }
}
