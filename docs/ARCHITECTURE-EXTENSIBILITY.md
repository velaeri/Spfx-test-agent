# Architecture Guide

> **Version:** 0.7.0  
> **Date:** February 2026

---

## High-Level Architecture

Test Agent uses a **hybrid LLM-first architecture** with two complementary execution strategies:

1. **Tool-calling orchestrator** — An agentic loop where the LLM autonomously decides what tools to call
2. **Direct LLM methods** — Specialized provider methods for planning, dependency detection, and batch generation

```
┌──────────────────────────────────────────────────────────────┐
│                      extension.ts                            │
│  Creates LLMProvider + ToolRegistry + LLMOrchestrator        │
│  Registers chat participant + commands                       │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                     ChatHandlers.ts                           │
│  Routes: /setup → /install → /generate → /generate-all       │
└──────────┬─────────┬─────────┬─────────┬─────────────────────┘
           │         │         │         │
           ▼         ▼         ▼         ▼
      ProjectSetup  Install  LLMOrchestrator  LLMOrchestrator
      Service       Loop     execute()        + BatchPlan
                             ┌─────────┐
                             │Agentic  │
                             │Loop     │
                             │(10 iter)│
                             └────┬────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │     ToolRegistry (8)        │
                    ├─────────────┬──────────────┤
                    │Deterministic│ Intelligent   │
                    │ 6 tools     │ 2 tools (LLM) │
                    └─────────────┴──────────────┘
```

---

## Execution Layers

### Layer 1: Entry Point (`extension.ts`)

On activation:
1. Selects LLM provider based on config (CopilotProvider or AzureOpenAIProvider)
2. Creates `ToolRegistry` via `OrchestratorFactory.createToolRegistry(provider)`
3. Creates `LLMOrchestrator(registry, provider)`
4. Registers `@test-agent` chat participant
5. Registers VS Code commands (`test-agent.setup`, `test-agent.checkSetup`, `test-agent.installWithCommand`)
6. Watches for config changes

### Layer 2: Command Router (`ChatHandlers.ts`)

Routes chat commands to handlers. Each handler receives the `orchestrator` instance.

| Command | Handler | Uses Orchestrator? |
|---|---|---|
| `/setup` | `handleSetupRequest()` | No — uses `ProjectSetupService` directly |
| `/install` | `handleInstallRequest()` | No — uses `DependencyDetectionService` + LLM retry loop |
| `/generate` | `handleGenerateSingleRequest()` | **Yes** — `orchestrator.executeGenerateAndHeal()` |
| `/generate-all` | `handleGenerateAllRequest()` | **Yes** — per-file `orchestrator.executeGenerateAndHeal()` |

### Layer 3: Agentic Orchestrator (`LLMOrchestrator`)

Two execution modes:

**Free-form (`execute()`):**
- Sends tool definitions + user request to LLM
- LLM picks tools, orchestrator executes them, feeds results back
- Loops until LLM says `DONE` or 10 iterations

**Predefined (`executeGenerateAndHeal()`):**
- Structured pipeline: CollectContext → ReadFile → GenerateTest → WriteFile → RunTest → (FixTest loop)
- Used by `/generate` and `/generate-all`

### Layer 4: Tool System

All tools extend `BaseTool`:

```typescript
abstract class BaseTool {
    abstract get name(): string;
    abstract get description(): string;
    abstract get parameters(): ToolParameter[];
    abstract get returns(): string;
    abstract execute(params, context): Promise<ToolResult>;
}
```

**Deterministic tools** — No LLM, pure logic:
- `ListSourceFilesTool` — Finds source files (`.ts`, `.tsx`, `.js`, `.jsx`)
- `ReadFileTool` — Reads file contents
- `WriteFileTool` — Writes files to disk
- `RunTestTool` — Executes Jest on a test file
- `AnalyzeProjectTool` — Runs `StackDiscoveryService.discover()`
- `CollectContextTool` — Gathers imports, types, dependency context via `SourceContextCollector`

**Intelligent tools** — Use LLM internally:
- `GenerateTestTool` — Calls `llmProvider.generateTest()` with full context
- `FixTestTool` — Calls `llmProvider.fixTest()` with error output

### Layer 5: LLM Providers

Both implement `ILLMProvider` (extends `ICoreProvider`):

| Provider | API | Use Case |
|---|---|---|
| `CopilotProvider` | `vscode.lm.selectChatModels()` | Default, no config needed |
| `AzureOpenAIProvider` | `@azure/openai` SDK | Corporate/custom deployments |

Specialized methods:
- `generateTest()` / `fixTest()` — Core generation
- `planTestStrategy()` — Pre-generation analysis
- `generateJestConfig()` — Personalized Jest configuration
- `detectDependencies()` — Version detection with project context
- `planBatchGeneration()` — Batch file prioritization
- `validateAndFixVersions()` — npm version validation
- `analyzeAndFixError()` — Install error diagnosis
- `sendPrompt()` — Generic prompt (ICoreProvider)

---

## Extensibility Architecture (v0.6.0+)

The extension includes a **capability-based plugin system** built on top of the core tool architecture:

