/**
 * PromptAssembler — Composes the final LLM prompt by combining:
 *   1. Golden testing policy (best practices extracted from reference repos)
 *   2. Stack-specific guidance (SPFx, React, etc.)
 *   3. Local rules from the target repo
 *   4. Test plan context (current item, tier, priority)
 *   5. Tier-specific templates
 *
 * This replaces the static PROMPTS object for the quality pipeline.
 * The old PROMPTS are still used for the legacy path.
 */

import * as fs from 'fs';
import { Logger } from '../services/Logger';
import { RepoInspection } from '../services/RepoInspector';
import { TestPlanItem, TestPlanPriority } from '../services/TestPlanBuilder';
import { getPolicyText, TestTier, TIERS, MOCK_BOUNDARIES } from '../policies/GoldenPolicy';
import { ProjectStack } from '../services/StackDiscoveryService';
import { PROMPTS } from '../utils/prompts';

// ────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────

export interface AssembledPrompt {
    systemPrompt: string;
    userPrompt: string;
}

export interface GeneratePromptInput {
    /** Current test plan item being generated */
    planItem: TestPlanItem;
    /** Full source code of the file under test */
    sourceCode: string;
    /** Resolved dependency context (imports 2 levels deep) */
    dependencyContext?: string;
    /** Existing mock files available in the repo */
    availableMocks?: string[];
    /** Existing test patterns observed in the repo */
    existingPatterns?: string;
    /** Local rules text (from TESTING_DOCUMENTATION.md, etc.) */
    localRules?: string;
}

export interface FixPromptInput {
    sourceCode: string;
    fileName: string;
    currentTestCode: string;
    errorOutput: string;
    attempt: number;
    dependencyContext?: string;
}

export interface ReviewPromptInput {
    sourceCode: string;
    testCode: string;
    fileName: string;
}

export interface LearningPromptInput {
    sourceCode: string;
    originalTestCode: string;
    critique: string;
    fixedTestCode: string;
    fileName: string;
}

// ────────────────────────────────────────────────────
// Templates
// ────────────────────────────────────────────────────

const TIER_TEMPLATES: Record<TestTier, string> = {
    1: `## TEMPLATE: TIER 1 — Pure Logic

Structure:
\`\`\`typescript
/**
 * ═══════════════════════════════════════════════════
 * TIER 1 — Pure Logic — {ModuleName}
 * ═══════════════════════════════════════════════════
 */

import { <exports> } from "<import_path>";

describe("{ModuleName}", () => {
    describe("{methodName}", () => {
        it("returns expected output for valid input", () => {
            const result = {methodName}({input});
            expect(result).toEqual({expected});
        });

        it("handles empty/null input", () => {
            expect({methodName}(null)).toEqual({default});
        });

        it("does not mutate the original input", () => {
            const original = {input};
            const copy = JSON.parse(JSON.stringify(original));
            {methodName}(original);
            expect(original).toEqual(copy);
        });

        it("handles edge case: {description}", () => {
            expect({methodName}({edgeInput})).toEqual({edgeExpected});
        });
    });
});
\`\`\`

Rules for Tier 1:
- NO mocks required (pure functions)
- Test ALL exported functions/methods
- Include: happy path, error path, edge cases, immutability
- No \`beforeEach\` needed unless shared setup is significant`,

    2: `## TEMPLATE: TIER 2 — Services / Boundaries  

Structure:
\`\`\`typescript
/**
 * ═══════════════════════════════════════════════════
 * TIER 2 — Service — {ServiceName}
 * ═══════════════════════════════════════════════════
 */

// Mocks MUST be declared before imports
jest.mock("{boundary_path}", () => {
    // CRITICAL: No TypeScript type annotations here
    return {
        __esModule: true,
        default: class MockBase {
            protected spCache;
            constructor() { this.spCache = {}; }
        },
    };
});

import { {ServiceName} } from "{import_path}";

describe("{ServiceName}", () => {
    let service;
    let mockQuery;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new {ServiceName}();
        mockQuery = {query_mock_setup};
    });

    describe("{methodName}", () => {
        it("returns mapped data from successful query", async () => {
            mockQuery.mockResolvedValueOnce({success_response});
            const result = await service.{methodName}();
            expect(result).toEqual({expected});
        });

        it("returns undefined on error", async () => {
            mockQuery.mockRejectedValueOnce(new Error("network error"));
            const result = await service.{methodName}();
            expect(result).toBeUndefined();
        });
    });
});
\`\`\`

Rules for Tier 2:
- Mock at the BOUNDARY (base class, API client), not individual methods
- Use \`.mockResolvedValueOnce()\` per test
- Always include an error-path test
- Always include \`beforeEach(() => jest.clearAllMocks())\`
- Test pure helper methods separately (no mocks)
- No TypeScript annotations inside jest.mock() factories`,

    3: `## TEMPLATE: TIER 3 — Components / UI

Structure:
\`\`\`typescript
/**
 * ═══════════════════════════════════════════════════
 * TIER 3 — Component — {ComponentName}
 * ═══════════════════════════════════════════════════
 */

import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Component-specific mocks (router, context, etc.)
jest.mock("react-router-dom", () => ({
    useNavigate: jest.fn(),
}));

import { {ComponentName} } from "{import_path}";

describe("{ComponentName}", () => {
    const defaultProps = {default_props};

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("renders with required props", () => {
        render(<{ComponentName} {...defaultProps} />);
        expect(screen.getByTestId("{testid}")).toBeInTheDocument();
    });

    it("displays correct content from props", () => {
        render(<{ComponentName} {...defaultProps} />);
        expect(screen.getByText("{expected_text}")).toBeInTheDocument();
    });

    it("handles user interaction correctly", () => {
        render(<{ComponentName} {...defaultProps} />);
        fireEvent.click(screen.getByRole("button"));
        // Assert state change or callback
    });

    it("cleans up on unmount", () => {
        const spy = jest.spyOn(window, "removeEventListener");
        const { unmount } = render(<{ComponentName} {...defaultProps} />);
        unmount();
        spy.mockRestore();
    });
});
\`\`\`

Rules for Tier 3:
- UI library components are mocked via moduleNameMapper (stubs render children + data-testid)
- DO NOT add data-testid to production code
- CSS modules mocked via Proxy (returns class name as string)
- Use \`screen.getByText/Role/TestId\` — prefer accessible queries
- Use \`fireEvent\` for user interactions
- Use \`waitFor\` ONLY for async data loading
- No snapshot tests`,
};

