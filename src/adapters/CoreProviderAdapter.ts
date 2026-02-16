import { ICoreProvider, CoreLLMResult } from '../interfaces/ICoreProvider';
import { 
    ILLMProvider, 
    LLMResult, 
    TestContext, 
    ProjectAnalysis, 
    TestStrategy,
    GeneratedJestConfig,
    BatchGenerationPlan,
    ReviewContext,
    ReviewResult,
    LearningContext,
    LearningEntry
} from '../interfaces/ILLMProvider';
import { PROMPTS } from '../utils/prompts';
import { Logger } from '../services/Logger';

/**
 * Adapter that bridges ICoreProvider (minimal generic interface) to ILLMProvider (testing-specific interface)
 * 
 * This allows TestAgent and other testing components to work with the new capability-based architecture
 * while maintaining backward compatibility.
 * 
 * **Migration Strategy:**
 * - Phase 1: Use this adapter to wrap ICoreProvider for TestGenerationCapability
 * - Phase 2: Gradually refactor components to use ICoreProvider directly
 * - Phase 3: Deprecate ILLMProvider once migration is complete
 */
export class CoreProviderAdapter implements ILLMProvider {
    private logger = Logger.getInstance();

    constructor(private coreProvider: ICoreProvider) {}

    /**
     * Generate a test file for the given source code
     */
    async generateTest(context: TestContext): Promise<LLMResult> {
        this.logger.debug('[CoreProviderAdapter] generateTest called', { fileName: context.fileName });

        const systemPrompt = context.systemPrompt || PROMPTS.SYSTEM;
        const userPrompt = PROMPTS.GENERATE_TEST(
            context.fileName,
            context.sourceCode,
            context.dependencyContext
        );

        const result = await this.coreProvider.sendPrompt(systemPrompt, userPrompt);
        
        return {
            code: result.content,
            model: result.model,
            tokensUsed: result.tokensUsed
        };
    }

    /**
     * Fix a failing test based on error output
     */
    async fixTest(context: TestContext): Promise<LLMResult> {
        this.logger.debug('[CoreProviderAdapter] fixTest called', { 
            fileName: context.fileName,
            attempt: context.attempt 
        });

        if (!context.currentTestCode) {
            throw new Error('currentTestCode is required for fixTest');
        }

        const attemptStr = `${context.attempt || 1}${context.maxAttempts ? `/${context.maxAttempts}` : ''}`;
        const errorContext = context.errorContext || '';
        
        // Check for specific error types
        const isSyntaxError = errorContext.includes('SyntaxError') || 
                            errorContext.includes('Unexpected token') || 
                            errorContext.includes('Missing semicolon');
        const isMockError = errorContext.includes('jest.mock') || 
                          errorContext.includes('@fluentui') || 
                          errorContext.includes('@microsoft') || 
                          errorContext.includes('vscode');

        let specificGuidance = '';
        if (isSyntaxError && isMockError) {
            specificGuidance = PROMPTS.FIX_SPECIFIC_GUIDANCE_MOCK_TYPES || '';
        }

        const systemPrompt = context.systemPrompt || PROMPTS.SYSTEM;
        const userPrompt = PROMPTS.FIX_TEST(
            attemptStr,
            context.fileName,
            context.currentTestCode,
            context.errorContext || '',
            specificGuidance,
            context.sourceCode
        );

        const result = await this.coreProvider.sendPrompt(systemPrompt, userPrompt);
        
        return {
            code: result.content,
            model: result.model,
            tokensUsed: result.tokensUsed
        };
    }

    /**
     * Check if the provider is available
     */
    async isAvailable(): Promise<boolean> {
        return this.coreProvider.isAvailable();
    }

    /**
     * Get the provider name
     */
    getProviderName(): string {
        return this.coreProvider.getProviderName();
    }

    /**
     * Get the vendor ID
     */
    getVendorId(): string {
        return this.coreProvider.getVendorId();
    }

    /**
     * Delegate sendPrompt to core provider
     */
    async sendPrompt(
        systemPrompt: string, 
        userPrompt: string, 
        options?: any
    ): Promise<CoreLLMResult> {
        return this.coreProvider.sendPrompt(systemPrompt, userPrompt, options);
    }

