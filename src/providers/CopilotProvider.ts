import * as vscode from 'vscode';
import { ILLMProvider, TestContext, LLMResult } from '../interfaces/ILLMProvider';
import { CoreLLMResult } from '../interfaces/ICoreProvider';
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
     * Get the vendor ID (implements ICoreProvider)
     */
    public getVendorId(): string {
        return this.vendor;
    }

    /**
     * Generic prompt sending method (implements ICoreProvider)
     * This is the core interface for all LLM interactions in the new architecture
     */
    public async sendPrompt(
        systemPrompt: string, 
        userPrompt: string, 
        options?: any
    ): Promise<CoreLLMResult> {
        this.logger.debug('[CopilotProvider] sendPrompt called');

        const result = await this.sendRequest(systemPrompt, userPrompt);
        
        // Convert LLMResult to CoreLLMResult
        return {
            content: result.code,
            model: result.model,
            tokensUsed: result.tokensUsed,
            metadata: options
        };
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

        const systemPrompt = context.systemPrompt || PROMPTS.SYSTEM;
        const userPrompt = PROMPTS.GENERATE_TEST(context.fileName, context.sourceCode, context.dependencyContext);

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

        const systemPrompt = context.systemPrompt || PROMPTS.SYSTEM;
        const attemptStr = `${context.attempt || 1}${context.maxAttempts ? `/${context.maxAttempts}` : ''}`;

        const errorContext = context.errorContext || '';
        const isSyntaxError = errorContext.includes('SyntaxError') || errorContext.includes('Unexpected token') || errorContext.includes('Missing semicolon');
        const isMockError = errorContext.includes('jest.mock') || errorContext.includes('@fluentui') || errorContext.includes('@microsoft') || errorContext.includes('vscode');

        let specificGuidance = '';
        if (isSyntaxError && isMockError) {
            specificGuidance = PROMPTS.FIX_SPECIFIC_GUIDANCE_MOCK_TYPES;
        }

        const userPrompt = PROMPTS.FIX_TEST(attemptStr, context.fileName, context.currentTestCode || '', errorContext, specificGuidance, context.sourceCode);

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
        const systemPrompt = `You are an expert in Node.js dependency management, TypeScript compilation, and Jest testing.

Your task is to analyze errors and provide CONCRETE, ACTIONABLE solutions.

Return ONLY valid JSON in the specified format - no markdown, no explanations outside the JSON.`;

        const deps = {
            ...projectContext.packageJson.dependencies || {},
            ...projectContext.packageJson.devDependencies || {}
        };

        const userPrompt = PROMPTS.ANALYZE_ERROR(
            error,
            projectContext.errorType,
            deps,
            projectContext.nodeVersion,
            projectContext.jestConfig
        );

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
        // Look for code blocks with typescript, tsx, ts, javascript, or json
        const codeBlockRegex = /```(?:typescript|tsx|ts|javascript|js|json)?\s*([\s\S]*?)\s*```/;
        const match = text.match(codeBlockRegex);

        if (match) {
            return match[1].trim();
        }

        // If no code block found, return as-is (LLM might have returned raw code)
        return text.trim();
    }

    /**
     * Extract JSON from LLM response (more robust for mixed text + JSON)
     */
    private extractJsonFromResponse(text: string): string {
        // First, try to find JSON in markdown code blocks
        const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
        const blockMatch = text.match(jsonBlockRegex);
        if (blockMatch) {
            return blockMatch[1].trim();
        }

        // If no code block, look for raw JSON (find first { to last })
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return jsonMatch[0].trim();
        }

        // Fallback: return as-is and let JSON.parse fail with better error
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
     * Supports retry with feedback from previous failed attempts
     */
    public async detectDependencies(
        packageJsonContent: any,
        previousAttempt?: { error: string; attemptNumber: number }
    ): Promise<Record<string, string>> {
        this.logger.info('Analyzing dependencies via Copilot...');

        let retryGuidance = '';
        if (previousAttempt) {
            retryGuidance = `\n\n🚨 **PREVIOUS ATTEMPT ${previousAttempt.attemptNumber} FAILED:**
\`\`\`
${previousAttempt.error}
\`\`\`

**This means npm could not find those versions. You MUST:**
- Suggest DIFFERENT versions that ACTUALLY exist in npm
- Use "latest" if uncertain about specific version numbers
- Ensure Jest ecosystem compatibility`;
        }

        // Extract stack analysis if provided by DependencyDetectionService
        const stackInfo = packageJsonContent._stackAnalysis;
        const stackContext = stackInfo
            ? `\n\n**Project stack analysis (deterministic):**\n- Framework: ${stackInfo.framework}\n- UI library: ${stackInfo.uiLibrary}\n- Language: ${stackInfo.language}\n- Uses JSX: ${stackInfo.usesJsx}\n- Has React: ${stackInfo.hasReact}\n- Has Angular: ${stackInfo.hasAngular}\n- Has Vue: ${stackInfo.hasVue}\n- Test runner: ${stackInfo.testRunner}\n\nBase your recommendations on this analysis. Only suggest packages relevant to this specific stack.`
            : '';

        const prompt = `🔍 Detect missing Jest dependencies with VALID npm versions

**package.json:**
\`\`\`json
${JSON.stringify({
    dependencies: packageJsonContent.dependencies || {},
    devDependencies: packageJsonContent.devDependencies || {}
}, null, 2)}
\`\`\`${stackContext}${retryGuidance}

**CRITICAL RULES:**
❌ DO NOT suggest fictional versions
✅ USE "latest" if uncertain
✅ Ensure jest@29.x → ts-jest@29.x, @types/jest@29.x alignment
✅ Use caret ranges (^) for flexibility
✅ ONLY suggest packages relevant to the detected project type

**Always required (universal Jest packages):**
jest, @types/jest, ts-jest

**Only if the project uses jsdom testEnvironment (React, browser-based UI projects):**
jest-environment-jsdom, identity-obj-proxy

**Only if the project has React as a dependency:**
@testing-library/react, @testing-library/jest-dom

**IMPORTANT:** Analyze the ACTUAL dependencies and stack analysis above.
- If there is NO React dependency, do NOT suggest @testing-library/react, react-test-renderer, etc.
- If there is NO browser/DOM need, do NOT suggest jest-environment-jsdom.
- For Node.js CLIs, VS Code extensions, APIs: ONLY suggest jest, @types/jest, ts-jest.
- Only suggest packages that are actually needed and NOT already installed.

**CRITICAL VERSION ALIGNMENT:**
- jest-environment-jsdom version MUST match Jest major version (jest@29 → jest-environment-jsdom@29)

**Return ONLY JSON:**
\`\`\`json
{"package": "^X.Y.Z" or "latest"}
\`\`\`

If all installed, return: \`{}\``;

        try {
            const systemPrompt = "You are a dependency management assistant. You return only JSON with valid npm versions.";
            const response = await this.sendRequest(systemPrompt, prompt);
            
            // Try to parse JSON from the response
            try {
                // Extract JSON using robust method
                const jsonStr = this.extractJsonFromResponse(response.code);
                this.logger.debug('Extracted JSON from LLM response', { length: jsonStr.length, preview: jsonStr.substring(0, 100) });
                const versions = JSON.parse(jsonStr);
                
                // Validate it's an object (not array or primitive)
                if (typeof versions !== 'object' || Array.isArray(versions)) {
                    this.logger.warn('LLM returned non-object JSON, ignoring');
                    return {};
                }
                
                this.logger.info('Successfully parsed LLM dependency recommendations', { count: Object.keys(versions).length });
                return versions;
            } catch (parseError) {
                this.logger.error('Failed to parse LLM dependency JSON', { error: parseError, rawResponse: response.code.substring(0, 500) });
                return {};
            }
        } catch (error) {
            this.logger.error('LLM dependency detection failed', error);
            return {};
        }
    }

    // ===== LLM-First Planning Methods =====

    /**
     * Plan test strategy by analyzing source code and project context
     */
    public async planTestStrategy(context: {
        sourceCode: string;
        fileName: string;
        projectAnalysis: any;
        existingTestPatterns?: string[];
    }): Promise<any> {
        this.logger.info(`Planning test strategy for ${context.fileName}`);

        const prompt = PROMPTS.PLAN_TEST_STRATEGY(
            context.sourceCode,
            context.fileName,
            context.projectAnalysis,
            context.existingTestPatterns
        );

        try {
            const response = await this.sendRequest(
                "You are a test planning expert. You return only JSON.",
                prompt
            );
            const jsonStr = this.extractJsonFromResponse(response.code);
            return JSON.parse(jsonStr);
        } catch (error) {
            this.logger.error('Failed to plan test strategy', error);
            // Return default strategy
            return {
                approach: 'unit',
                mockingStrategy: 'moderate',
                mocksNeeded: [],
                testStructure: 'standard describe/it structure',
                expectedCoverage: 80,
                potentialIssues: [],
                estimatedIterations: 2
            };
        }
    }

    /**
     * Generate personalized Jest configuration
     */
    public async generateJestConfig(context: {
        projectAnalysis: any;
        requirements: string[];
    }): Promise<any> {
        this.logger.info('Generating personalized Jest config');

        const prompt = PROMPTS.GENERATE_JEST_CONFIG(
            context.projectAnalysis,
            context.requirements
        );

        try {
            const response = await this.sendRequest(
                "You are a Jest configuration expert. Return only JSON.",
                prompt
            );
            const jsonStr = this.extractJsonFromResponse(response.code);
            return JSON.parse(jsonStr);
        } catch (error) {
            this.logger.error('Failed to generate Jest config', error);
            throw error;
        }
    }

    /**
     * Plan batch test generation with intelligent prioritization
     */
    public async planBatchGeneration(context: {
        allFiles: string[];
        projectStructure: any;
        existingTests: string[];
        dependencies: Record<string, string[]>;
    }): Promise<any> {
        this.logger.info(`Planning batch generation for ${context.allFiles.length} files`);

        const prompt = PROMPTS.PLAN_BATCH_GENERATION(
            context.allFiles,
            context.projectStructure,
            context.existingTests,
            context.dependencies
        );

        try {
            const response = await this.sendRequest(
                "You are a test planning expert. Return only JSON.",
                prompt
            );
            const jsonStr = this.extractJsonFromResponse(response.code);
            return JSON.parse(jsonStr);
        } catch (error) {
            this.logger.error('Failed to plan batch generation', error);
            // Return simple sequential plan
            return {
                groups: [{
                    name: 'All Files',
                    priority: 3,
                    files: context.allFiles,
                    reason: 'Sequential processing'
                }],
                estimatedTime: `${Math.ceil(context.allFiles.length * 45 / 60)} minutes`,
                recommendedConcurrency: 1
            };
        }
    }

    /**
     * Validate suggested versions and fix if needed
     */
    public async validateAndFixVersions(context: {
        suggestedVersions: Record<string, string>;
        validationErrors: string[];
    }): Promise<Record<string, string>> {
        this.logger.info('Validating and fixing package versions with LLM reasoning');

        const prompt = `🔍 CRITICAL TASK: Fix npm package versions that don't exist in registry

**Context:**
- You suggested versions that npm cannot find
- You MUST provide versions that ACTUALLY EXIST in npm registry
- DO NOT guess or make up version numbers

**Your previous suggestions (INVALID):**
\`\`\`json
${JSON.stringify(context.suggestedVersions, null, 2)}
\`\`\`

**Validation errors from npm:**
${context.validationErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

---

**ANALYSIS REQUIRED:**

For each failed package, you must:
1. **Identify the issue**: Why did npm reject this version?
   - Does the package name exist? (typo check)
   - Is the version number format correct?
   - Is that specific version published?

2. **Research alternatives**:
   - For Jest packages: Check recent stable versions (29.x, 28.x)
   - For @types packages: Must match runtime package major version
   - For testing-library: Check latest stable (14.x, 15.x)
   - For identity-obj-proxy: Simple package, use latest

3. **Select VALID version**:
   - Prefer stable releases (not beta/alpha)
   - Use semantic versioning (^X.Y.Z)
   - Ensure compatibility with other packages in the set

**REASONING PROCESS:**

Example analysis:
\`\`\`
Package: jest@29.7.0
Issue: Version 29.7.0 doesn't exist (typo? actual is 29.7.1)
Research: Latest Jest 29.x is 29.7.1, 28.x is 28.1.3
Decision: Use jest@^29.7.0 (caret allows patch versions)
Alternative: Use jest@latest for most recent stable
\`\`\`

**OUTPUT FORMAT:**

Return ONLY a JSON object with CORRECTED versions:
\`\`\`json
{
  "package-name": "^X.Y.Z",
  "another-package": "latest"
}
\`\`\`

**IMPORTANT:**
- Use "latest" if you're uncertain (npm will resolve to newest stable)
- Use caret (^) for flexibility (^29.0.0 allows 29.x.x)
- Double-check Jest ecosystem compatibility (jest, ts-jest, @types/jest)
- NO fictional versions - every version MUST exist in npm

**Start your analysis and provide corrected versions:**`;

        try {
            const response = await this.sendRequest(
                "You are an expert npm package maintainer. Analyze validation errors and provide ONLY versions that exist in npm registry. Reason through each package carefully.",
                prompt
            );
            
            const jsonStr = this.extractJsonFromResponse(response.code);
            const fixed = JSON.parse(jsonStr);
            
            this.logger.info('LLM provided fixed versions', { 
                original: Object.keys(context.suggestedVersions).length,
                fixed: Object.keys(fixed).length
            });
            
            return fixed;
        } catch (error) {
            this.logger.error('Failed to fix versions with LLM', error);
            // Fallback: Use "latest" for all packages
            this.logger.warn('Falling back to "latest" for all packages');
            const fallback: Record<string, string> = {};
            for (const pkg of Object.keys(context.suggestedVersions)) {
                fallback[pkg] = 'latest';
            }
            return fallback;
        }
    }
}