// ────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────

export class PromptAssembler {
    private logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
    }

    /**
     * Assemble the full system + user prompt for test generation.
     */
    assembleGeneratePrompt(
        input: GeneratePromptInput,
        inspection: RepoInspection
    ): AssembledPrompt {
        const systemPrompt = this.buildSystemPrompt(inspection);
        const userPrompt = this.buildGenerateUserPrompt(input, inspection);

        this.logger.debug('PromptAssembler: assembled generate prompt', {
            systemLength: systemPrompt.length,
            userLength: userPrompt.length,
            tier: input.planItem.tier,
            priority: input.planItem.priority,
        });

        return { systemPrompt, userPrompt };
    }

    /**
     * Assemble prompt for fixing a failing test.
     */
    assembleFixPrompt(
        input: FixPromptInput,
        inspection: RepoInspection
    ): AssembledPrompt {
        const systemPrompt = this.buildSystemPrompt(inspection);
        const userPrompt = this.buildFixUserPrompt(input);

        return { systemPrompt, userPrompt };
    }

    /**
     * Assemble prompt for adversarial review.
     */
    assembleReviewPrompt(input: ReviewPromptInput): AssembledPrompt {
        const systemPrompt = `You are a Senior QA Automation Architect and a brutal code critic.
Your mission is to identify weaknesses, lazy patterns, and missing edge cases in unit tests.
You are objective, technical, and focused on "True Quality" over just "Green Tests".

CRITICAL EVALUATION CRITERIA:
1. **Mock Integrity**: Are the mocks too simplistic? Do they return realistic data for the component's logic?
2. **Assertion Value**: Avoid weak assertions like .toBeDefined() or .toBeTruthy() when specific values should be checked.
3. **SPFx Context**: If this is a SharePoint test, does it properly handle the depth of the context (webpartContext, pageContext, etc.)?
4. **Error Paths**: Does the test genuinely verify what happens when a service fails, or is it just testing the success path?
5. **Logic Coverage**: Does it test boundary conditions (empty arrays, nulls, long strings) mentioned or implied in the source code?

You must respond in JSON format with exactly these properties:
{
  "passed": boolean, // true if the test is of professional grade, false if it needs improvement
  "score": number, // 0-10 (high is better)
  "critique": "A concise and honest explanation of why the test is good or needs work",
  "suggestions": ["specific improvement 1", "specific improvement 2"]
}`;

        const userPrompt = `# CODE REVIEW REQUEST
**File:** \`${input.fileName}\`

## SOURCE CODE (Target)
\`\`\`typescript
${input.sourceCode}
\`\`\`

## UNIT TEST TO REVIEW
\`\`\`typescript
${input.testCode}
\`\`\`

Analyze the test against the source code and provide your technical verdict in JSON format.`;

        return { systemPrompt, userPrompt };
    }

    /**
     * Assemble prompt for the Learning Agent to document the improvement delta.
     */
    assembleLearningPrompt(input: LearningPromptInput): AssembledPrompt {
        const systemPrompt = `You are a Senior Software Development Data Curator.
Your task is to analyze an improvement cycle where a weak test was criticized and then fixed.
You must extract the "learning core" from this experience to help improve future test generation logic.

Your output will be used to build a knowledge base of "Mediocore vs Professional" testing patterns.

Respond in JSON format:
{
  "improvementDelta": "A technical summary of what was upgraded (e.g., 'Switched from shallow object mocks to full interface simulation')",
  "category": "mocking" | "logic" | "edge-case" | "spfx-context" | "other",
  "reasoning": "Why the original test was deficient and why the fix is superior"
}`;

        const userPrompt = `# LEARNING EXPERIENCE CAPTURE
**File:** \`${input.fileName}\`

## SOURCE CODE
\`\`\`typescript
${input.sourceCode}
\`\`\`

## ORIGINAL (WEAK) TEST
\`\`\`typescript
${input.originalTestCode}
\`\`\`

## CRITIQUE RECEIVED
${input.critique}

## FINAL (HIGH QUALITY) TEST
\`\`\`typescript
${input.fixedTestCode}
\`\`\`

Document the technical improvement delta in JSON format.`;

        return { systemPrompt, userPrompt };
    }

    // ────────────────────────────────────────────────
    // System prompt (shared for generate + fix)
    // ────────────────────────────────────────────────

    private buildSystemPrompt(inspection: RepoInspection): string {
        const parts: string[] = [];

        // 1. Golden testing policy (best practices)
        parts.push(getPolicyText());

        // 2. Stack-specific guidance (from existing extension)
        const stackGuidance = PROMPTS.buildSystemPrompt(inspection.stack);
        parts.push(stackGuidance);

        // 3. Available mocks in the repo
        if (inspection.existingMocks.length > 0) {
            parts.push(this.buildMockInventorySection(inspection));
        }

        // 4. Test config context
        if (inspection.testConfig) {
            parts.push(this.buildTestConfigSection(inspection));
        }

        return parts.join('\n\n---\n\n');
    }

    private buildMockInventorySection(inspection: RepoInspection): string {
        const lines = inspection.existingMocks.map(
            (m) => `- \`${m.relativePath}\` → mocks: ${m.mockedModule || 'unknown'}`
        );
        return `## AVAILABLE MOCKS IN THIS REPO
The following mock files already exist — reuse them instead of creating inline mocks.
${lines.join('\n')}`;
    }

    private buildTestConfigSection(inspection: RepoInspection): string {
        const tc = inspection.testConfig!;
        const parts = [`## TEST CONFIGURATION`];
        parts.push(`- Runner: ${tc.runner}`);
        parts.push(`- Environment: ${tc.testEnvironment || 'default'}`);
        parts.push(`- Preset: ${tc.preset || 'none'}`);
        if (tc.setupFiles.length > 0) {
            parts.push(`- Setup files: ${tc.setupFiles.join(', ')}`);
        }
        if (Object.keys(tc.moduleNameMapper).length > 0) {
            parts.push(`- moduleNameMapper entries: ${Object.keys(tc.moduleNameMapper).length}`);
            parts.push(`  These modules are already mocked via config — do NOT mock them again with jest.mock().`);
        }
        return parts.join('\n');
    }

    // ────────────────────────────────────────────────
    // User prompt for generation
    // ────────────────────────────────────────────────

    private buildGenerateUserPrompt(
        input: GeneratePromptInput,
        inspection: RepoInspection
    ): string {
        const { planItem, sourceCode, dependencyContext, existingPatterns, localRules, availableMocks } = input;
        const tierDef = TIERS.find((t) => t.tier === planItem.tier);

        const parts: string[] = [];

        // Header
        parts.push(`# GENERATE TEST: ${planItem.sourceFile}`);
        parts.push(`- **Tier**: ${planItem.tier} — ${tierDef?.label || 'Unknown'}`);
        parts.push(`- **Priority**: ${planItem.priority}`);
        parts.push(`- **Action**: ${planItem.action}`);
        parts.push(`- **Reason**: ${planItem.reason}`);
        parts.push(`- **Test file location**: ${planItem.testFile} (co-located with source)`);

        // Source code
        parts.push(`\n## SOURCE CODE\n\`\`\`typescript\n${sourceCode}\n\`\`\``);

        // Dependencies
        if (dependencyContext) {
            parts.push(`\n## DEPENDENCY CONTEXT\n${dependencyContext}`);
        }

        // Estimated mocks
        if (planItem.estimatedMocks.length > 0) {
            parts.push(`\n## MOCKS NEEDED\nThese external dependencies need to be mocked:`);
            for (const mock of planItem.estimatedMocks) {
                // Check if already handled by moduleNameMapper
                const isInMapper = inspection.testConfig?.moduleNameMapper &&
                    Object.keys(inspection.testConfig.moduleNameMapper).some(
                        (key) => new RegExp(key).test(mock)
                    );
                if (isInMapper) {
                    parts.push(`- \`${mock}\` — ✅ Already mocked via moduleNameMapper (do NOT re-mock)`);
                } else {
                    parts.push(`- \`${mock}\` — Needs jest.mock() in this test file`);
                }
            }
        }

        // Available mocks
        if (availableMocks && availableMocks.length > 0) {
            parts.push(`\n## AVAILABLE MOCK FILES\nReuse these existing mocks:`);
            parts.push(availableMocks.map((m) => `- \`${m}\``).join('\n'));
        }

        // Template for this tier
        parts.push(`\n${TIER_TEMPLATES[planItem.tier]}`);

        // Local rules
        if (localRules) {
            parts.push(`\n## LOCAL REPO RULES\n${localRules}`);
        }

        // Existing patterns
        if (existingPatterns) {
            parts.push(`\n## EXISTING TEST PATTERNS IN THIS REPO\nFollow the same style:\n${existingPatterns}`);
        }

        // Final instructions
        parts.push(`\n## INSTRUCTIONS
1. Generate ONLY the test code — no explanations, no markdown outside code blocks.
2. Follow golden testing policy strictly (see system prompt).
3. Place the test at: \`${planItem.testFile}\`
4. Use the template for Tier ${planItem.tier} as a structural guide.
5. Do NOT invent requirements — test only what the source code actually does.
6. Do NOT inflate coverage with meaningless assertions.
7. Include: happy path + error path + edge cases + immutability checks where applicable.`);

        return parts.join('\n');
    }

    // ────────────────────────────────────────────────
    // User prompt for fixing
    // ────────────────────────────────────────────────

    private buildFixUserPrompt(input: FixPromptInput): string {
        return `# FIX FAILING TEST

## Attempt ${input.attempt}

**File:** \`${input.fileName}\`

## SOURCE CODE (module under test)
\`\`\`typescript
${input.sourceCode}
\`\`\`

## CURRENT TEST CODE (failing)
\`\`\`typescript
${input.currentTestCode}
\`\`\`

## ERROR OUTPUT
\`\`\`
${input.errorOutput.substring(0, 3000)}
\`\`\`

${input.dependencyContext ? `## DEPENDENCY CONTEXT\n${input.dependencyContext}` : ''}

## FIX INSTRUCTIONS
1. Analyze the error output carefully.
2. Identify the root cause (mock issue, import issue, assertion error, etc.).
3. Apply the MINIMAL fix — do not rewrite the entire test.
4. CRITICAL: Do NOT use TypeScript type annotations inside jest.mock() factories.
5. Use .mockResolvedValueOnce() instead of .mockResolvedValue().
6. Ensure beforeEach calls jest.clearAllMocks().
7. Return ONLY the complete fixed test code — no explanations.`;
    }

    // ────────────────────────────────────────────────
    // Read local rules from files
    // ────────────────────────────────────────────────

    /**
     * Read and concatenate local rules files into a single string.
     */
    readLocalRules(rulesFiles: string[]): string {
        const parts: string[] = [];

        for (const filePath of rulesFiles) {
            try {
                // Handle package.json#testing special case
                if (filePath.endsWith('#testing')) {
                    const pkgPath = filePath.replace('#testing', '');
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                    if (pkg.testing) {
                        parts.push(`[package.json#testing]\n${JSON.stringify(pkg.testing, null, 2)}`);
                    }
                    continue;
                }

                const content = fs.readFileSync(filePath, 'utf-8');
                // Truncate very large docs
                const truncated = content.length > 5000
                    ? content.substring(0, 5000) + '\n[...truncated]'
                    : content;
                parts.push(`[${filePath}]\n${truncated}`);
            } catch {
                // Skip unreadable files
            }
        }

        return parts.join('\n\n---\n\n');
    }

    /**
     * Extract existing test patterns from the repo's passing tests.
     * Returns a summary of patterns found in up to 3 test files.
     */
    extractExistingPatterns(testFiles: string[], maxFiles: number = 3): string {
        const patterns: string[] = [];

        for (const testFile of testFiles.slice(0, maxFiles)) {
            try {
                const content = fs.readFileSync(testFile, 'utf-8');
                // Extract describe/it structure (first 50 lines)
                const lines = content.split('\n').slice(0, 50);
                const structure = lines
                    .filter((l) =>
                        l.trim().startsWith('describe(') ||
                        l.trim().startsWith('it(') ||
                        l.trim().startsWith('beforeEach(') ||
                        l.trim().startsWith('jest.mock(')
                    )
                    .join('\n');
                if (structure) {
                    patterns.push(`// ${testFile}\n${structure}`);
                }
            } catch {
                // Skip
            }
        }

        return patterns.join('\n\n');
    }
}
