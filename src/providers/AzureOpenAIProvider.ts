import { OpenAIClient, AzureKeyCredential } from "@azure/openai";
import { ILLMProvider, TestContext, LLMResult } from '../interfaces/ILLMProvider';
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

    public async isAvailable(): Promise<boolean> {
        return !!this.client;
    }

    public async generateTest(context: TestContext): Promise<LLMResult> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');

        const systemPrompt = PROMPTS.SYSTEM;
        const userPrompt = PROMPTS.GENERATE_TEST(
            context.fileName, 
            context.sourceCode,
            context.dependencyContext || ''
        );

        return await this.sendRequest(systemPrompt, userPrompt);
    }

    public async fixTest(context: TestContext): Promise<LLMResult> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        if (!context.errorContext) throw new Error('Error context required');

        const attemptStr = `${context.attempt || 1}${context.maxAttempts ? `/${context.maxAttempts}` : ''}`;

        const userPrompt = PROMPTS.FIX_TEST(
            attemptStr, 
            context.fileName, 
            context.currentTestCode || '',
            context.errorContext,
            context.sourceCode,
            context.dependencyContext || '',
            context.environmentHints || ''
        );

        return await this.sendRequest(PROMPTS.SYSTEM, userPrompt);
    }

    public async detectDependencies(packageJsonContent: any): Promise<Record<string, string>> {
        if (!this.client) throw new LLMNotAvailableError('Azure OpenAI', 'GPT');
        
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

**CRITICAL RULES:**
1. ONLY include packages that are NOT already installed
2. If a package is already installed (even if different version), do NOT include it in the response
3. Ensure version compatibility with existing React version and other dependencies
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
            const jsonMatch = result.code.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                this.logger.warn('LLM did not return valid JSON', { response: result.code.substring(0, 200) });
                return {};
            }
            return JSON.parse(jsonMatch[0]);
        } catch (error) {
            this.logger.error('Failed to parse LLM response for dependencies', error);
            return {};
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
        const codeBlockRegex = /```(?:typescript|tsx|ts|javascript|js)?\s*([\s\S]*?)\s*```/;
        const match = text.match(codeBlockRegex);
        return match ? match[1].trim() : text.trim();
    }
}