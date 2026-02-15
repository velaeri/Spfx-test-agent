/**
 * QualityPipeline — Full pipeline that orchestrates quality-first test generation
 * components: RepoInspector → TestPlanBuilder → PromptAssembler → Generate → RepairLoop → Report.
 *
 * Works on any JS/TS project. Detects stack, config, and mocks dynamically.
 *
 * Supports two modes:
 * - execution-capable: can run tests, parse coverage, repair failing tests
 * - dry-run: generates tests with static analysis, no execution
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../services/Logger';
import { RepoInspector, RepoInspection } from '../services/RepoInspector';
import { TestPlanBuilder, TestPlan, TestPlanItem, TestInventoryItem } from '../services/TestPlanBuilder';
import { PromptAssembler } from '../services/PromptAssembler';
import { RepairLoop, RepairResult, TestExecutor, RepairContext } from '../services/RepairLoop';
import { evaluateQualityGates } from '../policies/GoldenPolicy';
import { ILLMProvider, LLMResult } from '../interfaces/ILLMProvider';
import { CoverageService, CoverageReport } from '../services/CoverageService';
import { TestRunner } from '../utils/TestRunner';
import { ConfigService } from '../services/ConfigService';

// ────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────

export type PipelineMode = 'execution-capable' | 'dry-run';

export interface PipelineConfig {
    mode: PipelineMode;
    maxTime: number;              // ms
    maxIterations: number;        // per file repair loop
    maxFilesPerRun: number;
    coverageThreshold: number;    // percentage
}

export interface PipelineResult {
    mode: PipelineMode;
    testsCreated: string[];
    testsRepaired: string[];
    testsDeleted: string[];
    testsPassing: number;
    testsFailing: number;
    coverageBefore: number | null;
    coverageAfter: number | null;
    plan: TestPlan;
    repairResults: RepairResult[];
    elapsed: number;
    aborted: boolean;
    abortReason: string | null;
}

interface FileGenerationResult {
    file: string;
    success: boolean;
    passed: boolean | null;     // null in dry-run
    error: string | null;
}

// ────────────────────────────────────────────────────
// Default config
// ────────────────────────────────────────────────────

const DEFAULT_CONFIG: PipelineConfig = {
    mode: 'execution-capable',
    maxTime: 300_000,           // 5 min
    maxIterations: 3,
    maxFilesPerRun: 50,
    coverageThreshold: 80,
};

// ────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────

export class QualityPipeline {
    private logger: Logger;
    private repoInspector: RepoInspector;
    private planBuilder: TestPlanBuilder;
    private promptAssembler: PromptAssembler;
    private repairLoop: RepairLoop;
    private llmProvider: ILLMProvider;
    private coverageService: CoverageService;
    private testRunner: TestRunner;

    constructor(llmProvider: ILLMProvider) {
        this.logger = Logger.getInstance();
        this.repoInspector = new RepoInspector();
        this.planBuilder = new TestPlanBuilder();
        this.promptAssembler = new PromptAssembler();
        this.repairLoop = new RepairLoop(llmProvider);
        this.llmProvider = llmProvider;
        this.coverageService = new CoverageService();
        this.testRunner = new TestRunner();
    }

    /**
     * Execute the full quality pipeline.
     */
    async execute(
        repoRoot: string,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        config: Partial<PipelineConfig> = {}
    ): Promise<PipelineResult> {
        const cfg: PipelineConfig = { ...DEFAULT_CONFIG, ...config };
        const startTime = Date.now();

        const result: PipelineResult = {
            mode: cfg.mode,
            testsCreated: [],
            testsRepaired: [],
            testsDeleted: [],
            testsPassing: 0,
            testsFailing: 0,
            coverageBefore: null,
            coverageAfter: null,
            plan: { p0: [], p1: [], p2: [], fillerToDelete: [], failingToRepair: [], estimatedTotalItems: 0, refactorSuggestions: [] },
            repairResults: [],
            elapsed: 0,
            aborted: false,
            abortReason: null,
        };

        try {
            // ── Fase 0: Repo Inspection ──
            stream.progress('Phase 0: Inspecting repository...');
            this.logger.info('Pipeline phase 0: Repo inspection');
            const inspection = await this.repoInspector.inspect(repoRoot);

            if (!inspection.packageInfo) {
                stream.markdown('❌ No `package.json` found. Aborting.\n');
                result.aborted = true;
                result.abortReason = 'No package.json found';
                return result;
            }

            stream.markdown(`📋 **Stack**: ${inspection.stack.framework} | **Test runner**: ${inspection.stack.testRunner} | **Source files**: ${inspection.paths.sourceFiles.length} | **Existing tests**: ${inspection.paths.existingTestFiles.length}\n\n`);

            this.checkCancellation(token, result);

            // ── Fase 1: Read Rules ──
            stream.progress('Phase 1: Reading rules...');
            this.logger.info('Pipeline phase 1: Read rules');
            const localRules = inspection.localRulesFiles.length > 0
                ? this.promptAssembler.readLocalRules(inspection.localRulesFiles)
                : undefined;

            if (localRules) {
                stream.markdown(`📖 Found ${inspection.localRulesFiles.length} local rules file(s)\n`);
            } else {
                stream.markdown('📖 No local rules found — using golden testing policy\n');
            }

            // ── Fase 2: Inventory ──
            stream.progress('Phase 2: Inventorying existing tests...');
            this.logger.info('Pipeline phase 2: Inventory');
            const inventory = await this.buildInventory(inspection, cfg);

            this.checkCancellation(token, result);

            // ── Fase 3: Plan ──
            stream.progress('Phase 3: Building test plan...');
            this.logger.info('Pipeline phase 3: Plan');
            const plan = this.planBuilder.buildPlan(inspection, inventory, cfg.maxFilesPerRun);
            result.plan = plan;

            stream.markdown(`\n📝 **Test Plan**:\n- P0 (critical): ${plan.p0.length} files\n- P1 (important): ${plan.p1.length} files\n- P2 (nice to have): ${plan.p2.length} files\n- To repair: ${plan.failingToRepair.length}\n- To delete (filler): ${plan.fillerToDelete.length}\n`);

            if (plan.refactorSuggestions.length > 0) {
                stream.markdown(`\n⚠️ **Refactor suggestions**: ${plan.refactorSuggestions.length} files have testability issues\n`);
            }

            this.checkCancellation(token, result);

            // ── Delete filler tests ──
            if (plan.fillerToDelete.length > 0) {
                stream.progress('Cleaning up filler tests...');
                for (const fillerFile of plan.fillerToDelete) {
                    try {
                        if (fs.existsSync(fillerFile)) {
                            // Don't actually delete — rename with .bak
                            fs.renameSync(fillerFile, fillerFile + '.bak');
                            result.testsDeleted.push(fillerFile);
                        }
                    } catch (e) {
                        this.logger.warn(`Failed to backup filler test: ${fillerFile}`, e);
                    }
                }
                if (result.testsDeleted.length > 0) {
                    stream.markdown(`🗑️ Backed up ${result.testsDeleted.length} filler test(s)\n`);
                }
            }

            // ── Fase 4: Generate ──
            stream.progress('Phase 4: Generating tests...');
            this.logger.info('Pipeline phase 4: Generate');

            const allItems = [
                ...plan.failingToRepair,
                ...plan.p0,
                ...plan.p1,
                ...plan.p2,
            ];

            let generationFailures = 0;
            const existingPatterns = this.promptAssembler.extractExistingPatterns(
                inspection.paths.existingTestFiles
            );

            for (let i = 0; i < allItems.length; i++) {
                // Time check
                if (Date.now() - startTime > cfg.maxTime) {
                    result.aborted = true;
                    result.abortReason = 'Timeout reached';
                    stream.markdown(`\n⏱️ **Timeout** — stopping after ${i} files\n`);
                    break;
                }

                this.checkCancellation(token, result);

                const item = allItems[i];
                const isRepair = item.action === 'repair';
                const label = isRepair ? '🔧 Repairing' : '✨ Generating';

                stream.progress(`${label} (${i + 1}/${allItems.length}): ${path.basename(item.sourceFile || item.testFile)}`);

                const genResult = await this.generateSingleTest(
                    item,
                    inspection,
                    cfg,
                    localRules,
                    existingPatterns
                );

                if (genResult.success) {
                    if (isRepair) {
                        result.testsRepaired.push(genResult.file);
                    } else {
                        result.testsCreated.push(genResult.file);
                    }

                    if (genResult.passed === true) {
                        result.testsPassing++;
                    } else if (genResult.passed === false) {
                        result.testsFailing++;
                    }
                    // passed === null → dry-run, don't count

                    stream.markdown(`  ✅ ${path.basename(genResult.file)}${genResult.passed === true ? ' (passing)' : genResult.passed === false ? ' (failing)' : ''}\n`);
                } else {
                    generationFailures++;
                    result.testsFailing++;
                    stream.markdown(`  ❌ ${path.basename(item.testFile)}: ${genResult.error}\n`);
                }

                // Abort if >50% failures
                if (generationFailures > allItems.length / 2 && generationFailures > 3) {
                    result.aborted = true;
                    result.abortReason = `>50% generation failures (${generationFailures}/${i + 1})`;
                    stream.markdown(`\n🛑 **Aborting**: too many failures\n`);
                    break;
                }
            }

            // ── Fase 6: Coverage ──
            if (cfg.mode === 'execution-capable' && !result.aborted) {
                stream.progress('Phase 6: Running coverage...');
                this.logger.info('Pipeline phase 6: Coverage');
                try {
                    const coverageReport = await this.coverageService.runCoverage(
                        repoRoot,
                        cfg.coverageThreshold
                    );
                    result.coverageAfter = coverageReport.global.lines;
                    stream.markdown(`\n📊 **Coverage**: ${coverageReport.global.lines.toFixed(1)}% lines\n`);
                } catch (e) {
                    this.logger.warn('Coverage analysis failed', e);
                    stream.markdown('\n⚠️ Coverage analysis failed\n');
                }
            }

            // ── Fase 7: Report ──
            result.elapsed = Date.now() - startTime;
            this.streamReport(result, stream);

        } catch (e) {
            if (e instanceof CancellationError) {
                result.aborted = true;
                result.abortReason = 'Cancelled by user';
                stream.markdown('\n🚫 **Cancelled by user**\n');
            } else {
                this.logger.error('Pipeline error', e);
                result.aborted = true;
                result.abortReason = e instanceof Error ? e.message : 'Unknown error';
                stream.markdown(`\n❌ **Pipeline error**: ${result.abortReason}\n`);
            }
        }

        result.elapsed = Date.now() - startTime;
        return result;
    }

    // ────────────────────────────────────────────────
    // Single test generation
    // ────────────────────────────────────────────────

    private async generateSingleTest(
        item: TestPlanItem,
        inspection: RepoInspection,
        cfg: PipelineConfig,
        localRules?: string,
        existingPatterns?: string
    ): Promise<FileGenerationResult> {
        try {
            // Read source file
            const sourceCode = item.sourceFile
                ? fs.readFileSync(item.sourceFile, 'utf-8')
                : '';

            // Assemble prompt
            const prompt = this.promptAssembler.assembleGeneratePrompt(
                {
                    planItem: item,
                    sourceCode,
                    availableMocks: inspection.existingMocks.map((m) => m.relativePath),
                    existingPatterns,
                    localRules,
                },
                inspection
            );

            // Call LLM
            const llmResult: LLMResult = await this.llmProvider.generateTest({
                sourceCode: prompt.userPrompt,
                fileName: path.basename(item.sourceFile || item.testFile),
                systemPrompt: prompt.systemPrompt,
            });

            if (!llmResult?.code) {
                return { file: item.testFile, success: false, passed: null, error: 'LLM returned empty response' };
            }

            // Extract test code
            const testCode = this.extractTestCode(llmResult.code);

            // Quality gate check
            const qgResult = evaluateQualityGates(testCode);
            if (!qgResult.passed) {
                const failures = qgResult.results.filter((r) => !r.result.passed);
                this.logger.warn('Quality gates failed', { failures });
                // Continue anyway but log — the repair loop may fix issues
            }

            // Write test file
            const testDir = path.dirname(item.testFile);
            if (!fs.existsSync(testDir)) {
                fs.mkdirSync(testDir, { recursive: true });
            }
            fs.writeFileSync(item.testFile, testCode, 'utf-8');

            // Execute if capable
            if (cfg.mode === 'execution-capable') {
                const executor: TestExecutor = {
                    run: async (testPath, wsRoot) => {
                        return this.testRunner.runTest(testPath, wsRoot);
                    },
                };

                const runResult = await executor.run(item.testFile, inspection.paths.root);

                if (runResult.success) {
                    return { file: item.testFile, success: true, passed: true, error: null };
                }

                // Enter repair loop
                const repairCtx: RepairContext = {
                    sourceCode,
                    fileName: path.basename(item.sourceFile || item.testFile),
                    testFilePath: item.testFile,
                    workspaceRoot: inspection.paths.root,
                    maxIterations: cfg.maxIterations,
                };

                const repairResult = await this.repairLoop.repair(repairCtx, executor);

                return {
                    file: item.testFile,
                    success: true,
                    passed: repairResult.passed,
                    error: repairResult.passed ? null : repairResult.finalError,
                };
            }

            // Dry-run mode: generated but not tested
            return { file: item.testFile, success: true, passed: null, error: null };

        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Unknown error';
            this.logger.error(`Failed to generate test for ${item.testFile}`, e);
            return { file: item.testFile, success: false, passed: null, error: msg };
        }
    }

    // ────────────────────────────────────────────────
    // Inventory
    // ────────────────────────────────────────────────

    private async buildInventory(
        inspection: RepoInspection,
        cfg: PipelineConfig
    ): Promise<TestInventoryItem[]> {
        const items: TestInventoryItem[] = [];

        for (const testFile of inspection.paths.existingTestFiles) {
            const sourceFile = this.planBuilder.testToSource(testFile);
            const sourceExists = fs.existsSync(sourceFile);

            if (!sourceExists) {
                items.push({ testFile, sourceFile: null, status: 'orphan' });
                continue;
            }

            // Check for filler patterns
            try {
                const content = fs.readFileSync(testFile, 'utf-8');
                if (this.isFillerTest(content)) {
                    items.push({ testFile, sourceFile, status: 'filler' });
                    continue;
                }
            } catch {
                // Can't read — mark unknown
                items.push({ testFile, sourceFile, status: 'unknown' });
                continue;
            }

            // If execution-capable, try running
            if (cfg.mode === 'execution-capable') {
                try {
                    const result = await this.testRunner.runTest(
                        testFile,
                        inspection.paths.root
                    );
                    items.push({
                        testFile,
                        sourceFile,
                        status: result.success ? 'passing' : 'failing',
                        errorMessage: result.success ? undefined : result.output.substring(0, 500),
                    });
                } catch (e) {
                    items.push({
                        testFile,
                        sourceFile,
                        status: 'failing',
                        errorType: 'RUNTIME_ERROR',
                        errorMessage: e instanceof Error ? e.message : 'Unknown',
                    });
                }
            } else {
                items.push({ testFile, sourceFile, status: 'unknown' });
            }
        }

        return items;
    }



    /**
     * Detect filler tests using static analysis.
     */
    private isFillerTest(content: string): boolean {
        // Interface-only tests
        if (/expect\s*\(\s*typeof\s+\w+\s*\)\s*\.toBe\s*\(\s*['"]object['"]\s*\)/.test(content)) {
            return true;
        }
        // Placeholder only
        if (/expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/.test(content) && content.split('it(').length <= 2) {
            return true;
        }
        // Very short with no real assertions
        const itMatches = content.match(/it\s*\(/g);
        const expectMatches = content.match(/expect\s*\(/g);
        if (itMatches && itMatches.length >= 1 && (!expectMatches || expectMatches.length === 0)) {
            return true;
        }
        return false;
    }

    // ────────────────────────────────────────────────
    // Report
    // ────────────────────────────────────────────────

    private streamReport(result: PipelineResult, stream: vscode.ChatResponseStream): void {
        stream.markdown('\n---\n\n');
        stream.markdown('## 📊 Test Generation Report\n\n');
        stream.markdown('### Summary\n');
        stream.markdown(`| Metric | Value |\n|--------|-------|\n`);
        stream.markdown(`| Mode | ${result.mode} |\n`);
        stream.markdown(`| Tests created | ${result.testsCreated.length} |\n`);
        stream.markdown(`| Tests repaired | ${result.testsRepaired.length} |\n`);
        stream.markdown(`| Tests deleted (filler) | ${result.testsDeleted.length} |\n`);
        stream.markdown(`| Tests passing | ${result.testsPassing} |\n`);
        stream.markdown(`| Tests failing | ${result.testsFailing} |\n`);
        if (result.coverageAfter !== null) {
            stream.markdown(`| Coverage | ${result.coverageAfter.toFixed(1)}% |\n`);
        }
        stream.markdown(`| Time | ${(result.elapsed / 1000).toFixed(1)}s |\n`);

        if (result.aborted) {
            stream.markdown(`\n⚠️ **Pipeline aborted**: ${result.abortReason}\n`);
        }

        // Files changed
        if (result.testsCreated.length > 0) {
            stream.markdown('\n### Files Created\n');
            for (const f of result.testsCreated) {
                stream.markdown(`- \`${path.basename(f)}\`\n`);
            }
        }

        // Refactor suggestions
        if (result.plan.refactorSuggestions.length > 0) {
            stream.markdown('\n### Refactor Suggestions\n');
            for (const s of result.plan.refactorSuggestions.slice(0, 5)) {
                stream.markdown(`- **${path.basename(s.file)}**: ${s.issue} → ${s.suggestion}\n`);
            }
        }

        // Commands
        stream.markdown('\n### Commands\n');
        stream.markdown('```bash\n# Run all tests\nnpx jest\n\n# Run with coverage\nnpx jest --coverage\n\n# Run single test\nnpx jest path/to/file.test.ts\n```\n');
    }

    // ────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────

    private extractTestCode(raw: string): string {
        const fenceMatch = raw.match(
            /```(?:typescript|tsx|ts|javascript|jsx)?\n([\s\S]*?)```/
        );
        if (fenceMatch) {
            return fenceMatch[1].trim();
        }
        return raw.trim();
    }

    private checkCancellation(
        token: vscode.CancellationToken,
        result: PipelineResult
    ): void {
        if (token.isCancellationRequested) {
            throw new CancellationError();
        }
    }
}

class CancellationError extends Error {
    constructor() {
        super('Cancelled by user');
        this.name = 'CancellationError';
    }
}
