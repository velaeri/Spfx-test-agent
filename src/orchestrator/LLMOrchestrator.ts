import * as vscode from 'vscode';
import { Logger } from '../services/Logger';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolCall, ToolResult, ToolExecutionContext } from '../tools/ToolTypes';
import { ILLMProvider, LLMResult } from '../interfaces/ILLMProvider';
import { ConfigService } from '../services/ConfigService';

/**
 * LLMOrchestrator — The central agentic loop engine.
 * 
 * This orchestrator:
 * 1. Builds a system prompt that includes all available tool definitions
 * 2. Sends the user's request + tools to the LLM
 * 3. Parses tool calls from the LLM output
 * 4. Executes the tools and feeds results back to the LLM
 * 5. Loops until the LLM responds with DONE or max iterations reached
 * 
 * Since vscode.lm API doesn't support native function calling,
 * we use structured output parsing (JSON in markdown code blocks).
 */
export class LLMOrchestrator {
    private toolRegistry: ToolRegistry;
    private llmProvider: ILLMProvider;
    private logger: Logger;
    private maxIterations: number;

    constructor(
        toolRegistry: ToolRegistry,
        llmProvider: ILLMProvider,
        maxIterations: number = 10
    ) {
        this.toolRegistry = toolRegistry;
        this.llmProvider = llmProvider;
        this.logger = Logger.getInstance();
        this.maxIterations = maxIterations;
    }

    /**
     * Execute an agentic workflow.
     * 
     * @param userRequest - The user's natural language request
     * @param context - Execution context (workspace root, cancellation, progress)
     * @param stream - VS Code chat response stream for real-time updates
     * @returns Final summary from the LLM
     */
    async execute(
        userRequest: string,
        context: ToolExecutionContext,
        stream: vscode.ChatResponseStream
    ): Promise<string> {
        const systemPrompt = this.buildSystemPrompt();
        const conversationHistory: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [];

        // Initial user message
        conversationHistory.push({ role: 'user', content: userRequest });

        this.logger.info('Orchestrator starting', {
            tools: this.toolRegistry.getToolNames(),
            maxIterations: this.maxIterations
        });

        for (let iteration = 0; iteration < this.maxIterations; iteration++) {
            // Check cancellation
            if (context.cancellationToken?.isCancellationRequested) {
                this.logger.warn('Orchestrator cancelled by user');
                return 'Operation cancelled by user';
            }

            this.logger.info(`Orchestrator iteration ${iteration + 1}/${this.maxIterations}`);

            // Build the full prompt from conversation history
            const fullUserPrompt = this.buildConversationPrompt(conversationHistory);

            // Send to LLM
            let llmResponse: string;
            try {
                const result: LLMResult = await this.sendToLLM(systemPrompt, fullUserPrompt);
                llmResponse = result.code; // LLMResult.code contains the raw text
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Unknown LLM error';
                this.logger.error('LLM request failed', error);
                stream.markdown(`\n❌ LLM error: ${errorMsg}\n`);
                return `Error: ${errorMsg}`;
            }

            // Parse tool calls from response
            const toolCalls = this.toolRegistry.parseToolCalls(llmResponse);

            // If no tool calls found, the LLM is providing a direct response
            if (toolCalls.length === 0) {
                this.logger.info('No tool calls found — treating as final response');
                conversationHistory.push({ role: 'assistant', content: llmResponse });
                return llmResponse;
            }

            // Check for DONE signal
            const doneCall = toolCalls.find(c => c.tool === 'DONE');
            if (doneCall) {
                const summary = (doneCall.parameters.summary as string) || 'Task completed';
                this.logger.info('Orchestrator received DONE signal', { summary });
                return summary;
            }

            // Execute each tool call
            for (const call of toolCalls) {
                stream.progress(`Executing tool: ${call.tool}...`);
                this.logger.info(`Executing tool call: ${call.tool}`, { params: call.parameters });

                const result = await this.toolRegistry.execute(call, context);

                // Build tool result message for conversation
                const resultStr = JSON.stringify(result, null, 2);
                conversationHistory.push({ role: 'assistant', content: `Calling tool: ${call.tool}` });
                conversationHistory.push({
                    role: 'tool',
                    content: `Tool "${call.tool}" result:\n${resultStr}`
                });

                // Stream progress to user
                if (result.success) {
                    stream.markdown(`✅ \`${call.tool}\` completed\n`);
                } else {
                    stream.markdown(`⚠️ \`${call.tool}\` failed: ${result.error}\n`);
                }
            }
        }

        this.logger.warn('Orchestrator reached max iterations');
        return 'Reached maximum iterations. The task may be partially completed.';
    }

