/**
 * Enhanced prompt system that includes full dependency context
 * for intelligent test generation.
 */

export const PROMPTS = {
    SYSTEM: `You are an expert in TypeScript unit testing for SharePoint Framework (SPFx) projects using Jest and ts-jest.

You generate COMPLETE, WORKING test files that compile and pass on first try.

KEY RULES:
1. Use jest.mock() to mock ALL external modules (node_modules) BEFORE any other code
2. For SPFx web parts, mock @microsoft/sp-* packages completely
3. For React components, use @testing-library/react if installed, otherwise use basic React.createElement rendering
4. Use identity-obj-proxy pattern for CSS/SCSS modules (already configured in jest.config)
5. Keep mock implementations simple — use jest.fn()
6. Use "any" type for mock variables to avoid TypeScript parsing issues with ts-jest
7. Always test the actual exported behavior, not internal implementation details
8. Write meaningful test descriptions that explain business logic
9. NEVER import from files that don't exist in the project

MOCK PATTERNS FOR SPFx:
- Mock @microsoft/sp-webpart-base with a simple class that has context property
- Mock @microsoft/sp-http with SPHttpClient containing get/post methods returning Promises
- Mock @fluentui/react components as simple functions returning null
- Mock .module.scss files as empty objects (handled by jest config)

RESPONSE FORMAT:
- Return ONLY the complete test file code inside a typescript code block
- NO explanations before or after the code
- The code must be self-contained and executable`,

    /**
     * Generate test with FULL context about the file and its dependencies
     */
    GENERATE_TEST: (fileName: string, sourceCode: string, dependencyContext: string): string => {
        return [
            'Generate comprehensive Jest unit tests for this SPFx file.',
            '',
            `**File to test:** ${fileName}`,
            '',
            dependencyContext,
            '',
            '**Source Code to test:**',
            '```typescript',
            sourceCode,
            '```',
            '',
            'REQUIREMENTS:',
            '1. Mock ALL external package imports with jest.mock() at the top of the file',
            '2. Read the dependency files above to understand the REAL types, interfaces, and class signatures',
            '3. Create mocks that match the ACTUAL interface shape (not guessed shapes)',
            '4. Test each exported function, class method, or component rendering',
            '5. For React components: test rendering with required props, test user interactions',
            '6. For SPFx WebParts: mock the WebPart context, test render method',
            '7. For pure functions/services: test input→output for normal and edge cases',
            '8. Use describe/it blocks with clear descriptions in English',
            '',
            'Return ONLY the complete test file code.'
        ].join('\n');
    },

    /**
     * Fix a failing test with full context: source, error, current test, and dependencies
     */
    FIX_TEST: (
        attemptStr: string,
        fileName: string,
        currentTestCode: string,
        errorContext: string,
        sourceCode: string,
        dependencyContext: string,
        environmentHints: string
    ): string => {
        return [
            `The test for ${fileName} is FAILING. Fix it completely.`,
            '',
            `**Attempt:** ${attemptStr}`,
            '',
            '**Error Output:**',
            '```',
            errorContext,
            '```',
            environmentHints,
            '',
            dependencyContext,
            '',
            '**Source Code being tested:**',
            '```typescript',
            sourceCode,
            '```',
            '',
            '**Current FAILING test code:**',
            '```typescript',
            currentTestCode,
            '```',
            '',
            'ANALYZE THE ERROR and apply the correct fix:',
            '',
            '- If "Cannot find module" → check imports match real file paths from the dependency list above',
            '- If "is not a constructor" → the mock does not match the real module shape; read the dependency code above',
            '- If "SyntaxError" or "Unexpected token" → the mock has TypeScript types inside jest.mock(); remove them',
            '- If "getVmContext" → wrong jest-environment-jsdom version; add @jest-environment jsdom docblock or change testEnvironment',
            '- If "cannot read property of undefined" → the mock is missing a property; add it based on the real source code',
            '- If test assertion fails → re-read the source code to understand the real behavior',
            '',
            'Return the COMPLETE FIXED test file code — not a partial diff.'
        ].join('\n');
    },

    /**
     * Analyze an error to determine if it's an infrastructure problem vs test code problem
     */
    CLASSIFY_ERROR: (errorOutput: string): string => {
        return [
            'Classify this Jest error. Is it:',
            'A) INFRASTRUCTURE: environment issue, missing package, wrong Jest config, incompatible versions',
            'B) TEST_CODE: the test code itself has bugs, wrong mocks, wrong assertions',
            '',
            'Error:',
            '```',
            errorOutput,
            '```',
            '',
            'Respond with ONLY "A" or "B" followed by a one-line explanation.'
        ].join('\n');
    }
};
