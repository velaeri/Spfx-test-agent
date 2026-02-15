import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger';
import { ILLMProvider, ProjectAnalysis, GeneratedJestConfig } from '../interfaces/ILLMProvider';

/**
 * Minimal ts-jest transform config — the ESSENTIAL piece to avoid Babel parsing TS
 */
const TS_JEST_TRANSFORM = {
    '^.+\\.tsx?$': ['ts-jest', {
        tsconfig: {
            jsx: 'react',
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            module: 'commonjs',
            target: 'es2015'
        }
    }]
};

/**
 * Build Default Jest configuration for SPFx projects.
 * setupFilesAfterEnv is only included when jest.setup.js exists.
 */
function buildDefaultJestConfig(projectRoot?: string): Record<string, unknown> {
    const config: Record<string, unknown> = {
        preset: 'ts-jest',
        testEnvironment: 'jsdom',
        moduleNameMapper: {
            '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
            '\\.(jpg|jpeg|png|gif|svg)$': '<rootDir>/__mocks__/fileMock.js'
        },
        testMatch: [
            '**/__tests__/**/*.(test|spec).ts?(x)',
            '**/?(*.)+(spec|test).ts?(x)'
        ],
        collectCoverageFrom: [
            'src/**/*.{ts,tsx}',
            '!src/**/*.d.ts',
            '!src/index.ts'
        ],
        transform: TS_JEST_TRANSFORM,
        transformIgnorePatterns: [
            'node_modules/'
        ],
        moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json']
    };

    // Only reference jest.setup.js when the setup file actually exists
    if (projectRoot) {
        const setupPath = path.join(projectRoot, 'jest.setup.js');
        if (fs.existsSync(setupPath)) {
            config.setupFilesAfterEnv = ['<rootDir>/jest.setup.js'];
        }
    }

    return config;
}

/**
 * Default jest.setup.js content — CommonJS, with safe try/catch so missing
 * packages don't blow up the whole test run.
 */
const JEST_SETUP_CONTENT = `// Jest setup file (CommonJS)
try {
  require('@testing-library/jest-dom');
} catch (_e) {
  // @testing-library/jest-dom not installed — skipping
}
`;

/**
 * File mock for static assets
 */
const FILE_MOCK_CONTENT = `module.exports = 'test-file-stub';
`;

export class JestConfigurationService {
    private logger: Logger;
    private llmProvider?: ILLMProvider;

    constructor(llmProvider?: ILLMProvider) {
        this.logger = Logger.getInstance();
        this.llmProvider = llmProvider;
    }

    /**
     * Check if project has a Jest configuration file
     * 
     * @param projectRoot - Project root directory
     * @returns True if jest.config.* exists
     */
    hasJestConfig(projectRoot: string): boolean {
        const configFiles = [
            'jest.config.js',
            'jest.config.ts',
            'jest.config.mjs',
            'jest.config.cjs',
            'jest.config.cts',
            'jest.config.json'
        ];

        return configFiles.some(file => 
            fs.existsSync(path.join(projectRoot, file))
        );
    }

    /**
     * Create jest.config.js using LLM-generated personalized configuration
     * Falls back to default config if LLM is unavailable
     */
    async createJestConfig(projectRoot: string): Promise<void> {
        const configPath = path.join(projectRoot, 'jest.config.js');
        
        // Try LLM-first approach if provider available
        if (this.llmProvider) {
            try {
                this.logger.info('Generating personalized Jest configuration via LLM...');
                const projectAnalysis = await this.buildProjectAnalysis(projectRoot);
                const requirements = this.detectRequirements(projectAnalysis);
                
                const llmConfig = await this.llmProvider.generateJestConfig({
                    projectAnalysis,
                    requirements
                });
                
                // Write LLM-generated config
                fs.writeFileSync(configPath, llmConfig.configJs, 'utf-8');
                
                // Write setup file if provided
                if (llmConfig.setupJs) {
                    const setupPath = path.join(projectRoot, 'jest.setup.js');
                    fs.writeFileSync(setupPath, llmConfig.setupJs, 'utf-8');
                    this.logger.info(`Created jest.setup.js from LLM`);
                }
                
                // Write custom mocks if provided
                if (Object.keys(llmConfig.mocks).length > 0) {
                    const mocksDir = path.join(projectRoot, '__mocks__');
                    if (!fs.existsSync(mocksDir)) {
                        fs.mkdirSync(mocksDir);
                    }
                    for (const [filename, content] of Object.entries(llmConfig.mocks)) {
                        fs.writeFileSync(path.join(mocksDir, filename), content, 'utf-8');
                    }
                    this.logger.info(`Created ${Object.keys(llmConfig.mocks).length} custom mocks`);
                }
                
                this.logger.info(`✅ Created LLM-personalized jest.config.js at ${configPath}`);
                this.logger.debug(`LLM explanation: ${llmConfig.explanation}`);
                return;
            } catch (error) {
                this.logger.warn('LLM config generation failed, falling back to default', error);
            }
        }
        
        // Fallback: Use default hardcoded config
        this.logger.info('Using default Jest configuration (LLM unavailable)');
        const config = buildDefaultJestConfig(projectRoot);
        const configContent = `module.exports = ${JSON.stringify(config, null, 2)};
`;
        fs.writeFileSync(configPath, configContent, 'utf-8');
        this.logger.info(`Created jest.config.js at ${configPath}`);
    }

