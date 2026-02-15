# Adding New Capabilities to Test Agent

## Quick Start Guide (v0.7.0)

This guide explains how to add new capabilities to Test Agent using both the **tool system** and the **capability-based plugin architecture**.

---

## Option 1: Adding a New Tool

The simplest way to extend the agent's abilities. Tools are exposed to the LLM in the agentic loop.

### Step 1: Create the Tool

```typescript
// src/tools/deterministic/FormatCodeTool.ts

import { BaseTool } from '../BaseTool';
import { ToolParameter, ToolResult, ToolExecutionContext } from '../ToolTypes';

export class FormatCodeTool extends BaseTool {
    get name(): string { return 'format_code'; }
    
    get description(): string {
        return 'Format a source file using the project\'s configured formatter (prettier, eslint --fix, etc.)';
    }
    
    get parameters(): ToolParameter[] {
        return [
            {
                name: 'filePath',
                type: 'string',
                description: 'Absolute path to the file to format',
                required: true
            }
        ];
    }
    
    get returns(): string {
        return 'Formatted file content or error message';
    }
    
    async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
        const validation = this.validateParams(params, ['filePath']);
        if (validation) return this.error(validation);
        
        const filePath = params.filePath as string;
        
        // Your implementation here
        try {
            // e.g., run prettier via child_process
            return this.success({ formatted: true, filePath });
        } catch (err: any) {
            return this.error(`Failed to format: ${err.message}`);
        }
    }
}
```

### Step 2: Register the Tool

Add it to `OrchestratorFactory.createToolRegistry()`:

```typescript
// src/orchestrator/OrchestratorFactory.ts

import { FormatCodeTool } from '../tools/deterministic/FormatCodeTool';

export class OrchestratorFactory {
    static createToolRegistry(llmProvider: ILLMProvider): ToolRegistry {
        const registry = new ToolRegistry();
        
        // Existing tools...
        registry.registerAll([
            new ListSourceFilesTool(),
            new ReadFileTool(),
            new WriteFileTool(),
            new RunTestTool(),
            new AnalyzeProjectTool(),
            new CollectContextTool(),
            new GenerateTestTool(llmProvider),
            new FixTestTool(llmProvider),
            new FormatCodeTool(),            // ← Add here
        ]);
        
        return registry;
    }
}
```

The tool is now available to the LLM in the agentic loop. The LLM will see its name, description, and parameters in the system prompt and can call it autonomously.

### Tool Types Reference

```typescript
interface ToolParameter {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description: string;
    required: boolean;
    enum?: string[];       // Allowed values
    default?: unknown;     // Default value
}

interface ToolResult {
    success: boolean;
    data?: unknown;        // Result data (passed back to LLM)
    error?: string;        // Error message (passed back to LLM)
    metadata?: Record<string, unknown>;
}

interface ToolExecutionContext {
    workspaceRoot: string;
    cancellationToken?: vscode.CancellationToken;
    progress?: vscode.Progress<{ message: string }>;
    extra?: Record<string, unknown>;
}
```

---

## Option 2: Adding a Capability Plugin

For more complex features that need their own command, context detection, and input validation.

### Step 1: Define Input/Output Types

```typescript
// src/capabilities/CodeRefactoringCapability.ts

export interface CodeRefactoringInput {
    sourceCode: string;
    filePath: string;
    refactoringType: 'extract-function' | 'rename' | 'simplify' | 'optimize';
    selectionRange?: { start: number; end: number };
}

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

### Step 2: Implement `ILLMCapability`

```typescript
import { ILLMCapability, CapabilityContext, ValidationResult } from '../interfaces/ILLMCapability';
import { ICoreProvider } from '../interfaces/ICoreProvider';
import * as vscode from 'vscode';

export class CodeRefactoringCapability implements ILLMCapability<CodeRefactoringInput, CodeRefactoringOutput> {
    readonly name = 'code-refactoring';
    readonly description = 'Refactor code using AI suggestions';
    readonly category = 'code-quality';

    async execute(
        provider: ICoreProvider,
        input: CodeRefactoringInput,
        stream: vscode.ChatResponseStream,
        token?: vscode.CancellationToken
    ): Promise<CodeRefactoringOutput> {
        stream.markdown(`## 🔄 Refactoring Code\n\n`);
        stream.progress(`Analyzing code for ${input.refactoringType}...`);

        // 1. Analyze current code
        const analysis = await provider.sendPrompt(
            'You are a code refactoring expert.',
            `Analyze this code and suggest ${input.refactoringType} refactoring:\n\n${input.sourceCode}`
        );

        // 2. Apply refactoring
        const result = await provider.sendPrompt(
            'You are a code refactoring expert.',
            `Apply the refactoring:\n\nOriginal:\n${input.sourceCode}\n\nAnalysis:\n${analysis.code}`
        );

        return {
            refactoredCode: result.code,
            changes: [],
            explanation: analysis.code
        };
    }

