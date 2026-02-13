import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger';
import { DependencyDetectionService } from './DependencyDetectionService';
import { PackageInstallationService } from './PackageInstallationService';
import { JestConfigurationService } from './JestConfigurationService';
import { ILLMProvider } from '../interfaces/ILLMProvider';
import { LLMProviderFactory } from '../factories/LLMProviderFactory';

export interface SetupStatus {
    hasPackageJson: boolean;
    hasJest: boolean;
    hasJestConfig: boolean;
    hasJestSetup: boolean;
    missingDependencies: string[];
    errors: string[];
    warnings: string[];
    installCommand?: string; // npm install command to execute
}

export interface SetupOptions {
    autoInstall?: boolean;
    force?: boolean;
}

/**
 * Service to validate and setup Jest testing environment in SPFx projects
 */
export class ProjectSetupService {
    private logger: Logger;
    private dependencyService: DependencyDetectionService;
    private packageService: PackageInstallationService;
    private configService: JestConfigurationService;
    private llmProvider: ILLMProvider;

    constructor(llmProvider?: ILLMProvider) {
        this.logger = Logger.getInstance();
        // Use provided LLM or create default
        this.llmProvider = llmProvider || LLMProviderFactory.createProvider();
        this.dependencyService = new DependencyDetectionService();
        this.packageService = new PackageInstallationService();
        this.configService = new JestConfigurationService(this.llmProvider);
    }

    /**
     * Check if the project is ready for testing
     */
    async checkProjectSetup(projectRoot: string): Promise<SetupStatus> {
        const status: SetupStatus = {
            hasPackageJson: false,
            hasJest: false,
            hasJestConfig: false,
            hasJestSetup: false,
            missingDependencies: [],
            errors: [],
            warnings: []
        };

        // Check package.json exists
        const packageJsonPath = path.join(projectRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            status.errors.push('No package.json found in project root');
            return status;
        }
        status.hasPackageJson = true;

        // Read package.json
        let packageJson: any;
        try {
            const content = fs.readFileSync(packageJsonPath, 'utf-8');
            packageJson = JSON.parse(content);
        } catch (error) {
            status.errors.push(`Failed to parse package.json: ${error}`);
            return status;
        }

        // Check Jest dependencies (use LLM-powered intelligent version detection)
        const allDeps = {
            ...packageJson.dependencies || {},
            ...packageJson.devDependencies || {}
        };

        this.logger.debug('All dependencies found in package.json', {
            total: Object.keys(allDeps).length,
            hasDeps: !!packageJson.dependencies,
            hasDevDeps: !!packageJson.devDependencies
        });

        status.hasJest = await this.dependencyService.checkJestAvailability(projectRoot);

        // Get LLM-recommended dependencies (intelligent detection)
        const compatibleDeps = await this.dependencyService.getCompatibleDependencies(projectRoot);

        this.logger.debug('LLM-recommended dependencies', {
            packages: Object.keys(compatibleDeps),
            count: Object.keys(compatibleDeps).length
        });

        // Check which dependencies are missing
        for (const [pkg, version] of Object.entries(compatibleDeps)) {
            if (!allDeps[pkg]) {
                this.logger.debug(`Missing dependency: ${pkg}`);
                status.missingDependencies.push(pkg);
            } else {
                this.logger.debug(`Dependency found: ${pkg} = ${allDeps[pkg]}`);
            }
        }

        // Generate npm install command if there are missing dependencies
        if (status.missingDependencies.length > 0) {
            const packageVersions = status.missingDependencies.map(pkg => {
                const version = compatibleDeps[pkg];
                return `${pkg}@${version}`;
            });
            status.installCommand = `npm install --save-dev --legacy-peer-deps ${packageVersions.join(' ')}`;
        } else {
            this.logger.info('✅ All required Jest dependencies are installed');
        }

        // Check jest.config.js or jest.config.ts
        status.hasJestConfig = this.configService.hasJestConfig(projectRoot);

        // Check jest.setup.js
        const jestSetupPath = path.join(projectRoot, 'jest.setup.js');
        status.hasJestSetup = fs.existsSync(jestSetupPath);

        // Add warnings
        if (!status.hasJestConfig) {
            status.warnings.push('No jest.config.js found - using default configuration');
        }
        if (!status.hasJestSetup) {
            status.warnings.push('No jest.setup.js found - testing-library/jest-dom may not work');
        }

        return status;
    }

