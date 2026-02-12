import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TestRunner } from '../utils/TestRunner';
import { JestLogParser } from '../utils/JestLogParser';
import { ILLMProvider } from '../interfaces/ILLMProvider';
import { Logger } from '../services/Logger';
import { ConfigService } from '../services/ConfigService';
import { StateService, TestGenerationHistory } from '../services/StateService';
import { ProjectSetupService } from '../services/ProjectSetupService';
import { JestConfigurationService } from '../services/JestConfigurationService';
import { PackageInstallationService } from '../services/PackageInstallationService';
import { DependencyDetectionService } from '../services/DependencyDetectionService';
import { TelemetryService } from '../services/TelemetryService';
import { SourceContextCollector } from '../utils/SourceContextCollector';
import { 
    JestNotFoundError, 
    TestGenerationError, 
    RateLimitError,
    FileValidationError
} from '../errors/CustomErrors';

/**
 * TestAgent - Core agentic workflow for automated SPFx test generation
 * 
 * This agent implements an intelligent self-healing loop:
 * 1. Collects full context: source file + imports + dependencies + project config
 * 2. Generates a test file using LLM with all context
 * 3. Executes ONLY the target test file using Jest
 * 4. If test fails, detects whether it's infrastructure vs code issue
 * 5. For infrastructure issues: auto-fixes (e.g., jsdom version)
 * 6. For code issues: sends error + current test + source + deps to LLM for fix
 * 7. Repeats up to N times until test passes
 */
export class TestAgent {
    private testRunner: TestRunner;
    private llmProvider: ILLMProvider;
    private logger: Logger;
    private stateService?: StateService;
    private setupService: ProjectSetupService;
    private configService: JestConfigurationService;
    private packageService: PackageInstallationService;
    private dependencyService: DependencyDetectionService;
    private telemetryService: TelemetryService;
    private contextCollector: SourceContextCollector;

    constructor(llmProvider: ILLMProvider, stateService?: StateService) {
        this.testRunner = new TestRunner();
        this.logger = Logger.getInstance();
        this.setupService = new ProjectSetupService();
        this.configService = new JestConfigurationService();
        this.packageService = new PackageInstallationService();
        this.dependencyService = new DependencyDetectionService();
        this.telemetryService = TelemetryService.getInstance();
        this.contextCollector = new SourceContextCollector();
        
        this.llmProvider = llmProvider;
        this.stateService = stateService;
        
        this.logger.info(`TestAgent initialized with provider: ${this.llmProvider.getProviderName()}`);
    }

