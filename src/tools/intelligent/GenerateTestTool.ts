import { BaseTool } from '../BaseTool';
import { ToolParameter, ToolResult, ToolExecutionContext } from '../ToolTypes';
import { ILLMProvider, TestContext, LLMResult } from '../../interfaces/ILLMProvider';
import { PROMPTS } from '../../utils/prompts';
import { StackDiscoveryService } from '../../services/StackDiscoveryService';

/**
 * GenerateTestTool — Uses the LLM to generate a test file for source code.
 * 
 * This is an "intelligent" tool: it wraps an LLM call inside a tool interface.
 * The orchestrator calls this tool, which internally sends a request to the LLM
 * with the source code and context, then returns the generated test code.
 */
export class GenerateTestTool extends BaseTool {
    private llmProvider: ILLMProvider;
    private stackDiscovery: StackDiscoveryService;

    constructor(llmProvider: ILLMProvider) {
        super();
        this.llmProvider = llmProvider;
        this.stackDiscovery = new StackDiscoveryService();
    }

    get name(): string { return 'generate_test'; }
    
    get description(): string {
        return 'Generate a Jest test file for the given source code. Uses AI to create comprehensive tests with proper mocking, assertions, and structure based on the source code analysis.';
    }

    get parameters(): ToolParameter[] {
        return [
            {
                name: 'sourceCode',
                type: 'string',
                description: 'The full source code of the file to generate tests for',
                required: true
            },
            {
                name: 'fileName',
                type: 'string',
                description: 'The source file name (e.g., UserService.ts)',
                required: true
            },
            {
                name: 'dependencyContext',
                type: 'string',
                description: 'Formatted context from collect_context tool (imports, types, framework patterns)',
                required: false
            }
        ];
    }

    get returns(): string {
        return 'Generated test file content as a string';
    }

    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const validation = this.validateParams(params, ['sourceCode', 'fileName']);
        if (validation) { return this.error(validation); }

        const sourceCode = params.sourceCode as string;
        const fileName = params.fileName as string;
        const dependencyContext = params.dependencyContext as string | undefined;

        try {
            context.progress?.('Generating test with AI...');

            // Build system prompt with stack awareness
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
                dependencyContext,
                systemPrompt,
                attempt: 1,
                maxAttempts: 1
            };

            const result: LLMResult = await this.llmProvider.generateTest(testContext);

            return this.success(result.code, {
                model: result.model,
                tokensUsed: result.tokensUsed,
                fileName
            });
        } catch (error) {
            return this.error(`Test generation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
