/**
 * RepoInspector — Inspects a target repository to detect its stack,
 * testing infrastructure, existing tests, and critical paths.
 *
 * This is the "Fase 0" of the pipeline: pure discovery, no mutations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../services/Logger';
import { StackDiscoveryService, ProjectStack } from '../services/StackDiscoveryService';

// ────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────

export interface RepoInspection {
    /** Detected technology stack */
    stack: ProjectStack;
    /** Key filesystem paths */
    paths: RepoPaths;
    /** npm scripts related to testing */
    scripts: RepoScripts;
    /** Whether a setupTests file exists */
    hasSetupFile: boolean;
    /** Jest/Vitest config parsed (raw object) */
    testConfig: TestConfigInfo | null;
    /** Existing mock files inventory */
    existingMocks: MockFileInfo[];
    /** Existing test helper files */
    existingHelpers: string[];
    /** Local rules files found */
    localRulesFiles: string[];
    /** Package.json partial (name, scripts, deps) */
    packageInfo: PackageInfo | null;
}

export interface RepoPaths {
    root: string;
    sourceRoot: string;
    testConfigPath: string | null;
    mockDirs: string[];
    helperDirs: string[];
    existingTestFiles: string[];
    sourceFiles: string[];
}

export interface RepoScripts {
    test: string | null;
    coverage: string | null;
    lint: string | null;
}

export interface TestConfigInfo {
    runner: 'jest' | 'vitest' | 'mocha' | 'unknown';
    configFilePath: string;
    preset: string | null;
    testEnvironment: string | null;
    setupFiles: string[];
    moduleNameMapper: Record<string, string>;
    coverageThresholds: Record<string, number> | null;
    transformConfig: Record<string, unknown> | null;
    collectCoverageFrom: string[];
}

export interface MockFileInfo {
    filePath: string;
    relativePath: string;
    type: 'moduleNameMapper' | 'manual' | 'inline';
    mockedModule: string | null;
}

export interface PackageInfo {
    name: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
}

// ────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────

export class RepoInspector {
    private logger: Logger;
    private stackService: StackDiscoveryService;

    constructor() {
        this.logger = Logger.getInstance();
        this.stackService = new StackDiscoveryService();
    }

    /**
     * Full inspection of a repository.
     * This is synchronous-heavy (filesystem reads) but safe — no mutations.
     */
    async inspect(repoRoot: string): Promise<RepoInspection> {
        this.logger.info(`RepoInspector: inspecting ${repoRoot}`);

        const packageInfo = this.readPackageInfo(repoRoot);
        const stack = await this.stackService.discover(repoRoot);
        const paths = this.discoverPaths(repoRoot);
        const scripts = this.extractScripts(packageInfo);
        const testConfig = this.readTestConfig(repoRoot, paths.testConfigPath);
        const existingMocks = this.inventoryMocks(repoRoot, paths.mockDirs);
        const existingHelpers = this.inventoryHelpers(paths.helperDirs);
        const localRulesFiles = this.findLocalRules(repoRoot);
        const hasSetupFile = this.checkSetupFile(repoRoot);

        const inspection: RepoInspection = {
            stack,
            paths,
            scripts,
            hasSetupFile,
            testConfig,
            existingMocks,
            existingHelpers,
            localRulesFiles,
            packageInfo,
        };

        this.logger.info('RepoInspector: inspection complete', {
            framework: stack.framework,
            testRunner: stack.testRunner,
            sourceFiles: paths.sourceFiles.length,
            existingTests: paths.existingTestFiles.length,
            mocks: existingMocks.length,
        });

        return inspection;
    }

    // ── Package.json ──

    private readPackageInfo(root: string): PackageInfo | null {
        const pkgPath = path.join(root, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            this.logger.warn('No package.json found');
            return null;
        }
        try {
            const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            return {
                name: raw.name || '',
                dependencies: raw.dependencies || {},
                devDependencies: raw.devDependencies || {},
                scripts: raw.scripts || {},
            };
        } catch (e) {
            this.logger.error('Failed to parse package.json', e);
            return null;
        }
    }

    // ── Paths ──

