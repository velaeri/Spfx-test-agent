/**
 * GoldenPolicy — Testing policy extracted from production-grade reference repos.
 *
 * Every rule in this file is derived from *observable patterns* in
 * battle-tested repositories.  Nothing is invented.
 *
 * The policy is consumed by PromptAssembler to build system-level
 * instructions and by TestPlanBuilder to prioritise and validate output.
 */

// ────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────

export type TestTier = 1 | 2 | 3;

export interface PolicyRule {
    id: string;
    category: PolicyCategory;
    description: string;
    enforcement: 'hard' | 'soft';
}

export type PolicyCategory =
    | 'naming'
    | 'structure'
    | 'mocking'
    | 'anti-flakiness'
    | 'quality-gate'
    | 'coverage'
    | 'file-location'
    | 'snapshot';

export interface QualityGate {
    id: string;
    label: string;
    check: (testCode: string) => QualityGateResult;
}

export interface QualityGateResult {
    passed: boolean;
    message: string;
}

export interface MockBoundary {
    pattern: string;
    strategy: 'moduleNameMapper' | 'jest.mock-factory' | 'jest.mock-empty';
    reason: string;
}

export interface TierDefinition {
    tier: TestTier;
    label: string;
    description: string;
    mockCost: 'none' | 'low' | 'medium' | 'high';
    priority: number; // lower = do first
    examples: string[];
}

// ────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────

export const TIERS: readonly TierDefinition[] = [
    {
        tier: 1,
        label: 'Pure Logic',
        description: 'Pure functions, reducers, constants, validators. No external mocks.',
        mockCost: 'none',
        priority: 1,
        examples: ['Utils.ts', 'FluentUIUtils.ts', 'constants.ts', 'reducer.ts'],
    },
    {
        tier: 2,
        label: 'Services / Boundaries',
        description: 'Services with external dependencies mocked at the boundary (API, DB, CMS).',
        mockCost: 'medium',
        priority: 2,
        examples: ['*SPManager.ts', '*Service.ts', 'pnpjsConfig.ts', 'apiClient.ts'],
    },
    {
        tier: 3,
        label: 'Components / UI',
        description: 'React/Angular/Vue components tested with Testing Library. Requires UI mocks.',
        mockCost: 'high',
        priority: 3,
        examples: ['*.tsx', '*Component.tsx', '*Page.tsx', '*View.tsx'],
    },
] as const;

// ────────────────────────────────────────────────────
// Rules — derived from production-grade testing patterns
// ────────────────────────────────────────────────────

