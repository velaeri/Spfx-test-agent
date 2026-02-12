export const PROMPTS = {
    SYSTEM: `You are an expert in TypeScript testing with Jest and ts-jest.

CRITICAL RULES FOR BABEL/TS-JEST COMPATIBILITY:
1. NEVER use type annotations inside jest.mock() factory functions
2. NEVER use type annotations in variable declarations inside jest.mock()
3. Use 'any' type or NO types for all variables and parameters in mocks
4. Keep mock implementations extremely simple

WRONG EXAMPLES (WILL CAUSE "Missing semicolon" ERROR):
❌ jest.mock('vscode', () => ({ window: { showInformationMessage: (msg: string) => Promise.resolve() } }))
❌ let mockContext: vscode.ExtensionContext;
❌ const mockLogger: jest.Mocked<Logger> = { info: jest.fn() };

CORRECT EXAMPLES:
✅ jest.mock('vscode', () => ({ window: { showInformationMessage: (msg) => Promise.resolve() } }))
✅ let mockContext: any;
✅ const mockLogger: any = { info: jest.fn() };

VARIABLE DECLARATIONS:
- Use 'any' type for ALL test variables
- WRONG: let service: MyService;
- CORRECT: let service: any;

JEST MOCKING PATTERNS:
- Use jest.fn() for function mocks
- Keep factory functions simple and type-free
- For React components, use props: any
- Example: jest.mock('@fluentui/react', () => ({ Button: (props) => null }))

Common Fixes for "import statement outside a module":
- Ensure all imports are at the top
- If mocking a module that causes this, try using jest.mock() with a factory that returns a simple object
- Ensure you are not importing ESM-only packages in a non-ESM environment

RESPONSE FORMAT:
- Return ONLY executable test code
- Use \`\`\`typescript code blocks if wrapping
- No explanations, just working code`,

    GENERATE_TEST: (fileName: string, sourceCode: string) => `Generate comprehensive Jest unit tests for this file.

**File:** ${fileName}

**Source Code:**
\`\`\`typescript
${sourceCode}
\`\`\`

IMPORTANT REQUIREMENTS:
1. Use 'any' type for ALL variable declarations (let service: any;)
2. NO type annotations in jest.mock() factory functions
3. Use jest.fn() for all function mocks
4. Keep mocks simple and type-free
5. Mock external dependencies with jest.mock() BEFORE imports

Generate a complete test file that will work with ts-jest WITHOUT Babel syntax errors.

Return ONLY the complete test file code - no explanations.`,

    FIX_TEST: (attemptStr: string, fileName: string, errorContext: string, specificGuidance: string, sourceCode: string) => `The test is failing. Fix it now.

**Attempt:** ${attemptStr}

**Source File:** ${fileName}

**Error:**
\`\`\`
${errorContext}
\`\`\`
${specificGuidance}
**Source Code:**
\`\`\`typescript
${sourceCode}
\`\`\`

CRITICAL FIX STEPS:
1. Replace ALL typed variable declarations with 'any' type
   - Change: let service: MyService; 
   - To: let service: any;
2. Remove ALL type annotations from jest.mock() functions
3. Use jest.fn() for all mocks
4. Keep everything simple and type-free

Return the COMPLETE FIXED test file code - no explanations.`,

    FIX_SPECIFIC_GUIDANCE_MOCK_TYPES: `
**CRITICAL ERROR DETECTED: Babel syntax error from TypeScript types**

THE PROBLEM:
- "Missing semicolon" or "Unexpected token" errors mean TypeScript types where they shouldn't be
- Common cause: Type annotations in variable declarations or jest.mock() functions

THE FIX:
1. Change ALL variable declarations to use 'any' type:
   - ❌ WRONG: let mockContext: vscode.ExtensionContext;
   - ✅ CORRECT: let mockContext: any;
   
2. Remove ALL types from jest.mock():
   - ❌ WRONG: jest.mock('lib', () => ({ fn: (x: string) => {} }))
   - ✅ CORRECT: jest.mock('lib', () => ({ fn: (x) => {} }))

3. Use only 'any' or no types in test variables

DO THIS NOW - replace every typed declaration with 'any' type.
`,
};
