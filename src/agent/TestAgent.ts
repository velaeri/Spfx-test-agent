import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TestRunner } from '../utils/TestRunner';
import { JestLogParser } from '../utils/JestLogParser';
import { ILLMProvider, ProjectAnalysis, TestStrategy } from '../interfaces/ILLMProvider';
import { CopilotProvider } from '../providers/CopilotProvider';
import { AzureOpenAIProvider } from '../providers/AzureOpenAIProvider';
import { Logger } from '../services/Logger';
import { ConfigService } from '../services/ConfigService';
import { StateService, TestGenerationHistory } from '../services/StateService';
import { ProjectSetupService } from '../services/ProjectSetupService';
import { TelemetryService } from '../services/TelemetryService';
import { SourceContextCollector } from '../utils/SourceContextCollector';
import { StackDiscoveryService, ProjectStack } from '../services/StackDiscoveryService';
import { PROMPTS } from '../utils/prompts';
import { 
    JestNotFoundError, 
    TestGenerationError, 
    RateLimitError,
    FileValidationError
} from '../errors/CustomErrors';

/**
 * TestAgent - Core agentic workflow for automated SPFx test generation
 * 
 * This agent implements a self-healing loop:
 * 1. Generates a test file using LLM (GPT-4 via Copilot or other providers)
 * 2. Executes the test using Jest
 * 3. If test fails, parses the error and asks LLM to fix it
 * 4. Repeats up to N times until test passes (configurable)
 */
export class TestAgent {
    private testRunner: TestRunner;
    private llmProvider: ILLMProvider;
    private logger: Logger;
    private stateService?: StateService;
    private setupService: ProjectSetupService;
    private telemetryService: TelemetryService;
    private contextCollector: SourceContextCollector;
    private stackDiscovery: StackDiscoveryService;
    private detectedStack?: ProjectStack;

    constructor(llmProvider?: ILLMProvider, stateService?: StateService) {
        this.testRunner = new TestRunner();
        this.logger = Logger.getInstance();
        this.setupService = new ProjectSetupService();
        this.telemetryService = TelemetryService.getInstance();
        this.contextCollector = new SourceContextCollector();
        this.stackDiscovery = new StackDiscoveryService();
        
        // Use provided LLM provider or create default Copilot provider
        if (llmProvider) {
            this.llmProvider = llmProvider;
        } else {
            const config = ConfigService.getConfig();
            
            // Check if Azure OpenAI is configured
            const hasAzureConfig = config.azureOpenAI?.endpoint && 
                                 config.azureOpenAI?.apiKey && 
                                 config.azureOpenAI?.deploymentName;

            if (hasAzureConfig) {
                this.llmProvider = new AzureOpenAIProvider();
            } else {
                this.llmProvider = new CopilotProvider(config.llmVendor, config.llmFamily);
            }
        }

        this.stateService = stateService;
        
        this.logger.info(`TestAgent initialized with provider: ${this.llmProvider.getProviderName()}`);
    }

