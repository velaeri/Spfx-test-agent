/**
 * TestPlanBuilder — Generates a prioritised P0/P1/P2 test plan
 * from a RepoInspection and golden testing policy.
 *
 * This is "Fase 3" of the pipeline: deterministic planning,
 * no LLM calls required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../services/Logger';
import { RepoInspection } from '../services/RepoInspector';
import {
    TestTier,
    TIERS,
    shouldSkipFile,
    classifyTier,
    SKIP_PATTERNS,
} from '../policies/GoldenPolicy';

// ────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────

export type TestPlanPriority = 'P0' | 'P1' | 'P2';
export type TestPlanAction = 'create' | 'repair' | 'extend' | 'delete';

export interface TestPlanItem {
    sourceFile: string;
    testFile: string;
    tier: TestTier;
    priority: TestPlanPriority;
    action: TestPlanAction;
    reason: string;
    estimatedMocks: string[];
    estimatedTests: number;
}

export interface RefactorSuggestion {
    file: string;
    issue: string;
    suggestion: string;
}

export interface TestPlan {
    p0: TestPlanItem[];
    p1: TestPlanItem[];
    p2: TestPlanItem[];
    fillerToDelete: string[];
    failingToRepair: TestPlanItem[];
    estimatedTotalItems: number;
    refactorSuggestions: RefactorSuggestion[];
}

export interface TestInventoryItem {
    testFile: string;
    sourceFile: string | null;
    status: 'passing' | 'failing' | 'filler' | 'orphan' | 'unknown';
    errorType?: string;
    errorMessage?: string;
}

// ────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────

export class TestPlanBuilder {
    private logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
    }

    /**
     * Build a prioritised test plan from repo inspection results.
     *
     * @param inspection - output of RepoInspector.inspect()
     * @param inventory - optional pre-run inventory of existing test results
     * @param maxFiles - max files to include in plan (default: 50)
     */
    buildPlan(
        inspection: RepoInspection,
        inventory?: TestInventoryItem[],
        maxFiles: number = 50
    ): TestPlan {
        this.logger.info('TestPlanBuilder: building plan', {
            sourceFiles: inspection.paths.sourceFiles.length,
            existingTests: inspection.paths.existingTestFiles.length,
        });

        const plan: TestPlan = {
            p0: [],
            p1: [],
            p2: [],
            fillerToDelete: [],
            failingToRepair: [],
            estimatedTotalItems: 0,
            refactorSuggestions: [],
        };

        // Step 1: Process existing tests (repair/delete filler)
        if (inventory) {
            this.processInventory(inventory, plan);
        }

        // Step 2: Find uncovered source files
        const coveredSources = new Set(
            inspection.paths.existingTestFiles.map((t) => this.testToSource(t))
        );

        const uncoveredSources = inspection.paths.sourceFiles.filter(
            (s) => !coveredSources.has(s)
        );

        // Step 3: Classify and prioritise each uncovered source
        for (const sourceFile of uncoveredSources) {
            const fileName = path.basename(sourceFile);
            const skip = shouldSkipFile(fileName);
            if (skip) {
                this.logger.debug(`Skipping ${fileName}: ${skip.reason}`);
                continue;
            }

            const item = this.classifySourceFile(sourceFile, inspection);
            if (item) {
                this.addToPlan(item, plan);
            }
        }

        // Step 4: Sort within each priority by tier (lower tier first)
        plan.p0.sort((a, b) => a.tier - b.tier);
        plan.p1.sort((a, b) => a.tier - b.tier);
        plan.p2.sort((a, b) => a.tier - b.tier);

        // Step 5: Detect hard-to-test code
        plan.refactorSuggestions = this.detectRefactorNeeds(
            uncoveredSources,
            inspection
        );

        // Step 6: Truncate to maxFiles
        plan.estimatedTotalItems =
            plan.p0.length +
            plan.p1.length +
            plan.p2.length +
            plan.failingToRepair.length;

        if (plan.estimatedTotalItems > maxFiles) {
            this.truncatePlan(plan, maxFiles);
        }

        this.logger.info('TestPlanBuilder: plan complete', {
            p0: plan.p0.length,
            p1: plan.p1.length,
            p2: plan.p2.length,
            toRepair: plan.failingToRepair.length,
            toDelete: plan.fillerToDelete.length,
            refactorSuggestions: plan.refactorSuggestions.length,
        });

        return plan;
    }

    // ────────────────────────────────────────────────
    // Inventory processing
    // ────────────────────────────────────────────────

    private processInventory(
        inventory: TestInventoryItem[],
        plan: TestPlan
    ): void {
        for (const item of inventory) {
            switch (item.status) {
                case 'failing':
                    plan.failingToRepair.push({
                        sourceFile: item.sourceFile || '',
                        testFile: item.testFile,
                        tier: 1, // Will be re-classified
                        priority: 'P0',
                        action: 'repair',
                        reason: `Failing: ${item.errorType || 'unknown'} — ${item.errorMessage || ''}`,
                        estimatedMocks: [],
                        estimatedTests: 0,
                    });
                    break;

                case 'filler':
                    plan.fillerToDelete.push(item.testFile);
                    break;

                case 'orphan':
                    plan.fillerToDelete.push(item.testFile);
                    this.logger.debug(`Orphan test: ${item.testFile}`);
                    break;

                default:
                    // passing or unknown — leave as is
                    break;
            }
        }
    }

    // ────────────────────────────────────────────────
    // Classification
    // ────────────────────────────────────────────────

    private classifySourceFile(
        sourceFile: string,
        inspection: RepoInspection
    ): TestPlanItem | null {
        const fileName = path.basename(sourceFile);
        const ext = path.extname(sourceFile);
        const isComponent = ext === '.tsx' || ext === '.jsx';

        // Quick analysis: read first 50 lines to detect imports
        let hasExternalDeps = false;
        let externalImports: string[] = [];
        let executableLines = 0;

        try {
            const content = fs.readFileSync(sourceFile, 'utf-8');
            const lines = content.split('\n');
            executableLines = this.countExecutableLines(lines);

            // Check for skip by executable lines
            const skipByLines = shouldSkipFile(fileName, executableLines);
            if (skipByLines) {
                this.logger.debug(`Skipping ${fileName}: ${skipByLines.reason}`);
                return null;
            }

            externalImports = this.extractExternalImports(lines);
            hasExternalDeps = externalImports.length > 0;
        } catch {
            // Cannot read file — skip
            return null;
        }

        const tier = classifyTier(sourceFile, hasExternalDeps, isComponent);
        const priority = this.tierToPriority(tier, hasExternalDeps, executableLines);
        const testFile = this.sourceToTest(sourceFile);

        return {
            sourceFile,
            testFile,
            tier,
            priority,
            action: 'create',
            reason: this.buildReason(tier, executableLines, externalImports),
            estimatedMocks: externalImports,
            estimatedTests: this.estimateTestCount(tier, executableLines),
        };
    }

    private tierToPriority(
        tier: TestTier,
        hasExternalDeps: boolean,
        executableLines: number
    ): TestPlanPriority {
        // Tier 1 pure functions = always P0
        if (tier === 1) { return 'P0'; }

        // Tier 2 services with significant logic = P0, otherwise P1
        if (tier === 2) {
            return executableLines > 30 ? 'P0' : 'P1';
        }

        // Tier 3 components: significant = P1, presentation-only = P2
        if (executableLines > 50) { return 'P1'; }
        return 'P2';
    }

    private buildReason(
        tier: TestTier,
        executableLines: number,
        imports: string[]
    ): string {
        const tierDef = TIERS.find((t) => t.tier === tier);
        const label = tierDef?.label || `Tier ${tier}`;
        const parts = [`${label} — ${executableLines} executable lines`];
        if (imports.length > 0) {
            parts.push(`mocks needed: ${imports.slice(0, 3).join(', ')}${imports.length > 3 ? '...' : ''}`);
        }
        return parts.join('. ');
    }

    private estimateTestCount(tier: TestTier, executableLines: number): number {
        // Rough heuristic: ~1 test per 8-12 executable lines for Tier 1-2,
        // ~1 test per 15 lines for Tier 3
        const ratio = tier <= 2 ? 10 : 15;
        return Math.max(2, Math.round(executableLines / ratio));
    }

    // ────────────────────────────────────────────────
    // Code analysis helpers
    // ────────────────────────────────────────────────

    private countExecutableLines(lines: string[]): number {
        let count = 0;
        for (const line of lines) {
            const trimmed = line.trim();
            if (
                trimmed.length === 0 ||
                trimmed.startsWith('//') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('*') ||
                trimmed.startsWith('*/') ||
                trimmed.startsWith('import ') ||
                trimmed.startsWith('export type ') ||
                trimmed.startsWith('export interface ') ||
                trimmed.startsWith('interface ') ||
                trimmed.startsWith('type ') ||
                trimmed === '{' ||
                trimmed === '}' ||
                trimmed === '};'
            ) {
                continue;
            }
            count++;
        }
        return count;
    }

    private extractExternalImports(lines: string[]): string[] {
        const externals: string[] = [];
        const localPrefixes = ['./', '../', 'src/'];

        for (const line of lines) {
            const match = line.match(/import\s+.*from\s+['"]([^'"]+)['"]/);
            if (match) {
                const mod = match[1];
                const isLocal = localPrefixes.some((p) => mod.startsWith(p));
                if (!isLocal) {
                    externals.push(mod);
                }
            }
        }

        return [...new Set(externals)];
    }

    // ────────────────────────────────────────────────
    // File path helpers
    // ────────────────────────────────────────────────

    /**
     * Convert a source file path to its expected test file path (co-located).
     */
    sourceToTest(sourceFile: string): string {
        const ext = path.extname(sourceFile);
        const base = path.basename(sourceFile, ext);
        const dir = path.dirname(sourceFile);
        return path.join(dir, `${base}.test${ext}`);
    }

    /**
     * Convert a test file path to its expected source file path.
     */
    testToSource(testFile: string): string {
        const ext = path.extname(testFile);
        const base = path.basename(testFile, ext).replace(/\.test$/, '');
        const dir = path.dirname(testFile);
        return path.join(dir, `${base}${ext}`);
    }

    // ────────────────────────────────────────────────
    // Hard-to-test detection
    // ────────────────────────────────────────────────

    private detectRefactorNeeds(
        sourceFiles: string[],
        inspection: RepoInspection
    ): RefactorSuggestion[] {
        const suggestions: RefactorSuggestion[] = [];

        for (const sourceFile of sourceFiles) {
            try {
                const content = fs.readFileSync(sourceFile, 'utf-8');
                const lines = content.split('\n');
                const imports = this.extractExternalImports(lines);
                const execLines = this.countExecutableLines(lines);

                // >5 external deps → complex mocking
                if (imports.length > 5) {
                    suggestions.push({
                        file: sourceFile,
                        issue: `${imports.length} external dependencies — high mock cost.`,
                        suggestion:
                            'Consider extracting pure logic into a separate util file that can be tested without mocks.',
                    });
                }

                // Singleton pattern detected
                if (
                    content.includes('static getInstance') ||
                    content.includes('let instance:')
                ) {
                    suggestions.push({
                        file: sourceFile,
                        issue: 'Singleton pattern detected.',
                        suggestion:
                            'Use `jest.resetModules()` in beforeEach to get fresh instances per test.',
                    });
                }

                // Constructor with side effects
                const constructorMatch = content.match(
                    /constructor\s*\([^)]*\)\s*\{([^}]*)\}/s
                );
                if (constructorMatch) {
                    const body = constructorMatch[1];
                    if (
                        body.includes('fetch(') ||
                        body.includes('.subscribe(') ||
                        body.includes('addEventListener')
                    ) {
                        suggestions.push({
                            file: sourceFile,
                            issue: 'Constructor has side effects (network call, subscription, or event listener).',
                            suggestion:
                                'Consider moving side effects to an `init()` method or using dependency injection.',
                        });
                    }
                }

                // No exports
                if (
                    !content.includes('export ') &&
                    !content.includes('module.exports')
                ) {
                    suggestions.push({
                        file: sourceFile,
                        issue: 'No exports found — nothing testable from outside.',
                        suggestion:
                            'Mark as low ROI or expose internal logic through exports.',
                    });
                }
            } catch {
                // Cannot read — skip
            }
        }

        return suggestions;
    }

    // ────────────────────────────────────────────────
    // Plan helpers
    // ────────────────────────────────────────────────

    private addToPlan(item: TestPlanItem, plan: TestPlan): void {
        switch (item.priority) {
            case 'P0':
                plan.p0.push(item);
                break;
            case 'P1':
                plan.p1.push(item);
                break;
            case 'P2':
                plan.p2.push(item);
                break;
        }
    }

    private truncatePlan(plan: TestPlan, maxFiles: number): void {
        // Truncate P2 first, then P1
        const totalAfterRepair = plan.p0.length + plan.failingToRepair.length;

        if (totalAfterRepair >= maxFiles) {
            plan.p1 = [];
            plan.p2 = [];
            plan.p0 = plan.p0.slice(0, maxFiles - plan.failingToRepair.length);
            return;
        }

        const remaining = maxFiles - totalAfterRepair;
        if (plan.p1.length > remaining) {
            plan.p1 = plan.p1.slice(0, remaining);
            plan.p2 = [];
            return;
        }

        const remaining2 = remaining - plan.p1.length;
        if (plan.p2.length > remaining2) {
            plan.p2 = plan.p2.slice(0, remaining2);
        }
    }
}
