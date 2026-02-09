import * as vscode from 'vscode';
import { ILLMProvider, TestContext, LLMResult } from '../interfaces/ILLMProvider';
import { LLMNotAvailableError, LLMTimeoutError, RateLimitError } from '../errors/CustomErrors';
import { Logger } from '../services/Logger';

/**
 * Copilot-based LLM Provider
 * Uses VS Code's Language Model API to interact with GitHub Copilot
 */
export class CopilotProvider implements ILLMProvider {
    private logger: Logger;
    private vendor: string;
    private family: string;
    private timeoutMs: number;

    constructor(vendor: string = 'copilot', family?: string, timeoutMs: number = 60000) {
        this.logger = Logger.getInstance();
        this.vendor = vendor;
        this.family = family || ''; // Empty string means "use default model"
        this.timeoutMs = timeoutMs;
    }

    /**
     * Get the provider name
     */
    public getProviderName(): string {
        if (this.family) {
            return `Copilot (${this.vendor}/${this.family})`;
        }
        return `Copilot (${this.vendor}/user-selected)`;
    }

    /**
     * Check if Copilot is available
     */
    public async isAvailable(): Promise<boolean> {
        try {
            // If family is specified, check for that specific model
            if (this.family) {
                const models = await vscode.lm.selectChatModels({
                    vendor: this.vendor,
                    family: this.family
                });
                return models.length > 0;
            }
            
            // Otherwise, check if any Copilot model is available
            const models = await vscode.lm.selectChatModels({
                vendor: this.vendor
            });
            return models.length > 0;
        } catch (error) {
            this.logger.warn('Failed to check Copilot availability', error);
            return false;
        }
    }

    /**
     * Generate a test file
     */
    public async generateTest(context: TestContext): Promise<LLMResult> {
        this.logger.info(`Generating test for ${context.fileName} (attempt ${context.attempt || 1})`);

        const systemPrompt = this.buildSystemPrompt();
        const userPrompt = context.errorContext
            ? this.buildFixPrompt(context)
            : this.buildInitialPrompt(context);

        return await this.sendRequest(systemPrompt, userPrompt);
    }

    /**
     * Fix a failing test
     */
    public async fixTest(context: TestContext): Promise<LLMResult> {
        this.logger.info(`Fixing test for ${context.fileName} (attempt ${context.attempt || 1})`);

        if (!context.errorContext) {
            throw new Error('Error context is required for fixing tests');
        }

        const systemPrompt = this.buildSystemPrompt();
        const userPrompt = this.buildFixPrompt(context);

        return await this.sendRequest(systemPrompt, userPrompt);
    }