    /**
     * Main method: Generate and heal a test file for a given source file
     * 
     * @param sourceFilePath - Absolute path to the source file (e.g., MyComponent.tsx)
     * @param workspaceRoot - Root directory of the workspace
     * @param stream - VS Code chat response stream for progress updates
     * @param mode - Generation mode (fast/balanced/thorough), defaults to balanced
     * @returns Path to the generated test file
     */
    async generateAndHealTest(
        sourceFilePath: string,
        workspaceRoot: string,
        stream: vscode.ChatResponseStream,
        mode: 'fast' | 'balanced' | 'thorough' = 'balanced'
    ): Promise<string> {
        const config = ConfigService.getConfig();
        
        // Override maxHealingAttempts based on mode
        let effectiveMaxAttempts = config.maxHealingAttempts;
        let shouldExecuteTests = true;
        
        switch (mode) {
            case 'fast':
                effectiveMaxAttempts = 0;
                shouldExecuteTests = false;
                break;
            case 'balanced':
                effectiveMaxAttempts = 1;
                break;
            case 'thorough':
                effectiveMaxAttempts = 3;
                break;
        }
        const startTime = Date.now();
        const errorPatterns: string[] = [];

        this.telemetryService.trackCommandExecution('generate');

        // Validate source file path
        this.validateSourceFile(sourceFilePath, workspaceRoot);

        // Verify Jest is available
        const jestAvailable = await this.testRunner.isJestAvailable(workspaceRoot, config.jestCommand);
        if (!jestAvailable) {
            throw new JestNotFoundError(workspaceRoot);
        }

        // Read the source file
        const sourceCode = fs.readFileSync(sourceFilePath, 'utf-8');
        const sourceFileName = path.basename(sourceFilePath);
        
        this.logger.info('Starting test generation', {
            sourceFile: sourceFileName,
            workspace: workspaceRoot
        });
        stream.progress('Collecting source context...');

        // Collect dependency context for more accurate test generation
        let dependencyContext: string | undefined;
        try {
            const fullContext = await this.contextCollector.collectContext(sourceFilePath, workspaceRoot);
            dependencyContext = this.contextCollector.formatForPrompt(fullContext);
            if (dependencyContext) {
                this.logger.info('Dependency context collected', {
                    dependencies: fullContext.dependencies.size,
                    spfxPatterns: fullContext.spfxPatterns.length
                });
            }
        } catch (error) {
            this.logger.warn('Failed to collect dependency context, proceeding without it', error);
        }

        // Discover project stack (cached per workspace) for dynamic prompts
        let systemPrompt: string | undefined;
        try {
            if (!this.detectedStack) {
                stream.progress('Discovering project stack...');
                this.detectedStack = await this.stackDiscovery.discover(workspaceRoot);
                this.logger.info('Stack discovered', {
                    framework: this.detectedStack.framework,
                    language: this.detectedStack.language,
                    testRunner: this.detectedStack.testRunner,
                    confidence: this.detectedStack.confidence
                });
                const summary = this.stackDiscovery.formatStackSummary(this.detectedStack);
                stream.markdown(`📦 **Detected stack:** ${summary}\n\n`);
            }
            systemPrompt = PROMPTS.buildSystemPrompt(this.detectedStack);
        } catch (error) {
            this.logger.warn('Stack discovery failed, using default prompts', error);
        }

        // Determine test file path
        const testFilePath = this.getTestFilePath(sourceFilePath, config.testFilePattern);
        
        this.logger.info(`Test file will be created at: ${testFilePath}`);
        
        // 🧠 LLM-FIRST: Plan test strategy before generating
        let testStrategy: TestStrategy | undefined;
        try {
            stream.progress('Analyzing source code and planning test strategy...');
            const projectAnalysis = await this.buildProjectAnalysis(workspaceRoot);
            
            testStrategy = await this.llmProvider.planTestStrategy({
                sourceCode,
                fileName: sourceFileName,
                projectAnalysis,
                existingTestPatterns: await this.findExistingTestPatterns(workspaceRoot)
            });
            
            // Show strategy to user
            stream.markdown(`\n🧠 **Test Strategy Planned by LLM:**\n\n`);
            stream.markdown(`- **Approach:** ${testStrategy.approach}\n`);
            stream.markdown(`- **Mocking:** ${testStrategy.mockingStrategy}\n`);
            if (testStrategy.mocksNeeded.length > 0) {
                stream.markdown(`- **Mocks needed:** ${testStrategy.mocksNeeded.slice(0, 3).join(', ')}${testStrategy.mocksNeeded.length > 3 ? '...' : ''}\n`);
            }
            if (testStrategy.potentialIssues.length > 0) {
                stream.markdown(`- **Potential issues:** ${testStrategy.potentialIssues[0]}\n`);
            }
            stream.markdown(`- **Est. iterations:** ${testStrategy.estimatedIterations}\n\n`);
            
            this.logger.info('Test strategy planned', {
                approach: testStrategy.approach,
                mockingStrategy: testStrategy.mockingStrategy,
                mocksCount: testStrategy.mocksNeeded.length
            });
        } catch (error) {
            this.logger.warn('Failed to plan test strategy, proceeding without it', error);
            stream.markdown(`⚠️ Could not plan strategy (LLM error), proceeding with default approach\n\n`);
        }
        
        stream.progress('Generating initial test...');

        // Attempt 1: Generate initial test
        let result = await this.llmProvider.generateTest({
            sourceCode,
            fileName: sourceFileName,
            dependencyContext,
            systemPrompt,
            attempt: 1,
            maxAttempts: config.maxHealingAttempts
        });

        fs.writeFileSync(testFilePath, result.code, 'utf-8');
        this.logger.info('Initial test file generated', { model: result.model, mode });

        stream.markdown(`✅ Generated test file: \`${path.relative(workspaceRoot, testFilePath)}\`\n\n`);
        
        // FAST mode: Skip test execution
        if (!shouldExecuteTests) {
            stream.markdown(`⚡ **Modo FAST**: Test generado sin ejecutar\n\n`);
            stream.markdown(`💡 Revisa el test manualmente o ejecútalo con: \`npm test ${path.basename(testFilePath)}\`\n`);
            
            const duration = Date.now() - startTime;
            this.telemetryService.trackTestGeneration(true, 1, duration);
            
            return testFilePath;
        }
        
        stream.progress('Running test...');

        // Run the test
        let testResult = await this.testRunner.runTest(testFilePath, workspaceRoot, config.jestCommand);

        // Self-healing loop
        let attempt = 1;
        let rateLimitRetries = 0;
        
        while (!testResult.success && attempt < effectiveMaxAttempts) {
            attempt++;
            
            stream.markdown(`⚠️ Test failed on attempt ${attempt - 1}. Analyzing errors...\n\n`);
            
            // Parse and clean the error output
            const cleanedError = JestLogParser.cleanJestOutput(testResult.output);
            
            // CRITICAL: If cleaned error is empty/short, use raw output
            const errorToSend = (cleanedError && cleanedError.length > 50) 
                ? cleanedError 
                : testResult.output.substring(0, 3000); // Use raw output if cleaning failed
            
            this.logger.info(`Test failed (attempt ${attempt}), error length: ${testResult.output.length} chars, cleaned: ${cleanedError.length} chars`);
            
            errorPatterns.push(errorToSend.substring(0, 200)); // Store first 200 chars
            const summary = JestLogParser.extractTestSummary(testResult.output);
            
            this.telemetryService.trackHealingAttempt(attempt, 'JestTestFailure');
            
            stream.markdown(`**Error Summary:** ${summary.failed} failed, ${summary.passed} passed\n\n`);
            stream.progress(`Healing test (attempt ${attempt}/${effectiveMaxAttempts})...`);

            // Wait briefly to avoid rate limits (exponential backoff)
            await this.sleep(config.initialBackoffMs * attempt);

            try {
                // Read the current failing test code to send to LLM
                const currentTestCode = fs.existsSync(testFilePath) 
                    ? fs.readFileSync(testFilePath, 'utf-8') 
                    : '';

                // Ask LLM to fix the test - use errorToSend which has fallback to raw output
                result = await this.llmProvider.fixTest({
                    sourceCode,
                    fileName: sourceFileName,
                    currentTestCode,
                    errorContext: errorToSend, // Use the error with fallback logic
                    dependencyContext,
                    systemPrompt,
                    attempt,
                    maxAttempts: config.maxHealingAttempts
                });

                fs.writeFileSync(testFilePath, result.code, 'utf-8');
                this.logger.info(`Test file updated (attempt ${attempt})`, { model: result.model });

                stream.markdown(`🔄 Updated test file (attempt ${attempt})\n\n`);
                stream.progress('Running test again...');

                // Run the test again
                testResult = await this.testRunner.runTest(testFilePath, workspaceRoot, config.jestCommand);
                rateLimitRetries = 0; // Reset rate limit counter on success
            } catch (error) {
                if (error instanceof RateLimitError) {
                    rateLimitRetries++;
                    if (rateLimitRetries >= config.maxRateLimitRetries) {
                        this.logger.error('Max rate limit retries exceeded');
                        throw error;
                    }
                    stream.markdown(`⏸️ Rate limit encountered (retry ${rateLimitRetries}/${config.maxRateLimitRetries}). Waiting...\n\n`);
                    await this.sleep(5000 * rateLimitRetries); // Exponential backoff for rate limits
                    attempt--; // Don't count this as a real attempt
                    continue;
                }
                this.logger.error('Error during test healing', error);
                throw error;
            }
        }

        // Save to history
        if (this.stateService) {
            const history: TestGenerationHistory = {
                sourceFile: sourceFilePath,
                testFile: testFilePath,
                timestamp: new Date(),
                attempts: attempt,
                success: testResult.success,
                errorPatterns,
                model: result.model || 'unknown'
            };
            await this.stateService.addTestGeneration(history);
            this.logger.debug('Test generation saved to history');
        }

        // Final results
        const duration = Date.now() - startTime;
        
        this.telemetryService.trackTestGeneration(
            testResult.success, 
            attempt, 
            duration
        );
        
        if (testResult.success) {
            stream.markdown(`✅ **Test passed successfully!** (${(duration / 1000).toFixed(1)}s)\n\n`);
            const summary = JestLogParser.extractTestSummary(testResult.output);
            stream.markdown(`**Final Results:** ${summary.passed} passed, ${summary.total} total\n\n`);
            this.logger.info('Test generation succeeded', { attempts: attempt, duration });
        } else {
            stream.markdown(`❌ **Test still failing after ${config.maxHealingAttempts} attempts.** (${(duration / 1000).toFixed(1)}s)\n\n`);
            stream.markdown('Consider reviewing the generated test manually.\n\n');
            
            // Show error to user - with fallback to raw output
            const cleanedError = JestLogParser.cleanJestOutput(testResult.output);
            const errorToShow = (cleanedError && cleanedError.length > 20)
                ? cleanedError
                : testResult.output.substring(0, 2000); // Show raw output if cleaning failed
            
            stream.markdown('```\n' + errorToShow + '\n```\n\n');
            this.logger.warn('Test generation failed', { 
                attempts: attempt, 
                duration,
                outputLength: testResult.output.length,
                cleanedLength: cleanedError.length
            });
            
            this.telemetryService.trackError('TestGenerationError', 'generation');
            
            throw new TestGenerationError(
                'Test still failing after maximum attempts',
                attempt,
                config.maxHealingAttempts,
                testResult.output
            );
        }

        return testFilePath;
    }