    private discoverPaths(root: string): RepoPaths {
        const sourceRoot = this.findSourceRoot(root);
        const testConfigPath = this.findTestConfig(root);
        const mockDirs = this.findDirectories(root, ['__mocks__', 'src/__mocks__']);
        const helperDirs = this.findDirectories(root, ['__testHelpers__', 'src/__testHelpers__', 'test/helpers', 'tests/helpers']);
        const sourceFiles = this.scanFiles(sourceRoot, /\.(ts|tsx|js|jsx)$/, /\.(test|spec|stories)\./);
        const existingTestFiles = this.scanFiles(sourceRoot, /\.(test|spec)\.(ts|tsx|js|jsx)$/);

        return {
            root,
            sourceRoot,
            testConfigPath,
            mockDirs,
            helperDirs,
            existingTestFiles,
            sourceFiles,
        };
    }

    private findSourceRoot(root: string): string {
        const candidates = ['src', 'lib', 'app', 'source'];
        for (const candidate of candidates) {
            const candidatePath = path.join(root, candidate);
            if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
                return candidatePath;
            }
        }
        return root;
    }

    private findTestConfig(root: string): string | null {
        const candidates = [
            'jest.config.js',
            'jest.config.ts',
            'jest.config.mjs',
            'jest.config.cjs',
            'jest.config.json',
            'vitest.config.ts',
            'vitest.config.js',
            'vitest.config.mts',
            '.mocharc.yml',
            '.mocharc.json',
        ];
        for (const candidate of candidates) {
            const fullPath = path.join(root, candidate);
            if (fs.existsSync(fullPath)) {
                return fullPath;
            }
        }
        return null;
    }

    private findDirectories(root: string, candidates: string[]): string[] {
        const found: string[] = [];
        for (const candidate of candidates) {
            const fullPath = path.join(root, candidate);
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                found.push(fullPath);
            }
        }
        return found;
    }

    private scanFiles(dir: string, matchPattern: RegExp, excludePattern?: RegExp): string[] {
        const results: string[] = [];
        if (!fs.existsSync(dir)) { return results; }

        const walk = (currentDir: string): void => {
            try {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(currentDir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') {
                            continue;
                        }
                        walk(fullPath);
                    } else if (entry.isFile()) {
                        if (matchPattern.test(entry.name)) {
                            if (excludePattern && excludePattern.test(entry.name)) {
                                continue;
                            }
                            results.push(fullPath);
                        }
                    }
                }
            } catch {
                // Permission denied or similar — skip silently
            }
        };

        walk(dir);
        return results;
    }

    // ── Scripts ──

    private extractScripts(pkg: PackageInfo | null): RepoScripts {
        if (!pkg) {
            return { test: null, coverage: null, lint: null };
        }
        const scripts = pkg.scripts;
        return {
            test: scripts['test'] || scripts['test:unit'] || null,
            coverage: scripts['test:coverage'] || scripts['coverage'] || null,
            lint: scripts['lint'] || scripts['lint:fix'] || null,
        };
    }

    // ── Test config ──

    private readTestConfig(root: string, configPath: string | null): TestConfigInfo | null {
        if (!configPath) { return null; }

        try {
            const ext = path.extname(configPath);
            let config: any;

            if (ext === '.json') {
                config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } else {
                // For JS/TS configs, read raw content and extract what we can
                const content = fs.readFileSync(configPath, 'utf-8');
                config = this.parseJsConfig(content);
            }

            const runner = this.detectRunner(configPath, config);

            return {
                runner,
                configFilePath: configPath,
                preset: config.preset || null,
                testEnvironment: config.testEnvironment || null,
                setupFiles: [
                    ...(config.setupFiles || []),
                    ...(config.setupFilesAfterSetup || []),
                ],
                moduleNameMapper: config.moduleNameMapper || {},
                coverageThresholds: config.coverageThreshold?.global || null,
                transformConfig: config.transform || null,
                collectCoverageFrom: config.collectCoverageFrom || [],
            };
        } catch (e) {
            this.logger.error('Failed to read test config', e);
            return null;
        }
    }

    private parseJsConfig(content: string): Record<string, any> {
        // Best-effort extraction of key properties from JS config
        const result: Record<string, any> = {};

        const presetMatch = content.match(/preset\s*:\s*['"]([^'"]+)['"]/);
        if (presetMatch) { result.preset = presetMatch[1]; }

        const envMatch = content.match(/testEnvironment\s*:\s*['"]([^'"]+)['"]/);
        if (envMatch) { result.testEnvironment = envMatch[1]; }

        // moduleNameMapper extraction
        const mapperMatch = content.match(/moduleNameMapper\s*:\s*\{([^}]*)\}/s);
        if (mapperMatch) {
            const mapper: Record<string, string> = {};
            const entries = mapperMatch[1].matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g);
            for (const entry of entries) {
                mapper[entry[1]] = entry[2];
            }
            result.moduleNameMapper = mapper;
        }

        // collectCoverageFrom extraction
        const coverageMatch = content.match(/collectCoverageFrom\s*:\s*\[([\s\S]*?)\]/);
        if (coverageMatch) {
            const items = coverageMatch[1].matchAll(/['"]([^'"]+)['"]/g);
            result.collectCoverageFrom = [...items].map((m) => m[1]);
        }

        return result;
    }

    private detectRunner(configPath: string, _config: any): 'jest' | 'vitest' | 'mocha' | 'unknown' {
        const name = path.basename(configPath).toLowerCase();
        if (name.startsWith('jest')) { return 'jest'; }
        if (name.startsWith('vitest')) { return 'vitest'; }
        if (name.startsWith('.mocharc')) { return 'mocha'; }
        return 'unknown';
    }

    // ── Mocks ──

    private inventoryMocks(root: string, mockDirs: string[]): MockFileInfo[] {
        const mocks: MockFileInfo[] = [];

        for (const dir of mockDirs) {
            if (!fs.existsSync(dir)) { continue; }
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    if (fs.statSync(fullPath).isFile()) {
                        mocks.push({
                            filePath: fullPath,
                            relativePath: path.relative(root, fullPath),
                            type: 'manual',
                            mockedModule: this.inferMockedModule(file),
                        });
                    }
                }
            } catch {
                // Skip unreadable directories
            }
        }

        return mocks;
    }

    private inferMockedModule(fileName: string): string | null {
        const base = path.basename(fileName, path.extname(fileName));
        // Common patterns
        if (base === 'cssModuleMock') { return 'css-modules'; }
        if (base === 'fileMock') { return 'static-assets'; }
        if (base === 'emptyModule') { return 'side-effect-imports'; }
        if (base.includes('fluent') || base.includes('Fluent')) { return '@fluentui/react'; }
        if (base === 'recharts') { return 'recharts'; }
        return base;
    }

    // ── Helpers ──

    private inventoryHelpers(helperDirs: string[]): string[] {
        const helpers: string[] = [];
        for (const dir of helperDirs) {
            if (!fs.existsSync(dir)) { continue; }
            try {
                const files = fs.readdirSync(dir);
                helpers.push(...files.map((f) => path.join(dir, f)));
            } catch {
                // Skip
            }
        }
        return helpers;
    }

    // ── Local rules ──

    private findLocalRules(root: string): string[] {
        const candidates = [
            '.testrc',
            '.testrc.json',
            '.testrc.yaml',
            '.testrc.yml',
            'testing.config.js',
            'testing.config.ts',
            'TESTING_DOCUMENTATION.md',
            'SESSION_NOTES.md',
            'docs/TESTING.md',
            'docs/testing.md',
        ];

        const found: string[] = [];
        for (const candidate of candidates) {
            const fullPath = path.join(root, candidate);
            if (fs.existsSync(fullPath)) {
                found.push(fullPath);
            }
        }

        // Check package.json for "testing" field
        const pkgPath = path.join(root, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.testing) {
                    found.push(pkgPath + '#testing');
                }
            } catch {
                // Ignore
            }
        }

        return found;
    }

    // ── Setup file ──

    private checkSetupFile(root: string): boolean {
        const candidates = [
            'src/setupTests.ts',
            'src/setupTests.js',
            'src/setupTests.tsx',
            'test/setup.ts',
            'test/setup.js',
            'tests/setup.ts',
        ];
        return candidates.some((c) => fs.existsSync(path.join(root, c)));
    }
}
