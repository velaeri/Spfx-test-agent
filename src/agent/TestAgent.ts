import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TestRunner } from '../utils/TestRunner';
import { JestLogParser } from '../utils/JestLogParser';
import { ILLMProvider } from '../interfaces/ILLMProvider';
import { CopilotProvider } from '../providers/CopilotProvider';
import { AzureOpenAIProvider } from '../providers/AzureOpenAIProvider';
import { Logger } from '../services/Logger';
import { ConfigService } from '../services/ConfigService';
import { StateService, TestGenerationHistory } from '../services/StateService';
import { ProjectSetupService } from '../services/ProjectSetupService';
import { TelemetryService } from '../services/TelemetryService';
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

    constructor(llmProvider?: ILLMProvider, stateService?: StateService) {
        this.testRunner = new TestRunner();
        this.logger = Logger.getInstance();
        this.setupService = new ProjectSetupService();
        this.telemetryService = TelemetryService.getInstance();
        
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
        stream.progress('Reading source file...');

        // Determine test file path
        const testFilePath = this.getTestFilePath(sourceFilePath, config.testFilePattern);
        
        this.logger.info(`Test file will be created at: ${testFilePath}`);
        stream.progress('Generating initial test...');

        // Attempt 1: Generate initial test
        let result = await this.llmProvider.generateTest({
            sourceCode,
            fileName: sourceFileName,
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
            errorPatterns.push(cleanedError.substring(0, 200)); // Store first 200 chars
            const summary = JestLogParser.extractTestSummary(testResult.output);
            
            this.telemetryService.trackHealingAttempt(attempt, 'JestTestFailure');
            
            stream.markdown(`**Error Summary:** ${summary.failed} failed, ${summary.passed} passed\n\n`);
            stream.progress(`Healing test (attempt ${attempt}/${effectiveMaxAttempts})...`);

            // Wait briefly to avoid rate limits (exponential backoff)
            await this.sleep(config.initialBackoffMs * attempt);

            try {
                // Ask LLM to fix the test
                result = await this.llmProvider.fixTest({
                    sourceCode,
                    fileName: sourceFileName,
                    errorContext: cleanedError,
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
            const cleanedError = JestLogParser.cleanJestOutput(testResult.output);
            stream.markdown('```\n' + cleanedError + '\n```\n\n');
            this.logger.warn('Test generation failed', { attempts: attempt, duration });
            
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
}
