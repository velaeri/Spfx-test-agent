# Test Agent — Autonomous QA Engineer with LLM-First Tool-Calling Architecture

**Test Agent** is a VS Code extension that acts as an **autonomous QA engineer**. It generates, runs, and self-heals unit tests for any JavaScript/TypeScript project.

The extension uses a **hybrid LLM-first architecture** where an agentic orchestrator gives the LLM access to deterministic and intelligent tools, letting it analyze your project, generate tests, execute them, and fix failures in a fully autonomous loop.

---

## Architecture Overview

```
User ──► @test-agent /generate
              │
              ▼
      ┌───────────────────┐
      │  LLMOrchestrator   │  ◄── Agentic loop (max 10 iterations)
      │  (execute())       │
      └────────┬──────────┘
               │  LLM decides which tools to call
               ▼
      ┌───────────────────────────────────────────┐
      │              ToolRegistry (8 tools)        │
      ├───────────────────┬───────────────────────┤
      │  Deterministic    │  Intelligent           │
      │  ─────────────    │  ───────────           │
      │  ListSourceFiles  │  GenerateTest (LLM)    │
      │  ReadFile         │  FixTest (LLM)         │
      │  WriteFile        │                        │
      │  RunTest          │                        │
      │  AnalyzeProject   │                        │
      │  CollectContext   │                        │
      └───────────────────┴───────────────────────┘
```

**How it works:**
1. The orchestrator sends the user's request + available tool definitions to the LLM
2. The LLM responds with tool calls (JSON in markdown code blocks)
3. The orchestrator executes the tools and feeds results back to the LLM
4. The loop continues until the LLM responds with `DONE` or max iterations is reached

---

## Features

### Autonomous Test Generation & Self-Healing
1. **Analyzes** → LLM inspects your source code with `ReadFile` and `CollectContext` tools
2. **Generates** → LLM writes the test via `GenerateTest` tool
3. **Executes** → `RunTest` tool runs Jest in an isolated environment
4. **Diagnoses** → If the test fails, LLM reads the error output
5. **Heals** → `FixTest` tool regenerates the test with corrections
6. **Iterates** → Up to 3–5 healing cycles (configurable)

### Smart Project-Aware Dependency Detection
A 3-layer intelligence system ensures the right packages are installed:
1. **Layer 1 — StackDiscoveryService** (deterministic): Detects framework, UI library, test runner, package manager, module system from `package.json` and config files
2. **Layer 2 — LLM with enriched context**: The stack analysis is injected into the prompt so the LLM suggests only relevant packages
3. **Layer 3 — `filterByStack()` guardrail** (deterministic): Post-LLM filter removes packages irrelevant to the detected stack (e.g., React testing packages for a Node.js CLI project)

### Framework Detection
Automatically detects: **React**, **Angular**, **Vue**, **Next.js**, **Express**, **SPFx**, **VS Code Extensions**, and more.

### Multi-Provider LLM Support
- **GitHub Copilot** — Native integration, no configuration needed
- **Azure OpenAI** — Configure your own endpoint for corporate models
- **Graceful fallback** — Degrades to sensible defaults if LLM is unavailable

---

## Commands

| Chat Command | Description |
|---|---|
| `@test-agent /setup` | Set up Jest environment (install dependencies + create config) |
| `@test-agent /install` | Install Jest dependencies with AI-powered error resolution |
| `@test-agent /generate` | Generate and heal unit tests for the active file |
| `@test-agent /generate-all` | Generate tests for all source files in the workspace |

| VS Code Command | Description |
|---|---|
| `Test Agent: Setup Jest Environment` | Same as `/setup` |
| `Test Agent: Check Jest Environment Setup` | Verify Jest installation status |
| `Test Agent: Install with Suggested Command` | Run an LLM-suggested install command |

---

## Quick Start

### Prerequisites
- VS Code 1.85.0+
- Node.js v18+
- An active **GitHub Copilot** subscription (or Azure OpenAI access)

### Getting Started
1. Install the extension from the Marketplace (or load the `.vsix` file).
2. Open any JavaScript/TypeScript project.
3. Open the Copilot Chat panel (`Ctrl+Alt+I`).
4. Run: `@test-agent /setup` — The agent will install Jest and configure everything.
5. Open a source file and run: `@test-agent /generate` — The agent will create and validate tests automatically.