    /**
     * Setup the project for testing (create config files only, return install command)
     */
    async setupProject(projectRoot: string, options: SetupOptions = {}): Promise<{ success: boolean; installCommand?: string }> {
        this.logger.info(`Setting up Jest environment in: ${projectRoot}`);

        const status = await this.checkProjectSetup(projectRoot);

        // Create progress notification
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Setting up Jest testing environment',
            cancellable: false
        }, async (progress) => {
            try {
                // Step 1: Ensure jest.config.js with ts-jest (create or fix)
                if (!status.hasJestConfig || options.force) {
                    progress.report({ message: 'Creating jest.config.js with ts-jest...', increment: 30 });
                    await this.configService.createJestConfig(projectRoot);
                } else {
                    // Validate existing config has ts-jest
                    progress.report({ message: 'Validating jest.config.js...', increment: 15 });
                    const configUpdated = await this.configService.ensureValidJestConfig(projectRoot);
                    if (configUpdated) {
                        progress.report({ message: 'Updated jest.config.js with ts-jest...', increment: 15 });
                    }
                }

                // Step 2: Create jest.setup.js if missing
                if (!status.hasJestSetup || options.force) {
                    progress.report({ message: 'Creating jest.setup.js...', increment: 20 });
                    await this.configService.createJestSetup(projectRoot);
                }

                // Step 3: Create __mocks__ directory
                progress.report({ message: 'Creating mock directories...', increment: 20 });
                await this.configService.createMockDirectory(projectRoot);

                // Step 4: Update package.json scripts
                progress.report({ message: 'Updating package.json scripts...', increment: 20 });
                await this.configService.updatePackageJsonScripts(projectRoot);

                // Auto install if requested with LLM-powered retry loop
                if (options.autoInstall && status.installCommand) {
                    const maxInstallRetries = 3;
                    let installAttempt = 0;
                    let installSuccess = false;
                    let lastInstallError: string | undefined;

                    progress.report({ message: 'Installing dependencies with LLM validation...', increment: 10 });

                    while (installAttempt < maxInstallRetries && !installSuccess) {
                        installAttempt++;
                        this.logger.info(`📦 Installation attempt ${installAttempt}/${maxInstallRetries}...`);

                        // Get package versions (from LLM or previous analysis)
                        let packageVersions: string[];

                        if (installAttempt === 1) {
                            // First attempt: use LLM-validated versions
                            const compatibleDeps = await this.dependencyService.getCompatibleDependencies(projectRoot);
                            packageVersions = status.missingDependencies.map(pkg => {
                                const version = compatibleDeps[pkg];
                                return `${pkg}@${version}`;
                            });
                        } else {
                            // Subsequent attempts: ask LLM to fix based on error
                            this.logger.info('❌ Installation failed, asking LLM to analyze and fix...');
                            
                            const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
                            const analysis = await this.llmProvider.analyzeAndFixError(lastInstallError!, {
                                packageJson,
                                errorType: 'dependency'
                            });

                            this.logger.info(`🧠 LLM diagnosis: ${analysis.diagnosis}`);

                            if (analysis.packages && analysis.packages.length > 0) {
                                packageVersions = analysis.packages;
                                this.logger.info(`🔄 LLM suggested packages: ${packageVersions.join(', ')}`);
                            } else {
                                this.logger.warn('LLM did not suggest alternative packages, retrying with same versions');
                                const compatibleDeps = await this.dependencyService.getCompatibleDependencies(projectRoot);
                                packageVersions = status.missingDependencies.map(pkg => {
                                    const version = compatibleDeps[pkg];
                                    return `${pkg}@${version}`;
                                });
                            }
                        }

                        // Attempt installation
                        const installResult = await this.packageService.installPackages(projectRoot, packageVersions);

                        if (installResult.success) {
                            installSuccess = true;
                            this.logger.info('✅ Dependencies installed successfully');
                            progress.report({ message: 'Dependencies installed successfully', increment: 10 });
                        } else {
                            lastInstallError = installResult.error || 'Unknown installation error';
                            this.logger.warn(`❌ Installation attempt ${installAttempt} failed: ${lastInstallError.substring(0, 200)}`);
                        }
                    }

                    if (!installSuccess) {
                        const errorMsg = `Failed to install dependencies after ${maxInstallRetries} attempts. Last error: ${lastInstallError}`;
                        this.logger.error(errorMsg);
                        throw new Error(errorMsg);
                    }
                }

                progress.report({ message: 'Setup complete!', increment: 100 });
                
                this.logger.info('Jest configuration files created successfully');
                
                // Return success and install command if dependencies are missing
                return {
                    success: true,
                    installCommand: status.installCommand
                };
            } catch (error) {
                this.logger.error('Setup failed', error);
                return {
                    success: false
                };
            }
        });

        return result;
    }

    /**
     * Verify the installation by running a dummy test
     */
    async verifyInstallation(projectRoot: string): Promise<{ success: boolean; message: string }> {
        const testRunner = new (await import('../utils/TestRunner')).TestRunner();
        
        // Create a temporary verification test file
        const verifyFile = path.join(projectRoot, 'src', 'verify-setup.test.ts');
        const verifyContent = `
describe('Setup Verification', () => {
    it('should run a simple test', () => {
        expect(true).toBe(true);
    });
});
`;
        
        try {
            // Ensure src directory exists
            const srcDir = path.dirname(verifyFile);
            if (!fs.existsSync(srcDir)) {
                fs.mkdirSync(srcDir, { recursive: true });
            }

            fs.writeFileSync(verifyFile, verifyContent, 'utf-8');
            
            // Run the test
            this.logger.info('Running verification test...');
            const result = await testRunner.runTest(verifyFile, projectRoot);
            
            // Cleanup
            if (fs.existsSync(verifyFile)) {
                fs.unlinkSync(verifyFile);
            }
            
            if (result.success) {
                return { success: true, message: 'Verification test passed' };
            } else {
                return { 
                    success: false, 
                    message: `Verification failed: ${result.output.substring(0, 200)}...` 
                };
            }
        } catch (error) {
            // Cleanup on error
            if (fs.existsSync(verifyFile)) {
                try { fs.unlinkSync(verifyFile); } catch {}
            }
            return { 
                success: false, 
                message: `Verification error: ${error instanceof Error ? error.message : String(error)}` 
            };
        }
    }

    /**
     * Show setup status to user
     */
    async showSetupStatus(projectRoot: string): Promise<void> {
        const status = await this.checkProjectSetup(projectRoot);

        const statusItems: string[] = [
            `Package.json: ${status.hasPackageJson ? '✅' : '❌'}`,
            `Jest installed: ${status.hasJest ? '✅' : '❌'}`,
            `Jest config: ${status.hasJestConfig ? '✅' : '⚠️ (using defaults)'}`,
            `Jest setup: ${status.hasJestSetup ? '✅' : '⚠️ (optional)'}`,
            ''
        ];

        if (status.missingDependencies.length > 0) {
            statusItems.push(`Missing dependencies (${status.missingDependencies.length}):`);
            status.missingDependencies.slice(0, 5).forEach(dep => {
                statusItems.push(`  - ${dep}`);
            });
            if (status.missingDependencies.length > 5) {
                statusItems.push(`  ... and ${status.missingDependencies.length - 5} more`);
            }
            statusItems.push('');
        }

        if (status.errors.length > 0) {
            statusItems.push('Errors:');
            status.errors.forEach(err => statusItems.push(`  ❌ ${err}`));
            statusItems.push('');
        }

        if (status.warnings.length > 0) {
            statusItems.push('Warnings:');
            status.warnings.forEach(warn => statusItems.push(`  ⚠️ ${warn}`));
        }

        const message = statusItems.join('\n');
        
        // Log status details to output channel
        this.logger.info('Project Setup Status:', message);

        if (!status.hasJest || status.missingDependencies.length > 0) {
            // Show non-blocking warning with actions
            vscode.window.showWarningMessage(
                'Jest testing environment not ready',
                'Setup Now', 'Show Details'
            ).then(async selection => {
                if (selection === 'Setup Now') {
                    await this.setupProject(projectRoot, { autoInstall: true });
                } else if (selection === 'Show Details') {
                    const doc = await vscode.workspace.openTextDocument({
                        content: message,
                        language: 'markdown'
                    });
                    await vscode.window.showTextDocument(doc);
                }
            });
        } else {
            vscode.window.showInformationMessage('✅ Jest environment ready');
        }
    }
}