export const RULES: readonly PolicyRule[] = [
    // ── naming ──
    {
        id: 'name-describe-class',
        category: 'naming',
        description:
            'Top-level `describe` must use the exact class/module name (PascalCase).',
        enforcement: 'hard',
    },
    {
        id: 'name-describe-method',
        category: 'naming',
        description:
            'Second-level `describe` should be the method name being tested.',
        enforcement: 'soft',
    },
    {
        id: 'name-it-behaviour',
        category: 'naming',
        description:
            'Each `it` must describe the expected behaviour: "[verb] [result] [condition]".',
        enforcement: 'hard',
    },

    // ── structure ──
    {
        id: 'struct-aaa',
        category: 'structure',
        description:
            'Tests follow implicit AAA (Arrange-Act-Assert) without comment labels.',
        enforcement: 'hard',
    },
    {
        id: 'struct-tier-banner',
        category: 'structure',
        description:
            'Each test file starts with a JSDoc banner: TIER N — Category — Module.',
        enforcement: 'soft',
    },
    {
        id: 'struct-single-file',
        category: 'structure',
        description:
            'One test file per source file; test lives in the same directory as its source.',
        enforcement: 'hard',
    },

    // ── mocking ──
    {
        id: 'mock-never-sut',
        category: 'mocking',
        description: 'Never mock the module under test.',
        enforcement: 'hard',
    },
    {
        id: 'mock-once-per-test',
        category: 'mocking',
        description:
            'Use `.mockResolvedValueOnce()` / `.mockReturnValueOnce()` per test, not `.mockResolvedValue()`.',
        enforcement: 'hard',
    },
    {
        id: 'mock-no-types-in-factory',
        category: 'mocking',
        description:
            'Do NOT use TypeScript type annotations inside `jest.mock()` factory functions.',
        enforcement: 'hard',
    },
    {
        id: 'mock-boundary-pattern',
        category: 'mocking',
        description:
            'Mock at the boundary (BaseSPManager, API client), not at individual method level.',
        enforcement: 'hard',
    },

    // ── anti-flakiness ──
    {
        id: 'flake-clear-mocks',
        category: 'anti-flakiness',
        description: '`beforeEach(() => jest.clearAllMocks())` is required in every describe with mocks.',
        enforcement: 'hard',
    },
    {
        id: 'flake-deterministic-data',
        category: 'anti-flakiness',
        description:
            'Test data must be hardcoded (deterministic). No Math.random(), no Date.now().',
        enforcement: 'hard',
    },
    {
        id: 'flake-reset-modules',
        category: 'anti-flakiness',
        description:
            'Use `jest.resetModules()` in beforeEach when testing singletons or cached modules.',
        enforcement: 'soft',
    },
    {
        id: 'flake-waitfor-selective',
        category: 'anti-flakiness',
        description: 'Use `waitFor()` only for async operations; do not abuse it as a "retry".',
        enforcement: 'soft',
    },
    {
        id: 'flake-immutability',
        category: 'anti-flakiness',
        description:
            'For functions that receive arrays/objects, include an immutability test.',
        enforcement: 'soft',
    },

    // ── snapshot ──
    {
        id: 'snap-none',
        category: 'snapshot',
        description: 'No snapshot tests allowed. Use explicit assertions.',
        enforcement: 'hard',
    },

    // ── quality-gate ──
    {
        id: 'qg-no-interface-test',
        category: 'quality-gate',
        description: 'Do not test pure TypeScript interfaces (they have no runtime representation).',
        enforcement: 'hard',
    },
    {
        id: 'qg-no-lib-behaviour',
        category: 'quality-gate',
        description: 'Do not test third-party library behaviour — only test YOUR integration with it.',
        enforcement: 'hard',
    },
    {
        id: 'qg-no-expect-true',
        category: 'quality-gate',
        description: 'Do not use `expect(true).toBe(true)` or similar placeholder assertions.',
        enforcement: 'hard',
    },
    {
        id: 'qg-error-path',
        category: 'quality-gate',
        description: 'Every async function must have an error-path test (reject/throw → expected fallback).',
        enforcement: 'hard',
    },
    {
        id: 'qg-edge-cases',
        category: 'quality-gate',
        description: 'Include edge cases: empty input, null, boundary values.',
        enforcement: 'soft',
    },
    {
        id: 'qg-no-testid-in-prod',
        category: 'quality-gate',
        description: 'Do not add `data-testid` to production code; stubs add their own.',
        enforcement: 'hard',
    },

    // ── coverage ──
    {
        id: 'cov-exclude-interfaces',
        category: 'coverage',
        description: 'Exclude `**/Models/I*.ts`, `**/models/I*.ts(x)` from coverage.',
        enforcement: 'hard',
    },
    {
        id: 'cov-exclude-dts',
        category: 'coverage',
        description: 'Exclude `*.d.ts` and `__mocks__/**` from coverage.',
        enforcement: 'hard',
    },
    {
        id: 'cov-exclude-barrels',
        category: 'coverage',
        description: 'Exclude `index.ts` barrel files and `setupTests.ts` from coverage.',
        enforcement: 'soft',
    },
    {
        id: 'cov-no-inflate',
        category: 'coverage',
        description:
            'Do not generate tests that only inflate coverage without meaningful assertions.',
        enforcement: 'hard',
    },

    // ── file-location ──
    {
        id: 'loc-colocate',
        category: 'file-location',
        description: 'Test file sits next to the source file, not in a separate __tests__ folder.',
        enforcement: 'hard',
    },
    {
        id: 'loc-suffix',
        category: 'file-location',
        description: 'Test file uses `.test.ts` or `.test.tsx` suffix.',
        enforcement: 'hard',
    },
    {
        id: 'loc-mocks-dir',
        category: 'file-location',
        description: 'Shared mocks live in `src/__mocks__/`. Test helpers in `src/__testHelpers__/`.',
        enforcement: 'soft',
    },
] as const;