    /**
     * Main method: Generate and heal a test file for a given source file
     */
    async generateAndHealTest(
        sourceFilePath: string,
        workspaceRoot: string,
        stream: vscode.ChatResponseStream,
        mode: 'fast' | 'balanced' | 'thorough' = 'balanced'
    ): Promise<string> {
        const config = ConfigService.getConfig();
        
        // Mode determines max healing attempts
        let maxAttempts: number;
        let shouldExecuteTests = true;
        
        switch (mode) {
            case 'fast':
                maxAttempts = 0;
                shouldExecuteTests = false;
                break;
            case 'balanced':
                maxAttempts = config.maxHealingAttempts; // Use configured value (default 3)
                break;
            case 'thorough':
                maxAttempts = Math.max(config.maxHealingAttempts, 5);
                break;
            default:
                maxAttempts = config.maxHealingAttempts;
        }

        const startTime = Date.now();
        const errorPatterns: string[] = [];

        this.telemetryService.trackCommandExecution('generate');

        // Validate source file
        this.validateSourceFile(sourceFilePath, workspaceRoot);

        // ── Phase 1: Environment Readiness ──
        await this.ensureEnvironment(workspaceRoot, stream, config);

        // ── Phase 2: Collect Full Context ──
        stream.progress('Analyzing source file and dependencies...');
        const sourceContext = await this.contextCollector.collectContext(sourceFilePath, workspaceRoot);
        const dependencyContextStr = this.contextCollector.formatForPrompt(sourceContext);
        
        const sourceFileName = sourceContext.fileName;
        const sourceCode = sourceContext.sourceCode;

        this.logger.info('Context collected', {
            sourceFile: sourceFileName,
            dependencies: sourceContext.dependencies.size,
            spfxPatterns: sourceContext.spfxPatterns.length
        });

        if (sourceContext.dependencies.size > 0) {
            stream.markdown(`📦 Analyzed **${sourceContext.dependencies.size}** imported dependencies\n`);
        }
        if (sourceContext.spfxPatterns.length > 0) {
            stream.markdown(`🔍 Detected: ${sourceContext.spfxPatterns.slice(0, 3).join(', ')}\n\n`);
        }

        // Determine test file path
        const testFilePath = this.getTestFilePath(sourceFilePath, config.testFilePattern);

        // ── Phase 3: Generate Initial Test ──
        stream.progress('Generating test with full project context...');

        let result = await this.llmProvider.generateTest({
            sourceCode,
            fileName: sourceFileName,
            dependencyContext: dependencyContextStr,
            attempt: 1,
            maxAttempts
        });

        let currentTestCode = this.extractPureCode(result.code);
        fs.writeFileSync(testFilePath, currentTestCode, 'utf-8');

        stream.markdown(`✅ Generated test file: \`${path.relative(workspaceRoot, testFilePath)}\`\n\n`);
        
        // FAST mode: Skip execution
        if (!shouldExecuteTests) {
            stream.markdown(`⚡ **Modo FAST**: Test generado sin ejecutar\n\n`);
            const duration = Date.now() - startTime;
            this.telemetryService.trackTestGeneration(true, 1, duration);
            return testFilePath;
        }

        // ── Phase 4: Execute & Self-Heal Loop ──
        stream.progress('Running test...');
        let testResult = await this.testRunner.runTest(testFilePath, workspaceRoot, config.jestCommand);

        let attempt = 0; // healing attempts counter
        let rateLimitRetries = 0;
        
        while (!testResult.success && attempt < maxAttempts) {
            attempt++;
            
            const cleanedError = JestLogParser.cleanJestOutput(testResult.output);
            errorPatterns.push(cleanedError.substring(0, 200));
            const summary = JestLogParser.extractTestSummary(testResult.output);

            this.telemetryService.trackHealingAttempt(attempt, 'JestTestFailure');

            // ── Phase 4a: Detect infrastructure issues ──
            const envHints = this.detectEnvironmentIssues(testResult.output);
            
            if (envHints.autoFixable) {
                stream.markdown(`🔧 **Infrastructure issue detected:** ${envHints.description}\n`);
                stream.progress(`Auto-fixing: ${envHints.description}...`);
                
                const fixed = await this.autoFixEnvironment(envHints, workspaceRoot, stream);
                if (fixed) {
                    stream.markdown(`✅ Fixed: ${envHints.description}\n\n`);
                    attempt--; // Don't count infra fix as healing attempt
                    stream.progress('Re-running test after environment fix...');
                    testResult = await this.testRunner.runTest(testFilePath, workspaceRoot, config.jestCommand);
                    continue;
                }
            }

            // ── Phase 4b: LLM-based healing ──
            stream.markdown(`⚠️ Test failed (healing attempt ${attempt}/${maxAttempts})\n`);
            if (summary.failed > 0 || summary.total > 0) {
                stream.markdown(`📊 ${summary.failed} failed, ${summary.passed} passed of ${summary.total} total\n`);
            }
            stream.progress(`Healing test (attempt ${attempt}/${maxAttempts})...`);

            await this.sleep(config.initialBackoffMs * attempt);

            try {
                // Read current test from disk
                currentTestCode = fs.readFileSync(testFilePath, 'utf-8');

                // Send EVERYTHING to the LLM: source + deps + current test + error
                result = await this.llmProvider.fixTest({
                    sourceCode,
                    fileName: sourceFileName,
                    dependencyContext: dependencyContextStr,
                    errorContext: cleanedError,
                    currentTestCode,
                    environmentHints: envHints.hints.length > 0 
                        ? `\n**Environment hints:**\n${envHints.hints.join('\n')}\n`
                        : '',
                    attempt,
                    maxAttempts
                });

                currentTestCode = this.extractPureCode(result.code);
                fs.writeFileSync(testFilePath, currentTestCode, 'utf-8');

                stream.markdown(`🔄 Test updated (attempt ${attempt})\n\n`);
                stream.progress('Running healed test...');

                testResult = await this.testRunner.runTest(testFilePath, workspaceRoot, config.jestCommand);
                rateLimitRetries = 0;
            } catch (error) {
                if (error instanceof RateLimitError) {
                    rateLimitRetries++;
                    if (rateLimitRetries >= config.maxRateLimitRetries) {
                        throw error;
                    }
                    stream.markdown(`⏸️ Rate limit (retry ${rateLimitRetries}/${config.maxRateLimitRetries}). Waiting...\n\n`);
                    await this.sleep(5000 * rateLimitRetries);
                    attempt--;
                    continue;
                }
                this.logger.error('Error during test healing', error);
                throw error;
            }
        }

        // ── Phase 5: Save Results ──
        if (this.stateService) {
            const history: TestGenerationHistory = {
                sourceFile: sourceFilePath,
                testFile: testFilePath,
                timestamp: new Date(),
                attempts: attempt + 1,
                success: testResult.success,
                errorPatterns,
                model: result.model || 'unknown'
            };
            await this.stateService.addTestGeneration(history);
        }

        const duration = Date.now() - startTime;
        this.telemetryService.trackTestGeneration(testResult.success, attempt + 1, duration);
        
        if (testResult.success) {
            stream.markdown(`✅ **Test passed!** (${(duration / 1000).toFixed(1)}s, ${attempt + 1} attempt(s))\n\n`);
            const summary = JestLogParser.extractTestSummary(testResult.output);
            stream.markdown(`📊 ${summary.passed} passed, ${summary.total} total\n\n`);
        } else {
            stream.markdown(`❌ **Test still failing after ${maxAttempts} healing attempts.** (${(duration / 1000).toFixed(1)}s)\n\n`);
            stream.markdown('Consider reviewing the generated test manually.\n\n');
            const cleanedError = JestLogParser.cleanJestOutput(testResult.output);
            stream.markdown('```\n' + cleanedError + '\n```\n\n');
            
            this.telemetryService.trackError('TestGenerationError', 'generation');
            throw new TestGenerationError(
                'Test still failing after maximum attempts',
                attempt + 1,
                maxAttempts,
                testResult.output
            );
        }

        return testFilePath;
    }

