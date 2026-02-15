import { BaseTool } from '../BaseTool';
import { ToolParameter, ToolResult, ToolExecutionContext } from '../ToolTypes';
import { TestRunner, TestRunResult } from '../../utils/TestRunner';

/**
 * RunTestTool — Executes a Jest test file and returns the result.
 * 
 * The LLM uses this after generating a test to verify it passes,
 * and to get error output for self-healing.
 */
export class RunTestTool extends BaseTool {
    private testRunner: TestRunner;

    constructor() {
        super();
        this.testRunner = new TestRunner();
    }

    get name(): string { return 'run_test'; }
    
    get description(): string {
        return 'Execute a Jest test file and return the result. Returns success/failure status and full test output including any errors.';
    }

    get parameters(): ToolParameter[] {
        return [
            {
                name: 'testFilePath',
                type: 'string',
                description: 'Path to the test file to run (relative to workspace root)',
                required: true
            },
            {
                name: 'jestCommand',
                type: 'string',
                description: 'Jest command to use (default: npx jest)',
                required: false,
                default: 'npx jest'
            }
        ];
    }

    get returns(): string {
        return 'Object with success (boolean), output (string with full Jest output)';
    }

    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const validation = this.validateParams(params, ['testFilePath']);
        if (validation) { return this.error(validation); }

        const testFilePath = params.testFilePath as string;
        const jestCommand = (params.jestCommand as string) || 'npx jest';
        const path = require('path');
        const absolutePath = path.resolve(context.workspaceRoot, testFilePath);

        try {
            context.progress?.('Running test...');
            
            const result: TestRunResult = await this.testRunner.runTest(
                absolutePath,
                context.workspaceRoot,
                jestCommand
            );

            // Truncate output if too long (keep first 3000 chars)
            const output = result.output.length > 3000
                ? result.output.substring(0, 3000) + '\n... (truncated)'
                : result.output;

            return this.success({
                success: result.success,
                output
            }, {
                testFilePath,
                passed: result.success,
                outputLength: result.output.length
            });
        } catch (error) {
            return this.error(`Failed to run test: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