    /**
     * Validate source file path
     */
    private validateSourceFile(sourceFilePath: string, workspaceRoot: string): void {
        const normalizedPath = path.normalize(sourceFilePath);
        const normalizedWorkspace = path.normalize(workspaceRoot);

        // Check if file is within workspace
        if (!normalizedPath.startsWith(normalizedWorkspace)) {
            throw new FileValidationError(
                'Source file must be within workspace',
                sourceFilePath
            );
        }

        // Check if file exists
        if (!fs.existsSync(normalizedPath)) {
            throw new FileValidationError(
                'Source file does not exist',
                sourceFilePath
            );
        }

        this.logger.debug('Source file validated', { sourceFilePath });
    }

    /**
     * Determines the test file path based on source file path
     * Supports customizable patterns via configuration
     */
    private getTestFilePath(sourceFilePath: string, pattern: string): string {
        const dir = path.dirname(sourceFilePath);
        const ext = path.extname(sourceFilePath);
        const baseName = path.basename(sourceFilePath, ext);
        
        // Parse pattern: ${fileName}.test.${ext}
        // Default pattern creates MyComponent.test.tsx from MyComponent.tsx
        let testFileName = pattern
            .replace('${fileName}', baseName)
            .replace('${ext}', ext.substring(1)); // Remove the dot
        
        // Ensure proper extension
        const hasTestExtension = testFileName.match(/\.test\.(ts|tsx)$|\.spec\.(ts|tsx)$/);
        if (!hasTestExtension) {
            testFileName += ext;
        }
        
        const testFilePath = path.join(dir, testFileName);
        this.logger.debug('Test file path determined', { 
            sourceFile: sourceFilePath, 
            testFile: testFilePath,
            pattern
        });
        
        return testFilePath;
    }

