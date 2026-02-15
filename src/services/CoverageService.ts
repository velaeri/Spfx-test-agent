import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from './Logger';
import { FileScanner } from '../utils/FileScanner';

/**
 * Per-file coverage metrics
 */
export interface FileCoverageMetrics {
    /** Absolute path to the file */
    filePath: string;
    /** Relative path from project root */
    relativePath: string;
    statements: { total: number; covered: number; pct: number };
    branches: { total: number; covered: number; pct: number };
    functions: { total: number; covered: number; pct: number };
    lines: { total: number; covered: number; pct: number };
}

/**
 * Global (aggregate) coverage metrics
 */
export interface CoverageReport {
    /** ISO timestamp of the report */
    timestamp: string;
    /** Global aggregate metrics */
    global: {
        statements: number;
        branches: number;
        functions: number;
        lines: number;
    };
    /** Per-file breakdown */
    files: FileCoverageMetrics[];
    /** Files below the target threshold */
    filesBelow: FileCoverageMetrics[];
    /** Target threshold (e.g. 80) */
    threshold: number;
    /** Whether global coverage meets threshold */
    meetsThreshold: boolean;
    /** Raw output from Jest (for logging/debugging) */
    rawOutput: string;
}

/**
 * CoverageService — Executes Jest with --coverage and parses the results.
 * 
 * Uses `coverage-summary.json` produced by Jest's `json-summary` reporter
 * to get per-file and global coverage metrics.
 */
