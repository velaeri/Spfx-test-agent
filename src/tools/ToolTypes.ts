/**
 * Tool Types — Core type definitions for the tool-calling architecture
 * 
 * These types define the contract between the LLMOrchestrator and tools.
 * The LLM "calls" tools by emitting structured JSON, and the orchestrator
 * matches tool names and parameters to execute them.
 */

/**
 * Describes a tool parameter for the LLM prompt
 */
export interface ToolParameter {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description: string;
    required: boolean;
    enum?: string[];
    default?: unknown;
}

/**
 * Tool definition exposed to the LLM in system prompts
 */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: ToolParameter[];
    returns: string;
}

/**
 * A tool call as parsed from LLM output
 */
export interface ToolCall {
    tool: string;
    parameters: Record<string, unknown>;
}

/**
 * Result of executing a tool
 */
export interface ToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
    /** Optional metadata (e.g., execution time, tokens used) */
    metadata?: Record<string, unknown>;
}

/**
 * Context passed to every tool execution.
 * Contains workspace info, cancellation token, and progress reporting.
 */
export interface ToolExecutionContext {
    workspaceRoot: string;
    /** VS Code cancellation token */
    cancellationToken?: { isCancellationRequested: boolean };
    /** Optional progress reporter */
    progress?: (message: string) => void;
    /** Additional context data the orchestrator wants to pass */
    extra?: Record<string, unknown>;
}