    /**
     * Detect missing dependencies based on package.json content
     */
    async detectDependencies(
        packageJsonContent: any,
        previousAttempt?: { error: string; attemptNumber: number }
    ): Promise<Record<string, string>> {
        this.logger.debug('[CoreProviderAdapter] detectDependencies called');

        const systemPrompt = `You are an expert in Node.js package management and Jest testing dependencies.
Analyze a package.json and suggest missing testing dependencies with exact version numbers.
Return ONLY valid JSON with package names as keys and version strings as values.`;

        const previousAttemptInfo = previousAttempt 
            ? `\n\nPREVIOUS ATTEMPT ${previousAttempt.attemptNumber} FAILED WITH:\n${previousAttempt.error}\n\nProvide ALTERNATIVE versions to fix this.`
            : '';

        const userPrompt = `Analyze this package.json and suggest missing Jest testing dependencies:

\`\`\`json
${JSON.stringify(packageJsonContent, null, 2)}
\`\`\`${previousAttemptInfo}

Required dependencies for Jest testing (if missing):
- jest
- ts-jest (for TypeScript)
- @types/jest
- jest-environment-jsdom (for React/DOM testing)
- @testing-library/react (for React components)
- @testing-library/jest-dom
- @testing-library/user-event

Return ONLY a JSON object with missing packages and their compatible versions:
\`\`\`json
{
  "jest": "^29.0.0",
  "ts-jest": "^29.0.0"
}
\`\`\``;

        const result = await this.coreProvider.sendPrompt(systemPrompt, userPrompt);
        
        try {
            // Parse LLM response - should be JSON object with package names and versions
            const parsed = JSON.parse(result.content);
            return parsed;
        } catch (error) {
            this.logger.error('[CoreProviderAdapter] Failed to parse dependency detection result', error);
            return {};
        }
    }

    /**
     * Analyze an error and suggest a fix
     */
    async analyzeAndFixError(
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
        this.logger.debug('[CoreProviderAdapter] analyzeAndFixError called', { 
            errorType: projectContext.errorType 
        });

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

        const result = await this.coreProvider.sendPrompt(systemPrompt, userPrompt);
        
        try {
            const parsed = JSON.parse(result.content);
            return parsed;
        } catch (parseError) {
            this.logger.error('[CoreProviderAdapter] Failed to parse error analysis result', parseError);
            // Return fallback response
            return {
                diagnosis: result.content,
                packages: [],
                commands: []
            };
        }
    }

    /**
     * Analyze project and plan test generation strategy
     */
    async planTestStrategy(context: {
        sourceCode: string;
        fileName: string;
        projectAnalysis: ProjectAnalysis;
        existingTestPatterns?: string[];
    }): Promise<TestStrategy> {
        this.logger.debug('[CoreProviderAdapter] planTestStrategy called', { 
            fileName: context.fileName 
        });

        const systemPrompt = PROMPTS.SYSTEM;
        const userPrompt = PROMPTS.PLAN_TEST_STRATEGY(
            context.sourceCode,
            context.fileName,
            context.projectAnalysis,
            context.existingTestPatterns
        );

        const result = await this.coreProvider.sendPrompt(systemPrompt, userPrompt);
        
        try {
            const parsed = JSON.parse(result.content);
            return parsed as TestStrategy;
        } catch (error) {
            this.logger.error('[CoreProviderAdapter] Failed to parse test strategy', error);
            // Return default strategy
            return {
                approach: 'unit',
                mockingStrategy: 'moderate',
                mocksNeeded: [],
                testStructure: 'describe/it blocks',
                expectedCoverage: 70,
                potentialIssues: [],
                estimatedIterations: 2
            };
        }
    }

    /**
     * Generate personalized Jest configuration for a project
     */
    async generateJestConfig(context: {
        projectAnalysis: ProjectAnalysis;
        requirements: string[];
    }): Promise<GeneratedJestConfig> {
        this.logger.debug('[CoreProviderAdapter] generateJestConfig called');

        const systemPrompt = PROMPTS.SYSTEM;
        const userPrompt = PROMPTS.GENERATE_JEST_CONFIG(
            context.projectAnalysis,
            context.requirements
        );

        const result = await this.coreProvider.sendPrompt(systemPrompt, userPrompt);
        
        try {
            const parsed = JSON.parse(result.content);
            return parsed as GeneratedJestConfig;
        } catch (error) {
            this.logger.error('[CoreProviderAdapter] Failed to parse Jest config', error);
            throw new Error('Failed to generate Jest configuration');
        }
    }

