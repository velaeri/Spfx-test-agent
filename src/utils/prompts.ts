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

    GENERATE_TEST: (fileName: string, sourceCode: string, dependencyContext?: string) => `# TASK: Generate Comprehensive Jest Unit Tests

## CONTEXT
You are analyzing a source file to generate professional, production-ready unit tests.

**Target File:** \`${fileName}\`

**Source Code to Test:**
\`\`\`typescript
${sourceCode}
\`\`\`
${dependencyContext ? `\n## DEPENDENCY ANALYSIS\n\n${dependencyContext}\n` : ''}

---

## YOUR ANALYSIS PROCESS

### Step 1: CODE UNDERSTANDING
- Identify all public exports (functions, classes, components, constants)
- Map dependencies and their usage patterns
- Identify async operations, error handling, side effects
- Note any framework-specific patterns (React hooks, SPFx context, etc.)

### Step 2: TEST STRATEGY PLANNING
- Determine which exports require test coverage
- Identify edge cases for each function/method
- Plan mock strategy for external dependencies
- Consider integration points that need verification

### Step 3: MOCK ARCHITECTURE
- **CRITICAL**: Mock ONLY external dependencies, NOT the module under test
- Use \`jest.mock('module-path')\` BEFORE imports
- Mock implementations should match the real API surface
- Avoid TypeScript type annotations inside \`jest.mock()\` factory functions

### Step 4: TEST STRUCTURE
- Group related tests in \`describe\` blocks
- Use descriptive test names: "should [expected behavior] when [condition]"
- Test happy path, edge cases, and error scenarios
- For async functions: use \`async/await\` and verify resolution/rejection

---

## OUTPUT REQUIREMENTS

Generate a **complete, runnable test file** with:

1. **Imports**: All necessary testing libraries and the module under test
2. **Mocks**: External dependencies mocked BEFORE imports
3. **Test Suites**: Organized \`describe\` blocks for each export
4. **Test Cases**: Individual \`it\`/\`test\` blocks for each scenario
5. **Assertions**: Proper expectations with meaningful error messages
6. **Cleanup**: \`beforeEach\`/\`afterEach\` hooks if needed

---

## CODE QUALITY STANDARDS

✅ **DO:**
- Use \`jest.fn()\` for function mocks
- Use \`React Testing Library\` for React components
- Test user-visible behavior, not implementation details
- Handle async with \`async/await\` and proper assertions
- Include type definitions for TypeScript
- Clear, descriptive test names

❌ **DON'T:**
- Mock the module under test itself
- Use TypeScript types inside \`jest.mock()\` factories
- Test private methods or internal state
- Write brittle tests dependent on implementation details
- Forget to handle promises/async operations properly

---

## EXAMPLE STRUCTURE

\`\`\`typescript
// Mock external dependencies FIRST
jest.mock('external-library', () => ({
  someFunction: jest.fn()
}));

import { render, screen } from '@testing-library/react';
import { TheComponentUnderTest } from './TheComponent';

describe('TheComponentUnderTest', () => {
  it('should render successfully', () => {
    render(<TheComponentUnderTest />);
    expect(screen.getByText('Expected Text')).toBeInTheDocument();
  });

  it('should handle click events', () => {
    const mockHandler = jest.fn();
    render(<TheComponentUnderTest onClick={mockHandler} />);
    // ... test interaction
  });
});
\`\`\`

---

**Generate the complete test file now:**`,

    FIX_TEST: (attemptStr: string, fileName: string, currentTestCode: string, errorContext: string, specificGuidance: string, sourceCode: string) => `# TASK: Debug and Fix Failing Test

## SITUATION
Your previously generated test is **failing**. You must analyze the error, identify the root cause, and provide a corrected version.

**Fix Attempt:** ${attemptStr}
**Target File:** \`${fileName}\`

---

## FAILING TEST CODE

\`\`\`typescript
${currentTestCode}
\`\`\`

---

## ERROR OUTPUT FROM JEST

\`\`\`
${errorContext}
\`\`\`

---
${specificGuidance ? `## SPECIFIC GUIDANCE\n\n${specificGuidance}\n\n---\n\n` : ''}
## ORIGINAL SOURCE CODE (FOR REFERENCE)

