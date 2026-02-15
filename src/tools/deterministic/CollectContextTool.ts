import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from '../BaseTool';
import { ToolParameter, ToolResult, ToolExecutionContext } from '../ToolTypes';
import { SourceContextCollector } from '../../utils/SourceContextCollector';

/**
 * CollectContextTool — Collects dependency context for a source file.
 * 
 * Resolves imports, reads dependency files, detects framework patterns,
 * and returns everything the LLM needs to generate accurate tests.
 */
export class CollectContextTool extends BaseTool {
    private contextCollector: SourceContextCollector;

    constructor() {
        super();
        this.contextCollector = new SourceContextCollector();
    }

    get name(): string { return 'collect_context'; }
    
    get description(): string {
        return 'Collect dependency context for a source file. Resolves local imports, reads dependency source code, detects framework patterns, and returns formatted context suitable for test generation prompts.';
    }

    get parameters(): ToolParameter[] {
        return [
            {
                name: 'filePath',
                type: 'string',
                description: 'Path to the source file (relative to workspace root)',
                required: true
            }
        ];
    }

    get returns(): string {
        return 'Formatted context string with dependency code, framework patterns, and package info';
    }

    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const validation = this.validateParams(params, ['filePath']);
        if (validation) { return this.error(validation); }

        const filePath = params.filePath as string;
        const absolutePath = path.resolve(context.workspaceRoot, filePath);

        if (!fs.existsSync(absolutePath)) {
            return this.error(`File not found: ${filePath}`);
        }

        try {
            const sourceContext = await this.contextCollector.collectContext(
                absolutePath,
                context.workspaceRoot
            );

            const formatted = this.contextCollector.formatForPrompt(sourceContext);

            return this.success(formatted, {
                dependencyCount: sourceContext.dependencies.size,
                frameworkPatterns: sourceContext.frameworkPatterns.length,
                hasPackageDeps: !!sourceContext.packageDeps,
                hasJestConfig: !!sourceContext.jestConfig
            });
        } catch (error) {
            return this.error(`Failed to collect context: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
