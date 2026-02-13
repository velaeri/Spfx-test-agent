/**
 * Core LLM Provider Interface
 * 
 * This is the minimal, generic interface that all LLM providers must implement.
 * It's agnostic to the specific use case (testing, refactoring, architecture analysis, etc.)
 * 
 * Capabilities build on top of this interface to implement domain-specific functionality.
 */

/**
 * Result from any LLM interaction
 */
export interface CoreLLMResult {
    /** The generated content (code, text, JSON, etc.) */
    content: string;
    
    /** The model used for generation */
    model: string;
    
    /** Optional: Number of tokens consumed */
    tokensUsed?: number;
    
    /** Optional: Additional metadata */
    metadata?: Record<string, any>;
}

/**
 * Core LLM Provider Interface
 * 
 * All LLM providers (Copilot, Azure OpenAI, Claude, Gemini, etc.) 
 * must implement this interface.
 */
export interface ICoreProvider {
    /**
     * Send a prompt to the LLM and get a response
     * 
     * This is the fundamental operation - all other functionality builds on this.
     * 
     * @param systemPrompt - Instructions that define the LLM's role and behavior
     * @param userPrompt - The actual task/question to process
     * @param options - Optional configuration (temperature, max tokens, etc.)
     * @returns The LLM's response
     */
    sendPrompt(
        systemPrompt: string, 
        userPrompt: string, 
        options?: {
            temperature?: number;
            maxTokens?: number;
            stream?: boolean;
            [key: string]: any;
        }
    ): Promise<CoreLLMResult>;

    /**
     * Check if the provider is available and configured correctly
     * 
     * @returns true if the provider can be used, false otherwise
     */
    isAvailable(): Promise<boolean>;

    /**
     * Get a human-readable name for this provider
     * 
     * @returns Provider name (e.g., "GitHub Copilot", "Azure OpenAI GPT-4")
     */
    getProviderName(): string;

    /**
     * Get the vendor/family identifier
     * 
     * @returns Vendor identifier (e.g., "copilot", "azure-openai", "anthropic")
     */
    getVendorId(): string;
}