// ── Common mock boundaries (framework-agnostic core + SPFx-specific) ──
export const MOCK_BOUNDARIES: readonly MockBoundary[] = [
    // CSS / assets
    { pattern: '\\.(css|less|scss|sass)$', strategy: 'moduleNameMapper', reason: 'Stylesheets have no runtime behaviour' },
    { pattern: '\\.(jpg|jpeg|png|gif|svg)$', strategy: 'moduleNameMapper', reason: 'Static assets' },
    // SPFx-specific
    { pattern: '^@pnp/sp/.+$', strategy: 'moduleNameMapper', reason: 'PnP side-effect augmentation imports' },
    { pattern: '^@pnp/logging$', strategy: 'moduleNameMapper', reason: 'Logging side effects' },
    { pattern: '^@fluentui/react', strategy: 'moduleNameMapper', reason: 'UI component library' },
    { pattern: '^office-ui-fabric-react', strategy: 'moduleNameMapper', reason: 'Legacy Fluent UI' },
    { pattern: '^recharts$', strategy: 'moduleNameMapper', reason: 'Chart library' },
    // Framework runtime
    { pattern: '@microsoft/sp-core-library', strategy: 'jest.mock-factory', reason: 'SPFx runtime' },
    { pattern: '@microsoft/sp-webpart-base', strategy: 'jest.mock-factory', reason: 'SPFx WebPart base' },
    { pattern: '@microsoft/sp-property-pane', strategy: 'jest.mock-empty', reason: 'SPFx property pane' },
] as const;

// ────────────────────────────────────────────────────
// Quality Gate Checks (static analysis of generated test code)
// ────────────────────────────────────────────────────

