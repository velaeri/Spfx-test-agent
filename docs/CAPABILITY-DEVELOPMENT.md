# Adding New Capabilities to SPFX Test Agent

## Quick Start Guide (v0.6.0+)

This guide shows you how to add new capabilities to the SPFX Test Agent using the plugin-based architecture introduced in v0.6.0.

---

## Architecture Overview

The extension now uses a **capability-based plugin architecture**:

```
┌─────────────────────────────────────────┐
│        CodeAssistantAgent               │
│  (Generic orchestrator)                 │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  Capability Registry (Map)        │ │
│  │  - TestGenerationCapability       │ │
│  │  - CodeRefactoringCapability      │ │
│  │  - ArchitectureAnalysisCapability │ │
│  │  - ... (your capability)          │ │
│  └───────────────────────────────────┘ │
│                                         │
│  Uses: ICoreProvider (generic LLM)     │
└─────────────────────────────────────────┘
          │
          ├─→ CopilotProvider (implements ICoreProvider)
          ├─→ AzureOpenAIProvider (implements ICoreProvider)
          └─→ YourCustomProvider (implements ICoreProvider)
```

**Key Concepts:**

1. **`ICoreProvider`** - Generic LLM interface (sendPrompt, isAvailable)
2. **`ILLMCapability<TInput, TOutput>`** - Plugin interface for capabilities
3. **`CodeAssistantAgent`** - Orchestrates capabilities, manages LLM provider
4. **Capabilities** - Self-contained features (testing, refactoring, analysis, etc.)

---

## Creating a New Capability

### 1. Define Input/Output Types

```typescript
// src/capabilities/CodeRefactoringCapability.ts

/**
 * Input for code refactoring capability
 */
export interface CodeRefactoringInput {
    sourceCode: string;
    filePath: string;
    refactoringType: 'extract-function' | 'rename' | 'simplify' | 'optimize';
    selectionRange?: { start: number; end: number };
    targetName?: string; // For rename operations
}

/**
 * Output from code refactoring capability
 */
export interface CodeRefactoringOutput {
    refactoredCode: string;
    changes: Array<{
        description: string;
        line: number;
        originalCode: string;
        newCode: string;
    }>;
    explanation: string;
}
```

### 2. Implement ILLMCapability