    /**
     * Sleep utility for backoff
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Build project analysis for LLM planning
     */
    private async buildProjectAnalysis(projectRoot: string): Promise<ProjectAnalysis> {
        const packageJsonPath = path.join(projectRoot, 'package.json');
        const tsConfigPath = path.join(projectRoot, 'tsconfig.json');
        
        let packageJson: any = {};
        let tsConfig: any = undefined;
        let existingJestConfig: string | undefined;
        
        // Read package.json
        if (fs.existsSync(packageJsonPath)) {
            packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        }
        
        // Read tsconfig.json
        if (fs.existsSync(tsConfigPath)) {
            tsConfig = JSON.parse(fs.readFileSync(tsConfigPath, 'utf-8'));
        }
        
        // Read existing jest config if present
        const configFiles = ['jest.config.js', 'jest.config.ts', 'jest.config.json'];
        for (const file of configFiles) {
            const configPath = path.join(projectRoot, file);
            if (fs.existsSync(configPath)) {
                existingJestConfig = fs.readFileSync(configPath, 'utf-8');
                break;
            }
        }
        
        // Find existing test files
        const existingTests: string[] = [];
        const srcDir = path.join(projectRoot, 'src');
        if (fs.existsSync(srcDir)) {
            this.findTestFiles(srcDir, existingTests);
        }
        
        return {
            packageJson,
            tsConfig,
            existingJestConfig,
            existingTests: existingTests.map(f => path.basename(f)),
            dependencies: packageJson.dependencies || {},
            devDependencies: packageJson.devDependencies || {},
            framework: this.detectFramework(packageJson),
            reactVersion: packageJson.dependencies?.react || packageJson.devDependencies?.react,
            nodeVersion: packageJson.engines?.node
        };
    }

