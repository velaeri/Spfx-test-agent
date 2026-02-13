import * as vscode from 'vscode';
import { ILLMProvider, TestContext, LLMResult } from '../interfaces/ILLMProvider';
import { LLMNotAvailableError, LLMTimeoutError, RateLimitError } from '../errors/CustomErrors';
import { Logger } from '../services/Logger';

import { ConfigService } from '../services/ConfigService';
import { PROMPTS } from '../utils/prompts';

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
        // Treat empty string as undefined to avoid model selection issues
        this.family = (family && family.trim() !== '') ? family : '';
        this.timeoutMs = timeoutMs;
        
        // Log the configuration for debugging
        if (!this.family) {
            this.logger.info('CopilotProvider initialized without family filter - will use user\'s default model');
        } else {
            this.logger.info(`CopilotProvider initialized with family: ${this.family}`);
        }
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

        const systemPrompt = PROMPTS.SYSTEM;
        const userPrompt = PROMPTS.GENERATE_TEST(context.fileName, context.sourceCode);

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

        const systemPrompt = PROMPTS.SYSTEM;
        const attemptStr = `${context.attempt || 1}${context.maxAttempts ? `/${context.maxAttempts}` : ''}`;

        const errorContext = context.errorContext || '';
        const isSyntaxError = errorContext.includes('SyntaxError') || errorContext.includes('Unexpected token') || errorContext.includes('Missing semicolon');
        const isMockError = errorContext.includes('jest.mock') || errorContext.includes('@fluentui') || errorContext.includes('@microsoft') || errorContext.includes('vscode');

        let specificGuidance = '';
        if (isSyntaxError && isMockError) {
            specificGuidance = PROMPTS.FIX_SPECIFIC_GUIDANCE_MOCK_TYPES;
        }

        const userPrompt = PROMPTS.FIX_TEST(attemptStr, context.fileName, errorContext, specificGuidance, context.sourceCode);

        return await this.sendRequest(systemPrompt, userPrompt);
    }

    /**
     * Send a generic request to the LLM (public method for other services)
     */
    public async ask(systemPrompt: string, userPrompt: string): Promise<LLMResult> {
        return await this.sendRequest(systemPrompt, userPrompt);
    }

    /**
     * Analyze an error and suggest a fix using AI
     */
    public async analyzeAndFixError(
        error: string,
        projectContext: {
            packageJson: any;
            nodeVersion?: string;
            jestConfig?: string;
            errorType: 'dependency' | 'compilation' | 'execution';
        }
    ): Promise<{
        diagnosis: string;
        packages?: string[];
        commands?: string[];
        configChanges?: Record<string, any>;
    }> {
        const systemPrompt = `You are an expert in Node.js dependency management, TypeScript compilation, and Jest testing in SharePoint Framework (SPFx) projects.

Your task is to analyze errors and provide CONCRETE, ACTIONABLE solutions.

RULES:
1. Identify version conflicts between packages
2. Consider React version compatibility with testing libraries
3. Check Jest version compatibility with ts-jest and jest-environment-jsdom
4. For SPFx projects, respect the existing React version (usually 17.x or 18.x)
5. Return ONLY valid JSON in the specified format`;

        const deps = {
            ...projectContext.packageJson.dependencies || {},
            ...projectContext.packageJson.devDependencies || {}
        };

        const userPrompt = `**Error Type:** ${projectContext.errorType}

**Error Output:**
\`\`\`
${error}
\`\`\`

**Current Dependencies:**
\`\`\`json
${JSON.stringify(deps, null, 2)}
\`\`\`

${projectContext.nodeVersion ? `**Node Version:** ${projectContext.nodeVersion}\n` : ''}
${projectContext.jestConfig ? `**Jest Config:**\n\`\`\`javascript\n${projectContext.jestConfig}\n\`\`\`\n` : ''}