```typescript
import { ILLMCapability, CapabilityContext, ValidationResult, CapabilityError } from '../interfaces/ILLMCapability';
import { ICoreProvider } from '../interfaces/ICoreProvider';
import * as vscode from 'vscode';

export class CodeRefactoringCapability implements ILLMCapability<CodeRefactoringInput, CodeRefactoringOutput> {
    // Required properties
    readonly name = 'code-refactoring';
    readonly description = 'Refactor code using AI suggestions';
    readonly category = 'code-quality';

    /**
     * Execute the capability
     */
    async execute(
        provider: ICoreProvider,
        input: CodeRefactoringInput,
        stream: vscode.ChatResponseStream,
        token?: vscode.CancellationToken
    ): Promise<CodeRefactoringOutput> {
        stream.markdown(`## 🔄 Refactoring Code\n\n`);
        stream.progress(`Analyzing code for ${input.refactoringType}...`);

        // Build prompts
        const systemPrompt = this.buildSystemPrompt(input.refactoringType);
        const userPrompt = this.buildUserPrompt(input);

        // Call LLM
        const result = await provider.sendPrompt(systemPrompt, userPrompt);

        // Parse response
        const output = this.parseRefactoringResult(result.content, input);

        stream.markdown(`✅ **Refactoring complete**\n\n`);
        stream.markdown(output.explanation);

        return output;
    }

    /**
     * Determine if this capability can handle the given context
     */
    canHandle(context: CapabilityContext): boolean {
        // Check for explicit command
        if (context.command === '/refactor') {
            return true;
        }

        // Check for keywords in message
        if (context.message) {
            const refactorKeywords = [
                'refactor',
                'extract function',
                'simplify code',
                'optimize',
                'clean up code'
            ];
            const lowerMessage = context.message.toLowerCase();
            if (refactorKeywords.some(kw => lowerMessage.includes(kw))) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get help text for this capability
     */
    getHelpText(): string {
        return `
**Code Refactoring Capability**

Automatically refactor code using AI analysis.

**Commands:**
- \`/refactor extract-function\` - Extract selected code into a function
- \`/refactor simplify\` - Simplify complex code
- \`/refactor rename <old> <new>\` - Intelligent rename with dependencies
- \`/refactor optimize\` - Optimize for performance

**Examples:**
\`\`\`
/refactor extract-function
Simplify this function
Refactor to use async/await
\`\`\`
        `.trim();
    }

    /**
     * Validate input before execution (optional)
     */
    async validateInput(input: CodeRefactoringInput): Promise<ValidationResult> {
        const errors: string[] = [];

        if (!input.sourceCode || input.sourceCode.trim().length === 0) {
            errors.push('sourceCode is required and cannot be empty');
        }

        if (!input.filePath) {
            errors.push('filePath is required');
        }

        const validTypes = ['extract-function', 'rename', 'simplify', 'optimize'];
        if (!validTypes.includes(input.refactoringType)) {
            errors.push(`Invalid refactoringType. Must be one of: ${validTypes.join(', ')}`);
        }

        if (input.refactoringType === 'rename' && !input.targetName) {
            errors.push('targetName is required for rename operations');
        }

        return {
            valid: errors.length === 0,
            error: errors.length > 0 ? errors.join('; ') : undefined
        };
    }

    // --- Private helpers ---

    private buildSystemPrompt(type: string): string {
        return `You are an expert code refactoring assistant.
Your task is to refactor code to improve quality, readability, and maintainability.
Focus on: ${type}`;
    }

    private buildUserPrompt(input: CodeRefactoringInput): string {
        const selection = input.selectionRange 
            ? `\nSelected lines: ${input.selectionRange.start}-${input.selectionRange.end}`
            : '';

        return `Refactor this code (${input.refactoringType}):

**File:** ${input.filePath}${selection}

\`\`\`typescript
${input.sourceCode}
\`\`\`

${input.targetName ? `New name: ${input.targetName}\n` : ''}

Provide:
1. Refactored code
2. List of changes with line numbers
3. Brief explanation of improvements

Format as JSON:
\`\`\`json
{
  "refactoredCode": "...",
  "changes": [{ "description": "...", "line": 10, "originalCode": "...", "newCode": "..." }],
  "explanation": "..."
}
\`\`\``;
    }

    private parseRefactoringResult(content: string, input: CodeRefactoringInput): CodeRefactoringOutput {
        try {
            const parsed = JSON.parse(content);
            return parsed as CodeRefactoringOutput;
        } catch (error) {
            throw new CapabilityError(
                'Failed to parse refactoring result from LLM',
                this.name,
                error instanceof Error ? error : undefined
            );
        }
    }
}
```

### 3. Register Your Capability

In `extension.ts`:

```typescript
import { CodeAssistantAgent } from './agent/CodeAssistantAgent';
import { TestGenerationCapability } from './capabilities/TestGenerationCapability';
import { CodeRefactoringCapability } from './capabilities/CodeRefactoringCapability';
import { LLMProviderFactory } from './factories/LLMProviderFactory';

export function activate(context: vscode.ExtensionContext) {
    // Create LLM provider
    const provider = LLMProviderFactory.createProvider();

    // Create agent
    const agent = new CodeAssistantAgent(provider);

    // Register capabilities
    agent.registerCapability(new TestGenerationCapability());
    agent.registerCapability(new CodeRefactoringCapability()); // ← Your capability

    // ... rest of activation
}
```

### 4. Add Chat Command Handler

```typescript
// In your chat handler
async function handleChatRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const agent = getCodeAssistantAgent(); // Your singleton agent

    // Auto-detect capability
    const capabilityContext = {
        command: request.command,
        message: request.prompt,
        files: [], // Add file context
        activeFile: vscode.window.activeTextEditor?.document.uri.fsPath
    };

    try {
        const result = await agent.autoExecute(capabilityContext, stream, token);
        return { metadata: { command: request.command } };
    } catch (error) {
        stream.markdown(`❌ Error: ${error.message}`);
        return { metadata: { error: true } };
    }
}
```

---

## Advanced: Custom LLM Provider

Want to use Claude, Gemini, or your own LLM service?

### 1. Implement ICoreProvider

```typescript
import { ICoreProvider, CoreLLMResult } from '../interfaces/ICoreProvider';

export class ClaudeProvider implements ICoreProvider {
    async sendPrompt(
        systemPrompt: string, 
        userPrompt: string, 
        options?: any
    ): Promise<CoreLLMResult> {
        // Call Claude API
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': YOUR_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-3-opus-20240229',
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
                max_tokens: options?.maxTokens || 4096
            })
        });

        const data = await response.json();

        return {
            content: data.content[0].text,
            model: data.model,
            tokensUsed: data.usage.input_tokens + data.usage.output_tokens,
            metadata: { stopReason: data.stop_reason }
        };
    }

    async isAvailable(): Promise<boolean> {
        return !!YOUR_API_KEY;
    }

    getProviderName(): string {
        return 'Claude';
    }

    getVendorId(): string {
        return 'anthropic';
    }
}
```

### 2. Use in Agent

```typescript
const agent = new CodeAssistantAgent(new ClaudeProvider());
```

---

## Testing Your Capability

### Unit Test Example

```typescript
// __tests__/CodeRefactoringCapability.test.ts

