import { Logger } from '../services/Logger';
import { ToolDefinition, ToolResult, ToolExecutionContext, ToolParameter } from './ToolTypes';

/**
 * BaseTool — Abstract base class for all tools in the agentic architecture.
 * 
 * Each tool encapsulates a single capability that the LLM can invoke:
 * - Deterministic tools (file I/O, test execution) run code directly
 * - Intelligent tools (test generation, config suggestion) use the LLM internally
 * 
 * Tools are self-describing: they expose their name, description, and parameters
 * so the orchestrator can build the LLM prompt automatically.
 */
export abstract class BaseTool {
    protected logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
    }

    /** Unique tool name (used by LLM to call it) */
    abstract get name(): string;

    /** Human-readable description (included in LLM system prompt) */
    abstract get description(): string;

    /** Parameter definitions for the LLM */
    abstract get parameters(): ToolParameter[];

    /** Description of what the tool returns */
    abstract get returns(): string;

    /**
     * Execute the tool with the given parameters.
     * Implementations should validate params and return structured results.
     */
    abstract execute(
        params: Record<string, unknown>,
        context: ToolExecutionContext
    ): Promise<ToolResult>;

    /**
     * Get the full tool definition for LLM prompt building
     */
    getDefinition(): ToolDefinition {
        return {
            name: this.name,
            description: this.description,
            parameters: this.parameters,
            returns: this.returns
        };
    }

    /**
     * Helper to validate required parameters
     */
    protected validateParams(
        params: Record<string, unknown>,
        required: string[]
    ): string | null {
        for (const param of required) {
            if (params[param] === undefined || params[param] === null) {
                return `Missing required parameter: ${param}`;
            }
        }
        return null;
    }

    /**
     * Helper to create a success result
     */
    protected success(data: unknown, metadata?: Record<string, unknown>): ToolResult {
        return { success: true, data, metadata };
    }

    /**
     * Helper to create an error result
     */
    protected error(message: string, metadata?: Record<string, unknown>): ToolResult {
        this.logger.error(`Tool ${this.name} error: ${message}`);
        return { success: false, error: message, metadata };
    }
}
