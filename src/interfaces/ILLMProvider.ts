/**
 * Context for test generation and fixing
 */
export interface TestContext {
    sourceCode: string;
    fileName: string;
    /** Formatted string with all dependency file contents */
    dependencyContext?: string;
    errorContext?: string;
    /** The current test code (for fix attempts) */
    currentTestCode?: string;
    /** Hints about environment issues detected */
    environmentHints?: string;
    /** Dynamic system prompt (built from detected stack) */
    systemPrompt?: string;
    attempt?: number;
    maxAttempts?: number;
}

/**
 * Result from LLM generation
 */
export interface LLMResult {
    code: string;
    model: string;
    tokensUsed?: number;
}

/**
 * Interface for LLM providers
 * Allows switching between different AI providers (Copilot, Azure OpenAI, etc.)
 */
export interface ILLMProvider {
    /**
     * Generate a test file for the given source code
     */
    generateTest(context: TestContext): Promise<LLMResult>;

    /**
     * Fix a failing test based on error output
     */
    fixTest(context: TestContext): Promise<LLMResult>;

    /**
     * Check if the provider is available
     */
    isAvailable(): Promise<boolean>;

    /**
     * Get the provider name
     */
    getProviderName(): string;

    /**
     * Detect missing dependencies based on package.json content
     */
    detectDependencies(packageJsonContent: any): Promise<Record<string, string>>;

    /**
     * Analyze an error (dependency, compilation, execution) and suggest a fix
     * Returns installation commands or configuration changes needed
     */
    analyzeAndFixError(error: string, projectContext: {
        packageJson: any;
        nodeVersion?: string;
        jestConfig?: string;
        errorType: 'dependency' | 'compilation' | 'execution';
    }): Promise<{
        diagnosis: string;
        packages?: string[]; // e.g., ['jest@^28.1.0', 'ts-jest@^28.0.8']
        commands?: string[]; // e.g., ['npm install --force']
        configChanges?: Record<string, any>;
    }>;
}