\`\`\`typescript
${sourceCode}
\`\`\`

---

## YOUR DEBUGGING PROCESS

### Step 1: ERROR CLASSIFICATION
Identify the error type:
- **Syntax Error**: Missing semicolon, unexpected token, parse failure
  - Often caused by TypeScript types in \`jest.mock()\` factories
  - Babel can't parse complex TS in mock implementations
- **Import Error**: Cannot find module, module resolution failure
  - Check if module paths are correct  
  - Verify mocks are declared BEFORE imports
- **Runtime Error**: ReferenceError, TypeError, null/undefined access
  - Mock implementations incomplete or incorrect
  - Missing return values from mocked functions
- **Assertion Error**: Expected X but received Y
  - Test logic doesn't match actual behavior
  - Async operations not properly awaited
  - Wrong selectors or queries

### Step 2: ROOT CAUSE ANALYSIS
Based on the error type, determine:
- **What specifically failed?** (line number, expression, assertion)
- **Why did it fail?** (missing mock, wrong type, async timing, etc.)
- **What assumption was wrong?** (API behavior, return types, side effects)

### Step 3: SOLUTION DESIGN
Plan the fix:
- **For Syntax Errors**: Remove types from mock factories, simplify mock implementations
- **For Import Errors**: Fix paths, reorder mocks, add missing modules
- **For Runtime Errors**: Complete mock implementations, add required properties/methods
- **For Assertion Errors**: Correct test logic, fix selectors, handle async properly

### Step 4: VALIDATION STRATEGY
After fixing, ensure:
- All mocks have complete implementations
- Async operations are properly handled with \`async/await\`
- Assertions match the actual behavior
- No TypeScript types in \`jest.mock()\` factories
- All imports are correct and mocks are declared first

---

## CRITICAL FIX RULES

### TypeScript & Babel Compatibility
❌ **NEVER do this:**
\`\`\`typescript
jest.mock('@fluentui/react', () => ({
  PrimaryButton: (props: any) => <button>{props.text}</button>
}));
\`\`\`

✅ **ALWAYS do this:**
\`\`\`typescript
jest.mock('@fluentui/react', () => ({
  PrimaryButton: (props) => <button>{props.text}</button>
}));
\`\`\`

### Mock Completeness
Ensure mocked functions/objects have ALL properties used in the code:
\`\`\`typescript
// If source uses: httpClient.get().then(r => r.json())
jest.mock('@microsoft/sp-http', () => ({
  SPHttpClient: {
    get: jest.fn(() => Promise.resolve({
      json: jest.fn(() => Promise.resolve({ data: 'mock' }))
    }))
  }
}));
\`\`\`

### Async Handling
Always await async operations in tests:
\`\`\`typescript
// ❌ WRONG
it('fetches data', () => {
  const result = fetchData();
  expect(result).toBe('data'); // Fails: result is a Promise
});

// ✅ CORRECT
it('fetches data', async () => {
  const result = await fetchData();
  expect(result).toBe('data');
});
\`\`\`

### React Testing Library
Use \`waitFor\` for elements that appear asynchronously:
\`\`\`typescript
await waitFor(() => {
  expect(screen.getByText('Loaded')).toBeInTheDocument();
});
\`\`\`

---

## OUTPUT REQUIREMENT

Provide the **complete CORRECTED test file** that addresses the identified error.

**Changes you must make:**
1. Fix the specific error shown in the output above
2. Ensure all mocks are complete and correct  
3. Verify async operations are properly handled
4. Remove any TypeScript types from mock factories
5. Validate assertion logic matches actual behavior

**Return the full, fixed test code now:**`,

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

    ANALYZE_ERROR: (error: string, errorType: string, deps: Record<string, string>, nodeVersion?: string, jestConfig?: string) => `# TASK: Diagnose and Fix Installation/Compilation Error

## SITUATION
Package installation or test execution has failed. You must analyze the error output, identify the root cause, and provide concrete solutions.

**Error Type:** ${errorType}
**Project Dependencies (installed):**
\`\`\`json
${JSON.stringify(deps, null, 2)}
\`\`\`
${nodeVersion ? `\n**Node Version:** ${nodeVersion}\n` : ''}${jestConfig ? `\n**Jest Configuration:**\n\`\`\`javascript\n${jestConfig}\n\`\`\`\n` : ''}
---

## ERROR OUTPUT