### Example Flow

```
You: @test-agent /generate

Agent: 🚀 Starting generation for UserService.ts
       📦 Analyzed 6 imported dependencies
       🔍 Detected: Express middleware, TypeScript
       
       ✅ Test generated: UserService.test.ts
       Running Jest...
       
       ⚠️ Test failed (attempt 1/3)
       Error: "Cannot find module '../db/connection'"
       Analyzing root cause...
       
       🔄 Fixing test (attempt 2)...
       Adding mock for database module...
       
       ✅ Test Passed! (Total: 3.8s)
       📊 1 passed, 0 failed
```

---

## Configuration

All settings use the `test-agent.*` prefix in VS Code settings:

| Setting | Default | Description |
|---|---|---|
| `test-agent.maxHealingAttempts` | `3` | Max self-healing attempts per test |
| `test-agent.initialBackoffMs` | `1000` | Backoff between retry attempts (ms) |
| `test-agent.maxRateLimitRetries` | `5` | Max retries on rate limit |
| `test-agent.maxTokensPerError` | `1500` | Max error chars sent to LLM |
| `test-agent.testFilePattern` | `${fileName}.test.${ext}` | Test file naming pattern |
| `test-agent.jestCommand` | `npx jest` | Jest execution command |
| `test-agent.llmProvider` | `copilot` | LLM provider (`copilot` or `azure-openai`) |
| `test-agent.llmVendor` | `copilot` | Vendor for `vscode.lm.selectChatModels` |
| `test-agent.llmFamily` | _(empty)_ | Model family (e.g., `gpt-4`). Empty = user's default |
| `test-agent.azureOpenAI.endpoint` | _(empty)_ | Azure OpenAI endpoint URL |
| `test-agent.azureOpenAI.apiKey` | _(empty)_ | Azure OpenAI API key |
| `test-agent.azureOpenAI.deploymentName` | _(empty)_ | Azure OpenAI deployment name |
| `test-agent.enableTelemetry` | `false` | Enable anonymous telemetry |
| `test-agent.logLevel` | `info` | Log level (`debug`, `info`, `warn`, `error`) |

---

## Architecture Deep Dive

### Tool System

All tools extend `BaseTool` and implement:
- `name` / `description` — Used to build the LLM system prompt
- `parameters` — Typed parameter definitions (name, type, required)
- `execute(params, context)` — Returns `ToolResult { success, data?, error? }`

**Deterministic Tools** (no LLM, pure logic):
| Tool | Purpose |
|---|---|
| `list_source_files` | Find `.ts`, `.tsx`, `.js`, `.jsx` files in the workspace |
| `read_file` | Read file contents from disk |
| `write_file` | Write test files to disk |
| `run_test` | Execute Jest on a specific test file |
| `analyze_project` | Run `StackDiscoveryService` to detect project stack |
| `collect_context` | Gather imports, types, and dependency context for a source file |

**Intelligent Tools** (use LLM internally):
| Tool | Purpose |
|---|---|
| `generate_test` | Generate a test file using LLM with full source context |
| `fix_test` | Fix a failing test using LLM with error output context |

### Orchestrator

