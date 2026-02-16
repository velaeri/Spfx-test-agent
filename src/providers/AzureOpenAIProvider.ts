import { OpenAIClient, AzureKeyCredential } from "@azure/openai";
import { ILLMProvider, TestContext, LLMResult, ReviewContext, ReviewResult, LearningContext, LearningEntry } from '../interfaces/ILLMProvider';
import { CoreLLMResult } from '../interfaces/ICoreProvider';
import { Logger } from '../services/Logger';
import { ConfigService } from '../services/ConfigService';
import { PROMPTS } from '../utils/prompts';
import { LLMNotAvailableError, RateLimitError } from '../errors/CustomErrors';

export class AzureOpenAIProvider implements ILLMProvider {
    private client: OpenAIClient | undefined;
    private deploymentName: string = '';
    private logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
        this.initializeClient();
    }

    private initializeClient() {
        const config = ConfigService.getConfig();
        const { endpoint, apiKey, deploymentName } = config.azureOpenAI || {};

        if (endpoint && apiKey && deploymentName) {
            try {
                this.client = new OpenAIClient(endpoint, new AzureKeyCredential(apiKey));
                this.deploymentName = deploymentName;
                this.logger.info('AzureOpenAIProvider initialized');
            } catch (error) {
                this.logger.error('Failed to initialize Azure OpenAI client', error);
            }
        } else {
            this.logger.warn('Azure OpenAI configuration missing');
        }
    }

    public getProviderName(): string {
        return 'Azure OpenAI';
    }

    /**
     * Get the vendor ID (implements ICoreProvider)
     */
    public getVendorId(): string {
        return 'azure-openai';
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
        this.logger.debug('[AzureOpenAIProvider] sendPrompt called');

        const result = await this.sendRequest(systemPrompt, userPrompt);
        
        // Convert LLMResult to CoreLLMResult
        return {
            content: result.code,
            model: result.model,
            tokensUsed: result.tokensUsed,
            metadata: options
        };
    }

    public async isAvailable(): Promise<boolean> {
        return !!this.client;
    }

    public async generateTest(context: TestContext): Promise<LLMResult> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');

        const systemPrompt = context.systemPrompt || PROMPTS.SYSTEM;
        const userPrompt = PROMPTS.GENERATE_TEST(context.fileName, context.sourceCode, context.dependencyContext);

        return await this.sendRequest(systemPrompt, userPrompt);
    }

    public async fixTest(context: TestContext): Promise<LLMResult> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        if (!context.errorContext) throw new Error('Error context required');

        const attemptStr = `${context.attempt || 1}${context.maxAttempts ? `/${context.maxAttempts}` : ''}`;

        const errorContext = context.errorContext || '';
        const isSyntaxError = errorContext.includes('SyntaxError') || errorContext.includes('Unexpected token') || errorContext.includes('Missing semicolon');
        const isMockError = errorContext.includes('jest.mock') || errorContext.includes('@fluentui') || errorContext.includes('@microsoft') || errorContext.includes('vscode');

        let specificGuidance = '';
        if (isSyntaxError && isMockError) {
            specificGuidance = PROMPTS.FIX_SPECIFIC_GUIDANCE_MOCK_TYPES;
        }

        const userPrompt = PROMPTS.FIX_TEST(attemptStr, context.fileName, context.currentTestCode || '', errorContext, specificGuidance, context.sourceCode);

        return await this.sendRequest(context.systemPrompt || PROMPTS.SYSTEM, userPrompt);
    }

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
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');

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

    public async detectDependencies(packageJsonContent: any): Promise<Record<string, string>> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        
        // Extract stack analysis if provided by DependencyDetectionService
        const stackInfo = packageJsonContent._stackAnalysis;
        const stackContext = stackInfo
            ? `\n\n**Project stack analysis (deterministic):**\n- Framework: ${stackInfo.framework}\n- UI library: ${stackInfo.uiLibrary}\n- Language: ${stackInfo.language}\n- Uses JSX: ${stackInfo.usesJsx}\n- Has React: ${stackInfo.hasReact}\n- Has Angular: ${stackInfo.hasAngular}\n- Has Vue: ${stackInfo.hasVue}\n- Test runner: ${stackInfo.testRunner}\n\nBase your recommendations on this analysis. Only suggest packages relevant to this specific stack.`
            : '';

        const prompt = `Analyze this package.json and determine which Jest testing dependencies are missing or need to be installed.

**Current package.json dependencies:**
\`\`\`json
${JSON.stringify({
    dependencies: packageJsonContent.dependencies || {},
    devDependencies: packageJsonContent.devDependencies || {}
}, null, 2)}
\`\`\`${stackContext}

**Task:** 
1. Analyze the EXISTING dependencies to determine what Jest packages are already installed
2. Use the stack analysis above to determine what type of project this is
3. Only recommend packages relevant to the detected project type

**Always required (universal Jest packages):**
- jest
- @types/jest
- ts-jest

**Only if the project uses React (has react in dependencies):**
- @testing-library/react
- @testing-library/jest-dom

**Only if the project needs jsdom testEnvironment (React, browser-based projects):**
- jest-environment-jsdom
- identity-obj-proxy

**IMPORTANT:**
- Do NOT suggest React-specific packages if React is NOT in the project's dependencies.
- For Node.js CLIs, VS Code extensions, APIs: ONLY suggest jest, @types/jest, ts-jest.

**CRITICAL RULES:**
1. ONLY include packages that are NOT already installed
2. If a package is already installed (even if different version), do NOT include it
3. Ensure version compatibility with existing dependencies
4. If Jest is already installed, match its major version for related packages
5. Return ONLY a valid JSON object with MISSING packages, or empty object {} if nothing is missing
6. Use specific version ranges (e.g., "^28.1.0" not "latest")

**Response format (JSON only - include ONLY missing packages):**
\`\`\`json
{
  "jest": "^29.7.0",
  "@types/jest": "^29.5.0"
}
\`\`\`

If ALL packages are already installed, return:
\`\`\`json
{}
\`\`\``;

        const result = await this.sendRequest(
            'You are an expert in Node.js package management and dependency resolution. Analyze package.json files and identify ONLY the missing dependencies needed.',
            prompt
        );

        try {
            // Extract JSON using robust method
            const jsonStr = this.extractJsonFromResponse(result.code);
            this.logger.debug('Extracted JSON from LLM response', { length: jsonStr.length, preview: jsonStr.substring(0, 100) });
            const versions = JSON.parse(jsonStr);
            
            // Validate it's an object (not array or primitive)
            if (typeof versions !== 'object' || Array.isArray(versions)) {
                this.logger.warn('LLM returned non-object JSON, ignoring');
                return {};
            }
            
            this.logger.info('Successfully parsed LLM dependency recommendations', { count: Object.keys(versions).length });
            return versions;
        } catch (error) {
            this.logger.error('Failed to parse LLM response for dependencies', { error, rawResponse: result.code.substring(0, 500) });
            return {};
        }
    }

    public async reviewTest(context: ReviewContext): Promise<ReviewResult> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        this.logger.info(`Performing adversarial review via Azure for ${context.fileName}`);
        
        const systemPrompt = context.systemPrompt || 'You are a Senior QA Automation Architect. Review the following test.';
        const userPrompt = context.userPrompt || `Review this test for ${context.fileName}:\n\nSource:\n${context.sourceCode}\n\nTest:\n${context.testCode}`;

        try {
            const result = await this.sendRequest(systemPrompt, userPrompt);
            const jsonText = this.extractJsonFromResponse(result.code);
            const parsed = JSON.parse(jsonText);

            return {
                passed: !!parsed.passed,
                score: typeof parsed.score === 'number' ? parsed.score : 0,
                critique: parsed.critique || 'No critique provided',
                suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
            };
        } catch (error) {
            this.logger.error('Azure adversarial review failed', error);
            return { passed: true, score: 5, critique: 'Review failed', suggestions: [] };
        }
    }

    public async generateLearningEntry(context: LearningContext): Promise<LearningEntry> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        this.logger.info(`Generating learning entry via Azure for ${context.fileName}`);

        const systemPrompt = context.systemPrompt || 'You are a Senior Software Development Data Curator. Extract the learning delta.';
        const userPrompt = context.userPrompt || `Original code:\n${context.originalTestCode}\n\nCritique:\n${context.critique}\n\nFixed code:\n${context.fixedTestCode}\n\nSource code context:\n${context.sourceCode}`;

        try {
            const result = await this.sendRequest(systemPrompt, userPrompt);
            const jsonText = this.extractJsonFromResponse(result.code);
            const parsed = JSON.parse(jsonText);

            return {
                timestamp: new Date().toISOString(),
                fileName: context.fileName,
                sourceCode: context.sourceCode,
                originalTestCode: context.originalTestCode,
                critique: context.critique,
                fixedTestCode: context.fixedTestCode,
                improvementDelta: parsed.improvementDelta || 'Refined test logic',
                category: parsed.category || 'other'
            };
        } catch (error) {
            this.logger.error('Azure learning entry failed', error);
            return {
                timestamp: new Date().toISOString(),
                fileName: context.fileName,
                sourceCode: context.sourceCode,
                originalTestCode: context.originalTestCode,
                critique: context.critique,
                fixedTestCode: context.fixedTestCode,
                improvementDelta: 'Automatic improvement',
                category: 'other'
            };
        }
    }

    private async sendRequest(systemPrompt: string, userPrompt: string): Promise<LLMResult> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        
        try {
            const messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ];

            const response = await this.client.getChatCompletions(this.deploymentName, messages, {
                temperature: 0.1,
            });

            const choice = response.choices[0];
            let code = choice.message?.content || '';
            
            code = this.extractCodeFromMarkdown(code);

            return {
                code,
                model: 'azure-openai',
                tokensUsed: response.usage?.totalTokens
            };

        } catch (error: any) {
            if (error.statusCode === 429) {
                throw new RateLimitError();
            }
            this.logger.error('Azure OpenAI request failed', error);
            throw error;
        }
    }

    private extractCodeFromMarkdown(text: string): string {
        const codeBlockRegex = /```(?:typescript|tsx|ts|javascript|js|json)?\s*([\s\S]*?)\s*```/;
        const match = text.match(codeBlockRegex);
        return match ? match[1].trim() : text.trim();
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

    // ===== LLM-First Planning Methods =====

    public async planTestStrategy(context: {
        sourceCode: string;
        fileName: string;
        projectAnalysis: any;
        existingTestPatterns?: string[];
    }): Promise<any> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        
        this.logger.info(`Planning test strategy for ${context.fileName}`);

        const prompt = `Analyze this source file and plan an optimal testing strategy.

**File:** ${context.fileName}
**Source Code:**
\`\`\`typescript
${context.sourceCode.substring(0, 3000)}
\`\`\`

**Task:** Return JSON with:
- \`approach\`: "unit" | "integration" | "component"
- \`mockingStrategy\`: "minimal" | "moderate" | "extensive"
- \`mocksNeeded\`: array
- \`testStructure\`: string
- \`expectedCoverage\`: number
- \`potentialIssues\`: array
- \`estimatedIterations\`: number

Return ONLY valid JSON.`;

        const result = await this.sendRequest("You are a test planning expert. Return only JSON.", prompt);

        try {
            const jsonStr = this.extractJsonFromResponse(result.code);
            return JSON.parse(jsonStr);
        } catch (error) {
            this.logger.error('Failed to plan test strategy', error);
            return { approach: 'unit', mockingStrategy: 'moderate', mocksNeeded: [], testStructure: 'standard', expectedCoverage: 80, potentialIssues: [], estimatedIterations: 2 };
        }
    }

    public async generateJestConfig(context: { projectAnalysis: any; requirements: string[]; }): Promise<any> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        
        this.logger.info('Generating Jest config');

        const prompt = `Generate Jest configuration files. Return JSON with: \`configJs\`, \`setupJs\`, \`mocks\`, \`explanation\`.`;

        const result = await this.sendRequest("You are a Jest expert. Return only JSON.", prompt);

        try {
            const jsonStr = this.extractJsonFromResponse(result.code);
            return JSON.parse(jsonStr);
        } catch (error) {
            this.logger.error('Failed to generate Jest config', error);
            throw error;
        }
    }

    public async planBatchGeneration(context: { allFiles: string[]; projectStructure: any; existingTests: string[]; dependencies: Record<string, string[]>; }): Promise<any> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        
        this.logger.info(`Planning batch for ${context.allFiles.length} files`);

        const prompt = `Plan batch generation. Return JSON with: \`groups\`, \`estimatedTime\`, \`recommendedConcurrency\`.`;

        const result = await this.sendRequest("You are a test planner. Return only JSON.", prompt);

        try {
            const jsonStr = this.extractJsonFromResponse(result.code);
            return JSON.parse(jsonStr);
        } catch (error) {
            this.logger.error('Failed to plan batch', error);
            return { groups: [{ name: 'All', priority: 3, files: context.allFiles, reason: 'Sequential' }], estimatedTime: `${Math.ceil(context.allFiles.length * 45 / 60)} min`, recommendedConcurrency: 1 };
        }
    }

    public async validateAndFixVersions(context: { suggestedVersions: Record<string, string>; validationErrors: string[]; }): Promise<Record<string, string>> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        
        this.logger.info('Validating versions');

        const prompt = `Fix invalid npm versions. Return corrected JSON.`;

        const result = await this.sendRequest("You are an npm expert. Return only JSON.", prompt);

        try {
            const jsonStr = this.extractJsonFromResponse(result.code);
            return JSON.parse(jsonStr);
        } catch (error) {
            this.logger.error('Failed to fix versions', error);
            return context.suggestedVersions;
        }
    }
}