```
┌────────────────────────────────┐
│   CodeAssistantAgent           │
│   (Generic orchestrator)       │
│                                │
│   registerCapability(cap)      │
│   execute(name, input, stream) │
│   autoExecute(context, stream) │
│   setProvider(provider)        │
└────────────┬───────────────────┘
             │
    ┌────────┴─────────────────────┐
    │   ILLMCapability<TIn, TOut>  │
    │                              │
    │   name, description, category│
    │   execute(provider, input)   │
    │   canHandle(context)         │
    │   validateInput(input)       │
    │   getHelpText()              │
    └──────────────────────────────┘
             │
    ┌────────┴───────────────────────────┐
    │   TestGenerationCapability         │
    │   (wraps TestAgent)                │
    │                                    │
    │   Detects: /generate, "generate    │
    │   test", .ts/.tsx files            │
    └────────────────────────────────────┘
```

**Key interfaces:**
- `ICoreProvider` — Minimal LLM interface: `sendPrompt()`, `isAvailable()`, `getProviderName()`, `getVendorId()`
- `ILLMCapability<TInput, TOutput>` — Plugin interface for any capability
- `CoreProviderAdapter` — Adapts `ICoreProvider` → `ILLMProvider` for backward compatibility

**Adding a new capability:**
1. Define input/output types
2. Implement `ILLMCapability<TInput, TOutput>`
3. Register with `agent.registerCapability(new YourCapability())`

See [docs/CAPABILITY-DEVELOPMENT.md](CAPABILITY-DEVELOPMENT.md) for the full guide.

---

## Smart Dependency Detection (3-Layer System)

```
┌─────────────────────────────────────────────┐
│ Layer 1: StackDiscoveryService              │
│ (deterministic)                             │
│                                             │
│ Reads: package.json, tsconfig.json,         │
│        lockfiles, directory structure       │
│                                             │
│ Detects: framework, language, uiLibrary,    │
│          testRunner, packageManager,         │
│          moduleSystem, reactVersion          │
│                                             │
│ Returns: ProjectStack                       │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│ Layer 2: LLM with enriched context          │
│                                             │
│ Input: packageJson + _stackAnalysis block   │
│ LLM knows the detected stack, so it         │
│ suggests ONLY relevant packages             │
│ 3 retries with feedback on failure          │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│ Layer 3: filterByStack() guardrail          │
│ (deterministic)                             │
│                                             │
│ Removes packages irrelevant to stack:       │
│ - React packages if no React detected       │
│ - Browser packages if no DOM need           │
│ - Framework-specific packages if wrong      │
│                                             │
│ Fallback: jest, @types/jest, ts-jest only   │
└─────────────────────────────────────────────┘
```

---

## Service Catalog

| Service | File | Purpose |
|---|---|---|
| `ConfigService` | `services/ConfigService.ts` | Extension settings reader |
| `Logger` | `services/Logger.ts` | Structured logging (debug/info/warn/error) |
| `StateService` | `services/StateService.ts` | Persistent state via globalState |
| `TelemetryService` | `services/TelemetryService.ts` | Anonymous usage telemetry |
| `CacheService` | `services/CacheService.ts` | LLM response caching |
| `StackDiscoveryService` | `services/StackDiscoveryService.ts` | Deterministic project stack detection |
| `DependencyDetectionService` | `services/DependencyDetectionService.ts` | 3-layer dependency detection |
| `JestConfigurationService` | `services/JestConfigurationService.ts` | LLM-assisted jest.config generation |
| `ProjectSetupService` | `services/ProjectSetupService.ts` | /setup and /install orchestration |
| `QueueService` | `services/QueueService.ts` | Batch generation queue management |
| `CoverageService` | `services/CoverageService.ts` | Jest coverage report parsing |
| `DependencyGraphService` | `services/DependencyGraphService.ts` | Import dependency graph building |
| `PackageInstallationService` | `services/PackageInstallationService.ts` | npm/yarn/pnpm command execution |

---

## Error Handling

Custom error types in `errors/CustomErrors.ts`:
- `WorkspaceNotFoundError` — No workspace folder open
- `FileValidationError` — Invalid file type or path
- `JestNotFoundError` — Jest not installed
- `TestGenerationError` — Test generation failed after all attempts
- `RateLimitError` — LLM rate limit exceeded
- `LLMNotAvailableError` — No LLM model available
- `SPFXTestAgentError` — Base error class

All errors have consistent handling via `handleError()` in ChatHandlers.

---

## Configuration

All settings under `test-agent.*` namespace:
- `maxHealingAttempts` (3) — Self-healing cycle limit
- `initialBackoffMs` (1000) — Retry backoff
- `maxRateLimitRetries` (5) — Rate limit retry count
- `maxTokensPerError` (1500) — Error output truncation
- `testFilePattern` — Test file naming
- `jestCommand` — Jest execution command
- `llmProvider` — `copilot` or `azure-openai`
- `llmVendor` / `llmFamily` — Model selection
- `azureOpenAI.*` — Azure endpoint config
- `enableTelemetry` — Anonymous telemetry
- `logLevel` — Logging verbosity
