import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../services/Logger';
import { DependencyDetectionService } from '../services/DependencyDetectionService';
import { JestConfigurationService } from '../services/JestConfigurationService';
import { PackageInstallationService } from '../services/PackageInstallationService';
import { SecurityError, TestExecutionError } from '../errors/CustomErrors';
import { FileScanner } from './FileScanner';

/**
 * Result of a test execution
 */
export interface TestRunResult {
    success: boolean;
    output: string;
}

/**
 * TestRunner - Executes Jest tests with security validation
 * 
 * This utility executes Jest on a specific test file and returns
 * structured results indicating success/failure along with the output.
 */
export class TestRunner {
    private logger: Logger;
    private dependencyService: DependencyDetectionService;
    private configService: JestConfigurationService;

    constructor() {
        this.logger = Logger.getInstance();
        this.dependencyService = new DependencyDetectionService();
        this.configService = new JestConfigurationService();
    }

    /**
     * Runs Jest on a specific test file.
     * 
     * CRITICAL: This method now guarantees that ts-jest is used for
     * TypeScript transformation.  Before spawning Jest it will:
     *  1. Locate the project root (closest package.json).
     *  2. Validate / create a jest.config.js that includes ts-jest.
     *  3. If ts-jest is not even installed in node_modules, fall back
     *     to an inline --config with the ts-jest transform so that
     *     TypeScript files are never parsed as plain JavaScript.
     * 
     * @param testFilePath - Absolute path to the test file
     * @param workspaceRoot - Root directory of the workspace
     * @param jestCommand - Base jest command (default: 'npx jest')
     * @returns Promise with test results
     */
    async runTest(
        testFilePath: string, 
        workspaceRoot: string,
        jestCommand: string = 'npx jest'
    ): Promise<TestRunResult> {
        // Validate and sanitize paths
        const normalizedTestPath = path.normalize(testFilePath);
        const normalizedWorkspaceRoot = path.normalize(workspaceRoot);

        // Security check: Ensure test file is within workspace
        if (!normalizedTestPath.startsWith(normalizedWorkspaceRoot)) {
            const error = new SecurityError(
                `Test file must be within workspace. File: ${normalizedTestPath}, Workspace: ${normalizedWorkspaceRoot}`
            );
            this.logger.error('Security violation detected', error);
            throw error;
        }

        // Find the project root for this test file (closest package.json)
        const projectRoot = FileScanner.findProjectRoot(normalizedTestPath) || normalizedWorkspaceRoot;
        
        this.logger.debug('Project root detected', {
            testFile: normalizedTestPath,
            projectRoot,
            workspaceRoot: normalizedWorkspaceRoot
        });

        // ────────── ENSURE TS-JEST IS INSTALLED ──────────
        // Without ts-jest in node_modules, Jest silently falls back to
        // babel-jest which CANNOT parse TypeScript syntax.
        if (!this.configService.isTsJestInstalled(projectRoot)) {
            this.logger.warn('ts-jest NOT found in node_modules — auto-installing...');
            const pkgService = new PackageInstallationService();
            // Detect Jest major version to pick compatible ts-jest
            const depService = new DependencyDetectionService();
            const jestVer = depService.getExistingJestVersion(projectRoot);
            const tsJestVer = (jestVer && jestVer.major === 28) ? '^28.0.8' : '^29.1.1';
            const typesVer = (jestVer && jestVer.major === 28) ? '^28.1.0' : '^29.5.11';
            await pkgService.installPackages(projectRoot, [
                `ts-jest@${tsJestVer}`,
                `@types/jest@${typesVer}`,
                'identity-obj-proxy@^3.0.0'
            ]);

            if (!this.configService.isTsJestInstalled(projectRoot)) {
                this.logger.error('ts-jest installation failed — tests will likely fail with Babel errors');
            } else {
                this.logger.info('ts-jest auto-installed successfully');
            }
        }

        // ────────── ENSURE TS-JEST CONFIG ──────────
        // Guarantee a valid ts-jest configuration exists before we ever spawn Jest.
        await this.configService.ensureValidJestConfig(projectRoot);

        const hasValidConfig = this.configService.hasJestConfig(projectRoot) 
                            && this.configService.validateExistingConfig(projectRoot);

        this.logger.debug('Jest config validation', { 
            projectRoot, 
            hasValidConfig,
            tsJestInstalled: this.configService.isTsJestInstalled(projectRoot)
        });

        // Always use 'npx jest' to invoke jest directly (never 'npm test'
        // which could be 'gulp test' in SPFx projects)
        const commandParts = jestCommand.split(' ');
        const command = commandParts[0];
        const baseArgs = commandParts.slice(1);

        // Build arguments array (safer than string concatenation)
        // CRITICAL: Use --testPathPattern with forward slashes for Windows compatibility.
        // Jest interprets the positional file argument as a regex, and Windows backslashes
        // break the regex matching, causing Jest to run ALL test files instead of just one.
        const testPathPattern = normalizedTestPath.replace(/\\/g, '/');
        const args = [
            ...baseArgs,
            '--testPathPattern',
            testPathPattern,
            '--no-coverage',
            '--verbose',
            '--colors'
        ];

        // If we STILL don't have a valid config on disk (edge case),
        // pass an inline config so ts-jest is guaranteed.
        if (!hasValidConfig) {
            const inlineArgs = this.configService.getInlineConfigArgs();
            args.push(...inlineArgs);
            this.logger.warn('Using inline ts-jest config as fallback');
        }

        this.logger.info(`Running Jest: ${command} ${args.join(' ')}`, {
            testFile: normalizedTestPath,
            projectRoot
        });

        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';

            // Use spawn instead of exec for better security
            const child = spawn(command, args, {
                cwd: projectRoot, // Use project root instead of workspace root
                env: { 
                    ...process.env, 
                    FORCE_COLOR: '1' // eslint-disable-line @typescript-eslint/naming-convention
                },
                shell: true // Required for npx/yarn to work on Windows
            });

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('error', (error) => {
                this.logger.error('Jest process error', error);
                resolve({
                    success: false,
                    output: `Process error: ${error.message}\n${stderr}`
                });
            });

            child.on('close', (code) => {
                const output = stdout + stderr;
                const success = code === 0;

                this.logger.debug(`Jest exited with code ${code}`, {
                    success,
                    outputLength: output.length
                });

                if (!success) {
                    this.logger.warn('Test execution failed', { exitCode: code });
                }

                resolve({
                    success,
                    output
                });
            });
        });
    }

    /**
     * Checks if Jest is available in the project
     * 
     * @param workspaceRoot - Root directory of the workspace
     * @param jestCommand - Command to check (e.g., 'npx jest', 'yarn jest') - ignored in favor of unified check
     * @returns Promise<boolean> indicating if Jest is installed
     */
    async isJestAvailable(
        workspaceRoot: string,
        jestCommand: string = 'npx jest'
    ): Promise<boolean> {
        this.logger.debug(`Checking Jest availability in: ${workspaceRoot}`);
        // Use unified detection logic
        return this.dependencyService.checkJestAvailability(workspaceRoot);
    }

    /**
     * Check if ts-jest is installed AND the jest config references it.
     * Used by callers that want to pre-validate before triggering a test run.
     */
    isEnvironmentReady(workspaceRoot: string): { ready: boolean; reason?: string } {
        const projectRoot = FileScanner.findProjectRoot(workspaceRoot) || workspaceRoot;

        if (!this.configService.isTsJestInstalled(projectRoot)) {
            return { ready: false, reason: 'ts-jest is not installed in node_modules' };
        }

        if (!this.configService.hasJestConfig(projectRoot)) {
            return { ready: false, reason: 'No jest.config.* file found' };
        }

        if (!this.configService.validateExistingConfig(projectRoot)) {
            return { ready: false, reason: 'jest.config exists but does not reference ts-jest' };
        }

        return { ready: true };
    }
}