    canHandle(context: CapabilityContext): boolean {
        if (context.command === 'refactor') return true;
        if (context.message?.toLowerCase().includes('refactor')) return true;
        return false;
    }

    validateInput(input: CodeRefactoringInput): ValidationResult {
        if (!input.sourceCode) return { valid: false, error: 'Source code is required' };
        if (!input.filePath) return { valid: false, error: 'File path is required' };
        return { valid: true };
    }

    getHelpText(): string {
        return 'Refactor code using AI-powered suggestions. Supports extract-function, rename, simplify, and optimize.';
    }
}
```

### Step 3: Register

```typescript
// In extension.ts or a setup function
import { CodeAssistantAgent } from './agent/CodeAssistantAgent';

const agent = new CodeAssistantAgent(llmProvider);
agent.registerCapability(new TestGenerationCapability());
agent.registerCapability(new CodeRefactoringCapability());
```

### Step 4: Wire to Chat Command

Add the command in `package.json`:
```json
{
    "name": "refactor",
    "description": "Refactor code using AI suggestions"
}
```

Add routing in `ChatHandlers.ts` or use `agent.autoExecute()` for context-based detection.

---

## Key Interfaces

### `ICoreProvider` — Generic LLM Interface

```typescript
interface ICoreProvider {
    sendPrompt(systemPrompt: string, userPrompt: string): Promise<LLMResult>;
    isAvailable(): Promise<boolean>;
    getProviderName(): string;
    getVendorId(): string;
}
```

### `ILLMCapability<TInput, TOutput>` — Plugin Interface

```typescript
interface ILLMCapability<TInput, TOutput> {
    name: string;
    description: string;
    category: string;
    
    execute(provider: ICoreProvider, input: TInput, stream: ChatResponseStream, token?: CancellationToken): Promise<TOutput>;
    canHandle(context: CapabilityContext): boolean;
    validateInput(input: TInput): ValidationResult;
    getHelpText(): string;
}
```

### `CoreProviderAdapter` — Bridge

Wraps any `ICoreProvider` to implement `ILLMProvider`. Used when a capability needs access to testing-specific methods (e.g., `generateTest()`, `fixTest()`).

---

## Architecture Diagram

```
                 ┌──────────────────────────┐
                 │   CodeAssistantAgent      │
                 │   registerCapability()    │
                 │   execute() / autoExecute()
                 └─────────┬────────────────┘
                           │
            ┌──────────────┼──────────────────┐
            ▼              ▼                  ▼
   ┌────────────┐  ┌────────────┐    ┌────────────┐
   │TestGenCap  │  │RefactorCap │    │AnalysisCap │
   │(wraps      │  │            │    │            │
   │ TestAgent) │  │            │    │            │
   └──────┬─────┘  └──────┬─────┘    └──────┬─────┘
          │               │                 │
          └───────────────┼─────────────────┘
                          ▼
                   ICoreProvider
                   ┌──────────────┐
                   │sendPrompt()  │
                   │isAvailable() │
                   └──────┬───────┘
                          │
                ┌─────────┼──────────┐
                ▼                    ▼
         CopilotProvider     AzureOpenAIProvider
```

---

## Testing a Capability

```typescript
describe('CodeRefactoringCapability', () => {
    it('should refactor code', async () => {
        const mockProvider: ICoreProvider = {
            sendPrompt: jest.fn().mockResolvedValue({ code: 'refactored code' }),
            isAvailable: jest.fn().mockResolvedValue(true),
            getProviderName: () => 'mock',
            getVendorId: () => 'mock'
        };
        
        const capability = new CodeRefactoringCapability();
        const mockStream = { markdown: jest.fn(), progress: jest.fn() };
        
        const result = await capability.execute(mockProvider, {
            sourceCode: 'function foo() { /* complex */ }',
            filePath: '/test.ts',
            refactoringType: 'simplify'
        }, mockStream as any);
        
        expect(result.refactoredCode).toBeDefined();
        expect(mockProvider.sendPrompt).toHaveBeenCalled();
    });
});
```
