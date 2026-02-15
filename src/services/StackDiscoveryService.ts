import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger';

/**
 * Detected project stack information
 */
export interface ProjectStack {
    /** Primary framework: 'spfx' | 'react' | 'angular' | 'vue' | 'node' | 'vscode-extension' | 'next' | 'express' | 'unknown' */
    framework: string;
    /** Language: 'typescript' | 'javascript' */
    language: 'typescript' | 'javascript';
    /** UI library: 'react' | 'angular' | 'vue' | 'svelte' | 'none' */
    uiLibrary: string;
    /** Component library: '@fluentui/react' | '@mui/material' | 'antd' | 'none' */
    componentLibrary: string;
    /** Test runner detected: 'jest' | 'vitest' | 'mocha' | 'jasmine' | 'none' */
    testRunner: string;
    /** Package manager: 'npm' | 'yarn' | 'pnpm' */
    packageManager: string;
    /** Module system: 'commonjs' | 'esm' | 'mixed' */
    moduleSystem: string;
    /** React version (if applicable) */
    reactVersion?: string;
    /** Node version (from engines or .nvmrc) */
    nodeVersion?: string;
    /** Key dependencies detected (name → version) */
    keyDependencies: Record<string, string>;
    /** SPFx-specific info (if detected) */
    spfx?: {
        version: string;
        solutionType: string; // 'webpart' | 'extension' | 'library'
    };
    /** Patterns to mock in tests (external packages the project uses) */
    mockPatterns: string[];
    /** Whether the project uses JSX/TSX */
    usesJsx: boolean;
    /** Confidence of detection: 'high' | 'medium' | 'low' */
    confidence: 'high' | 'medium' | 'low';
}

/**
 * StackDiscoveryService — Analyzes a project to detect its real technology stack.
 * 
 * No assumptions made. Everything is inferred from:
 * - package.json (dependencies, devDependencies, scripts, engines)
 * - Config files (tsconfig.json, angular.json, vite.config.*, etc.)
 * - Directory structure (src/, public/, pages/, etc.)
 * - Lock files (package-lock.json, yarn.lock, pnpm-lock.yaml)
 */
