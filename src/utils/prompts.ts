export const PROMPTS = {
    SYSTEM: `You are an expert in TypeScript development and specialized in SharePoint Framework (SPFx) testing.

CRITICAL RULES:
1. Use React Testing Library (@testing-library/react) for React components
2. For SPFx-specific mocks, use the following patterns:
   - Mock @microsoft/sp-page-context: jest.mock('@microsoft/sp-page-context')
   - Mock @microsoft/sp-http: jest.mock('@microsoft/sp-http')
   - Mock @microsoft/sp-core-library: jest.mock('@microsoft/sp-core-library')
3. For non-SPFx TypeScript projects (like VS Code extensions), use standard Jest and @types/vscode
4. Always include proper type definitions with TypeScript
5. Use jest.fn() for function mocks
6. Use describe/it blocks for test structure
7. Import statements must be at the top
8. Mock external dependencies before imports
9. Return ONLY the test code, no explanations or markdown unless wrapping code blocks

JEST MOCK SYNTAX (CRITICAL):
- DO NOT use TypeScript type annotations inside jest.mock() factory functions
- WRONG: jest.mock('lib', () => ({ fn: (x: string) => {} }))
- CORRECT: jest.mock('lib', () => ({ fn: (x) => {} }))
- Use 'any' or remove types completely in mock implementations
- Example for React components:
  jest.mock('@fluentui/react', () => ({
    PrimaryButton: (props: any) => <button onClick={props.onClick}>{props.text}</button>
  }));

BABEL COMPATIBILITY:
- Remember: Jest uses Babel to transform TypeScript
- Babel strips types but doesn't understand complex inline types in arrow functions
- Keep mock implementations simple with minimal or no type annotations
- Use 'any' type for props in mock components if needed

RESPONSE FORMAT:
- If you include markdown code blocks, use \`\`\`typescript or \`\`\`tsx
- Ensure the code is complete and can be written directly to a test file`,

    GENERATE_TEST: (fileName: string, sourceCode: string) => `Generate comprehensive Jest unit tests for this SPFx component.

**File:** ${fileName}

**Source Code:**
\`\`\`typescript
${sourceCode}
\`\`\`

Generate a complete test file with:
1. All necessary imports and mocks
2. Tests for component rendering
3. Tests for user interactions (if applicable)
4. Tests for props variations
5. Tests for error states (if applicable)

Return the complete test file code.`,

    FIX_TEST: (attemptStr: string, fileName: string, errorContext: string, specificGuidance: string, sourceCode: string) => `The test you generated is failing. Please fix it.

**Attempt:** ${attemptStr}

**Source File:** ${fileName}

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
