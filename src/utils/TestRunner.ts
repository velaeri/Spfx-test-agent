import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Result of a test execution
 */
export interface TestRunResult {
    success: boolean;
    output: string;
}

/**
 * TestRunner - Wrapper around child_process.exec to run Jest tests
 * 
 * This utility executes Jest on a specific test file and returns
 * structured results indicating success/failure along with the output.
 */
export class TestRunner {
    /**
     * Runs Jest on a specific test file
     * 
     * @param testFilePath - Absolute path to the test file
     * @param workspaceRoot - Root directory of the workspace (where package.json is)
     * @returns Promise with test results
     */
    async runTest(testFilePath: string, workspaceRoot: string): Promise<TestRunResult> {
        try {
            // Run Jest with specific configuration to test only this file
            // --no-coverage: Skip coverage reporting to reduce noise
            // --verbose: Get detailed output
            // --colors: Keep colors for better readability (will be cleaned by parser)
            const command = `npx jest "${testFilePath}" --no-coverage --verbose --colors`;
            
            const { stdout, stderr } = await execAsync(command, {
                cwd: workspaceRoot,
                env: { ...process.env, FORCE_COLOR: '1' }, // eslint-disable-line @typescript-eslint/naming-convention
                maxBuffer: 1024 * 1024 * 10 // 10MB buffer for large outputs
            });

            // Jest returns exit code 0 on success
            return {
                success: true,
                output: stdout + stderr
            };
        } catch (error: unknown) {
            // Jest returns non-zero exit code on test failures
            // We still capture the output for analysis
            const execError = error as { stdout?: string; stderr?: string; message: string };
            return {
                success: false,
                output: execError.stdout ? execError.stdout + (execError.stderr || '') : execError.message
            };
        }
    }

    /**
     * Checks if Jest is available in the project
     * 
     * @param workspaceRoot - Root directory of the workspace
     * @returns Promise<boolean> indicating if Jest is installed
     */
    async isJestAvailable(workspaceRoot: string): Promise<boolean> {
        try {
            await execAsync('npx jest --version', {
                cwd: workspaceRoot
            });
            return true;
        } catch {
            return false;
        }
    }
}
