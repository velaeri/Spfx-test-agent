/**
 * RepairLoop — Executes failing tests, parses errors, applies
 * minimal patches, and iterates until green or stop conditions.
 *
 * This is "Fase 5" of the pipeline.
 *
 * Key features:
 * - Classifies errors (MOCK, IMPORT, TYPE, ASSERTION, RUNTIME)
 * - Applies deterministic quick-fixes for common issues
 * - Falls back to LLM for complex fixes
 * - Detects infinite loops (same error, no diff, error increase)
 * - Keeps "best attempt" for revert
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../services/Logger';
import { ILLMProvider, LLMResult } from '../interfaces/ILLMProvider';

// ────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────

export type ErrorCategory =
    | 'MOCK_ERROR'
    | 'IMPORT_ERROR'
    | 'TYPE_ERROR'
    | 'ASSERTION_ERROR'
    | 'RUNTIME_ERROR'
    | 'SYNTAX_ERROR'
    | 'UNKNOWN';

export type FixStrategy = 'quick_fix' | 'llm_fix' | 'unfixable';

export interface ParsedTestError {
    category: ErrorCategory;
    message: string;
    file: string | null;
    line: number | null;
    rawOutput: string;
    errorCount: number;
}

export interface RepairAttempt {
    iteration: number;
    errorCategory: ErrorCategory;
    fixStrategy: FixStrategy;
    errorsBefore: number;
    errorsAfter: number;
    diffSize: number;
    applied: boolean;
}

export interface RepairResult {
    testFile: string;
    passed: boolean;
    attempts: number;
    finalError: string | null;
    history: RepairAttempt[];
    bestTestCode: string;
}

export interface RepairContext {
    sourceCode: string;
    fileName: string;
    testFilePath: string;
    workspaceRoot: string;
    dependencyContext?: string;
    maxIterations: number;
}

export interface TestExecutor {
    run(testFilePath: string, workspaceRoot: string): Promise<{ success: boolean; output: string }>;
}

// ────────────────────────────────────────────────────
// Error parser patterns (Jest / Vitest)
// ────────────────────────────────────────────────────

const ERROR_PATTERNS: Array<{ category: ErrorCategory; pattern: RegExp }> = [
    // Import / Module resolution
    { category: 'IMPORT_ERROR', pattern: /Cannot find module '([^']+)'/i },
    { category: 'IMPORT_ERROR', pattern: /Module not found/i },
    { category: 'IMPORT_ERROR', pattern: /Could not locate module/i },

    // Mock errors
    { category: 'MOCK_ERROR', pattern: /jest\.mock\(\).*is not allowed/i },
    { category: 'MOCK_ERROR', pattern: /mockImplementation.*is not a function/i },
    { category: 'MOCK_ERROR', pattern: /Cannot spy.*not a function/i },
    { category: 'MOCK_ERROR', pattern: /mock.*is not a function/i },
    { category: 'MOCK_ERROR', pattern: /The module factory of `jest\.mock\(\)` is not allowed to reference/i },

    // Type errors (common in jest.mock factories with TS annotations)
    { category: 'TYPE_ERROR', pattern: /TypeError:/i },
    { category: 'TYPE_ERROR', pattern: /SyntaxError:.*unexpected token.*:/i },
    { category: 'TYPE_ERROR', pattern: /Type '.*' is not assignable/i },
    { category: 'TYPE_ERROR', pattern: /Property '.*' does not exist on type/i },

    // Assertion errors
    { category: 'ASSERTION_ERROR', pattern: /expect\(received\)/i },
    { category: 'ASSERTION_ERROR', pattern: /Expected.*Received/i },
    { category: 'ASSERTION_ERROR', pattern: /toBe|toEqual|toContain|toHaveLength.*received/i },

    // Syntax
    { category: 'SYNTAX_ERROR', pattern: /SyntaxError:/i },
    { category: 'SYNTAX_ERROR', pattern: /Unexpected token/i },

    // Runtime
    { category: 'RUNTIME_ERROR', pattern: /ReferenceError:/i },
    { category: 'RUNTIME_ERROR', pattern: /RangeError:/i },
];

// ────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────

export class RepairLoop {
    private logger: Logger;
    private llmProvider: ILLMProvider;

    constructor(llmProvider: ILLMProvider) {
        this.logger = Logger.getInstance();
        this.llmProvider = llmProvider;
    }

    /**
     * Execute the repair loop for a single test file.
     */
    async repair(
        context: RepairContext,
        executor: TestExecutor
    ): Promise<RepairResult> {
        const history: RepairAttempt[] = [];
        let currentTestCode = fs.readFileSync(context.testFilePath, 'utf-8');
        let bestTestCode = currentTestCode;
        let bestErrorCount = Infinity;
        let lastErrorSignature = '';

        this.logger.info(`RepairLoop: starting for ${context.testFilePath}`, {
            maxIterations: context.maxIterations,
        });

        for (let iteration = 0; iteration < context.maxIterations; iteration++) {
            // Run the test
            const runResult = await executor.run(
                context.testFilePath,
                context.workspaceRoot
            );

            if (runResult.success) {
                this.logger.info(
                    `RepairLoop: test passed on iteration ${iteration}`
                );
                return {
                    testFile: context.testFilePath,
                    passed: true,
                    attempts: iteration,
                    finalError: null,
                    history,
                    bestTestCode: currentTestCode,
                };
            }

            // Parse the error
            const parsedError = this.parseError(runResult.output);
            this.logger.info(`RepairLoop: iteration ${iteration}`, {
                category: parsedError.category,
                errorCount: parsedError.errorCount,
                message: parsedError.message.substring(0, 200),
            });

            // Track best attempt
            if (parsedError.errorCount < bestErrorCount) {
                bestErrorCount = parsedError.errorCount;
                bestTestCode = currentTestCode;
            }

            // Detect infinite loop: same error signature as last iteration
            const errorSignature = `${parsedError.category}:${parsedError.message.substring(0, 100)}`;
            if (errorSignature === lastErrorSignature) {
                this.logger.warn('RepairLoop: same error as previous iteration — breaking');
                history.push({
                    iteration,
                    errorCategory: parsedError.category,
                    fixStrategy: 'unfixable',
                    errorsBefore: parsedError.errorCount,
                    errorsAfter: parsedError.errorCount,
                    diffSize: 0,
                    applied: false,
                });
                break;
            }
            lastErrorSignature = errorSignature;

            // Determine fix strategy
            const strategy = this.classifyFixStrategy(parsedError);

            if (strategy === 'unfixable') {
                this.logger.warn(
                    `RepairLoop: error classified as unfixable: ${parsedError.message}`
                );
                history.push({
                    iteration,
                    errorCategory: parsedError.category,
                    fixStrategy: 'unfixable',
                    errorsBefore: parsedError.errorCount,
                    errorsAfter: parsedError.errorCount,
                    diffSize: 0,
                    applied: false,
                });
                break;
            }

            // Apply fix
            let fixedCode: string | null = null;

            if (strategy === 'quick_fix') {
                fixedCode = this.applyQuickFix(currentTestCode, parsedError);
            }

            if (!fixedCode || fixedCode === currentTestCode) {
                // Quick fix didn't produce a change — fall back to LLM
                fixedCode = await this.applyLLMFix(
                    currentTestCode,
                    parsedError,
                    context,
                    iteration
                );
            }

            if (!fixedCode || fixedCode === currentTestCode) {
                this.logger.warn('RepairLoop: fix produced no changes');
                history.push({
                    iteration,
                    errorCategory: parsedError.category,
                    fixStrategy: strategy,
                    errorsBefore: parsedError.errorCount,
                    errorsAfter: parsedError.errorCount,
                    diffSize: 0,
                    applied: false,
                });
                break;
            }

            // Write fixed code
            const diffSize = Math.abs(fixedCode.length - currentTestCode.length);
            fs.writeFileSync(context.testFilePath, fixedCode, 'utf-8');
            currentTestCode = fixedCode;

            // Verify the fix didn't introduce MORE errors
            const verifyResult = await executor.run(
                context.testFilePath,
                context.workspaceRoot
            );

            if (verifyResult.success) {
                history.push({
                    iteration,
                    errorCategory: parsedError.category,
                    fixStrategy: strategy,
                    errorsBefore: parsedError.errorCount,
                    errorsAfter: 0,
                    diffSize,
                    applied: true,
                });
                return {
                    testFile: context.testFilePath,
                    passed: true,
                    attempts: iteration + 1,
                    finalError: null,
                    history,
                    bestTestCode: currentTestCode,
                };
            }

            const newError = this.parseError(verifyResult.output);
            history.push({
                iteration,
                errorCategory: parsedError.category,
                fixStrategy: strategy,
                errorsBefore: parsedError.errorCount,
                errorsAfter: newError.errorCount,
                diffSize,
                applied: true,
            });

            // If errors increased, revert to best
            if (newError.errorCount > parsedError.errorCount) {
                this.logger.warn(
                    'RepairLoop: fix made things worse — reverting to best attempt'
                );
                fs.writeFileSync(context.testFilePath, bestTestCode, 'utf-8');
                currentTestCode = bestTestCode;
            }
        }

        // Return with final state
        return {
            testFile: context.testFilePath,
            passed: false,
            attempts: history.length,
            finalError: lastErrorSignature || 'Max iterations reached',
            history,
            bestTestCode,
        };
    }

    // ────────────────────────────────────────────────
    // Error parsing
    // ────────────────────────────────────────────────

    parseError(output: string): ParsedTestError {
        let category: ErrorCategory = 'UNKNOWN';
        let message = '';

        for (const ep of ERROR_PATTERNS) {
            const match = output.match(ep.pattern);
            if (match) {
                category = ep.category;
                message = match[0];
                break;
            }
        }

        // Extract file and line
        const locationMatch = output.match(
            /at\s+.*\(([^:]+):(\d+):\d+\)/
        );
        const file = locationMatch ? locationMatch[1] : null;
        const line = locationMatch ? parseInt(locationMatch[2], 10) : null;

        // Count number of failing tests
        const failCountMatch = output.match(/(\d+)\s+fail/i);
        const errorCount = failCountMatch
            ? parseInt(failCountMatch[1], 10)
            : 1;

        // Extract more context from "Expected / Received" blocks
        if (category === 'ASSERTION_ERROR') {
            const expectedReceived = output.match(
                /Expected:.*\n.*Received:.*/s
            );
            if (expectedReceived) {
                message = expectedReceived[0].substring(0, 500);
            }
        }

        return {
            category,
            message: message || output.substring(0, 500),
            file,
            line,
            rawOutput: output,
            errorCount,
        };
    }

    // ────────────────────────────────────────────────
    // Fix strategy classification
    // ────────────────────────────────────────────────

    private classifyFixStrategy(error: ParsedTestError): FixStrategy {
        switch (error.category) {
            case 'IMPORT_ERROR':
                // Check if it's a resolvable module issue
                if (error.message.includes('node_modules')) {
                    return 'unfixable'; // Missing package — can't fix in test
                }
                return 'quick_fix';

            case 'TYPE_ERROR':
                // TS types in jest.mock is a common quick fix
                if (
                    error.message.includes('jest.mock') ||
                    error.message.includes('SyntaxError')
                ) {
                    return 'quick_fix';
                }
                return 'llm_fix';

            case 'MOCK_ERROR':
                return 'llm_fix';

            case 'ASSERTION_ERROR':
                return 'llm_fix';

            case 'SYNTAX_ERROR':
                return 'quick_fix';

            case 'RUNTIME_ERROR':
                return 'llm_fix';

            default:
                return 'llm_fix';
        }
    }

    // ────────────────────────────────────────────────
    // Quick fixes (deterministic, no LLM)
    // ────────────────────────────────────────────────

    private applyQuickFix(
        testCode: string,
        error: ParsedTestError
    ): string | null {
        let fixed = testCode;

        switch (error.category) {
            case 'TYPE_ERROR':
            case 'SYNTAX_ERROR':
                // Remove type annotations from jest.mock factories
                fixed = this.removeTypesFromMockFactories(fixed);
                break;

            case 'IMPORT_ERROR': {
                // Try to fix relative import paths
                const moduleMatch = error.message.match(
                    /Cannot find module '([^']+)'/
                );
                if (moduleMatch) {
                    const missingModule = moduleMatch[1];
                    // If it's a relative import, try alternate paths
                    if (missingModule.startsWith('./') || missingModule.startsWith('../')) {
                        fixed = this.tryFixRelativeImport(fixed, missingModule);
                    }
                }
                break;
            }

            default:
                return null;
        }

        return fixed !== testCode ? fixed : null;
    }

    /**
     * Remove TypeScript type annotations from jest.mock() factory functions.
     * This is the #1 most common error in generated tests.
     *
     * Transforms:
     *   jest.mock('x', () => ({ fn: (a: string, b: number) => {} }))
     * Into:
     *   jest.mock('x', () => ({ fn: (a, b) => {} }))
     */
    private removeTypesFromMockFactories(code: string): string {
        // Pattern: inside jest.mock() second argument, find typed params
        return code.replace(
            /(jest\.mock\([^,]+,\s*\(\)\s*=>\s*(?:\(?\{[\s\S]*?\}\)?))\)/g,
            (fullMatch) => {
                // Within the factory, remove `: Type` annotations from params
                return fullMatch.replace(
                    /(\w+)\s*:\s*(?:string|number|boolean|any|unknown|void|object|Record<[^>]+>|Array<[^>]+>|\w+(?:\[\])?)/g,
                    '$1'
                );
            }
        );
    }

    /**
     * Try to fix a relative import by adding/removing '../' levels.
     */
    private tryFixRelativeImport(code: string, modulePath: string): string {
        // Try one level up
        const oneUp = modulePath.replace(/^\.\//, '../');
        // Try one level down
        const oneDown = modulePath.replace(/^\.\.\//, './');

        // Simple heuristic: just try adding a level
        return code.replace(
            new RegExp(this.escapeRegex(modulePath), 'g'),
            oneUp
        );
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ────────────────────────────────────────────────
    // LLM-based fix
    // ────────────────────────────────────────────────

    private async applyLLMFix(
        currentTestCode: string,
        error: ParsedTestError,
        context: RepairContext,
        attempt: number
    ): Promise<string | null> {
        try {
            const result = await this.llmProvider.fixTest({
                sourceCode: context.sourceCode,
                fileName: context.fileName,
                currentTestCode,
                errorContext: error.rawOutput.substring(0, 3000),
                attempt: attempt + 1,
                dependencyContext: context.dependencyContext,
            });

            if (result?.code) {
                return this.extractTestCode(result.code);
            }
            return null;
        } catch (e) {
            this.logger.error('RepairLoop: LLM fix failed', e);
            return null;
        }
    }

    /**
     * Extract clean test code from LLM response (strip markdown fences).
     */
    private extractTestCode(raw: string): string {
        // Remove markdown code fences if present
        const fenceMatch = raw.match(
            /```(?:typescript|tsx|ts|javascript|jsx)?\n([\s\S]*?)```/
        );
        if (fenceMatch) {
            return fenceMatch[1].trim();
        }
        return raw.trim();
    }
}
