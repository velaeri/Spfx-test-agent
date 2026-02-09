/**
 * Context for test generation and fixing
 */
export interface TestContext {
    sourceCode: string;
    fileName: string;
    errorContext?: string;
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
}