    /**
     * Execute a predefined workflow (not free-form).
     * 
     * This is optimized for the common case: generate test for a single file.
     * Instead of letting the LLM decide which tools to call, we drive the loop
     * programmatically with optional LLM healing.
     */
    async executeGenerateAndHeal(
        sourceFilePath: string,
        workspaceRoot: string,
        stream: vscode.ChatResponseStream,
        mode: 'fast' | 'balanced' | 'thorough' = 'balanced'
    ): Promise<string> {
        const config = ConfigService.getConfig();
        const path = require('path');
        const fs = require('fs');
        const fileName = path.basename(sourceFilePath);
        const relativePath = path.relative(workspaceRoot, sourceFilePath);
        
        const context: ToolExecutionContext = {
            workspaceRoot,
            progress: (msg) => stream.progress(msg)
        };

        // Determine max healing attempts based on mode
        let maxAttempts: number;
        switch (mode) {
            case 'fast': maxAttempts = 0; break;
            case 'balanced': maxAttempts = 1; break;
            case 'thorough': maxAttempts = 3; break;
        }

        // Step 1: Read source file
        stream.progress('Reading source file...');
        const readResult = await this.toolRegistry.execute(
            { tool: 'read_file', parameters: { filePath: relativePath } },
            context
        );
        if (!readResult.success) {
            stream.markdown(`❌ Failed to read source file: ${readResult.error}\n`);
            return `Error: ${readResult.error}`;
        }
        const sourceCode = readResult.data as string;

        // Step 2: Collect context
        stream.progress('Collecting dependency context...');
        const contextResult = await this.toolRegistry.execute(
            { tool: 'collect_context', parameters: { filePath: relativePath } },
            context
        );
        const dependencyContext = contextResult.success ? (contextResult.data as string) : undefined;

        // Step 3: Generate test
        stream.progress('Generating test with AI...');
        const generateResult = await this.toolRegistry.execute(
            {
                tool: 'generate_test',
                parameters: {
                    sourceCode,
                    fileName,
                    dependencyContext
                }
            },
            context
        );
        if (!generateResult.success) {
            stream.markdown(`❌ Test generation failed: ${generateResult.error}\n`);
            return `Error: ${generateResult.error}`;
        }

        // Determine test file path
        const ext = path.extname(sourceFilePath);
        const baseName = path.basename(sourceFilePath, ext);
        const testFileName = `${baseName}.test${ext}`;
        const testRelativePath = path.join(path.dirname(relativePath), testFileName).replace(/\\/g, '/');

        // Step 4: Write test file
        const testCode = generateResult.data as string;
        await this.toolRegistry.execute(
            { tool: 'write_file', parameters: { filePath: testRelativePath, content: testCode } },
            context
        );
        stream.markdown(`✅ Generated test: \`${testRelativePath}\`\n\n`);

        // Fast mode: skip execution
        if (mode === 'fast') {
            stream.markdown(`⚡ **Fast mode**: Test generated without execution\n`);
            return testRelativePath;
        }

        // Step 5: Run test
        stream.progress('Running test...');
        let runResult = await this.toolRegistry.execute(
            { tool: 'run_test', parameters: { testFilePath: testRelativePath, jestCommand: config.jestCommand } },
            context
        );

        let testOutput = (runResult.data as any);
        let attempt = 0;

        // Step 6: Healing loop
        while (testOutput && !testOutput.success && attempt < maxAttempts) {
            attempt++;
            stream.markdown(`⚠️ Test failed. Healing attempt ${attempt}/${maxAttempts}...\n`);

            // Read current test code
            const currentTestResult = await this.toolRegistry.execute(
                { tool: 'read_file', parameters: { filePath: testRelativePath } },
                context
            );
            const currentTestCode = currentTestResult.success ? (currentTestResult.data as string) : testCode;

            // Fix test
            stream.progress(`Fixing test (attempt ${attempt})...`);
            const fixResult = await this.toolRegistry.execute(
                {
                    tool: 'fix_test',
                    parameters: {
                        sourceCode,
                        fileName,
                        currentTestCode,
                        errorOutput: testOutput.output || '',
                        dependencyContext,
                        attempt
                    }
                },
                context
            );

            if (!fixResult.success) {
                stream.markdown(`❌ Fix failed: ${fixResult.error}\n`);
                break;
            }

            // Write fixed test
            await this.toolRegistry.execute(
                { tool: 'write_file', parameters: { filePath: testRelativePath, content: fixResult.data as string } },
                context
            );

            // Re-run test
            stream.progress('Running test again...');
            runResult = await this.toolRegistry.execute(
                { tool: 'run_test', parameters: { testFilePath: testRelativePath, jestCommand: config.jestCommand } },
                context
            );
            testOutput = runResult.data as any;
        }

        // Final result
        if (testOutput?.success) {
            stream.markdown(`\n✅ **Test passed!** (${attempt > 0 ? `healed in ${attempt} attempt(s)` : 'first try'})\n`);
        } else {
            stream.markdown(`\n❌ **Test still failing after ${attempt} attempt(s)**\n`);
            if (testOutput?.output) {
                const truncated = testOutput.output.substring(0, 1500);
                stream.markdown(`\`\`\`\n${truncated}\n\`\`\`\n`);
            }
        }

        return testRelativePath;
    }

    /**
     * Build the system prompt including tool definitions
     */
    private buildSystemPrompt(): string {
        const toolsPrompt = this.toolRegistry.buildToolsPrompt();
        
        return `You are an expert test generation agent. You have access to tools that let you read files, analyze projects, generate tests, run tests, and fix failing tests.

Your workflow:
1. First, understand the request
2. Use available tools to gather information and execute actions
3. When done, signal completion with the DONE tool

Important rules:
- Always call ONE tool at a time
- Wait for the tool result before calling the next tool
- If a tool fails, try to recover or explain why
- Respond with JSON tool calls in code blocks

${toolsPrompt}`;
    }

    /**
     * Build the user prompt from conversation history
     */
    private buildConversationPrompt(
        history: Array<{ role: string; content: string }>
    ): string {
        return history.map(msg => {
            switch (msg.role) {
                case 'user': return `User: ${msg.content}`;
                case 'assistant': return `Assistant: ${msg.content}`;
                case 'tool': return `${msg.content}`;
                default: return msg.content;
            }
        }).join('\n\n');
    }

    /**
     * Send a message to the LLM using the existing provider infrastructure
     */
    private async sendToLLM(systemPrompt: string, userPrompt: string): Promise<LLMResult> {
        // Use the generateTest method with a custom context to get raw LLM output
        // This is a temporary bridge — in Phase 5 we'll add a direct sendRequest method
        return this.llmProvider.generateTest({
            sourceCode: userPrompt,
            fileName: 'orchestrator-request',
            systemPrompt
        });
    }
}