The `LLMOrchestrator` implements an **agentic loop**:
1. Builds a system prompt containing all tool definitions (name, description, parameters, return type)
2. Sends the user request to the LLM
3. Parses tool calls from the response (JSON in fenced code blocks — `vscode.lm` API doesn't support native function calling)
4. Executes the requested tools via `ToolRegistry`
5. Feeds tool results back to the LLM as conversation history
6. Repeats until the LLM signals completion or max iterations (10) is reached

Two execution modes:
- **Free-form** (`execute()`) — LLM has full autonomy over tool selection and order
- **Predefined workflow** (`executeGenerateAndHeal()`) — Structured generate → run → fix cycle

### Service Layer

| Service | Purpose |
|---|---|
| `ConfigService` | Read extension settings |
| `Logger` | Structured logging with configurable levels |
| `StateService` | Persist state across sessions via VS Code globalState |
| `TelemetryService` | Anonymous usage telemetry |
| `CacheService` | Cache LLM responses to reduce API calls |
| `StackDiscoveryService` | Detect project framework, language, UI library, test runner, package manager |
| `DependencyDetectionService` | LLM-first dependency version detection with npm registry validation |
| `JestConfigurationService` | LLM-assisted Jest config generation |
| `ProjectSetupService` | Orchestrate `/setup` and `/install` flows |
| `QueueService` | Manage batch generation queue |
| `CoverageService` | Parse and track test coverage |
| `DependencyGraphService` | Build import dependency graphs |
| `PackageInstallationService` | Execute npm/yarn/pnpm install commands |

### Provider Layer

Both providers implement `ILLMProvider` (which extends `ICoreProvider`):

- **CopilotProvider** — Uses `vscode.lm.selectChatModels()` to call GitHub Copilot models
- **AzureOpenAIProvider** — Uses the `@azure/openai` SDK with a custom endpoint

Key methods: `generateTest()`, `fixTest()`, `planTestStrategy()`, `generateJestConfig()`, `detectDependencies()`, `planBatchGeneration()`, `validateAndFixVersions()`, `analyzeAndFixError()`, `sendPrompt()`

### Extensibility Layer

The extension also includes a **capability-based plugin architecture** (v0.6.0+):
- `ICoreProvider` — Minimal generic LLM interface (`sendPrompt`, `isAvailable`)
- `ILLMCapability<TInput, TOutput>` — Plugin interface for adding new capabilities
- `CodeAssistantAgent` — Generic capability orchestrator with `registerCapability()`, `execute()`, `autoExecute()`
- `CoreProviderAdapter` — Bridge from `ICoreProvider` to `ILLMProvider` for backward compatibility
- `TestGenerationCapability` — Testing wrapped as a capability plugin

This enables future capabilities like code refactoring, architecture analysis, or documentation generation without modifying core code.

---

## Project Structure

```
src/
├── extension.ts                    # Entry point: registers participant, commands, orchestrator
├── ChatHandlers.ts                 # Routes chat commands to handlers
├── orchestrator/
│   ├── LLMOrchestrator.ts          # Agentic loop with tool calling
│   ├── OrchestratorFactory.ts      # Creates ToolRegistry with all 8 tools
│   └── index.ts
├── tools/
│   ├── BaseTool.ts                 # Abstract base class for all tools
│   ├── ToolRegistry.ts             # Tool storage, lookup, and prompt building
│   ├── ToolTypes.ts                # ToolParameter, ToolDefinition, ToolCall, ToolResult
│   ├── deterministic/              # 6 tools: file I/O, test execution, project analysis
│   └── intelligent/                # 2 tools: generate test, fix test (use LLM)
├── providers/
│   ├── CopilotProvider.ts          # GitHub Copilot via vscode.lm API
│   └── AzureOpenAIProvider.ts      # Azure OpenAI via @azure/openai SDK
├── interfaces/
│   ├── ILLMProvider.ts             # Full provider interface (testing-specific methods)
│   ├── ICoreProvider.ts            # Minimal generic LLM interface
│   └── ILLMCapability.ts           # Capability plugin interface
├── agent/
│   ├── TestAgent.ts                # Self-healing test generation agent
│   └── CodeAssistantAgent.ts       # Generic capability orchestrator
├── adapters/
│   └── CoreProviderAdapter.ts      # ICoreProvider → ILLMProvider bridge
├── capabilities/
│   └── TestGenerationCapability.ts # Testing as a capability plugin
├── services/                       # 13 services (config, logging, stack detection, etc.)
├── utils/                          # File scanning, test running, prompts, constants
├── errors/                         # Custom error types
└── factories/
    └── LLMProviderFactory.ts       # Creates CopilotProvider or AzureOpenAIProvider
```

---

## Troubleshooting

### "Jest command failed"
Run `@test-agent /setup` first. The agent will detect missing packages and install them.

### "Rate Limited"
The agent implements exponential backoff. If you hit rate limits frequently, wait a few seconds between commands or configure `test-agent.maxRateLimitRetries`.

### Tests always failing
Check the Output panel (`Test Agent`) for detailed logs. Set `test-agent.logLevel` to `debug` for verbose output. Common causes:
- Missing mocks for external modules
- Incorrect Jest environment (node vs jsdom)
- TypeScript compilation errors in test files

---

## License

MIT
