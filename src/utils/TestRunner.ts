import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../services/Logger';
import { DependencyDetectionService } from '../services/DependencyDetectionService';
import { JestConfigurationService } from '../services/JestConfigurationService';
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
     * Runs Jest on a specific test file
     * 
     * @param testFilePath - Absolute path to the test file
     * @param workspaceRoot - Root directory of the workspace (where package.json is)
     * @param jestCommand - Command to run Jest (e.g., 'npx jest', 'yarn jest')
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

        // Check if jest.config exists
        const hasJestConfig = this.configService.hasJestConfig(projectRoot);
        this.logger.debug('Jest config check', { 
            projectRoot, 
            hasJestConfig 
        });

        // Parse jest command (support for 'npx jest', 'yarn jest', etc.)
        const commandParts = jestCommand.split(' ');
        const command = commandParts[0];
        const baseArgs = commandParts.slice(1);

        // Build arguments array (safer than string concatenation)
        const args = [
            ...baseArgs,
            normalizedTestPath,
            '--no-coverage',
            '--verbose',
            '--colors'
        ];

        // If no jest.config, add passWithNoTests to avoid errors
        if (!hasJestConfig) {
            args.push('--passWithNoTests');
            args.push('--testEnvironment=node');
            this.logger.info('No Jest config found, using default configuration');
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
}