    /**
     * Ensure environment is ready: Jest, ts-jest, jsdom compatibility
     */
    private async ensureEnvironment(
        workspaceRoot: string, 
        stream: vscode.ChatResponseStream,
        config: ReturnType<typeof ConfigService.getConfig>
    ): Promise<void> {
        const jestAvailable = await this.testRunner.isJestAvailable(workspaceRoot, config.jestCommand);
        if (!jestAvailable) {
            throw new JestNotFoundError(workspaceRoot);
        }

        if (!this.configService.isTsJestInstalled(workspaceRoot)) {
            stream.markdown(`📦 Installing ts-jest...\n`);
            const existingJest = this.dependencyService.getExistingJestVersion(workspaceRoot);
            const tsJestVersion = (existingJest && existingJest.major === 28) ? '^28.0.8' : '^29.1.1';
            const typesJestVersion = (existingJest && existingJest.major === 28) ? '^28.1.0' : '^29.5.11';

            const ok = await this.packageService.installPackages(workspaceRoot, [
                `ts-jest@${tsJestVersion}`,
                `@types/jest@${typesJestVersion}`,
                'identity-obj-proxy@^3.0.0'
            ]);
            if (!ok) {
                throw new TestGenerationError('ts-jest installation failed', 0, 0, '');
            }
            stream.markdown(`✅ Dependencies installed\n\n`);
        }

        const configCreated = await this.configService.ensureValidJestConfig(workspaceRoot);
        if (configCreated) {
            stream.markdown(`🔧 Updated jest.config.js with ts-jest\n\n`);
        }

        const jestSetupPath = path.join(workspaceRoot, 'jest.setup.js');
        if (!fs.existsSync(jestSetupPath)) {
            await this.configService.createJestSetup(workspaceRoot);
        }
        await this.configService.createMockDirectory(workspaceRoot);
        await this.configService.updatePackageJsonScripts(workspaceRoot);

        // Check jsdom compatibility
        await this.ensureJsdomCompatibility(workspaceRoot, stream);
    }

