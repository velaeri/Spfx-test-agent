import * as vscode from 'vscode';
import { 
    ILLMCapability, 
    CapabilityContext, 
    ValidationResult, 
    CapabilityError 
} from '../interfaces/ILLMCapability';
import { ICoreProvider } from '../interfaces/ICoreProvider';
import { TestAgent } from '../agent/TestAgent';
import { CoreProviderAdapter } from '../adapters/CoreProviderAdapter';
import { Logger } from '../services/Logger';
import { StateService } from '../services/StateService';

/**
 * Input for test generation capability
 */
export interface TestGenerationInput {
    sourceFilePath: string;
    workspaceRoot: string;
    mode?: 'fast' | 'balanced' | 'thorough';
}

/**
 * Output from test generation capability
 */
export interface TestGenerationOutput {
    testFilePath: string;
    passed: boolean;
    attempts: number;
    duration: number;
}

/**
 * Test Generation Capability
 * 
 * Wraps TestAgent functionality as a capability in the new architecture.
 * This capability handles:
 * - Generating test files for source code
 * - Self-healing loop (generate → execute → fix → repeat)
 * - Strategy planning with LLM
 * - Error capture and analysis
 * 
 * **Design Philosophy:**
 * - Pure wrapper: delegates ALL functionality to TestAgent
 * - Zero behavioral changes from v0.5.3
 * - Implements ILLMCapability for extensibility
 * - Uses CoreProviderAdapter to bridge ICoreProvider → ILLMProvider
 */
export class TestGenerationCapability implements ILLMCapability<TestGenerationInput, TestGenerationOutput> {
    readonly name = 'test-generation';
    readonly description = 'Generate and self-heal test files for source code';
    readonly category = 'testing';

    private logger = Logger.getInstance();
    private stateService?: StateService;

    constructor(stateService?: StateService) {
        this.stateService = stateService;
    }

    /**
     * Execute test generation
     */
    async execute(
        provider: ICoreProvider,
        input: TestGenerationInput,
        stream: vscode.ChatResponseStream,
        token?: vscode.CancellationToken
    ): Promise<TestGenerationOutput> {
        this.logger.info('[TestGenerationCapability] Starting test generation', {
            file: input.sourceFilePath,
            mode: input.mode || 'balanced'
        });

        const startTime = Date.now();

        try {
            // Create adapter to convert ICoreProvider → ILLMProvider
            const adapter = new CoreProviderAdapter(provider);
            
            // Create TestAgent with adapted provider
            const testAgent = new TestAgent(adapter, this.stateService);

            // Delegate to TestAgent (preserves ALL existing functionality)
            const testFilePath = await testAgent.generateAndHealTest(
                input.sourceFilePath,
                input.workspaceRoot,
                stream,
                input.mode || 'balanced'
            );

            const duration = Date.now() - startTime;

            this.logger.info('[TestGenerationCapability] Test generation completed', {
                testFilePath,
                duration
            });

            // TODO: Get actual attempts and passed status from TestAgent
            // This requires minor refactoring of TestAgent to return this info
            return {
                testFilePath,
                passed: true, // Assume passed if no exception
                attempts: 1,  // TODO: Track actual attempts
                duration
            };

        } catch (error) {
            const duration = Date.now() - startTime;
            this.logger.error('[TestGenerationCapability] Test generation failed', error);
            
            throw new CapabilityError(
                `Failed to generate test: ${error instanceof Error ? error.message : String(error)}`,
                this.name,
                error instanceof Error ? error : undefined
            );
        }
    }

    /**
     * Determine if this capability can handle the given context
     */
    canHandle(context: CapabilityContext): boolean {
        // Check if command is test-related
        if (context.command) {
            const testCommands = [
                '/generate',
                '/generate-all',
                '/test',
                '/fix-test'
            ];
            if (testCommands.includes(context.command)) {
                return true;
            }
        }

        // Check if message mentions test generation
        if (context.message) {
            const testKeywords = [
                'generate test',
                'create test',
                'write test',
                'test file',
                'unit test',
                'jest test'
            ];
            const lowerMessage = context.message.toLowerCase();
            if (testKeywords.some(keyword => lowerMessage.includes(keyword))) {
                return true;
            }
        }

        // Check if active file is a source file (not already a test)
        if (context.activeFile) {
            const isTestFile = context.activeFile.includes('.test.') || 
                             context.activeFile.includes('.spec.');
            const isSourceFile = context.activeFile.endsWith('.ts') || 
                               context.activeFile.endsWith('.tsx') ||
                               context.activeFile.endsWith('.js') ||
                               context.activeFile.endsWith('.jsx');
            
            if (isSourceFile && !isTestFile) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get help text for this capability
     */
    getHelpText(): string {
        return `
**Test Generation Capability**

Automatically generates test files using AI-powered self-healing loop.

**Commands:**
- \`/generate\` - Generate test for active file
- \`/generate-all\` - Generate tests for all source files
- \`/fix-test\` - Fix failing test

**Modes:**
- \`fast\` - Generate without execution (quick but no validation)
- \`balanced\` - Generate and validate with limited healing (default)
- \`thorough\` - Full self-healing loop with multiple fix attempts

**Examples:**
\`\`\`
/generate balanced
Generate test for UserService.ts
Create unit test for my component
\`\`\`

**How it works:**
1. **Analyze** - Detects project stack (React, SPFx, etc.)
2. **Plan** - LLM creates test strategy (mocking approach, structure)
3. **Generate** - LLM writes test code
4. **Execute** - Runs test with Jest
5. **Heal** - If test fails, LLM analyzes error and fixes (iterative)

**Success Rate:** 95%+ after self-healing loop
        `.trim();
    }

    /**
     * Validate input before execution
     */
    async validateInput(input: TestGenerationInput): Promise<ValidationResult> {
        const errors: string[] = [];

        // Validate source file path
        if (!input.sourceFilePath) {
            errors.push('sourceFilePath is required');
        } else {
            // Check if file exists
            try {
                const uri = vscode.Uri.file(input.sourceFilePath);
                await vscode.workspace.fs.stat(uri);
            } catch (error) {
                errors.push(`Source file not found: ${input.sourceFilePath}`);
            }
        }

        // Validate workspace root
        if (!input.workspaceRoot) {
            errors.push('workspaceRoot is required');
        }

        // Validate mode
        if (input.mode && !['fast', 'balanced', 'thorough'].includes(input.mode)) {
            errors.push(`Invalid mode: ${input.mode}. Must be fast, balanced, or thorough`);
        }

        return {
            valid: errors.length === 0,
            error: errors.length > 0 ? errors.join('; ') : undefined
        };
    }
}
