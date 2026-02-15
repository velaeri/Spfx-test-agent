# LLM-First Architecture — Design Rationale

> **Date:** February 2026  
> **Status:** Implemented in v0.7.0

---

## The Problem

The extension was originally designed as an **"LLM-assisted"** tool — not a truly LLM-first system.

**Evidence (v0.4.x):**
- 13 services with hardcoded logic: `FileScanner → ProjectSetup → DependencyDetection → JestConfig → StackDiscovery → LLM(plan) → LLM(generate) → LLM(fix) → TestRunner`
- The extension made ALL decisions, the LLM was just a "code generator"
- 6 layers of indirection: `extension → ChatHandlers → 13 Services → Factories → Adapters → Providers → LLM`
- Hardcoded version strings, fixed configuration templates, SPFx-specific heuristics

**Symptoms:**
- Adding new functionality required modifying 5+ files
- LLM had no autonomy — couldn't decide to read a file, run a test, or inspect an error
- React testing packages were suggested for Node.js CLI projects because detection was hardcoded:

```typescript
// ❌ Old approach (v0.4.x)
const JEST_DEPENDENCIES = {
    'jest': '^29.7.0',                    // Fixed version
    '@testing-library/react': '^14.0.0',  // Always included
    'react-test-renderer': '^18.2.0',     // Even for non-React projects
};
```

---

## What LLM-First Actually Means

**Definition:** The LLM is the **decision engine**. The application provides:
1. **Tools** the LLM can invoke (file I/O, test execution, project analysis)
2. **Initial context** of the user's goal
3. **Execution infrastructure** for tool calls
4. **UI** to visualize progress

**Key distinction:**
- `LLM-assisted` = Extension decides everything, uses LLM for text generation
- `LLM-first` = LLM decides what to do, extension provides tools and executes them

---

## The Solution: Hybrid Architecture (v0.7.0)

### Tool-Calling Orchestrator

An agentic loop where the LLM has access to 8 tools and full autonomy:

```
User: "Generate tests for UserService.ts"
    ↓
LLMOrchestrator.execute()
    ↓
LLM: "I need to understand this project first"
    → calls analyze_project
    → calls read_file (UserService.ts)
    → calls collect_context (imports, types)
    → calls generate_test (with full context)
    → calls write_file (UserService.test.ts)
    → calls run_test
    → test fails → calls fix_test
    → calls write_file (fixed version)
    → calls run_test
    → test passes → "DONE"
```

**The LLM decides:**
- Which tools to call and in what order
- When to read additional files for context
- How to diagnose and fix test failures
- When the task is complete

### Smart Dependency Detection (3-Layer System)

For dependency installation, a hybrid approach combines deterministic analysis with LLM intelligence:

1. **StackDiscoveryService** (deterministic) — Reads `package.json`, lockfiles, and config to detect framework, language, UI library, test runner, package manager
2. **LLM with enriched context** — Receives the stack analysis as part of the prompt, so it suggests only relevant packages
3. **`filterByStack()` guardrail** (deterministic) — Post-LLM filter removes packages irrelevant to the detected stack

```typescript
// ✅ New approach (v0.7.0)
// Layer 1: Deterministic stack detection
const stack = await StackDiscoveryService.discover(projectRoot);
// → { framework: 'express', uiLibrary: 'none', hasReact: false }

// Layer 2: LLM with context
packageJson._stackAnalysis = stack;
const deps = await llmProvider.detectDependencies(packageJson);
// LLM sees hasReact=false → suggests only jest, @types/jest, ts-jest

// Layer 3: Guardrail
const filtered = filterByStack(deps, stack);
// Removes any React packages the LLM might have included anyway
```

---

## Architecture Comparison

| Aspect | v0.4.x (LLM-assisted) | v0.7.0 (LLM-first) |
|---|---|---|
| **Decision maker** | Extension hardcoded logic | LLM with tool access |
| **LLM role** | Text/code generator only | Autonomous agent |
| **File operations** | Extension reads files, passes to LLM | LLM calls `read_file` tool |
| **Test execution** | Extension runs Jest, passes errors | LLM calls `run_test` tool |
| **Error diagnosis** | Extension parses errors, sends to LLM | LLM sees raw error, diagnoses itself |
| **Dependency detection** | Hardcoded version maps | 3-layer stack-aware system |
| **Adding features** | Modify 5+ files | Add a tool or capability |
| **Framework support** | SPFx-specific | Any JS/TS framework |

---

## Design Decisions

### Why not 100% LLM-driven?

Some operations are better done deterministically:
- **File I/O** — Reading/writing files doesn't need LLM reasoning
- **Test execution** — Running Jest is a mechanical operation
- **Stack detection** — Parsing `package.json` is faster and more reliable than asking the LLM
- **Package filtering** — Removing irrelevant packages is a simple rule-based check

The hybrid approach gives the LLM autonomy over **strategy** while keeping **infrastructure** deterministic.

### Why tool calling via JSON in code blocks?

The `vscode.lm` API doesn't support native function calling. The orchestrator uses a convention:
- LLM outputs tool calls as JSON in fenced code blocks
- `ToolRegistry.parseToolCalls()` extracts them
- Results are fed back as conversation history

### Why keep the old TestAgent as fallback?

The `handleGenerateSingleRequest()` handler accepts an optional `orchestrator` parameter. If not available, it falls back to `TestAgent.generateAndHealTest()`. This ensures backward compatibility during the migration.

---

## Migration History

| Version | Architecture | Key Change |
|---|---|---|
| v0.3.x | Imperative | Direct LLM calls, hardcoded everything |
| v0.4.x | LLM-assisted | Added LLM planning methods, still hardcoded |
| v0.5.x | LLM-first methods | LLM generates configs, detects versions, plans batches |
| v0.6.0 | Capability plugins | Added ICoreProvider, ILLMCapability, CodeAssistantAgent |
| **v0.7.0** | **Tool-calling** | **LLMOrchestrator + ToolRegistry + 8 tools + 3-layer deps** |