    /**
     * Plan batch test generation with prioritization
     */
    async planBatchGeneration(context: {
        allFiles: string[];
        projectStructure: any;
        existingTests: string[];
        dependencies: Record<string, string[]>;
    }): Promise<BatchGenerationPlan> {
        this.logger.debug('[CoreProviderAdapter] planBatchGeneration called', {
            fileCount: context.allFiles.length
        });

        const systemPrompt = PROMPTS.SYSTEM;
        const userPrompt = PROMPTS.PLAN_BATCH_GENERATION(
            context.allFiles,
            context.projectStructure,
            context.existingTests,
            context.dependencies
        );

        const result = await this.coreProvider.sendPrompt(systemPrompt, userPrompt);
        
        try {
            const parsed = JSON.parse(result.content);
            return parsed as BatchGenerationPlan;
        } catch (error) {
            this.logger.error('[CoreProviderAdapter] Failed to parse batch generation plan', error);
            // Return default plan
            return {
                groups: [{
                    name: 'default',
                    priority: 1,
                    files: context.allFiles,
                    reason: 'Default sequential generation'
                }],
                estimatedTime: 'Unknown',
                recommendedConcurrency: 1
            };
        }
    }

    /**
     * Validate if suggested package versions exist in npm registry
     */
    async validateAndFixVersions(context: {
        suggestedVersions: Record<string, string>;
        validationErrors: string[];
    }): Promise<Record<string, string>> {
        this.logger.debug('[CoreProviderAdapter] validateAndFixVersions called');

        const systemPrompt = `You are an expert in npm package versions and dependency resolution.
Analyze validation errors and suggest alternative compatible versions that exist in the npm registry.
Return ONLY valid JSON with package names as keys and corrected version strings as values.`;

        const userPrompt = `These package versions failed validation:

Suggested versions:
${JSON.stringify(context.suggestedVersions, null, 2)}

Validation errors:
${context.validationErrors.join('\n')}

Provide corrected versions that:
1. Exist in the npm registry
2. Are compatible with each other
3. Are stable (prefer non-beta, non-RC versions)

Return ONLY a JSON object with corrected versions:
\`\`\`json
{
  "package-name": "^X.Y.Z"
}
\`\`\``;

        const result = await this.coreProvider.sendPrompt(systemPrompt, userPrompt);
        
        try {
            const parsed = JSON.parse(result.content);
            return parsed;
        } catch (error) {
            this.logger.error('[CoreProviderAdapter] Failed to parse version validation', error);
            return context.suggestedVersions; // Return original versions as fallback
        }
    }

    async reviewTest(context: ReviewContext): Promise<ReviewResult> {
        this.logger.debug('[CoreProviderAdapter] reviewTest called', { fileName: context.fileName });
        
        const result = await this.coreProvider.sendPrompt(context.systemPrompt!, context.userPrompt!);
        
        try {
            // Check if the output has markdown blocks and strip them
            let content = result.content.trim();
            if (content.startsWith('```json')) {
                content = content.replace(/^```json\n?/, '').replace(/\n?```$/, '');
            } else if (content.startsWith('```')) {
                content = content.replace(/^```\n?/, '').replace(/\n?```$/, '');
            }

            const parsed = JSON.parse(content);
            return {
                passed: !!parsed.passed,
                score: parsed.score || 0,
                critique: parsed.critique || content,
                suggestions: parsed.suggestions || []
            };
        } catch (e) {
            this.logger.error('[CoreProviderAdapter] Failed to parse review JSON', e);
            return {
                passed: false,
                critique: result.content,
                score: 5,
                suggestions: ["Failed to parse review as JSON"]
            };
        }
    }

    async generateLearningEntry(context: LearningContext): Promise<LearningEntry> {
        this.logger.debug('[CoreProviderAdapter] generateLearningEntry called');
        
        const result = await this.coreProvider.sendPrompt(context.systemPrompt!, context.userPrompt!);
        
        try {
             let content = result.content.trim();
             if (content.startsWith('```json')) {
                 content = content.replace(/^```json\n?/, '').replace(/\n?```$/, '');
             } else if (content.startsWith('```')) {
                 content = content.replace(/^```\n?/, '').replace(/\n?```$/, '');
             }

             const parsed = JSON.parse(content);
             return {
                 timestamp: new Date().toISOString(),
                 fileName: context.fileName,
                 sourceCode: context.sourceCode,
                 originalTestCode: context.originalTestCode,
                 critique: context.critique,
                 fixedTestCode: context.fixedTestCode,
                 improvementDelta: parsed.improvementDelta || "See fixed and original code comparison",
                 category: parsed.category || 'other'
             };
        } catch (e) {
            this.logger.error('[CoreProviderAdapter] Failed to parse learning JSON', e);
            return {
                timestamp: new Date().toISOString(),
                fileName: context.fileName,
                sourceCode: context.sourceCode,
                originalTestCode: context.originalTestCode,
                critique: context.critique,
                fixedTestCode: context.fixedTestCode,
                improvementDelta: "Analysis failure: " + (e instanceof Error ? e.message : String(e)),
                category: 'other'
            };
        }
    }
}