\`\`\`
${error}
\`\`\`

---

## YOUR DIAGNOSTIC PROCESS

### Step 1: ERROR CLASSIFICATION
Identify the specific error category:
- **Dependency Resolution Error**: ERESOLVE, peer dependency conflict, version mismatch
  - Conflicting package versions (e.g., react 17 vs 18)
  - Missing peer dependencies
  - Incompatible version ranges
- **Installation Error**: E404, ETARGET, network failure, registry not found
  - Package version doesn't exist in npm registry
  - Network/proxy issues
  - Authentication problems
- **Compilation Error**: TypeScript errors, module resolution failures
  - Missing type definitions (@types/*)
  - Import path errors
  - tsconfig.json misconfiguration
- **Execution Error**: Runtime failures during test execution
  - Missing runtime dependencies
  - Configuration issues (jest.config.js)
  - Environment setup problems (jsdom, node)

### Step 2: ROOT CAUSE IDENTIFICATION
Analyze the error details:
- **What package is causing the issue?** (extract from error message)
- **What version conflicts exist?** (compare requested vs available)
- **Are there peer dependency warnings?** (check npm peer dep requirements)
- **Is this a compatibility matrix issue?** (e.g., jest 29 + ts-jest 29 + @types/jest 29)

### Step 3: COMPATIBILITY RESEARCH
Determine compatible versions:
- **For React projects**: Ensure testing-library versions match React version
  - React 17: @testing-library/react@^12.x
  - React 18: @testing-library/react@^13.x or ^14.x
- **For Jest ecosystem**: Match major versions
  - jest@29 → ts-jest@29 → @types/jest@29
  - jest@28 → ts-jest@28 → @types/jest@28
- **For SPFx projects**: Respect the locked React version
  - Most SPFx uses React 17.x
  - Don't upgrade core SPFx dependencies

### Step 4: SOLUTION DESIGN
Provide actionable fix:
- **Specific package versions** that resolve conflicts (e.g., \`jest@29.7.0\`)
- **Installation commands** if special flags needed (\`--legacy-peer-deps\`, \`--force\`)
- **Configuration changes** if jest.config.js needs updates
- **Alternative approaches** if standard installation won't work

---

## CRITICAL RULES

### Version Compatibility
✅ **DO:**
- Use exact or caret versions (^29.7.0) that you know exist in npm
- Respect existing major versions (don't upgrade React 17→18 without permission)
- Match major versions across related packages (jest/ts-jest/@types/jest)
- Use \`--legacy-peer-deps\` for peer dependency conflicts

❌ **DON'T:**
- Suggest versions that don't exist in npm registry
- Downgrade core framework dependencies (React, Angular, etc.)
- Mix incompatible major versions
- Ignore peer dependency warnings without addressing them

### Package Selection
- **Prefer established, stable versions** over bleeding-edge
- **Check npm registry** mentally - suggest versions you've seen before
- **Latest is safe** but pinned versions are more predictable
- **For @types/**, match the library major version

---

## OUTPUT FORMAT

Return **ONLY valid JSON** with this exact structure:

\`\`\`json
{
  "diagnosis": "Brief 1-2 sentence explanation of the root cause",
  "packages": ["package1@^29.7.0", "package2@^13.4.0"],
  "commands": ["npm install --legacy-peer-deps"],
  "configChanges": {
    "jest.config.js": {
      "testEnvironment": "jsdom"
    }
  }
}
\`\`\`

**Field specifications:**
- **diagnosis** (required): Human-readable explanation of what went wrong
- **packages** (required): Array of package@version strings to install/reinstall. Use empty array [] if no packages needed.
- **commands** (optional): Array of shell commands if needed beyond npm install. Omit if not required.
- **configChanges** (optional): Object with file paths as keys, changes as values. Omit if no config changes needed.

**Example responses:**

\`\`\`json
{
  "diagnosis": "Jest 29 requires ts-jest@^29.x but ts-jest@^28.x is installed, causing compilation failures",
  "packages": ["ts-jest@^29.1.1", "@types/jest@^29.5.5"],
  "commands": ["npm install --legacy-peer-deps"]
}
\`\`\`

\`\`\`json
{
  "diagnosis": "Package @testing-library/jest-dom@6.x requires different peer dependencies than installed",
  "packages": ["@testing-library/jest-dom@^5.17.0"],
  "commands": []
}
\`\`\`

**Return your JSON analysis now:**`,

    PLAN_TEST_STRATEGY: (sourceCode: string, fileName: string, projectAnalysis: any, existingTestPatterns?: string[]) => `# TASK: Plan Optimal Testing Strategy

## CONTEXT
You are analyzing a source file to design an intelligent testing approach **before** generating actual test code.

**Target File:** \`${fileName}\`
**Source Code Preview:**
\`\`\`typescript
${sourceCode.substring(0, 3000)}${sourceCode.length > 3000 ? '\n... (truncated)' : ''}
\`\`\`

**Project Context:**
- Framework: ${projectAnalysis.framework || 'Unknown'}
- UI Library: ${projectAnalysis.uiLibrary || 'Unknown'}
- React Version: ${projectAnalysis.reactVersion || 'Unknown'}
- TypeScript: ${projectAnalysis.hasTypeScript ? 'Yes' : 'No'}
- Existing Tests: ${projectAnalysis.existingTests?.length || 0} test files
${existingTestPatterns && existingTestPatterns.length > 0 ? `\n**Successful patterns from previous tests:**\n${existingTestPatterns.slice(0, 3).join('\n\n')}` : ''}

---

## YOUR PLANNING PROCESS

### Step 1: CODE ANALYSIS
Examine the source code structure:
- **What does this file do?** (component, service, utility, model, etc.)
- **What are the key exports?** (classes, functions, components)
- **What external dependencies exist?** (imports from npm packages, framework APIs)
- **What complexity level?** (simple utility vs complex business logic)

### Step 2: TEST APPROACH SELECTION
Determine the testing strategy:
- **Unit Testing** → Pure functions, utilities, simple classes (isolated, fast)
- **Integration Testing** → Services that interact with APIs, databases, multiple modules
- **Component Testing** → React/Angular/Vue components (render, user interaction, props)

### Step 3: MOCKING STRATEGY
Decide what needs mocking:
- **Minimal** → File has no/few external dependencies (pure functions, simple logic)
- **Moderate** → Some external dependencies but mostly self-contained (1-3 mocks)
- **Extensive** → Heavy dependencies on framework APIs, UI libraries, external services (5+ mocks)

Identify specific items to mock:
- **For SPFx**: \`@microsoft/sp-*\` modules, \`SPHttpClient\`, \`WebPartContext\`
- **For React**: \`@fluentui/*\`, \`@testing-library/react\` setup
- **For VS Code**: \`vscode\` module with virtual flag
- **For Node**: \`fs\`, \`path\`, network modules

### Step 4: RISK ASSESSMENT
Identify potential issues:
- **Async operations** → Promises, async/await that might cause timing issues
- **Framework-specific context** → SharePoint context, VS Code extension activation
- **Complex DOM interactions** → User events, form submissions, state updates
- **TypeScript compatibility** → Babel parsing issues with inline types
- **Dependency version conflicts** → React 17 vs 18, Jest 28 vs 29

---

## OUTPUT REQUIREMENTS

Return **ONLY valid JSON** with this exact structure:

\`\`\`json
{
  "approach": "unit | integration | component",
  "mockingStrategy": "minimal | moderate | extensive",
  "mocksNeeded": ["SPHttpClient", "WebPartContext", "@fluentui/react"],
  "testStructure": "Single describe block with 5 test cases covering success/error paths",
  "expectedCoverage": 85,
  "potentialIssues": [
    "SharePoint context requires complete mock",
    "Async HTTP calls need proper Promise handling"
  ],
  "estimatedIterations": 2
}
\`\`\`

**Field specifications:**
- **approach** (required): One of: "unit", "integration", "component"
- **mockingStrategy** (required): One of: "minimal", "moderate", "extensive"
- **mocksNeeded** (required): Array of string identifiers for what to mock. Empty array [] if none needed.
- **testStructure** (required): Human-readable description of the test file structure (e.g., "2 describe blocks, 8 total tests")
- **expectedCoverage** (required): Number 0-100 representing realistic coverage percentage
- **potentialIssues** (required): Array of anticipated problems. Empty array [] if none expected.
- **estimatedIterations** (required): Number 1-5 representing how many fix attempts might be needed

---

## QUALITY STANDARDS

✅ **DO:**
- Be realistic about coverage (pure functions → 90%+, complex UI → 70-80%)
- Anticipate common SPFx/framework issues
- Suggest mocking only external dependencies, not the code under test
- Plan for both success and error paths

❌ **DON'T:**
- Mock the file being tested (only mock its dependencies)
- Suggest 100% coverage for complex UI components
- Overlook async/Promise handling needs
- Ignore framework-specific requirements (SPFx context, vscode activation)

**Return your strategy JSON now:**`,

    GENERATE_JEST_CONFIG: (projectAnalysis: any, requirements: string[]) => `# TASK: Generate Personalized Jest Configuration

## CONTEXT
You are creating custom Jest configuration files tailored to this specific project's needs.

**Project Analysis:**
\`\`\`json
${JSON.stringify(projectAnalysis, null, 2)}
\`\`\`

**Specific Requirements:**
${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}

---

## YOUR CONFIGURATION PROCESS

### Step 1: DETERMINE TEST ENVIRONMENT
Choose the appropriate Jest environment:
- **jsdom** → For React/DOM testing (components, browser APIs)
- **node** → For Node.js services, utilities, APIs (no DOM)

### Step 2: CONFIGURE TYPESCRIPT SUPPORT
Set up ts-jest properly:
- Use \`preset: 'ts-jest'\` for TypeScript projects
- Configure \`transform\` to handle .ts/.tsx files
- Set \`moduleFileExtensions\` to include ts, tsx
- Add \`globals\` for ts-jest if needed

### Step 3: MODULE RESOLUTION
Configure how Jest resolves modules:
- **moduleNameMapper** → Mock CSS/images/static assets (\`\\.(css|scss)$\` → mock)
- **modulePathIgnorePatterns** → Exclude node_modules, dist, build
- **roots** → Specify where tests live (usually ["<rootDir>/src"])

### Step 4: COVERAGE CONFIGURATION
Set reasonable coverage thresholds:
- **For application code**: 70-80% coverage
- **For libraries**: 80-90% coverage
- **Exclude**: node_modules, __mocks__, .test. files, .d.ts files

### Step 5: SETUP FILE
Create jest.setup.js for:
- **Testing library extensions** → @testing-library/jest-dom
- **Global mocks** → console, fetch, localStorage
- **Framework-specific setup** → SPFx polyfills, VS Code mocks

---

## OUTPUT REQUIREMENTS

Return **ONLY valid JSON** with this exact structure:

\`\`\`json
{
  "configJs": "module.exports = { ... }; // full jest.config.js content",
  "setupJs": "// jest.setup.js full content",
  "mocks": {
    "__mocks__/styleMock.js": "module.exports = {};",
    "__mocks__/fileMock.js": "module.exports = 'test-file-stub';"
  },
  "explanation": "Brief explanation of key configuration choices"
}
\`\`\`

**Field specifications:**
- **configJs** (required): Complete jest.config.js file content as a string
- **setupJs** (required): Complete jest.setup.js file content as a string
- **mocks** (required): Object mapping mock file paths (relative to project root) to their content. Empty object {} if no mocks needed.
- **explanation** (required): 2-3 sentence explanation of the most important configuration decisions

---

## CONFIGURATION STANDARDS

### jest.config.js MUST include:
\`\`\`javascript
{
  preset: 'ts-jest',
  testEnvironment: 'jsdom', // or 'node'
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.test.{ts,tsx}'
  ],
  coverageThresholds: {
    global: { branches: 70, functions: 70, lines: 70, statements: 70 }
  },
  moduleNameMapper: {
    '\\.(css|scss|sass)$': '<rootDir>/__mocks__/styleMock.js'
  }
}
\`\`\`

### jest.setup.js SHOULD include:
\`\`\`javascript
// Testing library matchers (if using React Testing Library)
import '@testing-library/jest-dom';

// Global test utilities
global.console = {
  ...console,
  error: jest.fn(), // Suppress expected errors
  warn: jest.fn()
};
\`\`\`

✅ **DO:**
- Use TypeScript-friendly configuration
- Set reasonable coverage thresholds (70-80%)
- Mock static assets (CSS, images)
- Include common test file patterns

❌ **DON'T:**
- Set 100% coverage requirements
- Forget to configure ts-jest for TypeScript
- Leave testEnvironment unspecified (defaults to node)
- Include node_modules in coverage

**Return your configuration JSON now:**`,

    PLAN_BATCH_GENERATION: (allFiles: string[], projectStructure: any, existingTests: string[], dependencies: Record<string, string[]>) => `# TASK: Plan Intelligent Batch Test Generation

## CONTEXT
You are creating an optimal strategy to generate tests for multiple files, prioritizing by business value and technical dependencies.

**Files Requiring Tests:** ${allFiles.length} files
**Sample Files:**
${allFiles.slice(0, 15).map(f => `  • ${f}`).join('\n')}
${allFiles.length > 15 ? `  ... and ${allFiles.length - 15} more files` : ''}

**Existing Tests:** ${existingTests.length} test files
**Project Structure:**
\`\`\`json
${JSON.stringify(projectStructure, null, 2).substring(0, 600)}${JSON.stringify(projectStructure, null, 2).length > 600 ? '... (truncated)' : ''}
\`\`\`

---

## YOUR PLANNING PROCESS

### Step 1: FILE CATEGORIZATION
Classify each file by type and importance:
- **Core Business Logic** (Priority 1) → Services, APIs, business rules, data transformations
- **Components** (Priority 2) → UI components, web parts, views that users interact with
- **Models & Interfaces** (Priority 3) → Data models, type definitions, domain entities
- **Utilities** (Priority 4) → Helper functions, formatters, validators
- **Constants & Config** (Priority 5) → Configuration files, constants, enums

### Step 2: DEPENDENCY ANALYSIS
Identify testing order based on dependencies:
- **Test dependencies first** → If FileA imports FileB, test FileB before FileA
- **Group related files** → Service + its models + its helpers should be tested together
- **Maximize reusability** → Successfully tested patterns can inform later tests

### Step 3: RISK ASSESSMENT
Consider complexity and likelihood of issues:
- **High Risk** → Complex business logic, external API calls, state management
- **Medium Risk** → Standard CRUD operations, UI components with moderate logic
- **Low Risk** → Pure functions, simple utilities, straightforward transformations

### Step 4: RESOURCE OPTIMIZATION
Balance speed vs quality:
- **Concurrency** → How many files can be tested simultaneously? (1-5)
- **Time estimation** → ~30-60 seconds per file (including generation + execution + potential fixes)
- **Grouping** → Logically related files in same batch for context sharing

---

## OUTPUT REQUIREMENTS

Return **ONLY valid JSON** with this exact structure:

\`\`\`json
{
  "groups": [
    {
      "name": "Core Services",
      "priority": 1,
      "files": ["src/services/DataService.ts", "src/services/ApiClient.ts"],
      "reason": "Core business logic with dependencies - test first to establish patterns"
    },
    {
      "name": "Utilities",
      "priority": 4,
      "files": ["src/utils/formatter.ts", "src/utils/validator.ts"],
      "reason": "Simple helper functions with no dependencies - low complexity"
    }
  ],
  "estimatedTime": "15 minutes",
  "recommendedConcurrency": 2
}
\`\`\`

**Field specifications:**
- **groups** (required): Array of file groups. Each group has:
  - **name** (string): Human-readable group name
  - **priority** (number 1-5): 1=highest (test first), 5=lowest (test last)
  - **files** (array): File paths from the input allFiles array
  - **reason** (string): Brief explanation why these files are grouped and prioritized this way
- **estimatedTime** (required): Human-readable time estimate (e.g., "15 minutes", "1 hour")
- **recommendedConcurrency** (required): Number 1-5 representing how many files to process in parallel

---

## PRIORITIZATION GUIDELINES

### Priority 1 (CRITICAL - Test First)
- Core business logic and domain services
- API clients and data access layers
- State management stores
- Authentication/authorization logic

### Priority 2 (HIGH - Test Early)
- Main UI components users interact with
- Web parts and page-level components
- Form handlers and validation logic

### Priority 3 (MEDIUM - Standard Order)
- Data models and entity classes
- Type definitions with validation logic
- Adapters and mappers

### Priority 4 (LOW - Test Later)
- Pure utility functions
- Formatters and parsers
- Simple helper functions

### Priority 5 (MINIMAL - Test Last)
- Constants files
- Type-only interfaces
- Configuration objects
- Enums

---

## QUALITY STANDARDS

✅ **DO:**
- Group files by feature/module when possible (e.g., "User Management" group)
- Test dependencies before dependents
- Provide realistic time estimates (45-60 sec per file)
- Use concurrency 2-3 for most projects, 1 for complex projects
- Explain reasoning for each group clearly

❌ **DON'T:**
- Create too many small groups (prefer 3-6 meaningful groups)
- Test dependent files before their dependencies
- Suggest concurrency > 3 for complex projects
- Put unrelated files in the same group without reason
- Overestimate or underestimate time dramatically

**Return your batch plan JSON now:**`,
};