    /**
     * Send a request to the LLM
     */
    private async sendRequest(systemPrompt: string, userPrompt: string): Promise<LLMResult> {
        // Get available models
        let models;
        if (this.family) {
            // Use specific model family if configured
            models = await vscode.lm.selectChatModels({
                vendor: this.vendor,
                family: this.family
            });
        } else {
            // Use user's currently selected model (no family filter)
            models = await vscode.lm.selectChatModels({
                vendor: this.vendor
            });
        }

        if (models.length === 0) {
            const familyMsg = this.family ? `family '${this.family}'` : 'any model';
            throw new LLMNotAvailableError(this.vendor, familyMsg);
        }

        const model = models[0];
        this.logger.info(`Using model: ${model.id} (${model.name || 'unnamed'})`);

        // Create messages
        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt),
            vscode.LanguageModelChatMessage.User(userPrompt)
        ];

        // Send request with timeout
        const cancellationTokenSource = new vscode.CancellationTokenSource();
        const timeoutHandle = setTimeout(() => {
            cancellationTokenSource.cancel();
        }, this.timeoutMs);

        try {
            const response = await model.sendRequest(messages, {}, cancellationTokenSource.token);

            // Collect the streamed response
            let code = '';
            for await (const chunk of response.text) {
                code += chunk;
            }

            clearTimeout(timeoutHandle);

            // Extract code from markdown if present
            code = this.extractCodeFromMarkdown(code);

            this.logger.debug('LLM response received', { codeLength: code.length });

            return {
                code,
                model: model.id,
                tokensUsed: undefined // VS Code API doesn't expose token count
            };

        } catch (error) {
            clearTimeout(timeoutHandle);

            // Check for specific error types
            if (cancellationTokenSource.token.isCancellationRequested) {
                throw new LLMTimeoutError(this.timeoutMs);
            }

            if (this.isRateLimitError(error)) {
                throw new RateLimitError();
            }

            this.logger.error('LLM request failed', error);
            throw error;
        } finally {
            cancellationTokenSource.dispose();
        }
    }

    /**
     * Build the system prompt with SPFx-specific instructions
     */
    private buildSystemPrompt(): string {
        return `You are an expert in SharePoint Framework (SPFx) development and testing.

CRITICAL RULES:
1. Use React Testing Library (@testing-library/react) for React 16+ components
2. For SPFx-specific mocks, use the following patterns:
   - Mock @microsoft/sp-page-context: jest.mock('@microsoft/sp-page-context')
   - Mock @microsoft/sp-http: jest.mock('@microsoft/sp-http')
   - Mock @microsoft/sp-core-library: jest.mock('@microsoft/sp-core-library')
3. Always include proper type definitions with TypeScript
4. Use jest.fn() for function mocks
5. Use describe/it blocks for test structure
6. Import statements must be at the top
7. Mock external dependencies before imports
8. Return ONLY the test code, no explanations or markdown unless wrapping code blocks

JEST MOCK SYNTAX (CRITICAL):
- DO NOT use TypeScript type annotations inside jest.mock() factory functions
- WRONG: jest.mock('lib', () => ({ fn: (x: string) => {} }))
- CORRECT: jest.mock('lib', () => ({ fn: (x) => {} }))
- Use 'any' or remove types completely in mock implementations
- Example for React components:
  jest.mock('@fluentui/react', () => ({
    PrimaryButton: (props: any) => <button onClick={props.onClick}>{props.text}</button>
  }));

BABEL COMPATIBILITY:
- Remember: Jest uses Babel to transform TypeScript
- Babel strips types but doesn't understand complex inline types in arrow functions
- Keep mock implementations simple with minimal or no type annotations
- Use 'any' type for props in mock components if needed

RESPONSE FORMAT:
- If you include markdown code blocks, use \`\`\`typescript or \`\`\`tsx
- Ensure the code is complete and can be written directly to a .test.tsx file`;
    }

    /**
     * Build the initial test generation prompt
     */
    private buildInitialPrompt(context: TestContext): string {
        return `Generate comprehensive Jest unit tests for this SPFx component.

**File:** ${context.fileName}

**Source Code:**
\`\`\`typescript
${context.sourceCode}
\`\`\`

Generate a complete test file with:
1. All necessary imports and mocks
2. Tests for component rendering
3. Tests for user interactions (if applicable)
4. Tests for props variations
5. Tests for error states (if applicable)

Return the complete test file code.`;
    }

    /**
     * Build the fix prompt when test fails
     */
    private buildFixPrompt(context: TestContext): string {
        const errorContext = context.errorContext || '';
        
        // Detect common error patterns
        const isSyntaxError = errorContext.includes('SyntaxError') || errorContext.includes('Unexpected token');
        const isMockError = errorContext.includes('jest.mock') || errorContext.includes('@fluentui') || errorContext.includes('@microsoft');
        const isTypeError = errorContext.includes('expected ","') && errorContext.includes('props:');

        let specificGuidance = '';
        if (isSyntaxError && isMockError && isTypeError) {
            specificGuidance = `
**DETECTED ISSUE: TypeScript types in jest.mock() causing Babel syntax error**

The error shows TypeScript type annotations inside a jest.mock() factory function.
Babel cannot parse inline type annotations like \`(props: { text: string })\` in mock factories.

**FIX REQUIRED:**
Replace:
  jest.mock('library', () => ({
    Component: (props: { text: string; onClick: () => void }) => ...
  }));

With:
  jest.mock('library', () => ({
    Component: (props: any) => ...
  }));

OR remove the parameter type completely:
  jest.mock('library', () => ({
    Component: (props) => ...
  }));
`;
        }

        return `The test you generated is failing. Please fix it.

**Attempt:** ${context.attempt || 1}${context.maxAttempts ? `/${context.maxAttempts}` : ''}

**Source File:** ${context.fileName}

**Test Error Output:**
\`\`\`
${errorContext}
\`\`\`
${specificGuidance}
**Original Source Code:**
\`\`\`typescript
${context.sourceCode}
\`\`\`

Analyze the error and generate a CORRECTED version of the test file that will pass.
Focus on:
1. **CRITICAL**: Remove TypeScript type annotations from jest.mock() factory functions
2. Use 'any' type or no type for parameters in mock implementations
3. Fixing import errors
4. Correcting mock implementations  
5. Fixing assertion logic
6. Handling async operations properly

Return the complete FIXED test file code.`;
    }

    /**
     * Extract TypeScript/TSX code from markdown code blocks
     */
    private extractCodeFromMarkdown(text: string): string {
        // Look for code blocks with typescript, tsx, ts, or javascript
        const codeBlockRegex = /```(?:typescript|tsx|ts|javascript|js)?\s*([\s\S]*?)\s*```/;
        const match = text.match(codeBlockRegex);

        if (match) {
            return match[1].trim();
        }

        // If no code block found, return as-is (LLM might have returned raw code)
        return text.trim();
    }

    /**
     * Check if an error is a rate limit error
     */
    private isRateLimitError(error: unknown): boolean {
        const message = (error as Error)?.message || '';
        return message.toLowerCase().includes('rate limit') ||
            message.includes('429') ||
            message.toLowerCase().includes('too many requests');
    }
}
