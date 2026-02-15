import * as vscode from 'vscode';
import { BaseTool } from '../BaseTool';
import { ToolParameter, ToolResult, ToolExecutionContext } from '../ToolTypes';
import { FileScanner } from '../../utils/FileScanner';

/**
 * ListSourceFilesTool — Lists source files in a workspace directory.
 * 
 * The LLM uses this to discover what files exist before deciding
 * which ones to generate tests for.
 */
export class ListSourceFilesTool extends BaseTool {
    get name(): string { return 'list_source_files'; }
    
    get description(): string {
        return 'List all source files (TS/JS/TSX/JSX) in the workspace, excluding test files, node_modules, and build outputs. Returns file paths relative to workspace root.';
    }

    get parameters(): ToolParameter[] {
        return [
            {
                name: 'path',
                type: 'string',
                description: 'Subdirectory to scan (relative to workspace root). Use "." or omit for entire workspace.',
                required: false,
                default: '.'
            },
            {
                name: 'withoutTestsOnly',
                type: 'boolean',
                description: 'If true, only return files that do NOT already have a test file.',
                required: false,
                default: false
            }
        ];
    }

    get returns(): string {
        return 'Array of file paths relative to workspace root';
    }

    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const subPath = (params.path as string) || '.';
        const withoutTestsOnly = params.withoutTestsOnly === true;

        try {
            const scanBase = vscode.Uri.file(
                require('path').resolve(context.workspaceRoot, subPath)
            );

            let files = await FileScanner.findSourceFiles(scanBase);

            if (withoutTestsOnly) {
                files = FileScanner.filterFilesWithoutTests(files);
            }

            const relativePaths = files.map(f => 
                require('path').relative(context.workspaceRoot, f.fsPath).replace(/\\/g, '/')
            );

            return this.success(relativePaths, { count: relativePaths.length });
        } catch (error) {
            return this.error(`Failed to list files: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