    private findTestFiles(dir: string, results: string[]): void {
        if (results.length >= 10) return; // Limit to 10 examples
        
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (results.length >= 10) break;
                
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && entry.name !== 'node_modules') {
                    this.findTestFiles(fullPath, results);
                } else if (entry.name.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) {
                    results.push(fullPath);
                }
            }
        } catch (error) {
            // Ignore read errors
        }
    }

    private detectFramework(packageJson: any): string {
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        
        if (deps['@microsoft/sp-core-library']) return 'spfx';
        if (deps['@angular/core']) return 'angular';
        if (deps['next']) return 'next';
        if (deps['react']) return 'react';
        if (deps['vue']) return 'vue';
        if (deps['@types/vscode']) return 'vscode-extension';
        
        return 'unknown';
    }

    private async findExistingTestPatterns(projectRoot: string): Promise<string[]> {
        const patterns: string[] = [];
        const srcDir = path.join(projectRoot, 'src');
        
        if (!fs.existsSync(srcDir)) {
            return patterns;
        }
        
        const testFiles: string[] = [];
        this.findTestFiles(srcDir, testFiles);
        
        // Extract patterns from first 3 test files
        for (const testFile of testFiles.slice(0, 3)) {
            try {
                const content = fs.readFileSync(testFile, 'utf-8');
                // Extract key patterns: describe blocks, it blocks, common setup
                const describeBlocks = content.match(/describe\(['"](.*?)['"]/g);
                const itBlocks = content.match(/it\(['"](.*?)['"]/g);
                
                if (describeBlocks && describeBlocks.length > 0) {
                    patterns.push(describeBlocks[0]);
                }
                if (itBlocks && itBlocks.length > 0) {
                    patterns.push(itBlocks[0]);
                }
                
                // Check for common setup patterns
                if (content.includes('beforeEach')) {
                    patterns.push('Uses beforeEach setup');
                }
                if (content.includes('jest.mock')) {
                    patterns.push('Uses jest.mock for dependencies');
                }
            } catch (error) {
                // Ignore read errors
            }
        }
        
        return patterns.slice(0, 5); // Return max 5 patterns
    }
}
