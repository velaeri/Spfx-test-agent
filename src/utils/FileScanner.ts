import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * File discovery utilities for workspace scanning
 */
export class FileScanner {
    /**
     * Find all source files in the workspace (excluding test files)
     * Supports TypeScript (.ts/.tsx) and JavaScript (.js/.jsx)
     * 
     * @param base - Workspace folder or URI to scan
     * @param exclude - Additional patterns to exclude
     * @returns Array of file URIs
     */
    public static async findSourceFiles(
        base: vscode.WorkspaceFolder | vscode.Uri,
        exclude: string[] = []
    ): Promise<vscode.Uri[]> {
        // Default exclusions
        const defaultExclusions = [
            '**/node_modules/**',
            '**/dist/**',
            '**/lib/**',
            '**/temp/**',
            '**/build/**',
            '**/*.test.ts',
            '**/*.test.tsx',
            '**/*.test.js',
            '**/*.test.jsx',
            '**/*.spec.ts',
            '**/*.spec.tsx',
            '**/*.spec.js',
            '**/*.spec.jsx',
            '**/*.d.ts'
        ];

        const allExclusions = [...defaultExclusions, ...exclude];

        // Search for .ts, .tsx, .js, .jsx files
        const tsFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(base, '**/*.ts'),
            `{${allExclusions.join(',')}}`,
            1000
        );

        const tsxFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(base, '**/*.tsx'),
            `{${allExclusions.join(',')}}`,
            1000
        );

        const jsFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(base, '**/*.js'),
            `{${allExclusions.join(',')}}`,
            1000
        );

        const jsxFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(base, '**/*.jsx'),
            `{${allExclusions.join(',')}}`,
            1000
        );

        return [...tsFiles, ...tsxFiles, ...jsFiles, ...jsxFiles];
    }

    /**
     * Find the closest package.json going up from a file
     * 
     * @param filePath - Starting file path
     * @returns Path to package.json or undefined
     */
    public static findClosestPackageJson(filePath: string): string | undefined {
        let currentDir = path.dirname(filePath);
        const root = path.parse(currentDir).root;

        while (currentDir !== root) {
            const packageJsonPath = path.join(currentDir, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                return packageJsonPath;
            }
            currentDir = path.dirname(currentDir);
        }

        return undefined;
    }

    /**
     * Find the project root (directory with package.json) for a file
     * 
     * @param filePath - File path
     * @returns Project root directory or undefined
     */
    public static findProjectRoot(filePath: string): string | undefined {
        const packageJson = this.findClosestPackageJson(filePath);
        return packageJson ? path.dirname(packageJson) : undefined;
    }

    /**
     * Check if a file already has a test file
     * 
     * @param sourceFilePath - Source file path
     * @returns True if test file exists
     */
    public static hasTestFile(sourceFilePath: string): boolean {
        const dir = path.dirname(sourceFilePath);
        const ext = path.extname(sourceFilePath);
        const baseName = path.basename(sourceFilePath, ext);

        // Check for .test.* and .spec.* patterns
        const testPatterns = [
            path.join(dir, `${baseName}.test${ext}`),
            path.join(dir, `${baseName}.spec${ext}`),
            path.join(dir, `${baseName}.test.ts`),
            path.join(dir, `${baseName}.spec.ts`),
            path.join(dir, `${baseName}.test.tsx`),
            path.join(dir, `${baseName}.spec.tsx`)
        ];

        return testPatterns.some(p => fs.existsSync(p));
    }

    /**
     * Filter files that don't have tests yet
     * 
     * @param files - Array of file URIs
     * @returns Files without existing tests
     */
    public static filterFilesWithoutTests(files: vscode.Uri[]): vscode.Uri[] {
        return files.filter(file => !this.hasTestFile(file.fsPath));
    }

    /**
     * Group files by their project root
     * 
     * @param files - Array of file URIs
     * @returns Map of project root to files
     */
    public static groupFilesByProject(files: vscode.Uri[]): Map<string, vscode.Uri[]> {
        const projectMap = new Map<string, vscode.Uri[]>();

        for (const file of files) {
            const projectRoot = this.findProjectRoot(file.fsPath);
            if (projectRoot) {
                const existing = projectMap.get(projectRoot) || [];
                existing.push(file);
                projectMap.set(projectRoot, existing);
            }
        }

        return projectMap;
    }
}
