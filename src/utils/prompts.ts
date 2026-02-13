import { ProjectStack } from '../services/StackDiscoveryService';

/**
 * Build a dynamic SYSTEM prompt based on the detected project stack.
 * Falls back to a generic TypeScript testing expert if no stack provided.
 */
function buildSystemPrompt(stack?: ProjectStack): string {
    const frameworkLabel = stack ? getFrameworkLabel(stack) : 'TypeScript';

    // Base rules that apply to ALL project types
    const baseRules = `You are an expert in ${frameworkLabel} development and automated unit test generation.

CRITICAL RULES:
1. Use jest.fn() for function mocks
2. Use describe/it blocks for test structure
3. Import statements must be at the top
4. Mock external dependencies before imports
5. Do NOT mock the module under test — only mock its external dependencies
6. Return ONLY the test code, no explanations or markdown unless wrapping code blocks
7. Always include proper type definitions with TypeScript
8. Handle async operations with async/await and proper assertions`;

    // Jest mock syntax rules (universal)
    const jestMockRules = `

JEST MOCK SYNTAX (CRITICAL):
- DO NOT use TypeScript type annotations inside jest.mock() factory functions
- WRONG: jest.mock('lib', () => ({ fn: (x: string) => {} }))
- CORRECT: jest.mock('lib', () => ({ fn: (x) => {} }))
- Use 'any' or remove types completely in mock implementations`;

    // Framework-specific guidance
    const frameworkGuidance = stack ? getFrameworkGuidance(stack) : '';

    // Response format
    const responseFormat = `

RESPONSE FORMAT:
- If you include markdown code blocks, use \`\`\`typescript or \`\`\`tsx
- Ensure the code is complete and can be written directly to a test file`;

    return baseRules + jestMockRules + frameworkGuidance + responseFormat;
}

/**
 * Get a human-readable label for the detected framework
 */
function getFrameworkLabel(stack: ProjectStack): string {
    switch (stack.framework) {
        case 'spfx': return 'SharePoint Framework (SPFx)';
        case 'react': return 'React';
        case 'angular': return 'Angular';
        case 'vue': return 'Vue.js';
        case 'next': return 'Next.js';
        case 'express': return 'Express.js';
        case 'vscode-extension': return 'VS Code Extension';
        case 'node': return 'Node.js';
        default: return 'TypeScript';
    }
}

/**
 * Generate framework-specific testing guidance
 */
function getFrameworkGuidance(stack: ProjectStack): string {
    const parts: string[] = [];

    // UI testing library
    if (stack.uiLibrary === 'react') {
        parts.push(`
REACT TESTING:
- Use React Testing Library (@testing-library/react) for component testing
- Use render(), screen, fireEvent, waitFor from @testing-library/react
- Test user-visible behavior, not implementation details
- Use userEvent for user interactions when possible`);

        if (stack.componentLibrary !== 'none') {
            parts.push(`- Mock ${stack.componentLibrary} components if they introduce complexity`);
        }
    } else if (stack.uiLibrary === 'angular') {
        parts.push(`
ANGULAR TESTING:
- Use TestBed from @angular/core/testing
- Configure testing modules with TestBed.configureTestingModule()
- Use ComponentFixture for component tests
- Mock services using jasmine spies or jest.fn()`);
    } else if (stack.uiLibrary === 'vue') {
        parts.push(`
VUE TESTING:
- Use @vue/test-utils mount() or shallowMount()
- Test component output and events
- Mock Vuex store or Pinia if used`);
    }

    // Framework-specific mocking patterns
    if (stack.framework === 'spfx') {
        parts.push(`
SPFX MOCKING:
- Mock @microsoft/sp-core-library: jest.mock('@microsoft/sp-core-library')
- Mock @microsoft/sp-http: jest.mock('@microsoft/sp-http')  
- Mock @microsoft/sp-page-context: jest.mock('@microsoft/sp-page-context')
- Mock @microsoft/sp-webpart-base: jest.mock('@microsoft/sp-webpart-base')
- SPHttpClient.get/post should return mock responses
- PageContext should provide mock site/web/user data

BABEL COMPATIBILITY (SPFx uses Babel):
- Babel strips types but doesn't understand complex inline types in arrow functions
- Keep mock implementations simple with minimal or no type annotations
- Use 'any' type for props in mock components if needed`);
    } else if (stack.framework === 'vscode-extension') {
        parts.push(`
VS CODE EXTENSION MOCKING:
- Mock 'vscode' module: jest.mock('vscode', () => ({...}), { virtual: true })
- vscode.window, vscode.workspace, vscode.commands should be mocked
- Use jest.fn() for command registration handlers
- Mock vscode.Uri, vscode.Range, vscode.Position as needed
- Extension context should be a mock object with subscriptions array`);
    } else if (stack.framework === 'next') {
        parts.push(`
NEXT.JS MOCKING:
- Mock next/router or next/navigation depending on version
- Mock next/image if components use it
- For API routes, test the handler function directly
- For Server Components, test the data fetching logic separately`);
    } else if (stack.framework === 'express') {
        parts.push(`
EXPRESS MOCKING:
- Mock req, res, next objects for route handler tests
- Use supertest if integration tests are appropriate
- Mock database connections and external API calls`);
    }

    // Mock patterns summary
    if (stack.mockPatterns.length > 0) {
        parts.push(`
PACKAGES TO MOCK IN THIS PROJECT:
${stack.mockPatterns.map(p => `- jest.mock('${p}')`).join('\n')}`);
    }

    // Module system guidance
    if (stack.moduleSystem === 'esm') {
        parts.push(`
ESM COMPATIBILITY:
- This project uses ES modules
- Use jest.unstable_mockModule() if using native ESM with Jest
- Or ensure jest.config uses transform with ts-jest for CJS compatibility`);
    }

    return parts.join('\n');
}

