import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from '../BaseTool';
import { ToolParameter, ToolResult, ToolExecutionContext } from '../ToolTypes';
import { StackDiscoveryService, ProjectStack } from '../../services/StackDiscoveryService';

/**
 * AnalyzeProjectTool — Analyzes the project structure and technology stack.
 * 
 * Deterministic tool that reads package.json, tsconfig.json, and existing config
 * to provide the LLM with complete project understanding.
 */
export class AnalyzeProjectTool extends BaseTool {
    private stackDiscovery: StackDiscoveryService;

    constructor() {
        super();
        this.stackDiscovery = new StackDiscoveryService();
    }

    get name(): string { return 'analyze_project'; }
    
    get description(): string {
        return 'Analyze the project structure, detect the technology stack (framework, language, test runner), and return project metadata including package.json deps, tsconfig, and existing Jest configuration.';
    }

    get parameters(): ToolParameter[] {
        return [
            {
                name: 'path',
                type: 'string',
                description: 'Project root path (relative to workspace root). Default: workspace root.',
                required: false,
                default: '.'
            }
        ];
    }

    get returns(): string {
        return 'Object with framework, language, dependencies, devDependencies, tsconfig, jestConfig, and stack discovery details';
    }

    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const subPath = (params.path as string) || '.';
        const projectRoot = path.resolve(context.workspaceRoot, subPath);

        try {
            const result: Record<string, unknown> = {};

            // Read package.json
            const packageJsonPath = path.join(projectRoot, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                result.projectName = pkg.name;
                result.dependencies = pkg.dependencies || {};
                result.devDependencies = pkg.devDependencies || {};
                result.scripts = pkg.scripts || {};
                result.engines = pkg.engines;
            } else {
                return this.error('No package.json found in project root');
            }

            // Read tsconfig.json
            const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
            if (fs.existsSync(tsconfigPath)) {
                try {
                    result.tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
                } catch {
                    result.tsconfig = 'present but invalid JSON';
                }
            }

            // Read existing jest config
            const jestConfigs = ['jest.config.js', 'jest.config.ts', 'jest.config.json', 'jest.config.mjs'];
            for (const configFile of jestConfigs) {
                const configPath = path.join(projectRoot, configFile);
                if (fs.existsSync(configPath)) {
                    result.jestConfigFile = configFile;
                    result.jestConfig = fs.readFileSync(configPath, 'utf-8');
                    break;
                }
            }

            // Stack discovery (framework, language, test runner)
            try {
                const stack: ProjectStack = await this.stackDiscovery.discover(projectRoot);
                result.stack = {
                    framework: stack.framework,
                    language: stack.language,
                    testRunner: stack.testRunner,
                    confidence: stack.confidence,
                    summary: this.stackDiscovery.formatStackSummary(stack)
                };
            } catch (error) {
                this.logger.warn('Stack discovery failed', error);
                result.stack = { error: 'Discovery failed' };
            }

            // Check for existing test files
            const testFiles = this.findTestFiles(path.join(projectRoot, 'src'));
            result.existingTestFiles = testFiles.slice(0, 10); // First 10

            return this.success(result);
        } catch (error) {
            return this.error(`Failed to analyze project: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private findTestFiles(dir: string, results: string[] = []): string[] {
        if (!fs.existsSync(dir) || results.length >= 10) return results;

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (results.length >= 10) break;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && entry.name !== 'node_modules') {
                    this.findTestFiles(fullPath, results);
                } else if (entry.name.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) {
                    results.push(entry.name);
                }
            }
        } catch { /* ignore */ }
        
        return results;
    }
}