    /**
     * Create jest.setup.js
     */
    async createJestSetup(projectRoot: string): Promise<void> {
        const setupPath = path.join(projectRoot, 'jest.setup.js');
        fs.writeFileSync(setupPath, JEST_SETUP_CONTENT, 'utf-8');
        this.logger.info(`Created jest.setup.js at ${setupPath}`);
    }

    /**
     * Create __mocks__ directory with file mock
     */
    async createMockDirectory(projectRoot: string): Promise<void> {
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
     * Update package.json to add test scripts.
     * Only adds scripts if missing or if the current "test" script is a placeholder.
     */
    async updatePackageJsonScripts(projectRoot: string): Promise<void> {
        const packageJsonPath = path.join(projectRoot, 'package.json');
        const content = fs.readFileSync(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);

        if (!packageJson.scripts) {
            packageJson.scripts = {};
        }

        // Override or add "test" if it's missing or a placeholder
        const currentTest = packageJson.scripts.test || '';
        const placeholderPatterns = ['echo "Error: no test specified"', 'exit 1', 'gulp test'];
        const isPlaceholder = !currentTest || placeholderPatterns.some(p => currentTest.includes(p));
        
        if (isPlaceholder) {
            packageJson.scripts.test = 'jest';
            this.logger.info(`Replaced test script "${currentTest}" with "jest"`);
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

    // ─────────────────────────────────────────────────────────────────────
    //  VALIDATION & RUNTIME GUARANTEE
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Validate whether an existing jest config file actually references ts-jest.
     * Returns true only when we can confirm ts-jest is configured.
     */
    validateExistingConfig(projectRoot: string): boolean {
        const configFiles = [
            'jest.config.js',
            'jest.config.ts',
            'jest.config.mjs',
            'jest.config.cjs',
            'jest.config.cts',
            'jest.config.json'
        ];

        for (const file of configFiles) {
            const configPath = path.join(projectRoot, file);
            if (fs.existsSync(configPath)) {
                try {
                    const content = fs.readFileSync(configPath, 'utf-8');
                    if (content.includes('ts-jest')) {
                        this.logger.debug(`ts-jest found in ${file}`);
                        return true;
                    }
                    this.logger.warn(`${file} exists but does NOT reference ts-jest`);
                } catch (err) {
                    this.logger.warn(`Failed to read ${file}`, err);
                }
            }
        }

        // Also check package.json "jest" field
        try {
            const pkgPath = path.join(projectRoot, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.jest && JSON.stringify(pkg.jest).includes('ts-jest')) {
                    this.logger.debug('ts-jest found in package.json "jest" field');
                    return true;
                }
            }
        } catch { /* ignore */ }

        return false;
    }

    /**
     * Ensure the project has a VALID jest config that uses ts-jest.
     * If one exists without ts-jest, back it up and create a new one.
     * If none exists, create one.
     *
     * @returns true if configuration was created/updated, false if already valid
     */
    async ensureValidJestConfig(projectRoot: string): Promise<boolean> {
        // 1. Already valid?
        if (this.hasJestConfig(projectRoot) && this.validateExistingConfig(projectRoot)) {
            this.logger.info('Existing jest config already uses ts-jest — no changes needed');
            return false;
        }

        // 2. Config exists but does NOT use ts-jest → back up & replace
        if (this.hasJestConfig(projectRoot)) {
            const existing = ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs']
                .find(f => fs.existsSync(path.join(projectRoot, f)));
            if (existing) {
                const src = path.join(projectRoot, existing);
                const backup = src + '.backup';
                fs.copyFileSync(src, backup);
                this.logger.warn(`Backed up ${existing} to ${existing}.backup (missing ts-jest)`);
                // Remove old config so createJestConfig can write a new one
                fs.unlinkSync(src);
            }
        }

        // 3. Create a brand-new valid config
        await this.createJestConfig(projectRoot);
        this.logger.info('Created new jest.config.js with ts-jest transform');
        return true;
    }

    /**
     * Build CLI args that guarantee ts-jest is used even without a config file.
     * Useful as a last-resort fallback when running jest.
     */
    getInlineConfigArgs(): string[] {
        const inlineConfig = JSON.stringify({
            transform: TS_JEST_TRANSFORM,
            testEnvironment: 'jsdom',
            moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
            moduleNameMapper: {
                '\\.(css|less|scss|sass)$': 'identity-obj-proxy'
            }
        });
        return ['--config', inlineConfig];
    }

    /**
     * Check if ts-jest is installed in node_modules
     */
    isTsJestInstalled(projectRoot: string): boolean {
        const tsJestPath = path.join(projectRoot, 'node_modules', 'ts-jest');
        return fs.existsSync(tsJestPath);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  LLM-FIRST HELPERS
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Build project analysis for LLM
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
        
        // Find existing tests
        const existingTests: string[] = [];
        const srcDir = path.join(projectRoot, 'src');
        if (fs.existsSync(srcDir)) {
            this.findTestFiles(srcDir, existingTests);
        }
        
        return {
            packageJson,
            tsConfig,
            existingJestConfig,
            existingTests: existingTests.slice(0, 5), // Only first 5 as examples
            dependencies: packageJson.dependencies || {},
            devDependencies: packageJson.devDependencies || {},
            framework: this.detectFramework(packageJson),
            reactVersion: packageJson.dependencies?.react || packageJson.devDependencies?.react,
            nodeVersion: packageJson.engines?.node
        };
    }

    private findTestFiles(dir: string, results: string[]): void {
        if (results.length >= 5) return; // Limit to 5 examples
        
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (results.length >= 5) break;
                
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && entry.name !== 'node_modules') {
                    this.findTestFiles(fullPath, results);
                } else if (entry.name.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) {
                    results.push(fs.readFileSync(fullPath, 'utf-8').substring(0, 500)); // First 500 chars
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

    private detectRequirements(analysis: ProjectAnalysis): string[] {
        const requirements: string[] = [];
        
        // Framework-specific requirements (detected dynamically)
        switch (analysis.framework) {
            case 'spfx':
                requirements.push('Support SharePoint Framework (SPFx) components');
                requirements.push('Mock @microsoft/sp-* modules');
                requirements.push('Handle Office UI Fabric / Fluent UI');
                break;
            case 'angular':
                requirements.push('Support Angular components with TestBed');
                requirements.push('Configure zone.js for testing');
                break;
            case 'next':
                requirements.push('Support Next.js with server/client components');
                requirements.push('Mock next/router and next/navigation');
                break;
            case 'vue':
                requirements.push('Support Vue components with @vue/test-utils');
                break;
            case 'react':
                requirements.push('Support React components and JSX/TSX');
                requirements.push('Configure jsdom test environment');
                break;
            case 'vscode-extension':
                requirements.push('Support VS Code extension API mocking');
                break;
        }
        
        if (analysis.reactVersion) {
            requirements.push('Support React components and JSX/TSX');
            requirements.push('Configure jsdom test environment');
        }
        
        if (analysis.tsConfig?.compilerOptions?.jsx) {
            requirements.push('Transform TypeScript with JSX support');
        }
        
        if (analysis.devDependencies['@testing-library/react']) {
            requirements.push('Support Testing Library matchers');
        }
        
        requirements.push('Use ts-jest for TypeScript transformation');
        requirements.push('Mock CSS/SCSS imports');
        requirements.push('Mock static assets (images, fonts)');
        
        return requirements;
    }
}
