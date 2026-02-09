import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Logger } from './Logger';

/**
 * Required Jest dependencies for SPFx projects
 */
const JEST_DEPENDENCIES = {
    // Core Jest packages
    'jest': '^29.7.0',
    '@types/jest': '^29.5.11',
    'ts-jest': '^29.1.1',
    
    // React Testing Library (SPFx uses React)
    '@testing-library/react': '^14.1.2',
    '@testing-library/jest-dom': '^6.1.5',
    '@testing-library/user-event': '^14.5.1',
    
    // Additional React test utilities
    'react-test-renderer': '^17.0.1',
    '@types/react-test-renderer': '^17.0.1',
    
    // Identity mock for module imports (CSS, images, etc.)
    'identity-obj-proxy': '^3.0.0'
};

/**
 * Default Jest configuration for SPFx projects
 */
const DEFAULT_JEST_CONFIG = {
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    moduleNameMapper: {
        '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
        '\\.(jpg|jpeg|png|gif|svg)$': '<rootDir>/__mocks__/fileMock.js'
    },
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    testMatch: [
        '**/__tests__/**/*.(test|spec).ts?(x)',
        '**/?(*.)+(spec|test).ts?(x)'
    ],
    collectCoverageFrom: [
        'src/**/*.{ts,tsx}',
        '!src/**/*.d.ts',
        '!src/index.ts'
    ],
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: {
                jsx: 'react',
                esModuleInterop: true,
                allowSyntheticDefaultImports: true
            }
        }]
    },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json']
};

/**
 * Default jest.setup.js content
 */
const JEST_SETUP_CONTENT = `// Jest setup file
import '@testing-library/jest-dom';

// Mock SharePoint framework context if needed
global.spfxContext = {};
`;

/**
 * File mock for static assets
 */
const FILE_MOCK_CONTENT = `module.exports = 'test-file-stub';
`;

export interface SetupStatus {
    hasPackageJson: boolean;
    hasJest: boolean;
    hasJestConfig: boolean;
    hasJestSetup: boolean;
    missingDependencies: string[];
    errors: string[];
    warnings: string[];
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

