import { BaseTool } from '../BaseTool';
import { ToolParameter, ToolResult, ToolExecutionContext } from '../ToolTypes';
import { ILLMProvider, TestContext, LLMResult } from '../../interfaces/ILLMProvider';
import { PROMPTS } from '../../utils/prompts';
import { StackDiscoveryService } from '../../services/StackDiscoveryService';

/**
 * FixTestTool — Uses the LLM to fix a failing test based on error output.
 * 
 * Intelligent tool that takes the current test code, the error output,
 * and the source code, then asks the LLM to produce a corrected version.
 */
export class FixTestTool extends BaseTool {
    private llmProvider: ILLMProvider;
    private stackDiscovery: StackDiscoveryService;

    constructor(llmProvider: ILLMProvider) {
        super();
        this.llmProvider = llmProvider;
        this.stackDiscovery = new StackDiscoveryService();
    }

    get name(): string { return 'fix_test'; }
    
    get description(): string {
        return 'Fix a failing test by analyzing the error output. Uses AI to diagnose the error and produce a corrected test file. Call this after run_test returns a failure.';
    }

    get parameters(): ToolParameter[] {
        return [
            {
                name: 'sourceCode',
                type: 'string',
                description: 'The original source code being tested',
                required: true
            },
            {
                name: 'fileName',
                type: 'string',
                description: 'The source file name',
                required: true
            },
            {
                name: 'currentTestCode',
                type: 'string',
                description: 'The current (failing) test code',
                required: true
            },
            {
                name: 'errorOutput',
                type: 'string',
                description: 'The Jest error output from run_test',
                required: true
            },
            {
                name: 'dependencyContext',
                type: 'string',
                description: 'Formatted context from collect_context tool',
                required: false
            },
            {
                name: 'attempt',
                type: 'number',
                description: 'Current fix attempt number (for tracking)',
                required: false,
                default: 1
            }
        ];
    }

    get returns(): string {
        return 'Fixed test file content as a string';
    }

    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const validation = this.validateParams(params, ['sourceCode', 'fileName', 'currentTestCode', 'errorOutput']);
        if (validation) { return this.error(validation); }

        const sourceCode = params.sourceCode as string;
        const fileName = params.fileName as string;
        const currentTestCode = params.currentTestCode as string;
        const errorOutput = params.errorOutput as string;
        const dependencyContext = params.dependencyContext as string | undefined;
        const attempt = (params.attempt as number) || 1;

        try {
            context.progress?.(`Fixing test (attempt ${attempt})...`);

            let systemPrompt: string | undefined;
            try {
                const stack = await this.stackDiscovery.discover(context.workspaceRoot);
                systemPrompt = PROMPTS.buildSystemPrompt(stack);
            } catch {
                this.logger.warn('Stack discovery failed, using default prompt');
            }

            const testContext: TestContext = {
                sourceCode,
                fileName,
                currentTestCode,
                errorContext: errorOutput,
                dependencyContext,
                systemPrompt,
                attempt,
                maxAttempts: 3
            };

            const result: LLMResult = await this.llmProvider.fixTest(testContext);

            return this.success(result.code, {
                model: result.model,
                tokensUsed: result.tokensUsed,
                attempt,
                fileName
            });
        } catch (error) {
            return this.error(`Test fix failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