**Task:**
Analyze this error and provide a solution. Return ONLY a JSON object with this structure:
\`\`\`json
{
  "diagnosis": "Brief explanation of what's wrong",
  "packages": ["package1@version", "package2@version"],
  "commands": ["optional shell commands if needed"],
  "configChanges": { "optional": "config updates" }
}
\`\`\`

If no packages need installing, use empty array. If no commands needed, omit the field.`;

        try {
            const result = await this.sendRequest(systemPrompt, userPrompt);
            
            // Parse JSON from response
            const jsonMatch = result.code.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                this.logger.warn('LLM did not return valid JSON for error analysis');
                return {
                    diagnosis: 'Could not analyze error automatically',
                    packages: []
                };
            }

            const parsed = JSON.parse(jsonMatch[0]);
            return {
                diagnosis: parsed.diagnosis || 'Unknown issue',
                packages: parsed.packages || [],
                commands: parsed.commands,
                configChanges: parsed.configChanges
            };
        } catch (error) {
            this.logger.error('Failed to analyze error with LLM', error);
            return {
                diagnosis: 'Error analysis failed',
                packages: []
            };
        }
    }

    /**
     * Send a request to the LLM
     */
    private async sendRequest(systemPrompt: string, userPrompt: string): Promise<LLMResult> {
        // Get available models with intelligent fallback
        let models: readonly vscode.LanguageModelChat[] = [];
        
        if (this.family) {
            // Use specific model family if configured
            this.logger.info(`Requesting models with family: ${this.family}`);
            models = await vscode.lm.selectChatModels({
                vendor: this.vendor,
                family: this.family
            });
        }
        
        // If no models found with specified family, or no family specified, try GPT-4o
        if (models.length === 0) {
            this.logger.info('Trying GPT-4o as primary model...');
            models = await vscode.lm.selectChatModels({
                vendor: this.vendor,
                family: 'gpt-4o'
            });
        }
        
        // If still no models, try any GPT-4 model
        if (models.length === 0) {
            this.logger.info('Trying any GPT-4 model...');
            models = await vscode.lm.selectChatModels({
                vendor: this.vendor,
                family: 'gpt-4'
            });
        }
        
        // Last resort: get all models and filter out known problematic ones
        if (models.length === 0) {
            this.logger.info('Trying any available model, filtering problematic ones...');
            const allModels = await vscode.lm.selectChatModels({
                vendor: this.vendor
            });
            
            // Filter out Claude models that don't support extension API
            models = allModels.filter(model => {
                const isClaudeOpus = model.id.includes('claude-opus') || model.family.includes('claude-opus');
                if (isClaudeOpus) {
                    this.logger.warn(`Skipping unsupported model: ${model.id} (${model.name})`);
                    return false;
                }
                return true;
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

    /**
     * Detect missing dependencies based on package.json content
     */
    public async detectDependencies(packageJsonContent: any): Promise<Record<string, string>> {
        this.logger.info('Analyzing dependencies via Copilot...');

        const prompt = `Analyze this package.json and determine which Jest testing dependencies are missing or need to be installed.

**Current package.json dependencies:**
\`\`\`json
${JSON.stringify({
    dependencies: packageJsonContent.dependencies || {},
    devDependencies: packageJsonContent.devDependencies || {}
}, null, 2)}
\`\`\`

**Task:** 
1. Analyze the EXISTING dependencies to determine what Jest packages are already installed
2. Determine what ADDITIONAL packages (if any) are needed for a complete Jest + React Testing Library setup
3. For any missing packages, recommend versions that are COMPATIBLE with the existing dependencies

**Required packages for full Jest + React Testing Library:**
- jest
- @types/jest  
- ts-jest
- @testing-library/react
- @testing-library/jest-dom
- @testing-library/user-event
- react-test-renderer
- @types/react-test-renderer
- identity-obj-proxy

Return ONLY a JSON object mapping package names to their recommended version strings (e.g. {"jest": "^29.0.0"}). If everything is already installed, return an empty object {}. No markdown, no explanations outside the JSON block.`;

        try {
            const systemPrompt = "You are a dependency management assistant. You return only JSON.";
            const response = await this.sendRequest(systemPrompt, prompt);
            
            // Try to parse JSON from the response
            try {
                // Remove potential markdown code blocks
                const jsonStr = this.extractCodeFromMarkdown(response.code);
                this.logger.debug('Parsing LLM dependency response', { jsonStr });
                const versions = JSON.parse(jsonStr);
                return versions;
            } catch (parseError) {
                this.logger.error('Failed to parse LLM dependency JSON', parseError);
                return {};
            }
        } catch (error) {
            this.logger.error('LLM dependency detection failed', error);
            return {};
        }
    }
}