export const PROMPTS = {
    /**
     * Static SYSTEM prompt (backward-compatible default, used when no stack detected)
     */
    SYSTEM: buildSystemPrompt(),

    /**
     * Build a dynamic SYSTEM prompt based on detected stack
     */
    buildSystemPrompt,

    GENERATE_TEST: (fileName: string, sourceCode: string, dependencyContext?: string) => `Generate comprehensive Jest unit tests for this file.

**File:** ${fileName}

**Source Code:**
\`\`\`typescript
${sourceCode}
\`\`\`
${dependencyContext ? `\n${dependencyContext}\n` : ''}
Generate a complete test file with:
1. All necessary imports and mocks
2. Tests for all public functions/methods/exports
3. Tests for edge cases and error handling
4. Tests for async operations (if applicable)
5. Do NOT mock the module under test — only mock its external dependencies

Return the complete test file code.`,

    FIX_TEST: (attemptStr: string, fileName: string, currentTestCode: string, errorContext: string, specificGuidance: string, sourceCode: string) => `The test you generated is failing. Please fix it.

**Attempt:** ${attemptStr}

**Source File:** ${fileName}

**Current Test Code (FAILING):**
\`\`\`typescript
${currentTestCode}
\`\`\`

**Test Error Output:**
\`\`\`
${errorContext}
\`\`\`
${specificGuidance}
**Original Source Code:**
\`\`\`typescript
${sourceCode}
\`\`\`

Analyze the error and generate a CORRECTED version of the test file that will pass.
Focus on:
1. **CRITICAL**: Remove TypeScript type annotations from jest.mock() factory functions
2. Use 'any' type or no type for parameters in mock implementations
3. Fixing import errors
4. Correcting mock implementations  
5. Fixing assertion logic
6. Handling async operations properly

Return the complete FIXED test file code.`,

    FIX_SPECIFIC_GUIDANCE_MOCK_TYPES: `
**DETECTED ISSUE: Babel syntax error (likely TypeScript types in jest.mock())**

The error output (like "Missing semicolon" or "Unexpected token") suggests that Babel is failing to parse the test file. 
This is almost always because of TypeScript type annotations inside a \`jest.mock()\` factory function or using complex TS features where Babel expects simple JS.

**FIX REQUIRED:**
1. Remove ALL type annotations from inside \`jest.mock()\` factory functions.
   - WRONG: \`jest.mock('lib', () => ({ fn: (x: string) => {} }))\`
   - CORRECT: \`jest.mock('lib', () => ({ fn: (x) => {} }))\`
2. Use \`any\` or avoid types entirely for mock parameters.
3. If mocking \`vscode\`, use simple objects and sometimes \`{ virtual: true }\` if the module is not in node_modules.
`,
};
