import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../services/Logger';

/**
 * Represents the full context needed by the LLM to generate accurate tests
 */
export interface SourceContext {
    /** The main source file code */
    sourceCode: string;
    /** The main source file name */
    fileName: string;
    /** Resolved dependency files: relative import path → file content */
    dependencies: Map<string, string>;
    /** The tsconfig.json content (for module resolution hints) */
    tsConfig?: string;
    /** The jest.config.js content */
    jestConfig?: string;
    /** The package.json (dependencies section only) */
    packageDeps?: Record<string, string>;
    /** SPFx-specific context detected */
    spfxPatterns: string[];
}

/**
 * Collects all relevant context for a source file so the LLM can understand
 * the full picture: imports, types, interfaces, base classes, etc.
 * 
 * This is the core "intelligence" that was missing — without dependency context,
 * the LLM generates tests that mock things incorrectly.
 */
export class SourceContextCollector {
    private logger: Logger;
    private maxDepth = 2; // How many levels of imports to follow
    private maxFileSize = 8000; // Max chars per dependency file to include
    private visitedFiles = new Set<string>();

    constructor() {
        this.logger = Logger.getInstance();
    }

    /**
     * Collect full context for a source file
     */
    async collectContext(sourceFilePath: string, workspaceRoot: string): Promise<SourceContext> {
        this.visitedFiles.clear();

        const sourceCode = fs.readFileSync(sourceFilePath, 'utf-8');
        const fileName = path.basename(sourceFilePath);

        const context: SourceContext = {
            sourceCode,
            fileName,
            dependencies: new Map(),
            spfxPatterns: []
        };

        // 1. Resolve and read local import dependencies
        this.logger.info(`Collecting dependency context for ${fileName}`);
        await this.resolveImports(sourceFilePath, workspaceRoot, context, 0);

        // 2. Read tsconfig.json
        const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
        if (fs.existsSync(tsconfigPath)) {
            try {
                context.tsConfig = fs.readFileSync(tsconfigPath, 'utf-8');
            } catch { /* ignore */ }
        }

        // 3. Read jest.config.js
        const jestConfigPath = path.join(workspaceRoot, 'jest.config.js');
        if (fs.existsSync(jestConfigPath)) {
            try {
                context.jestConfig = fs.readFileSync(jestConfigPath, 'utf-8');
            } catch { /* ignore */ }
        }

        // 4. Read package.json dependencies
        const packageJsonPath = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                context.packageDeps = {
                    ...pkg.dependencies || {},
                    ...pkg.devDependencies || {}
                };
            } catch { /* ignore */ }
        }

        // 5. Detect SPFx patterns
        context.spfxPatterns = this.detectSPFxPatterns(sourceCode, context.packageDeps);

        this.logger.info(`Context collected: ${context.dependencies.size} dependencies, ${context.spfxPatterns.length} SPFx patterns`);

        return context;
    }

    /**
     * Parse imports from source code and resolve local file dependencies
     */
    private async resolveImports(
        filePath: string,
        workspaceRoot: string,
        context: SourceContext,
        depth: number
    ): Promise<void> {
        if (depth > this.maxDepth) { return; }

        const normalizedPath = path.normalize(filePath);
        if (this.visitedFiles.has(normalizedPath)) { return; }
        this.visitedFiles.add(normalizedPath);

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return;
        }

        // Parse all import statements
        const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
        const exportRegex = /export\s+(?:\{[^}]*\}\s+from|.*from)\s+['"]([^'"]+)['"]/g;

        const allImports = new Set<string>();
        let match: RegExpExecArray | null;

        while ((match = importRegex.exec(content)) !== null) {
            allImports.add(match[1]);
        }
        while ((match = exportRegex.exec(content)) !== null) {
            allImports.add(match[1]);
        }

        const dir = path.dirname(filePath);

        for (const importPath of allImports) {
            // Skip node_modules / external packages
            if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
                continue;
            }

            // Try to resolve the actual file
            const resolvedPath = this.resolveFilePath(importPath, dir);
            if (!resolvedPath) {
                this.logger.debug(`Could not resolve import: ${importPath} from ${filePath}`);
                continue;
            }

            // Read and store the dependency
            try {
                let depContent = fs.readFileSync(resolvedPath, 'utf-8');
                // Truncate very large files
                if (depContent.length > this.maxFileSize) {
                    depContent = depContent.substring(0, this.maxFileSize) + '\n// ... (truncated)';
                }

                const relativePath = path.relative(workspaceRoot, resolvedPath).replace(/\\/g, '/');
                context.dependencies.set(relativePath, depContent);

                this.logger.debug(`Resolved dependency: ${importPath} → ${relativePath}`);

                // Recursively resolve sub-imports (depth + 1)
                await this.resolveImports(resolvedPath, workspaceRoot, context, depth + 1);
            } catch {
                this.logger.debug(`Failed to read resolved import: ${resolvedPath}`);
            }
        }
    }

    /**
     * Try to resolve an import path to an actual file
     */
    private resolveFilePath(importPath: string, fromDir: string): string | null {
        const basePath = path.resolve(fromDir, importPath);

        // Try exact path first
        const extensions = ['.ts', '.tsx', '.js', '.jsx', ''];
        for (const ext of extensions) {
            const fullPath = basePath + ext;
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                return fullPath;
            }
        }

        // Try index files in directory
        for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
            const indexPath = path.join(basePath, `index${ext}`);
            if (fs.existsSync(indexPath)) {
                return indexPath;
            }
        }

        return null;
    }

    /**
     * Detect SPFx-specific patterns in the source code
     */
    private detectSPFxPatterns(sourceCode: string, deps?: Record<string, string>): string[] {
        const patterns: string[] = [];

        if (sourceCode.includes('BaseClientSideWebPart')) {
            patterns.push('SPFx WebPart (extends BaseClientSideWebPart)');
        }
        if (sourceCode.includes('BaseApplicationCustomizer')) {
            patterns.push('SPFx Application Customizer');
        }
        if (sourceCode.includes('BaseFieldCustomizer')) {
            patterns.push('SPFx Field Customizer');
        }
        if (sourceCode.includes('BaseListViewCommandSet')) {
            patterns.push('SPFx ListView Command Set');
        }
        if (sourceCode.includes('@microsoft/sp-http') || sourceCode.includes('SPHttpClient')) {
            patterns.push('Uses SPHttpClient for SharePoint API calls');
        }
        if (sourceCode.includes('@pnp/sp') || sourceCode.includes('@pnp/spfx-controls')) {
            patterns.push('Uses PnP JS for SharePoint operations');
        }
        if (sourceCode.includes('React.Component') || sourceCode.includes('React.FC') || sourceCode.includes('FunctionComponent')) {
            patterns.push('React Component');
        }
        if (sourceCode.includes('@fluentui/react') || sourceCode.includes('office-ui-fabric-react')) {
            patterns.push('Uses Fluent UI / Office UI Fabric components');
        }
        if (sourceCode.includes('WebPartContext') || sourceCode.includes('this.context')) {
            patterns.push('Uses WebPart context (needs mocking)');
        }
        if (sourceCode.includes('.module.scss') || sourceCode.includes('.module.css')) {
            patterns.push('Uses CSS/SCSS modules (needs identity-obj-proxy mock)');
        }

        // Check package.json for SPFx version
        if (deps) {
            const spfxVersion = deps['@microsoft/sp-core-library'] || deps['@microsoft/sp-webpart-base'];
            if (spfxVersion) {
                patterns.push(`SPFx version: ${spfxVersion}`);
            }
            const reactVersion = deps['react'];
            if (reactVersion) {
                patterns.push(`React version: ${reactVersion}`);
            }
        }

        return patterns;
    }

    /**
     * Format the collected context into a string suitable for the LLM prompt
     */
    formatForPrompt(context: SourceContext): string {
        const parts: string[] = [];

        // SPFx patterns detected
        if (context.spfxPatterns.length > 0) {
            parts.push(`## Project Context`);
            parts.push(`This is a SharePoint Framework (SPFx) project with these characteristics:`);
            context.spfxPatterns.forEach(p => parts.push(`- ${p}`));
            parts.push('');
        }

        // Dependencies
        if (context.dependencies.size > 0) {
            parts.push(`## Related Source Files (Imported Dependencies)`);
            parts.push(`These files are imported by ${context.fileName} — use them to understand types, interfaces, and behavior:\n`);
            
            for (const [depPath, depContent] of context.dependencies) {
                parts.push(`### ${depPath}`);
                parts.push('```typescript');
                parts.push(depContent);
                parts.push('```\n');
            }
        }

        // Package dependencies (just the names for context)
        if (context.packageDeps) {
            const relevantDeps = Object.keys(context.packageDeps)
                .filter(d => d.startsWith('@microsoft/sp-') || 
                            d.startsWith('@fluentui') || 
                            d.startsWith('@pnp') || 
                            d === 'react' || 
                            d === 'react-dom' ||
                            d.startsWith('@testing-library') ||
                            d === 'jest' ||
                            d === 'ts-jest');
            if (relevantDeps.length > 0) {
                parts.push(`## Installed Packages (relevant)`);
                relevantDeps.forEach(d => parts.push(`- ${d}: ${context.packageDeps![d]}`));
                parts.push('');
            }
        }

        // Jest config
        if (context.jestConfig) {
            parts.push(`## Jest Configuration (jest.config.js)`);
            parts.push('```javascript');
            parts.push(context.jestConfig);
            parts.push('```\n');
        }

        return parts.join('\n');
    }
}