export class StackDiscoveryService {
    private logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
    }

    /**
     * Discover the full stack for a project root
     */
    async discover(projectRoot: string): Promise<ProjectStack> {
        this.logger.info(`Discovering project stack in: ${projectRoot}`);

        const stack: ProjectStack = {
            framework: 'unknown',
            language: 'javascript',
            uiLibrary: 'none',
            componentLibrary: 'none',
            testRunner: 'none',
            packageManager: 'npm',
            moduleSystem: 'commonjs',
            keyDependencies: {},
            mockPatterns: [],
            usesJsx: false,
            confidence: 'low'
        };

        // 1. Read package.json
        const packageJson = this.readPackageJson(projectRoot);
        if (!packageJson) {
            this.logger.warn('No package.json found — cannot detect stack');
            return stack;
        }

        const allDeps = {
            ...packageJson.dependencies || {},
            ...packageJson.devDependencies || {}
        };
        stack.keyDependencies = allDeps;

        // 2. Detect language
        stack.language = this.detectLanguage(projectRoot, allDeps);

        // 3. Detect package manager
        stack.packageManager = this.detectPackageManager(projectRoot);

        // 4. Detect Node version
        stack.nodeVersion = this.detectNodeVersion(projectRoot, packageJson);

        // 5. Detect framework
        stack.framework = this.detectFramework(projectRoot, packageJson, allDeps);

        // 6. Detect UI library
        stack.uiLibrary = this.detectUILibrary(allDeps);

        // 7. Detect component library
        stack.componentLibrary = this.detectComponentLibrary(allDeps);

        // 8. Detect React version
        if (allDeps['react']) {
            stack.reactVersion = allDeps['react'];
        }

        // 9. Detect test runner
        stack.testRunner = this.detectTestRunner(projectRoot, packageJson, allDeps);

        // 10. Detect module system
        stack.moduleSystem = this.detectModuleSystem(projectRoot, packageJson);

        // 11. Detect JSX usage
        stack.usesJsx = this.detectJsxUsage(projectRoot, allDeps);

        // 12. Build mock patterns
        stack.mockPatterns = this.buildMockPatterns(stack, allDeps);

        // 13. Detect SPFx specifics
        if (stack.framework === 'spfx') {
            stack.spfx = this.detectSpfxDetails(projectRoot, allDeps);
        }

        // 14. Set confidence
        stack.confidence = this.assessConfidence(stack);

        this.logger.info('Stack discovery complete', {
            framework: stack.framework,
            language: stack.language,
            uiLibrary: stack.uiLibrary,
            testRunner: stack.testRunner,
            confidence: stack.confidence
        });

        return stack;
    }

    // ─── Detection Methods ────────────────────────────────────────

    private readPackageJson(projectRoot: string): any | null {
        const pkgPath = path.join(projectRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) { return null; }
        try {
            return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        } catch {
            return null;
        }
    }

    private detectLanguage(projectRoot: string, deps: Record<string, string>): 'typescript' | 'javascript' {
        if (deps['typescript']) { return 'typescript'; }
        if (fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) { return 'typescript'; }
        return 'javascript';
    }

    private detectPackageManager(projectRoot: string): string {
        if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) { return 'pnpm'; }
        if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) { return 'yarn'; }
        return 'npm';
    }

    private detectNodeVersion(projectRoot: string, packageJson: any): string | undefined {
        // Check .nvmrc
        const nvmrcPath = path.join(projectRoot, '.nvmrc');
        if (fs.existsSync(nvmrcPath)) {
            try {
                return fs.readFileSync(nvmrcPath, 'utf-8').trim();
            } catch { /* ignore */ }
        }
        // Check engines
        return packageJson.engines?.node;
    }

    private detectFramework(
        projectRoot: string,
        packageJson: any,
        deps: Record<string, string>
    ): string {
        // SPFx — most specific, check first
        if (deps['@microsoft/sp-core-library'] || deps['@microsoft/sp-webpart-base']) {
            return 'spfx';
        }
        if (fs.existsSync(path.join(projectRoot, 'config', 'package-solution.json'))) {
            return 'spfx';
        }

        // VS Code Extension
        if (packageJson.engines?.vscode || deps['@types/vscode']) {
            return 'vscode-extension';
        }

        // Angular
        if (deps['@angular/core']) {
            return 'angular';
        }
        if (fs.existsSync(path.join(projectRoot, 'angular.json'))) {
            return 'angular';
        }

        // Next.js
        if (deps['next']) {
            return 'next';
        }

        // Vue
        if (deps['vue']) {
            return 'vue';
        }

        // Express / Fastify / Koa (server frameworks)
        if (deps['express']) { return 'express'; }
        if (deps['fastify']) { return 'node'; }
        if (deps['koa']) { return 'node'; }

        // React (standalone — after checking Next.js)
        if (deps['react'] && deps['react-dom']) {
            return 'react';
        }

        // Generic Node.js
        if (packageJson.main || packageJson.bin || deps['node'] || 
            fs.existsSync(path.join(projectRoot, 'src', 'index.ts')) ||
            fs.existsSync(path.join(projectRoot, 'src', 'index.js'))) {
            return 'node';
        }

        return 'unknown';
    }

    private detectUILibrary(deps: Record<string, string>): string {
        if (deps['react']) { return 'react'; }
        if (deps['@angular/core']) { return 'angular'; }
        if (deps['vue']) { return 'vue'; }
        if (deps['svelte']) { return 'svelte'; }
        return 'none';
    }

    private detectComponentLibrary(deps: Record<string, string>): string {
        if (deps['@fluentui/react'] || deps['@fluentui/react-components']) { return '@fluentui/react'; }
        if (deps['@mui/material'] || deps['@material-ui/core']) { return '@mui/material'; }
        if (deps['antd']) { return 'antd'; }
        if (deps['@chakra-ui/react']) { return '@chakra-ui/react'; }
        if (deps['react-bootstrap']) { return 'react-bootstrap'; }
        return 'none';
    }

    private detectTestRunner(
        projectRoot: string,
        packageJson: any,
        deps: Record<string, string>
    ): string {
        // Check devDependencies first
        if (deps['vitest']) { return 'vitest'; }
        if (deps['jest'] || deps['ts-jest'] || deps['@jest/core']) { return 'jest'; }
        if (deps['mocha']) { return 'mocha'; }
        if (deps['jasmine']) { return 'jasmine'; }

        // Check scripts
        const scripts = packageJson.scripts || {};
        const testScript = scripts.test || '';
        if (testScript.includes('vitest')) { return 'vitest'; }
        if (testScript.includes('jest')) { return 'jest'; }
        if (testScript.includes('mocha')) { return 'mocha'; }

        // Check config files
        if (fs.existsSync(path.join(projectRoot, 'jest.config.js')) ||
            fs.existsSync(path.join(projectRoot, 'jest.config.ts')) ||
            fs.existsSync(path.join(projectRoot, 'jest.config.mjs'))) {
            return 'jest';
        }
        if (fs.existsSync(path.join(projectRoot, 'vitest.config.ts')) ||
            fs.existsSync(path.join(projectRoot, 'vitest.config.js'))) {
            return 'vitest';
        }
        if (fs.existsSync(path.join(projectRoot, '.mocharc.yml')) ||
            fs.existsSync(path.join(projectRoot, '.mocharc.json'))) {
            return 'mocha';
        }

        return 'none';
    }

    private detectModuleSystem(projectRoot: string, packageJson: any): string {
        if (packageJson.type === 'module') { return 'esm'; }
        if (packageJson.type === 'commonjs') { return 'commonjs'; }

        // Check tsconfig module setting
        const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
        if (fs.existsSync(tsconfigPath)) {
            try {
                const raw = fs.readFileSync(tsconfigPath, 'utf-8');
                // Simple regex to avoid JSON parse issues with comments
                const moduleMatch = raw.match(/"module"\s*:\s*"(\w+)"/i);
                if (moduleMatch) {
                    const mod = moduleMatch[1].toLowerCase();
                    if (mod.includes('esnext') || mod === 'es2020' || mod === 'es2022' || mod === 'nodenext') {
                        return 'esm';
                    }
                }
            } catch { /* ignore */ }
        }

        return 'commonjs';
    }

    private detectJsxUsage(projectRoot: string, deps: Record<string, string>): boolean {
        if (deps['react'] || deps['preact']) { return true; }

        // Check tsconfig jsx setting
        const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
        if (fs.existsSync(tsconfigPath)) {
            try {
                const raw = fs.readFileSync(tsconfigPath, 'utf-8');
                if (raw.includes('"jsx"')) { return true; }
            } catch { /* ignore */ }
        }

        return false;
    }

    /**
     * Build a list of external packages/modules that should be mocked in tests
     */
    private buildMockPatterns(stack: ProjectStack, deps: Record<string, string>): string[] {
        const patterns: string[] = [];

        // Framework-specific mocks
        switch (stack.framework) {
            case 'spfx':
                patterns.push(
                    '@microsoft/sp-core-library',
                    '@microsoft/sp-webpart-base',
                    '@microsoft/sp-http',
                    '@microsoft/sp-page-context',
                    '@microsoft/sp-property-pane',
                    '@microsoft/sp-lodash-subset'
                );
                break;

            case 'vscode-extension':
                patterns.push('vscode');
                break;

            case 'angular':
                patterns.push('@angular/core/testing', '@angular/common/http');
                break;

            case 'next':
                patterns.push('next/router', 'next/navigation', 'next/image');
                break;
        }

        // HTTP / fetch mocks
        if (deps['axios']) { patterns.push('axios'); }
        if (deps['node-fetch'] || deps['cross-fetch']) { patterns.push('node-fetch'); }

        // Database / external service mocks
        if (deps['@pnp/sp'] || deps['@pnp/graph']) {
            patterns.push('@pnp/sp', '@pnp/graph');
        }
        if (deps['@azure/cosmos']) { patterns.push('@azure/cosmos'); }
        if (deps['@azure/openai']) { patterns.push('@azure/openai'); }
        if (deps['@azure/identity']) { patterns.push('@azure/identity'); }
        if (deps['mongoose']) { patterns.push('mongoose'); }
        if (deps['pg'] || deps['mysql2']) { patterns.push('pg', 'mysql2'); }

        // State management
        if (deps['redux'] || deps['@reduxjs/toolkit']) { patterns.push('redux'); }
        if (deps['zustand']) { patterns.push('zustand'); }

        // Component libraries (mock heavy components)
        if (stack.componentLibrary !== 'none') {
            patterns.push(stack.componentLibrary);
        }

        // Filter to only patterns that exist in the project dependencies
        return patterns.filter(p => deps[p] || this.isFrameworkMock(p, stack));
    }

    private isFrameworkMock(pattern: string, stack: ProjectStack): boolean {
        // Some mocks are needed even if not in deps (e.g., vscode is provided by the runtime)
        if (pattern === 'vscode' && stack.framework === 'vscode-extension') { return true; }
        return false;
    }

    private detectSpfxDetails(projectRoot: string, deps: Record<string, string>): ProjectStack['spfx'] {
        let version = deps['@microsoft/sp-core-library'] || 'unknown';
        let solutionType = 'webpart';

        // Check package-solution.json for more info
        const solutionPath = path.join(projectRoot, 'config', 'package-solution.json');
        if (fs.existsSync(solutionPath)) {
            try {
                const solution = JSON.parse(fs.readFileSync(solutionPath, 'utf-8'));
                if (solution.solution?.features) {
                    // Heuristic: check feature scope to determine type
                    const features = solution.solution.features;
                    if (Array.isArray(features) && features.length > 0) {
                        const scope = features[0].scope;
                        if (scope === 'Site') { solutionType = 'webpart'; }
                        else if (scope === 'Web') { solutionType = 'extension'; }
                    }
                }
            } catch { /* ignore */ }
        }

        // Check if it's a library component
        if (deps['@microsoft/sp-module-interfaces']) {
            solutionType = 'library';
        }

        return { version, solutionType };
    }

    private assessConfidence(stack: ProjectStack): 'high' | 'medium' | 'low' {
        if (stack.framework === 'unknown') { return 'low'; }
        
        // High confidence: specific framework + test runner + language detected
        if (stack.framework !== 'node' && stack.testRunner !== 'none') {
            return 'high';
        }

        // Medium: framework detected but missing runner
        if (stack.framework !== 'unknown') {
            return 'medium';
        }

        return 'low';
    }

    /**
     * Format the detected stack as a summary for chat display
     */
    formatStackSummary(stack: ProjectStack): string {
        const lines: string[] = [];

        lines.push(`### 🔍 Stack Detected\n`);
        lines.push(`| Property | Value |`);
        lines.push(`|---|---|`);
        lines.push(`| Framework | **${stack.framework}** |`);
        lines.push(`| Language | ${stack.language} |`);
        lines.push(`| UI Library | ${stack.uiLibrary} |`);
        lines.push(`| Component Lib | ${stack.componentLibrary} |`);
        lines.push(`| Test Runner | ${stack.testRunner} |`);
        lines.push(`| Package Manager | ${stack.packageManager} |`);
        lines.push(`| Module System | ${stack.moduleSystem} |`);
        lines.push(`| Uses JSX | ${stack.usesJsx ? 'Yes' : 'No'} |`);
        if (stack.reactVersion) {
            lines.push(`| React Version | ${stack.reactVersion} |`);
        }
        if (stack.nodeVersion) {
            lines.push(`| Node Version | ${stack.nodeVersion} |`);
        }
        lines.push(`| Confidence | ${stack.confidence} |`);
        lines.push(``);

        if (stack.spfx) {
            lines.push(`#### SPFx Details`);
            lines.push(`- Version: ${stack.spfx.version}`);
            lines.push(`- Type: ${stack.spfx.solutionType}`);
            lines.push(``);
        }

        if (stack.mockPatterns.length > 0) {
            lines.push(`#### Packages to Mock`);
            stack.mockPatterns.forEach(p => lines.push(`- \`${p}\``));
            lines.push(``);
        }

        return lines.join('\n');
    }
}