    /**
     * Ensure jest-environment-jsdom is compatible with the installed Jest version
     */
    private async ensureJsdomCompatibility(
        workspaceRoot: string, 
        stream: vscode.ChatResponseStream
    ): Promise<void> {
        const jestVersion = this.dependencyService.getExistingJestVersion(workspaceRoot);
        if (!jestVersion) return;

        const jsdomEnvPath = path.join(workspaceRoot, 'node_modules', 'jest-environment-jsdom');
        if (!fs.existsSync(jsdomEnvPath)) {
            const version = jestVersion.major >= 29 ? '^29.0.0' : `^${jestVersion.major}.0.0`;
            const ok = await this.packageService.installPackages(workspaceRoot, [
                `jest-environment-jsdom@${version}`
            ]);
            if (ok) {
                stream.markdown(`📦 Installed jest-environment-jsdom@${version}\n`);
            }
            return;
        }

        try {
            const jsdomPkgPath = path.join(jsdomEnvPath, 'package.json');
            if (fs.existsSync(jsdomPkgPath)) {
                const jsdomPkg = JSON.parse(fs.readFileSync(jsdomPkgPath, 'utf-8'));
                const jsdomMajor = parseInt(jsdomPkg.version?.split('.')[0] || '0', 10);
                
                if (jsdomMajor !== jestVersion.major) {
                    const targetVersion = `^${jestVersion.major}.0.0`;
                    stream.markdown(`⚠️ Fixing jsdom version mismatch...\n`);
                    await this.packageService.installPackages(workspaceRoot, [
                        `jest-environment-jsdom@${targetVersion}`
                    ]);
                    stream.markdown(`✅ jest-environment-jsdom updated\n\n`);
                }
            }
        } catch (error) {
            this.logger.warn('Failed to check jsdom compatibility', error);
        }
    }

    /**
     * Detect environment/infrastructure issues from Jest output
     */
    private detectEnvironmentIssues(output: string): {
        autoFixable: boolean;
        description: string;
        fixType?: 'jsdom' | 'module' | 'config';
        hints: string[];
    } {
        const hints: string[] = [];
        
        if (output.includes('getVmContext')) {
            return {
                autoFixable: true,
                description: 'jest-environment-jsdom version incompatible',
                fixType: 'jsdom',
                hints: ['Install compatible jest-environment-jsdom version']
            };
        }

        const cannotFindModule = output.match(/Cannot find module '([^']+)'/g);
        if (cannotFindModule) {
            for (const match of cannotFindModule) {
                const moduleName = match.match(/Cannot find module '([^']+)'/)?.[1];
                if (moduleName && !moduleName.startsWith('.') && !moduleName.startsWith('/')) {
                    hints.push(`Module '${moduleName}' may not be installed`);
                }
            }
        }

        if (output.includes('SyntaxError') && output.includes('Cannot use import statement outside a module')) {
            hints.push('An imported module uses ESM syntax — may need transformIgnorePatterns update');
        }

        return { autoFixable: false, description: '', hints };
    }

    /**
     * Attempt to auto-fix an infrastructure issue
     */
    private async autoFixEnvironment(
        issue: { fixType?: string },
        workspaceRoot: string,
        _stream: vscode.ChatResponseStream
    ): Promise<boolean> {
        if (issue.fixType === 'jsdom') {
            const jestVersion = this.dependencyService.getExistingJestVersion(workspaceRoot);
            const targetVersion = jestVersion ? `^${jestVersion.major}.0.0` : '^29.0.0';
            return await this.packageService.installPackages(workspaceRoot, [
                `jest-environment-jsdom@${targetVersion}`
            ]);
        }
        return false;
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
     */
    private getTestFilePath(sourceFilePath: string, pattern: string): string {
        const dir = path.dirname(sourceFilePath);
        const ext = path.extname(sourceFilePath);
        const baseName = path.basename(sourceFilePath, ext);
        
        let testFileName = pattern
            .replace('${fileName}', baseName)
            .replace('${ext}', ext.substring(1));
        
        const hasTestExtension = testFileName.match(/\.test\.(ts|tsx)$|\.spec\.(ts|tsx)$/);
        if (!hasTestExtension) {
            testFileName += ext;
        }
        
        return path.join(dir, testFileName);
    }

    /**
     * Extract pure code from LLM response (remove markdown fences)
     */
    private extractPureCode(code: string): string {
        const codeBlockRegex = /```(?:typescript|tsx|ts|javascript|js)?\s*([\s\S]*?)\s*```/;
        const match = code.match(codeBlockRegex);
        if (match) {
            return match[1].trim();
        }
        return code.trim();
    }

    /**
     * Sleep utility for backoff
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
