import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TestRunner } from '../utils/TestRunner';
import { JestLogParser } from '../utils/JestLogParser';

/**
 * TestAgent - Core agentic workflow for automated SPFx test generation
 * 
 * This agent implements a self-healing loop:
 * 1. Generates a test file using LLM (GPT-4 via Copilot)
 * 2. Executes the test using Jest
 * 3. If test fails, parses the error and asks LLM to fix it
 * 4. Repeats up to 3 times until test passes
 */
export class TestAgent {
    private testRunner: TestRunner;
    private maxAttempts = 3;

    constructor() {
        this.testRunner = new TestRunner();
    }

    /**
     * Main method: Generate and heal a test file for a given source file
     * 
     * @param sourceFilePath - Absolute path to the source file (e.g., MyComponent.tsx)
     * @param workspaceRoot - Root directory of the workspace
     * @param stream - VS Code chat response stream for progress updates
     * @returns Path to the generated test file
     */
    async generateAndHealTest(
        sourceFilePath: string,
        workspaceRoot: string,
        stream: vscode.ChatResponseStream
    ): Promise<string> {
        // Verify Jest is available
        const jestAvailable = await this.testRunner.isJestAvailable(workspaceRoot);
        if (!jestAvailable) {
            throw new Error('Jest is not installed in this project. Please run: npm install --save-dev jest @types/jest');
        }

        // Read the source file
        const sourceCode = fs.readFileSync(sourceFilePath, 'utf-8');
        const sourceFileName = path.basename(sourceFilePath);
        
        stream.progress('Reading source file...');

        // Determine test file path
        const testFilePath = this.getTestFilePath(sourceFilePath);
        
        stream.progress('Generating initial test...');

        // Attempt 1: Generate initial test
        let testCode = await this.generateTest(sourceCode, sourceFileName, null, 1);
        fs.writeFileSync(testFilePath, testCode, 'utf-8');

        stream.markdown(`✅ Generated test file: \`${path.relative(workspaceRoot, testFilePath)}\`\n\n`);
        stream.progress('Running test...');

        // Run the test
        let result = await this.testRunner.runTest(testFilePath, workspaceRoot);

        // Self-healing loop
        let attempt = 1;
        while (!result.success && attempt < this.maxAttempts) {
            attempt++;
            
            stream.markdown(`⚠️ Test failed on attempt ${attempt - 1}. Analyzing errors...\n\n`);
            
            // Parse and clean the error output
            const cleanedError = JestLogParser.cleanJestOutput(result.output);
            const summary = JestLogParser.extractTestSummary(result.output);
            
            stream.markdown(`**Error Summary:** ${summary.failed} failed, ${summary.passed} passed\n\n`);
            stream.progress(`Healing test (attempt ${attempt}/${this.maxAttempts})...`);

            // Wait briefly to avoid rate limits
            await this.sleep(1000 * attempt); // Exponential backoff: 1s, 2s, 3s

            try {
                // Ask LLM to fix the test
                testCode = await this.generateTest(sourceCode, sourceFileName, cleanedError, attempt);
                fs.writeFileSync(testFilePath, testCode, 'utf-8');

                stream.markdown(`🔄 Updated test file (attempt ${attempt})\n\n`);
                stream.progress('Running test again...');

                // Run the test again
                result = await this.testRunner.runTest(testFilePath, workspaceRoot);
            } catch (error) {
                if (this.isRateLimitError(error)) {
                    stream.markdown(`⏸️ Rate limit encountered. Waiting before retry...\n\n`);
                    await this.sleep(5000); // Wait 5 seconds for rate limit
                    attempt--; // Don't count this as a real attempt
                    continue;
                }
                throw error;
            }
        }

        if (result.success) {
            stream.markdown(`✅ **Test passed successfully!**\n\n`);
            const summary = JestLogParser.extractTestSummary(result.output);
            stream.markdown(`**Final Results:** ${summary.passed} passed, ${summary.total} total\n\n`);
        } else {
            stream.markdown(`❌ **Test still failing after ${this.maxAttempts} attempts.**\n\n`);
            stream.markdown('Consider reviewing the generated test manually.\n\n');
            const cleanedError = JestLogParser.cleanJestOutput(result.output);
            stream.markdown('```\n' + cleanedError + '\n```\n\n');
        }

        return testFilePath;
    }