export class CoverageService {
    private logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
    }

    /**
     * Run Jest with coverage enabled and return a structured report.
     * 
     * @param projectRoot - Root directory of the project under test
     * @param threshold - Coverage percentage target (default 80)
     * @param jestCommand - Base command to invoke Jest (default 'npx jest')
     * @returns CoverageReport with per-file and global results
     */
    async runCoverage(
        projectRoot: string,
        threshold: number = 80,
        jestCommand: string = 'npx jest'
    ): Promise<CoverageReport> {
        this.logger.info(`Running coverage analysis in: ${projectRoot}`);

        // Ensure coverage output directory
        const coverageDir = path.join(projectRoot, 'coverage');

        // Build Jest command arguments
        const commandParts = jestCommand.split(' ');
        const command = commandParts[0];
        const baseArgs = commandParts.slice(1);

        const args = [
            ...baseArgs,
            '--coverage',
            '--coverageReporters=json-summary',
            '--coverageReporters=text',
            '--silent',
            '--forceExit'
        ];

        this.logger.debug(`Coverage command: ${command} ${args.join(' ')}`);

        const rawOutput = await this.executeJest(command, args, projectRoot);

        // Parse the coverage-summary.json
        const summaryPath = path.join(coverageDir, 'coverage-summary.json');
        
        if (!fs.existsSync(summaryPath)) {
            this.logger.warn('coverage-summary.json not found after Jest run');
            return this.buildEmptyReport(threshold, rawOutput);
        }

        try {
            const summaryRaw = fs.readFileSync(summaryPath, 'utf-8');
            const summary = JSON.parse(summaryRaw);
            return this.parseSummary(summary, projectRoot, threshold, rawOutput);
        } catch (error) {
            this.logger.error('Failed to parse coverage-summary.json', error);
            return this.buildEmptyReport(threshold, rawOutput);
        }
    }

    /**
     * Execute Jest and capture stdout+stderr
     */
    private executeJest(command: string, args: string[], cwd: string): Promise<string> {
        return new Promise((resolve) => {
            let output = '';

            const child = spawn(command, args, {
                cwd,
                env: { ...process.env, FORCE_COLOR: '0' },
                shell: true
            });

            child.stdout?.on('data', (data) => {
                output += data.toString();
            });

            child.stderr?.on('data', (data) => {
                output += data.toString();
            });

            child.on('error', (error) => {
                this.logger.error('Jest coverage process error', error);
                resolve(`Process error: ${error.message}`);
            });

            child.on('close', (code) => {
                this.logger.debug(`Jest coverage exited with code ${code}`);
                resolve(output);
            });
        });
    }

    /**
     * Parse the Jest coverage-summary.json into a CoverageReport
     */
    private parseSummary(
        summary: Record<string, any>,
        projectRoot: string,
        threshold: number,
        rawOutput: string
    ): CoverageReport {
        const files: FileCoverageMetrics[] = [];

        // Extract per-file metrics (every key except "total")
        for (const [filePath, metrics] of Object.entries(summary)) {
            if (filePath === 'total') { continue; }

            const m = metrics as any;
            const fileMetric: FileCoverageMetrics = {
                filePath,
                relativePath: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
                statements: { total: m.statements.total, covered: m.statements.covered, pct: m.statements.pct },
                branches: { total: m.branches.total, covered: m.branches.covered, pct: m.branches.pct },
                functions: { total: m.functions.total, covered: m.functions.covered, pct: m.functions.pct },
                lines: { total: m.lines.total, covered: m.lines.covered, pct: m.lines.pct }
            };
            files.push(fileMetric);
        }

        // Global metrics from "total" key
        const total = summary.total || {};
        const globalMetrics = {
            statements: total.statements?.pct ?? 0,
            branches: total.branches?.pct ?? 0,
            functions: total.functions?.pct ?? 0,
            lines: total.lines?.pct ?? 0
        };

        // Files below threshold (based on statements pct)
        const filesBelow = files.filter(f => f.statements.pct < threshold);

        // Sort filesBelow by uncovered statements descending (highest ROI first)
        filesBelow.sort((a, b) => {
            const uncoveredA = a.statements.total - a.statements.covered;
            const uncoveredB = b.statements.total - b.statements.covered;
            return uncoveredB - uncoveredA;
        });

        const meetsThreshold = globalMetrics.statements >= threshold;

        this.logger.info('Coverage analysis complete', {
            statements: `${globalMetrics.statements}%`,
            branches: `${globalMetrics.branches}%`,
            functions: `${globalMetrics.functions}%`,
            lines: `${globalMetrics.lines}%`,
            totalFiles: files.length,
            filesBelow: filesBelow.length,
            meetsThreshold
        });

        return {
            timestamp: new Date().toISOString(),
            global: globalMetrics,
            files,
            filesBelow,
            threshold,
            meetsThreshold,
            rawOutput
        };
    }

    /**
     * Build an empty report when coverage data is unavailable
     */
    private buildEmptyReport(threshold: number, rawOutput: string): CoverageReport {
        return {
            timestamp: new Date().toISOString(),
            global: { statements: 0, branches: 0, functions: 0, lines: 0 },
            files: [],
            filesBelow: [],
            threshold,
            meetsThreshold: false,
            rawOutput
        };
    }

    /**
     * Format a coverage report as a Markdown table for chat display
     */
    formatReportAsMarkdown(report: CoverageReport): string {
        const lines: string[] = [];

        lines.push(`### 📊 Coverage Report\n`);
        lines.push(`| Metric | Coverage |`);
        lines.push(`|---|---|`);
        lines.push(`| Statements | **${report.global.statements.toFixed(1)}%** |`);
        lines.push(`| Branches | **${report.global.branches.toFixed(1)}%** |`);
        lines.push(`| Functions | **${report.global.functions.toFixed(1)}%** |`);
        lines.push(`| Lines | **${report.global.lines.toFixed(1)}%** |`);
        lines.push(``);

        if (report.meetsThreshold) {
            lines.push(`✅ **Global coverage meets ≥${report.threshold}% threshold**\n`);
        } else {
            lines.push(`❌ **Global coverage below ${report.threshold}% threshold**\n`);
        }

        if (report.filesBelow.length > 0) {
            lines.push(`### Files Below ${report.threshold}%\n`);
            lines.push(`| File | Stmts | Branch | Funcs | Lines | Uncovered Stmts |`);
            lines.push(`|---|---|---|---|---|---|`);

            // Show top 20 worst files
            const topFiles = report.filesBelow.slice(0, 20);
            for (const file of topFiles) {
                const uncovered = file.statements.total - file.statements.covered;
                lines.push(
                    `| \`${file.relativePath}\` | ${file.statements.pct.toFixed(0)}% | ${file.branches.pct.toFixed(0)}% | ${file.functions.pct.toFixed(0)}% | ${file.lines.pct.toFixed(0)}% | ${uncovered} |`
                );
            }

            if (report.filesBelow.length > 20) {
                lines.push(`| ... and ${report.filesBelow.length - 20} more | | | | | |`);
            }
            lines.push(``);
        }

        return lines.join('\n');
    }

    /**
     * Get list of source files that need more coverage, sorted by ROI
     * (most uncovered statements first)
     */
    getFilesNeedingCoverage(report: CoverageReport): string[] {
        return report.filesBelow.map(f => f.filePath);
    }

    /**
     * Compare two reports and produce a delta summary
     */
    compareCoverage(before: CoverageReport, after: CoverageReport): string {
        const delta = {
            statements: after.global.statements - before.global.statements,
            branches: after.global.branches - before.global.branches,
            functions: after.global.functions - before.global.functions,
            lines: after.global.lines - before.global.lines
        };

        const sign = (n: number) => n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1);

        const lines: string[] = [];
        lines.push(`### 📈 Coverage Delta\n`);
        lines.push(`| Metric | Before | After | Delta |`);
        lines.push(`|---|---|---|---|`);
        lines.push(`| Statements | ${before.global.statements.toFixed(1)}% | ${after.global.statements.toFixed(1)}% | ${sign(delta.statements)}% |`);
        lines.push(`| Branches | ${before.global.branches.toFixed(1)}% | ${after.global.branches.toFixed(1)}% | ${sign(delta.branches)}% |`);
        lines.push(`| Functions | ${before.global.functions.toFixed(1)}% | ${after.global.functions.toFixed(1)}% | ${sign(delta.functions)}% |`);
        lines.push(`| Lines | ${before.global.lines.toFixed(1)}% | ${after.global.lines.toFixed(1)}% | ${sign(delta.lines)}% |`);
        lines.push(``);

        return lines.join('\n');
    }
}
