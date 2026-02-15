import * as vscode from 'vscode';
import { ICoreProvider } from './ICoreProvider';

/**
 * Generic LLM Capability Interface
 * 
 * A "capability" is a specific piece of functionality that uses an LLM to accomplish a task.
 * Examples: test generation, code refactoring, architecture analysis, documentation generation.
 * 
 * This interface provides a plugin-like system where new capabilities can be added
 * without modifying existing code.
 * 
 * @template TInput - The input type for this capability
 * @template TOutput - The output type for this capability
 */
export interface ILLMCapability<TInput = any, TOutput = any> {
    /**
     * Unique identifier for this capability
     * Used for registration and lookup
     * 
     * Examples: "test-generation", "code-refactoring", "architecture-analysis"
     */
    readonly name: string;

    /**
     * Human-readable description of what this capability does
     */
    readonly description: string;

    /**
     * Category for grouping capabilities
     * Examples: "testing", "quality", "documentation", "architecture"
     */
    readonly category: string;

    /**
     * Execute this capability
     * 
     * This is the main entry point - it orchestrates the LLM interactions to accomplish the task.
     * 
     * @param provider - The LLM provider to use for AI operations
     * @param input - The input data specific to this capability
     * @param stream - VS Code chat stream for user feedback
     * @param token - Cancellation token
     * @returns The result of executing this capability
     */
    execute(
        provider: ICoreProvider,
        input: TInput,
        stream: vscode.ChatResponseStream,
        token?: vscode.CancellationToken
    ): Promise<TOutput>;

    /**
     * Check if this capability can handle a given request
     * 
     * Used for auto-detection of which capability to invoke based on user intent.
     * 
     * @param context - The request context (command, message, files, etc.)
     * @returns true if this capability can handle the request
     */
    canHandle(context: CapabilityContext): boolean;

    /**
     * Get help text for this capability
     * Displayed when user asks for help or the capability fails
     * 
     * @returns Markdown-formatted help text
     */
    getHelpText(): string;

    /**
     * Optional: Validate input before execution
     * Allows early validation and informative error messages
     * 
     * @param input - The input to validate
     * @returns Validation result with optional error message
     */
    validateInput?(input: TInput): Promise<ValidationResult>;
}

/**
 * Context provided to canHandle() for capability detection
 */
export interface CapabilityContext {
    /** Explicit command from user (e.g., "generate", "refactor") */
    command?: string;

    /** The user's natural language message */
    message?: string;

    /** Selected/referenced files */
    files?: string[];

    /** Current active file */
    activeFile?: string;

    /** Additional context data */
    metadata?: Record<string, any>;
}

/**
 * Result of input validation
 */
export interface ValidationResult {
    /** Whether the input is valid */
    valid: boolean;

    /** Error message if validation failed */
    error?: string;

    /** Optional: Suggestions to fix the input */
    suggestions?: string[];
}

/**
 * Standard error that capabilities can throw
 */
export class CapabilityError extends Error {
    constructor(
        message: string,
        public readonly capabilityName: string,
        public readonly cause?: Error
    ) {
        super(message);
        this.name = 'CapabilityError';
    }
}
