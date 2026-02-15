import { Logger } from '../services/Logger';
import { BaseTool } from './BaseTool';
import { ToolDefinition, ToolCall, ToolResult, ToolExecutionContext } from './ToolTypes';

/**
 * ToolRegistry — Central registry for all available tools.
 * 
 * The orchestrator uses this to:
 * 1. Build the tools section of the LLM system prompt
 * 2. Look up and execute tools by name when the LLM calls them
 * 3. Parse tool calls from LLM output
 */
export class ToolRegistry {
    private tools: Map<string, BaseTool> = new Map();
    private logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
    }

    /**
     * Register a tool instance
     */
    register(tool: BaseTool): void {
        if (this.tools.has(tool.name)) {
            this.logger.warn(`Tool "${tool.name}" already registered, overwriting`);
        }
        this.tools.set(tool.name, tool);
        this.logger.debug(`Tool registered: ${tool.name}`);
    }

    /**
     * Register multiple tools at once
     */
    registerAll(tools: BaseTool[]): void {
        for (const tool of tools) {
            this.register(tool);
        }
    }

    /**
     * Get a tool by name
     */
    getTool(name: string): BaseTool | undefined {
        return this.tools.get(name);
    }

    /**
     * Get all registered tool definitions (for building LLM prompts)
     */
    getDefinitions(): ToolDefinition[] {
        return Array.from(this.tools.values()).map(t => t.getDefinition());
    }

    /**
     * Get the list of tool names
     */
    getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * Execute a tool call
     */
    async execute(
        call: ToolCall,
        context: ToolExecutionContext
    ): Promise<ToolResult> {
        const tool = this.tools.get(call.tool);
        if (!tool) {
            this.logger.error(`Unknown tool: ${call.tool}`);
            return {
                success: false,
                error: `Unknown tool: "${call.tool}". Available tools: ${this.getToolNames().join(', ')}`
            };
        }

        this.logger.info(`Executing tool: ${call.tool}`, { parameters: call.parameters });
        const startTime = Date.now();

        try {
            const result = await tool.execute(call.parameters, context);
            const duration = Date.now() - startTime;
            this.logger.info(`Tool ${call.tool} completed in ${duration}ms`, {
                success: result.success
            });
            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Tool ${call.tool} threw an exception after ${duration}ms`, error);
            return {
                success: false,
                error: `Tool execution failed: ${errorMessage}`
            };
        }
    }

    /**
     * Build the tools description for the LLM system prompt.
     * 
     * Format:
     * ## Available Tools
     * 
     * ### tool_name
     * Description: ...
     * Parameters:
     * - param1 (type, required): description
     * Returns: ...
     */
    buildToolsPrompt(): string {
        const definitions = this.getDefinitions();
        if (definitions.length === 0) {
            return '';
        }

        const lines: string[] = [
            '## Available Tools',
            '',
            'You can call tools by responding with a JSON object in this format:',
            '```json',
            '{ "tool": "tool_name", "parameters": { "param1": "value1" } }',
            '```',
            '',
            'After each tool result, you will receive the output and can call another tool or provide a final answer.',
            'When you are done, respond with:',
            '```json',
            '{ "tool": "DONE", "parameters": { "summary": "what was accomplished" } }',
            '```',
            ''
        ];

        for (const def of definitions) {
            lines.push(`### ${def.name}`);
            lines.push(`Description: ${def.description}`);
            
            if (def.parameters.length > 0) {
                lines.push('Parameters:');
                for (const param of def.parameters) {
                    const req = param.required ? 'required' : 'optional';
                    const enumStr = param.enum ? ` [${param.enum.join('|')}]` : '';
                    const defaultStr = param.default !== undefined ? ` (default: ${param.default})` : '';
                    lines.push(`- ${param.name} (${param.type}, ${req}${enumStr}${defaultStr}): ${param.description}`);
                }
            }
            
            lines.push(`Returns: ${def.returns}`);
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Parse tool calls from LLM output text.
     * 
     * The LLM responds with JSON blocks like:
     * ```json
     * { "tool": "list_files", "parameters": { "path": "src/" } }
     * ```
     * 
     * This parser extracts all such calls.
     */
    parseToolCalls(llmOutput: string): ToolCall[] {
        const calls: ToolCall[] = [];

        // Strategy 1: Extract from ```json ... ``` code blocks
        const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/g;
        let match;
        while ((match = codeBlockRegex.exec(llmOutput)) !== null) {
            const parsed = this.tryParseToolCall(match[1].trim());
            if (parsed) {
                calls.push(parsed);
            }
        }

        // Strategy 2: If no code blocks found, try to find raw JSON objects
        if (calls.length === 0) {
            const jsonRegex = /\{[\s\S]*?"tool"\s*:\s*"[^"]+?"[\s\S]*?\}/g;
            while ((match = jsonRegex.exec(llmOutput)) !== null) {
                const parsed = this.tryParseToolCall(match[0]);
                if (parsed) {
                    calls.push(parsed);
                }
            }
        }

        return calls;
    }

    /**
     * Try to parse a string as a ToolCall JSON
     */
    private tryParseToolCall(text: string): ToolCall | null {
        try {
            const obj = JSON.parse(text);
            if (obj && typeof obj.tool === 'string') {
                return {
                    tool: obj.tool,
                    parameters: obj.parameters || {}
                };
            }
        } catch {
            // Not valid JSON — ignore
        }
        return null;
    }
}