    constructor() {
        this.logger = Logger.getInstance();
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

        // Check Jest dependencies
        const allDeps = {
            ...packageJson.dependencies || {},
            ...packageJson.devDependencies || {}
        };

        for (const [pkg, _version] of Object.entries(JEST_DEPENDENCIES)) {
            if (!allDeps[pkg]) {
                status.missingDependencies.push(pkg);
            }
        }

        status.hasJest = allDeps['jest'] !== undefined;

        // Check jest.config.js or jest.config.ts
        const jestConfigPaths = [
            path.join(projectRoot, 'jest.config.js'),
            path.join(projectRoot, 'jest.config.ts'),
            path.join(projectRoot, 'jest.config.json')
        ];
        status.hasJestConfig = jestConfigPaths.some(p => fs.existsSync(p));

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
     * Setup the project for testing (install dependencies, create config files)
     */
    async setupProject(projectRoot: string, options: SetupOptions = {}): Promise<boolean> {
        this.logger.info(`Setting up Jest environment in: ${projectRoot}`);

        const status = await this.checkProjectSetup(projectRoot);

        // Create progress notification
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Setting up Jest testing environment',
            cancellable: false
        }, async (progress) => {
            try {
                // Step 1: Install missing dependencies
                if (status.missingDependencies.length > 0) {
                    progress.report({ message: 'Installing Jest dependencies...', increment: 10 });
                    
                    if (options.autoInstall !== false) {
                        const success = await this.installDependencies(projectRoot, status.missingDependencies);
                        if (!success) {
                            vscode.window.showErrorMessage('Failed to install Jest dependencies');
                            return false;
                        }
                    } else {
                        const install = await vscode.window.showInformationMessage(
                            `Missing ${status.missingDependencies.length} Jest dependencies. Install now?`,
                            'Yes', 'No'
                        );
                        if (install === 'Yes') {
                            const success = await this.installDependencies(projectRoot, status.missingDependencies);
                            if (!success) {
                                return false;
                            }
                        } else {
                            return false;
                        }
                    }
                }

                // Step 2: Create jest.config.js if missing
                if (!status.hasJestConfig || options.force) {
                    progress.report({ message: 'Creating jest.config.js...', increment: 30 });
                    await this.createJestConfig(projectRoot);
                }

                // Step 3: Create jest.setup.js if missing
                if (!status.hasJestSetup || options.force) {
                    progress.report({ message: 'Creating jest.setup.js...', increment: 20 });
                    await this.createJestSetup(projectRoot);
                }

                // Step 4: Create __mocks__ directory
                progress.report({ message: 'Creating mock directories...', increment: 20 });
                await this.createMockDirectory(projectRoot);

                // Step 5: Update package.json scripts
                progress.report({ message: 'Updating package.json scripts...', increment: 20 });
                await this.updatePackageJsonScripts(projectRoot);

                progress.report({ message: 'Setup complete!', increment: 100 });
                
                this.logger.info('Jest setup completed successfully');
                vscode.window.showInformationMessage('✅ Jest testing environment setup complete!');
                
                return true;
            } catch (error) {
                this.logger.error('Setup failed', error);
                vscode.window.showErrorMessage(`Setup failed: ${error}`);
                return false;
            }
        });
    }

    /**
     * Install dependencies using npm
     */
    private async installDependencies(projectRoot: string, packages: string[]): Promise<boolean> {
        this.logger.info(`Installing packages: ${packages.join(', ')}`);

        const packageVersions = packages.map(pkg => {
            const version = JEST_DEPENDENCIES[pkg as keyof typeof JEST_DEPENDENCIES];
            return version ? `${pkg}@${version}` : pkg;
        });

        return new Promise((resolve) => {
            const npmProcess = spawn('npm', ['install', '--save-dev', ...packageVersions], {
                cwd: projectRoot,
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let output = '';
            npmProcess.stdout?.on('data', (data) => {
                output += data.toString();
            });

            npmProcess.stderr?.on('data', (data) => {
                output += data.toString();
            });

            npmProcess.on('close', (code) => {
                if (code === 0) {
                    this.logger.info('Dependencies installed successfully');
                    resolve(true);
                } else {
                    this.logger.error('npm install failed', new Error(output));
                    resolve(false);
                }
            });

            npmProcess.on('error', (error) => {
                this.logger.error('Failed to spawn npm process', error);
                resolve(false);
            });
        });
    }

    /**
     * Create jest.config.js
     */
    private async createJestConfig(projectRoot: string): Promise<void> {
        const configPath = path.join(projectRoot, 'jest.config.js');
        
        const configContent = `module.exports = ${JSON.stringify(DEFAULT_JEST_CONFIG, null, 2)};
`;

        fs.writeFileSync(configPath, configContent, 'utf-8');
        this.logger.info(`Created jest.config.js at ${configPath}`);
    }

    /**
     * Create jest.setup.js
     */
    private async createJestSetup(projectRoot: string): Promise<void> {
        const setupPath = path.join(projectRoot, 'jest.setup.js');
        fs.writeFileSync(setupPath, JEST_SETUP_CONTENT, 'utf-8');
        this.logger.info(`Created jest.setup.js at ${setupPath}`);
    }

    /**
     * Create __mocks__ directory with file mock
     */
    private async createMockDirectory(projectRoot: string): Promise<void> {
        const mocksDir = path.join(projectRoot, '__mocks__');
        if (!fs.existsSync(mocksDir)) {
            fs.mkdirSync(mocksDir);
        }

        const fileMockPath = path.join(mocksDir, 'fileMock.js');
        if (!fs.existsSync(fileMockPath)) {
            fs.writeFileSync(fileMockPath, FILE_MOCK_CONTENT, 'utf-8');
        }

        this.logger.info(`Created __mocks__ directory at ${mocksDir}`);
    }

    /**
     * Update package.json to add test scripts
     */
    private async updatePackageJsonScripts(projectRoot: string): Promise<void> {
        const packageJsonPath = path.join(projectRoot, 'package.json');
        const content = fs.readFileSync(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);

        if (!packageJson.scripts) {
            packageJson.scripts = {};
        }

        // Add test scripts if they don't exist
        if (!packageJson.scripts.test) {
            packageJson.scripts.test = 'jest';
        }
        if (!packageJson.scripts['test:watch']) {
            packageJson.scripts['test:watch'] = 'jest --watch';
        }
        if (!packageJson.scripts['test:coverage']) {
            packageJson.scripts['test:coverage'] = 'jest --coverage';
        }

        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf-8');
        this.logger.info('Updated package.json scripts');
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
        
        if (!status.hasJest || status.missingDependencies.length > 0) {
            const setup = await vscode.window.showWarningMessage(
                'Jest testing environment not ready',
                { modal: true, detail: message },
                'Setup Now', 'Show Details'
            );

            if (setup === 'Setup Now') {
                await this.setupProject(projectRoot, { autoInstall: true });
            } else if (setup === 'Show Details') {
                const doc = await vscode.workspace.openTextDocument({
                    content: message,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc);
            }
        } else {
            vscode.window.showInformationMessage('✅ Jest environment ready', { detail: message });
        }
    }
}
