import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from '../BaseTool';
import { ToolParameter, ToolResult, ToolExecutionContext } from '../ToolTypes';

/**
 * ReadFileTool — Reads the content of a file.
 * 
 * The LLM uses this to inspect source code before generating tests,
 * or to read existing tests, configs, etc.
 */
export class ReadFileTool extends BaseTool {
    get name(): string { return 'read_file'; }
    
    get description(): string {
        return 'Read the content of a file. Returns the file content as a string. Use this to inspect source code before generating tests.';
    }

    get parameters(): ToolParameter[] {
        return [
            {
                name: 'filePath',
                type: 'string',
                description: 'Path to the file (relative to workspace root)',
                required: true
            },
            {
                name: 'maxLines',
                type: 'number',
                description: 'Maximum number of lines to return (0 = all). Use to limit large files.',
                required: false,
                default: 0
            }
        ];
    }

    get returns(): string {
        return 'File content as string, with file metadata (size, line count)';
    }

    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const validation = this.validateParams(params, ['filePath']);
        if (validation) { return this.error(validation); }

        const filePath = params.filePath as string;
        const maxLines = (params.maxLines as number) || 0;
        const absolutePath = path.resolve(context.workspaceRoot, filePath);

        // Security: ensure file is within workspace
        if (!absolutePath.startsWith(path.normalize(context.workspaceRoot))) {
            return this.error('File must be within workspace');
        }

        if (!fs.existsSync(absolutePath)) {
            return this.error(`File not found: ${filePath}`);
        }

        try {
            let content = fs.readFileSync(absolutePath, 'utf-8');
            const totalLines = content.split('\n').length;
            
            if (maxLines > 0) {
                content = content.split('\n').slice(0, maxLines).join('\n');
            }

            return this.success(content, {
                filePath,
                totalLines,
                returnedLines: maxLines > 0 ? Math.min(maxLines, totalLines) : totalLines,
                sizeBytes: Buffer.byteLength(content, 'utf-8')
            });
        } catch (error) {
            return this.error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