export const QUALITY_GATES: readonly QualityGate[] = [
    {
        id: 'qg-has-describe',
        label: 'Has describe block',
        check: (code) => ({
            passed: /describe\s*\(/.test(code),
            message: 'Test must have at least one describe block.',
        }),
    },
    {
        id: 'qg-has-it',
        label: 'Has it blocks',
        check: (code) => ({
            passed: /it\s*\(/.test(code),
            message: 'Test must have at least one it block.',
        }),
    },
    {
        id: 'qg-has-clear-mocks',
        label: 'Has clearAllMocks',
        check: (code) => {
            const hasMocks = /jest\.mock\(/.test(code) || /jest\.fn\(/.test(code);
            if (!hasMocks) { return { passed: true, message: 'No mocks — clearAllMocks not required.' }; }
            return {
                passed: /jest\.clearAllMocks\(\)/.test(code),
                message: 'beforeEach must call jest.clearAllMocks() when mocks are present.',
            };
        },
    },
    {
        id: 'qg-no-snapshot',
        label: 'No snapshots',
        check: (code) => ({
            passed: !/toMatchSnapshot|toMatchInlineSnapshot/.test(code),
            message: 'Snapshot tests are not allowed. Use explicit assertions.',
        }),
    },
    {
        id: 'qg-no-expect-true',
        label: 'No placeholder assertions',
        check: (code) => ({
            passed: !/expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/.test(code),
            message: 'Placeholder `expect(true).toBe(true)` is not allowed.',
        }),
    },
    {
        id: 'qg-no-types-in-mock',
        label: 'No TS types in jest.mock factory',
        check: (code) => {
            // Detect typed arrow params inside jest.mock(() => { ... })
            const mockFactories = code.match(/jest\.mock\([^)]*,\s*\(\)\s*=>\s*\{[^}]*\}/g) || [];
            for (const factory of mockFactories) {
                // Check for typed params like (x: string) =>
                if (/\(\s*\w+\s*:\s*\w+/.test(factory)) {
                    return {
                        passed: false,
                        message: 'Do not use TypeScript type annotations inside jest.mock() factory.',
                    };
                }
            }
            return { passed: true, message: 'No typed params in mock factories.' };
        },
    },
    {
        id: 'qg-mockonce',
        label: 'Uses mockOnce variants',
        check: (code) => {
            const hasMockResolved = /\.mockResolvedValue\(/.test(code);
            const hasMockReturn = /\.mockReturnValue\(/.test(code);
            const notOnce = (hasMockResolved || hasMockReturn);
            // Allow in beforeAll but not in it blocks – simplified: just flag if mockResolvedValue without Once
            if (!notOnce) { return { passed: true, message: 'OK' }; }
            return {
                passed: false,
                message: 'Prefer .mockResolvedValueOnce() / .mockReturnValueOnce() over non-once variants.',
            };
        },
    },
    {
        id: 'qg-error-path',
        label: 'Has error path test',
        check: (code) => {
            const hasAsync = /async\s/.test(code);
            if (!hasAsync) { return { passed: true, message: 'No async code — error path not required.' }; }
            const hasReject = /mockRejectedValue|mockRejectedValueOnce|throw|rejects/.test(code);
            const hasErrorAssert = /toBeUndefined|toBeNull|toThrow|rejects|toEqual\s*\(\s*\[\s*\]\s*\)/.test(code);
            return {
                passed: hasReject || hasErrorAssert,
                message: 'Async functions should have error-path tests (reject → expected fallback).',
            };
        },
    },
    {
        id: 'qg-colocated',
        label: 'File naming convention',
        check: (code) => {
            // This is a code-level check; file-level validation is done by TestPlanBuilder.
            return { passed: true, message: 'File naming checked at plan level.' };
        },
    },
] as const;

// ────────────────────────────────────────────────────
// Skip heuristics — when NOT to generate a test
// ────────────────────────────────────────────────────

export interface SkipReason {
    pattern: RegExp;
    reason: string;
}

export const SKIP_PATTERNS: readonly SkipReason[] = [
    { pattern: /^I[A-Z].*\.ts$/, reason: 'Pure interface file — no runtime code.' },
    { pattern: /\.d\.ts$/, reason: 'Type declaration file.' },
    { pattern: /^index\.ts$/, reason: 'Barrel re-export file.' },
    { pattern: /setupTests\.ts$/, reason: 'Test setup file.' },
    { pattern: /\.stories\.(ts|tsx)$/, reason: 'Storybook file — not a testable module.' },
    { pattern: /\.config\.(js|ts)$/, reason: 'Configuration file — low ROI.' },
] as const;

/**
 * Check if a file should be skipped based on golden policy patterns.
 */
export function shouldSkipFile(fileName: string, executableLines?: number): SkipReason | null {
    for (const skip of SKIP_PATTERNS) {
        if (skip.pattern.test(fileName)) {
            return skip;
        }
    }
    if (executableLines !== undefined && executableLines < 10) {
        return { pattern: /.*/, reason: `Only ${executableLines} executable lines — ROI too low.` };
    }
    return null;
}

/**
 * Classify a source file into its appropriate test tier.
 */
export function classifyTier(filePath: string, hasExternalDeps: boolean, isComponent: boolean): TestTier {
    if (isComponent) { return 3; }
    if (hasExternalDeps) { return 2; }
    return 1;
}

/**
 * Run all quality gates on generated test code.
 * Returns { passed: boolean, results: QualityGateResult[] }.
 */
export function evaluateQualityGates(testCode: string): {
    passed: boolean;
    results: Array<{ gate: string; result: QualityGateResult }>;
} {
    const results = QUALITY_GATES.map((gate) => ({
        gate: gate.id,
        result: gate.check(testCode),
    }));
    const hardGateIds = RULES
        .filter((r) => r.enforcement === 'hard')
        .map((r) => r.id);
    // A hard failure on any gate with matching rule = overall fail
    const passed = results.every((r) => {
        const isHard = hardGateIds.some((id) => r.gate.includes(id.replace('qg-', '')));
        return r.result.passed || !isHard;
    });
    return { passed, results };
}

/**
 * Get the full policy text suitable for embedding in an LLM system prompt.
 */
export function getPolicyText(): string {
    const hardRules = RULES.filter((r) => r.enforcement === 'hard');
    const softRules = RULES.filter((r) => r.enforcement === 'soft');

    return `## GOLDEN TESTING POLICY

### HARD RULES (violations = reject test)
${hardRules.map((r, i) => `${i + 1}. [${r.category}] ${r.description}`).join('\n')}

### SOFT RULES (prefer but don't reject)
${softRules.map((r, i) => `${i + 1}. [${r.category}] ${r.description}`).join('\n')}

### TEST TIER PRIORITY (generate in this order)
${TIERS.map((t) => `- **Tier ${t.tier} — ${t.label}**: ${t.description} (mock cost: ${t.mockCost})`).join('\n')}

### MOCK BOUNDARIES (always mock these)
${MOCK_BOUNDARIES.map((b) => `- \`${b.pattern}\` — ${b.reason} (strategy: ${b.strategy})`).join('\n')}

### SKIP PATTERNS (do NOT generate tests for)
${SKIP_PATTERNS.map((s) => `- \`${s.pattern.source}\` — ${s.reason}`).join('\n')}
- Files with < 10 executable lines — ROI too low.

### QUALITY GATES
${QUALITY_GATES.map((g) => `- ${g.label}`).join('\n')}
`;
}