import { CodeRefactoringCapability } from '../capabilities/CodeRefactoringCapability';
import { ICoreProvider } from '../interfaces/ICoreProvider';

describe('CodeRefactoringCapability', () => {
    let capability: CodeRefactoringCapability;
    let mockProvider: jest.Mocked<ICoreProvider>;

    beforeEach(() => {
        mockProvider = {
            sendPrompt: jest.fn(),
            isAvailable: jest.fn().mockResolvedValue(true),
            getProviderName: jest.fn().mockReturnValue('Mock'),
            getVendorId: jest.fn().mockReturnValue('mock')
        };

        capability = new CodeRefactoringCapability();
    });

    it('should refactor code successfully', async () => {
        const input = {
            sourceCode: 'function foo() { return 1 + 1; }',
            filePath: 'test.ts',
            refactoringType: 'simplify' as const
        };

        mockProvider.sendPrompt.mockResolvedValue({
            content: JSON.stringify({
                refactoredCode: 'const foo = () => 2;',
                changes: [{
                    description: 'Simplified addition',
                    line: 1,
                    originalCode: 'return 1 + 1',
                    newCode: '=> 2'
                }],
                explanation: 'Replaced computation with result'
            }),
            model: 'mock',
            tokensUsed: 100
        });

        const mockStream = { markdown: jest.fn(), progress: jest.fn() } as any;

        const result = await capability.execute(mockProvider, input, mockStream);

        expect(result.refactoredCode).toContain('const foo = () => 2');
        expect(result.changes).toHaveLength(1);
    });

    it('should validate input correctly', async () => {
        const invalidInput = {
            sourceCode: '',
            filePath: '',
            refactoringType: 'invalid' as any
        };

        const validation = await capability.validateInput(invalidInput);

        expect(validation.valid).toBe(false);
        expect(validation.error).toContain('sourceCode is required');
    });
});
```

---

## Best Practices

### 1. **Clear Separation**
Each capability should be self-contained with no dependencies on other capabilities.

### 2. **Typed Input/Output**
Use TypeScript interfaces for strong typing and IntelliSense support.

### 3. **Comprehensive Validation**
Validate input before execution to provide clear error messages.

### 4. **Context Detection**
Implement `canHandle()` thoughtfully to avoid false positives.

### 5. **User Feedback**
Use streams for progress updates and clear success/error messages.

### 6. **Error Handling**
Throw `CapabilityError` with descriptive messages for actionable feedback.

### 7. **Help Text**
Provide comprehensive help with examples and command syntax.

---

## Examples of Future Capabilities

### Architecture Analysis
```typescript
class ArchitectureAnalysisCapability implements ILLMCapability<ArchInput, ArchOutput> {
    // Analyze: Dependency graph, circular dependencies, modularity score
}
```

### Complexity Analysis
```typescript
class ComplexityAnalysisCapability implements ILLMCapability<ComplexInput, ComplexOutput> {
    // Analyze: Cyclomatic complexity, cognitive complexity, maintainability index
}
```

### Documentation Generation
```typescript
class DocumentationGenerationCapability implements ILLMCapability<DocInput, DocOutput> {
    // Generate: JSDoc comments, README sections, architecture docs
}
```

### Security Scan
```typescript
class SecurityScanCapability implements ILLMCapability<SecurityInput, SecurityOutput> {
    // Scan: Vulnerabilities, insecure patterns, OWASP Top 10
}
```

---

## Contributing

Want to contribute a capability to the official extension?

1. Fork the repository
2. Create your capability in `src/capabilities/`
3. Add comprehensive tests
4. Update documentation
5. Submit a pull request

**Guidelines:**
- Follow existing code style
- 100% test coverage for new capabilities
- Clear, descriptive commit messages
- Update CHANGELOG.md

---

## Need Help?

- **Issues:** https://github.com/velaeri/Spfx-test-agent/issues
- **Discussions:** https://github.com/velaeri/Spfx-test-agent/discussions
- **Documentation:** https://github.com/velaeri/Spfx-test-agent/tree/main/docs
