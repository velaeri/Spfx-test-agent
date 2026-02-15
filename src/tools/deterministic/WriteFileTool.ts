import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from '../BaseTool';
import { ToolParameter, ToolResult, ToolExecutionContext } from '../ToolTypes';

/**
 * WriteFileTool — Writes content to a file (creates or overwrites).
 * 
 * The LLM uses this to write generated test files, config files, etc.
 */
export class WriteFileTool extends BaseTool {
    get name(): string { return 'write_file'; }
    
    get description(): string {
        return 'Write content to a file. Creates the file if it does not exist, or overwrites it. Creates parent directories if needed.';
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
                name: 'content',
                type: 'string',
                description: 'The full content to write to the file',
                required: true
            }
        ];
    }

    get returns(): string {
        return 'Confirmation with file path and size';
    }

    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const validation = this.validateParams(params, ['filePath', 'content']);
        if (validation) { return this.error(validation); }

        const filePath = params.filePath as string;
        const content = params.content as string;
        const absolutePath = path.resolve(context.workspaceRoot, filePath);

        // Security: ensure file is within workspace
        if (!absolutePath.startsWith(path.normalize(context.workspaceRoot))) {
            return this.error('File must be within workspace');
        }

        try {
            // Create parent directories if needed
            const dir = path.dirname(absolutePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const existed = fs.existsSync(absolutePath);
            fs.writeFileSync(absolutePath, content, 'utf-8');

            return this.success(
                `File ${existed ? 'updated' : 'created'}: ${filePath}`,
                {
                    filePath,
                    existed,
                    sizeBytes: Buffer.byteLength(content, 'utf-8'),
                    lineCount: content.split('\n').length
                }
            );
        } catch (error) {
            return this.error(`Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