    /**
     * Generates or fixes a test using the LLM
     * 
     * @param sourceCode - The source code to test
     * @param fileName - Name of the source file
     * @param errorContext - Error from previous attempt (null for first attempt)
     * @param attempt - Current attempt number
     * @returns Generated test code
     */
    private async generateTest(
        sourceCode: string,
        fileName: string,
        errorContext: string | null,
        attempt: number
    ): Promise<string> {
        // Select the GPT-4 model via Copilot
        // We specifically use vendor: 'copilot' and family: 'gpt-4' to ensure
        // we get the most capable model for code generation
        const models = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: 'gpt-4'
        });

        if (models.length === 0) {
            throw new Error('No GPT-4 model available. Ensure GitHub Copilot is installed and activated.');
        }

        const model = models[0];

        // Build the system prompt with SPFx-specific guidance
        const systemPrompt = this.buildSystemPrompt();

        // Build the user prompt
        const userPrompt = errorContext 
            ? this.buildFixPrompt(sourceCode, fileName, errorContext, attempt)
            : this.buildInitialPrompt(sourceCode, fileName);

        // Create messages for the chat
        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt),
            vscode.LanguageModelChatMessage.User(userPrompt)
        ];

        // Send request to the model
        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

        // Collect the streamed response
        let testCode = '';
        for await (const chunk of response.text) {
            testCode += chunk;
        }

        // Extract code from markdown if present
        testCode = this.extractCodeFromMarkdown(testCode);

        return testCode;
    }

    /**
     * Builds the system prompt with SPFx-specific instructions
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

RESPONSE FORMAT:
- If you include markdown code blocks, use \`\`\`typescript or \`\`\`tsx
- Ensure the code is complete and can be written directly to a .test.tsx file`;
    }

    /**
     * Builds the initial test generation prompt
     */
    private buildInitialPrompt(sourceCode: string, fileName: string): string {
        return `Generate comprehensive Jest unit tests for this SPFx component.

**File:** ${fileName}

**Source Code:**
\`\`\`typescript
${sourceCode}
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
     * Builds the fix prompt when test fails
     */
    private buildFixPrompt(
        sourceCode: string,
        fileName: string,
        errorContext: string,
        attempt: number
    ): string {
        return `The test you generated is failing. Please fix it.

**Attempt:** ${attempt}

**Source File:** ${fileName}

**Test Error Output:**
\`\`\`
${errorContext}
\`\`\`

**Original Source Code:**
\`\`\`typescript
${sourceCode}
\`\`\`

Analyze the error and generate a CORRECTED version of the test file that will pass.
Focus on:
1. Fixing import errors
2. Correcting mock implementations
3. Fixing assertion logic
4. Handling async operations properly

Return the complete FIXED test file code.`;
    }

    /**
     * Extracts TypeScript/TSX code from markdown code blocks
     */
    private extractCodeFromMarkdown(text: string): string {
        // Look for code blocks with typescript, tsx, ts, or javascript
        const codeBlockRegex = /```(?:typescript|tsx|ts|javascript|js)?\n([\s\S]*?)```/;
        const match = text.match(codeBlockRegex);
        
        if (match) {
            return match[1].trim();
        }

        // If no code block found, return as-is (LLM might have returned raw code)
        return text.trim();
    }

    /**
     * Determines the test file path based on source file path
     * Supports both .test.tsx and .spec.tsx patterns
     */
    private getTestFilePath(sourceFilePath: string): string {
        const dir = path.dirname(sourceFilePath);
        const ext = path.extname(sourceFilePath);
        const baseName = path.basename(sourceFilePath, ext);
        
        // Use .test.tsx for React components, .test.ts for plain TypeScript
        const testExt = ext === '.tsx' ? '.test.tsx' : '.test.ts';
        
        return path.join(dir, `${baseName}${testExt}`);
    }

    /**
     * Checks if an error is a rate limit error
     */
    private isRateLimitError(error: unknown): boolean {
        const message = (error as Error)?.message || '';
        return message.includes('rate limit') || 
               message.includes('429') || 
               message.includes('Too Many Requests');
    }

    /**
     * Sleep utility for backoff
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
