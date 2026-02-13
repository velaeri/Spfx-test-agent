# Changelog

All notable changes to the "spfx-test-agent" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.6.0] - 2026-02-13

### 🏗️ **MAJOR REFACTOR: Capability-Based Plugin Architecture**

#### **Strategic Vision:**
Transformed the extension from a **testing-specific tool** to an **extensible code assistant platform** using a capability-based plugin architecture. Testing is now ONE capability among many future possibilities (refactoring, architecture analysis, complexity assessment, etc.).

#### **Architectural Changes:**

**1. New Core Interfaces**
- ✅ **`ICoreProvider`** - Minimal, generic LLM interface
  - `sendPrompt()` - Core method for all LLM interactions
  - `isAvailable()`, `getProviderName()`, `getVendorId()`
  - Replaces testing-specific methods with generic prompt interface
  
- ✅ **`ILLMCapability<TInput, TOutput>`** - Plugin system interface
  - `execute()` - Run capability with typed input/output
  - `canHandle()` - Auto-detection based on context (command, message, files)
  - `validateInput()` - Pre-execution validation
  - `getHelpText()` - Self-documenting capabilities
  
- ✅ **`ILLMProvider extends ICoreProvider`** - Backward compatibility bridge
  - Maintains all existing testing-specific methods
  - 100% backward compatible with v0.5.x
  - Gradual migration path to new architecture

**2. Generic Agent**
- ✅ **`CodeAssistantAgent`** - Capability orchestrator
  - `registerCapability()` - Plugin registration
  - `execute()` - Named capability execution
  - `autoExecute()` - Context-based auto-detection
  - `showHelp()` - Self-documenting interface
  - `setProvider()` - Hot-swap LLM provider at runtime

**3. Adapter Layer**
- ✅ **`CoreProviderAdapter`** - Bridge ICoreProvider → ILLMProvider
  - Wraps generic `sendPrompt()` into testing-specific methods
  - Allows TestAgent to work with new architecture
  - Zero behavioral changes from v0.5.3

**4. Capability Implementation**
- ✅ **`TestGenerationCapability`** - Testing as a capability
  - Pure wrapper around existing `TestAgent`
  - Preserves ALL v0.5.3 functionality (self-healing, strategy planning, etc.)
  - Implements `ILLMCapability` for extensibility
  - Input validation with detailed error messages
  - Context detection (commands: `/generate`, `/fix-test`; keywords: "generate test", "create test")

**5. Provider Updates**
- ✅ **`CopilotProvider` & `AzureOpenAIProvider` implement ICoreProvider**
  - Added `sendPrompt()` method (delegates to existing `sendRequest()`)
  - Added `getVendorId()` method
  - Backward compatible with ILLMProvider interface
  
#### **Benefits:**

✅ **Extensibility**
- Add new capabilities without touching core code
- Each capability is self-contained and independently testable
- Plugin marketplace potential (community contributions)

✅ **Maintainability**
- Clear separation of concerns
- Generic agent reduces code duplication
- Easier to add features (refactoring, analysis, documentation generation)

✅ **Flexibility**
- Hot-swap LLM providers at runtime
- Context-based auto-detection of capabilities
- Self-documenting help system

✅ **Zero Breaking Changes**
- 100% backward compatible with v0.5.3
- Existing tests pass without modification
- Gradual migration path

#### **Future Capabilities (Planned):**
- 🔄 **CodeRefactoringCapability** - Extract function, rename, simplify
- 📊 **ArchitectureAnalysisCapability** - Dependency graphs, modularity scores
- 🧠 **ComplexityAnalysisCapability** - Cyclomatic complexity, cognitive load
- 📝 **DocumentationGenerationCapability** - JSDoc, README, architecture docs
- 🔒 **CodeSecurityScanCapability** - Vulnerability detection, best practices

#### **Migration Notes:**
- No configuration changes required
- Existing commands work identically (`/generate`, `/generate-all`, `/setup`, `/install`)
- New architecture is opt-in for future capabilities
- Documentation updated: see `docs/ARCHITECTURE-EXTENSIBILITY.md`

---

## [0.5.3] - 2026-02-13

### 🐛 **CRITICAL BUGFIX: Test Error Capture & LLM Feedback Loop**

#### **Problem Identified:**
After v0.5.2 improvements, the installation retry loop worked perfectly, but **test generation was failing silently** with empty "Validation Error" messages. The LLM couldn't fix tests because it **wasn't receiving the actual Jest error output**.

**Root Cause:**
- `JestLogParser.cleanJestOutput()` was too aggressive in filtering
- Returned empty string for compilation errors or unexpected formats
- LLM received empty error context → couldn't diagnose → tests kept failing
- Result: 0% coverage, all tests failing after 3-5 attempts

#### **What Was Fixed:**

**1. Enhanced Error Capture in `JestLogParser`**
- ✅ **Empty output detection** - Returns diagnostic message instead of empty string
- ✅ **Expanded error patterns** - Now catches:
  - `ReferenceError`, `ENOENT`, `Failed to compile`, `Module parse failed`
  - Compilation errors, module resolution failures
  - Stack traces with `at` prefix
- ✅ **Fallback to raw output** - If no patterns match, returns last 2000 chars (usually contains error)
- ✅ **Better size limits** - Increased from 1500 to 2000 chars for context
- ✅ **Diagnostic messages** - Clear feedback when parsing fails

**2. Robust Error Handling in `TestAgent`**
- ✅ **Dual-path error capture**:
  ```typescript
  const errorToSend = (cleanedError.length > 50) 
      ? cleanedError              // Use cleaned if non-empty
      : testResult.output.substring(0, 3000); // Use RAW if cleaning failed
  ```
- ✅ **Detailed logging** - Logs both raw and cleaned error lengths for debugging
- ✅ **Guaranteed error context** - LLM ALWAYS receives error information
- ✅ **User-visible errors** - Shows meaningful error in UI even when parsing fails

**3. Extended Error Patterns**
Now captures these critical scenarios:
- **TypeScript compilation errors** (Missing semicolon, Unexpected token)
- **Module resolution failures** (Cannot find module, ENOENT)
- **Babel transpilation errors** (Failed to compile, Module parse failed) 
- **Runtime errors** (ReferenceError, undefined variables)
- **Jest configuration issues** (Missing environment, invalid config)

---

### 📊 **Impact on Test Generation Success Rate**

**Before (v0.5.2):**
```
❌ Test failing after 3 attempts
Consider reviewing manually
Validation Error:
(empty - no error shown)
```
**LLM received:** Empty string → Couldn't diagnose → Same error repeated

**After (v0.5.3):**
```
❌ Test failing after 3 attempts
Validation Error:
SyntaxError: Unexpected token (4:15)
  2 | jest.mock('@fluentui/react', () => ({
  3 |   PrimaryButton: (props: any) => <button>
> 4 |   ... actual error with context
```
**LLM receives:** Full compilation error → Identifies TypeScript in mock → Fixes → Test passes

---

### 🔄 **Complete Iterative Flow Now Working**

```
1. /install → LLM suggests → npm validates → install fails
2. LLM analyzes npm error → fixes versions → retry → ✅ installs
3. /generate → LLM plans strategy → generates test
4. Jest runs → FAILS with compilation error
5. ✅ NEW: LLM receives FULL error (not empty)
6. LLM diagnoses → removes types from mocks → regenerates
7. Jest runs → ✅ PASSES
8. Coverage check → iterate if needed
```

**Key Improvement:** Step 5 now provides complete error context to LLM

---

### 🛠️ **Technical Changes**

#### **File: `src/utils/JestLogParser.ts`**
- Added empty output check at start of `cleanJestOutput()`
- Expanded `errorLines` filter to catch 10+ new error patterns
- Added fallback: returns last 2000 chars if no patterns match
- Returns diagnostic message with raw excerpt if parsing completely fails
- Improved `trim()` usage to avoid empty result strings

#### **File: `src/agent/TestAgent.ts`**
- Introduced `errorToSend` variable with fallback logic
- Added logging: `error length: X chars, cleaned: Y chars`
- Applied fallback in two places: LLM fix call AND user-facing error display
- Extended logging in `logger.warn()` to include both lengths

---

### ⚠️ **Breaking Changes**
None — Fully backward compatible

---

### 📝 **Migration Notes**
- No action required
- Tests that previously failed silently will now show actual errors
- LLM will be able to fix errors it couldn't see before
- Expected improvement: **20-40% higher test generation success rate**

---

## [0.5.2] - 2026-02-13

### 🔧 **CRITICAL FIX: Real NPM Version Validation**

#### **Problem Solved:**
Previous version (0.5.1) had LLM planning methods but **wasn't actually validating** if suggested versions exist in npm registry before attempting installation. This caused `ETARGET` errors when LLM suggested non-existent versions.

#### **What Changed:**

**1. Added Real NPM Validation**
- New method `validateVersionsWithNpm()` — Executes `npm view package@version` to verify existence
- Validates EVERY package before attempting installation
- Runs validation in parallel for performance

**2. Enhanced LLM Validation Loop**
- `detectDependencies()` → Suggests versions
- **NEW:** `validateVersionsWithNpm()` → Checks with npm registry
- If errors → `validateAndFixVersions()` → LLM fixes with feedback
- Re-validate fixed versions
- If still fails → Retry with better feedback (3 attempts)

**3. Improved Prompts**
- `detectDependencies` prompt now EMPHASIZES:
  - "DO NOT suggest fictional versions"
  - "USE 'latest' if uncertain"
  - "Ensure Jest ecosystem version alignment"
- `validateAndFixVersions` prompt now includes:
  - Detailed analysis requirements
  - Reasoning process examples
  - Explicit instruction to research actual npm versions

**4. Better Fallback Strategy**
- After 3 failed LLM attempts → Uses `"latest"` for all packages
- `"latest"` tag always resolves to newest stable version in npm
- NO hardcoded version strings that might become obsolete

---

### 📊 **Validation Flow Diagram**

```
User runs /install
↓
DependencyDetectionService.getCompatibleDependencies()
├─ Attempt 1:
│  ├─ LLM.detectDependencies() → Suggests versions
│  ├─ validateVersionsWithNpm() → ✅/❌ Check each package
│  ├─ If errors → LLM.validateAndFixVersions() → Get corrections
│  └─ Re-validate corrections
├─ Attempt 2 (if failed):
│  └─ Same flow with feedback: "Package X@Y.Z not found"
├─ Attempt 3 (if failed):
│  └─ Same flow with cumulative feedback
└─ Fallback:
   └─ Return {"jest": "latest", ...} (npm resolves stable)
```

---

### 🛠️ **Technical Implementation**

#### **New Method: `checkPackageVersionExists()`**
```typescript
// Spawns: npm view package@version version
// Returns: true if exists, false if 404/ETARGET
// Timeout: 5 seconds per package
// Parallelized for performance
```

**Error Detection:**
- `E404` — Package doesn't exist
- `ETARGET` — Version doesn't exist
- `notarget` — npm couldn't find matching version

---

### 🎯 **Impact**

**Before (0.5.1):**
```
LLM suggests: jest@29.8.0 (doesn't exist)
npm install fails with ETARGET
User sees error, must manually fix
```

**After (0.5.2):**
```
LLM suggests: jest@29.8.0
Validation: ❌ 404 not found
LLM fixes: jest@29.7.0 (actual latest)
Validation: ✅ exists
npm install succeeds
```

---

### ⚠️ **Breaking Changes**
None — Fully backward compatible

---

### 📝 **Migration Notes**
- No action required for users
- Extension now validates all versions automatically
- `/install` command is now much more reliable

---

### 🔄 **ADDITIONAL IMPROVEMENTS: Complete Iterative LLM Loop**

#### **Installation Retry Loop**
Package installation now includes intelligent retry with LLM error analysis:

**Flow:**
```
1. LLM suggests versions → npm validates → install attempt
2. If install fails → capture error output
3. LLM.analyzeAndFixError() → analyzes npm error
4. LLM suggests corrected versions
5. Retry installation (up to 3 attempts)
6. Each attempt gets cumulative error context
```

**Implementation:**
- `ProjectSetupService.setupProject()` now has complete retry loop
- Each failed installation triggers `llmProvider.analyzeAndFixError()`
- LLM receives full npm error output for diagnosis
- Automatic fallback to latest versions after 3 failed attempts

---

#### **Professional Structured Prompts**
All LLM prompts updated with explicit reasoning guidance:

**New Prompt Structure:**
```markdown
# TASK: [Clear objective]
## CONTEXT: [Available information]
## YOUR ANALYSIS PROCESS:
### Step 1: [First reasoning step]
### Step 2: [Second step]
...
## OUTPUT REQUIREMENTS: [What to produce]
## QUALITY STANDARDS:
✅ DO: [Best practices]
❌ DON'T: [Anti-patterns]
## EXAMPLE: [Sample output]
```

**Updated Prompts:**
1. ✅ `GENERATE_TEST` — 4-step analysis process (code understanding → strategy → mocks → structure)
2. ✅ `FIX_TEST` — Systematic debugging (error classification → root cause → solution → validation)
3. ✅ `ANALYZE_ERROR` — Installation error diagnosis (classification → identification → research → solution)
4. ✅ `PLAN_TEST_STRATEGY` — Strategic planning (code analysis → approach → mocking → risk assessment)
5. ✅ `GENERATE_JEST_CONFIG` — Configuration design (environment → TypeScript → resolution → coverage)
6. ✅ `PLAN_BATCH_GENERATION` — Batch prioritization (categorization → dependencies → risk → optimization)

**Benefits:**
- LLM reasoning is now **explicit and guided** at every step
- Consistent quality across all LLM operations
- Easier to debug when LLM makes mistakes
- Better maintainability and extensibility

---

#### **Complete End-to-End Iterative Loop**

**The Full Workflow:**
```
/install
├─ 1. Detect missing packages
│  └─ LLM: detectDependencies() → suggests versions
├─ 2. Validate versions
│  └─ npm: check each version exists
├─ 3. Install packages
│  ├─ npm install attempt
│  └─ IF FAILS → LLM: analyzeAndFixError() → retry (3x)
├─ 4. Generate tests (/generate)
│  ├─ LLM: planTestStrategy() → create strategy
│  └─ LLM: generateTest() → implement tests
├─ 5. Execute tests
│  ├─ Jest: run test file
│  └─ IF FAILS → LLM: fixTest() → regenerate (5x)
└─ 6. Coverage iteration
   └─ Re-run low-coverage files until threshold met
```

**Each step has:**
- ✅ LLM reasoning with structured prompts
- ✅ Automatic error detection
- ✅ Retry loop with error context
- ✅ Fallback to safe defaults
- ✅ User visibility (logs + UI feedback)

---

## [0.5.1] - 2026-02-13

### 🚀 **MAJOR RELEASE: Complete LLM-First Architecture**

This release represents a **fundamental architectural transformation** — the extension is now a **pure orchestrator** where the LLM analyzes, decides, executes, validates, and reiterates autonomously. **Zero hardcoded logic for critical decisions.**

---

### ✨ **New LLM-First Features**

#### 1. **Intelligent Test Strategy Planning**
- `ILLMProvider.planTestStrategy()` — LLM analyzes source code and decides:
  - Test approach (unit/integration/component)
  - Mocking strategy (minimal/moderate/extensive)
  - Specific mocks needed
  - Expected coverage and potential issues
  - Estimated iterations for self-healing
- **Integration:** TestAgent now consults LLM for strategy before generating any test
- **User Visibility:** Strategy displayed to user before generation starts

#### 2. **Personalized Jest Configuration**
- `ILLMProvider.generateJestConfig()` — LLM generates project-specific configs:
  - Analyzes `package.json`, `tsconfig.json`, and existing tests
  - Detects framework (SPFx, React, Angular, Vue, etc.)
  - Creates custom `jest.config.js` tailored to detected stack
  - Generates `jest.setup.js` and custom mocks as needed
- **Integration:** `JestConfigurationService` now uses LLM for `/setup` command
- **Fallback:** Gracefully falls back to sensible defaults if LLM unavailable

#### 3. **Smart Batch Test Prioritization**
- `ILLMProvider.planBatchGeneration()` — LLM prioritizes files intelligently:
  - Groups files by dependencies and complexity
  - Prioritizes critical/foundational files first
  - Estimates total time and recommends concurrency
- **Integration:** `/generate-all` command now uses LLM to reorder files
- **Impact:** More efficient batch generation with fewer API calls

#### 4. **Automatic Dependency Version Validation**
- `ILLMProvider.validateAndFixVersions()` — LLM validates npm package versions
- Checks if suggested versions actually exist in npm registry
- Suggests alternatives when versions are invalid/deprecated

---

### 🔧 **Refactored Services (LLM-First)**

#### **DependencyDetectionService**
- **BREAKING:** Removed all hardcoded version constants
  - `JEST_DEPENDENCIES` → **deprecated** (now `JEST_DEPENDENCIES_DEPRECATED`)
  - `JEST_28_COMPATIBLE_DEPENDENCIES` → **deprecated**
- **New Flow:**
  1. LLM detects compatible versions (3 retry attempts with feedback)
  2. If LLM fails after 3 attempts → fallback to npm `"latest"`
  3. **NO hardcoded versions anywhere**
- `detectDependencies()` now accepts `previousAttempt` parameter for retry feedback

#### **JestConfigurationService**
- Constructor now accepts optional `ILLMProvider`
- `createJestConfig()` uses LLM to generate personalized configuration
- Falls back to hardcoded defaults only if LLM unavailable
- Added helper methods:
  - `buildProjectAnalysis()` — Gathers context for LLM
  - `detectRequirements()` — Determines what LLM should optimize for
  - `findTestFiles()` — Samples existing tests for pattern detection

#### **ProjectSetupService**
- Constructor now accepts optional `ILLMProvider`
- Injects LLM provider into `JestConfigurationService`
- Uses `LLMProviderFactory` if no provider specified

#### **TestAgent**
- Added `planTestStrategy()` call before `generateTest()`
- New helper methods:
  - `buildProjectAnalysis()` — Constructs `ProjectAnalysis` for LLM
  - `findExistingTestPatterns()` — Extracts patterns from existing tests
  - `detectFramework()` — Fast framework detection for analysis
- Strategy displayed to user before test generation begins

#### **handleGenerateAllRequest (ChatHandlers)**
- Added `planBatchGeneration()` call before processing files
- Files now reordered according to LLM's prioritization
- Shows batch plan to user (top 3 groups with reasoning)
- Falls back to default order if LLM planning fails

---

### 📦 **Updated Interfaces**

#### **ILLMProvider** (New Methods)
```typescript
planTestStrategy(context): Promise<TestStrategy>
generateJestConfig(context): Promise<GeneratedJestConfig>
planBatchGeneration(context): Promise<BatchGenerationPlan>
validateAndFixVersions(context): Promise<Record<string, string>>
detectDependencies(pkg, previousAttempt?): Promise<Record<string, string>>
```

#### **New Types**
- `ProjectAnalysis` — Complete project context for LLM
- `TestStrategy` — LLM's test generation plan
- `GeneratedJestConfig` — LLM-generated configuration bundle
- `BatchGenerationPlan` — Prioritized file groups with reasoning

---

### 🛠️ **Provider Implementations**

#### **CopilotProvider**
- ✅ Full implementation of all 4 new LLM-First methods
- Robust JSON extraction with fallback parsing
- Comprehensive prompts for each planning method
- Retry logic with feedback for `detectDependencies()`

#### **AzureOpenAIProvider**
- ✅ Simplified implementation of all 4 methods
- Uses Azure OpenAI SDK with proper error handling
- Compatible JSON parsing for structured outputs

---

### 🧪 **Test Updates**

- Updated `TestAgent.test.ts` — Added mocks for new interface methods
- Updated `constants.test.ts` — Now tests deprecation notices
- All test suites passing with new architecture

---

### 📝 **Documentation**

#### **New Files**
- `docs/IMPLEMENTATION-V0.5.0.md` — Complete implementation guide
- `docs/LLM-FIRST-ANALYSIS.md` — Original architectural analysis

#### **Archive**
- Moved obsolete docs to `.archive/`
- Cleaned project root of temporary files
- Removed old `.vsix` packages

---

### ⚠️ **Breaking Changes**

1. **Constants Deprecated:**
   - `JEST_DEPENDENCIES` → Use LLM-based detection
   - `JEST_28_COMPATIBLE_DEPENDENCIES` → Use LLM-based detection
   - Constants kept for reference but **NOT USED** in code

2. **Service Constructors:**
   - `ProjectSetupService(llmProvider?)` — Optional LLM provider parameter
   - `JestConfigurationService(llmProvider?)` — Optional LLM provider parameter

3. **Dependency Detection:**
   - `getCompatibleDependencies()` no longer uses hardcoded fallbacks
   - Fallback strategy: npm `"latest"` instead of hardcoded versions

---

### 🔄 **Migration Guide (v0.4.x → v0.5.0)**

#### **For Users:**
- **No action required** — Extension behavior improved automatically
- `/install` command now smarter with auto-retry and LLM healing
- `/setup` command creates personalized configs for your project
- `/generate-all` processes files in optimal order

#### **For Developers/Contributors:**
1. **Remove hardcoded version references:**
   ```typescript
   // ❌ Old (v0.4.x)
   import { JEST_DEPENDENCIES } from './utils/constants';
   const versions = JEST_DEPENDENCIES;
   
   // ✅ New (v0.5.0)
   const versions = await llmProvider.detectDependencies(packageJson);
   ```

2. **Use LLM planning methods:**
   ```typescript
   // ❌ Old: Direct generation
   const result = await llmProvider.generateTest(context);
   
   // ✅ New: Plan first, then generate
   const strategy = await llmProvider.planTestStrategy(context);
   const result = await llmProvider.generateTest(context);
   ```

3. **Update service instantiation:**
   ```typescript
   // ❌ Old
   const service = new ProjectSetupService();
   
   // ✅ New (with LLM)
   const llm = LLMProviderFactory.createProvider();
   const service = new ProjectSetupService(llm);
   
   // ✅ Also OK (auto-creates LLM)
   const service = new ProjectSetupService();
   ```

---

### 🎯 **Philosophy: LLM-First Architecture**

**Core Principle:** The extension should be a **pure orchestrator of prompts and results**, with the LLM making all strategic decisions.

**Before (v0.4.x):**
- Hardcoded Jest version strings
- Fixed configuration templates
- Sequential file processing
- Assumptions about project structure

**After (v0.5.0):**
- LLM detects compatible versions dynamically
- LLM generates project-specific configurations
- LLM prioritizes files intelligently
- LLM analyzes actual project structure

**Result:** 
- More accurate test generation
- Better compatibility across diverse projects
- Fewer hardcoded assumptions
- Truly adaptive AI assistant

---

### 📊 **Metrics**

- **Compilation:** ✅ Clean build (webpack 5.105.0)
- **Test Suite:** ✅ All tests passing
- **TypeScript:** ✅ No compilation errors
- **Architecture:** ✅ 100% LLM-First for critical decisions

---

### 🔮 **Future Work**

- [ ] LLM-powered stack discovery (replace `StackDiscoveryService` hardcoded rules)
- [ ] Real-time dependency graph analysis for batch planning
- [ ] Adaptive retry strategies based on error patterns
- [ ] Multi-provider orchestration (Copilot + Azure OpenAI hybrid)

---

## [0.4.38] - 2026-02-09

### 🔧 **Critical UX Fixes**
- **Removed blocking modal dialogs** — No more interruptions during test generation
- Users can now continue working while tests generate in background
- Progress shown via chat stream instead of modal windows

### 🐛 **Bug Fixes**
- Fixed rate limit handling during batch generation
- Improved error messages for dependency installation failures
- Fixed Jest configuration validation edge cases

---

## [0.3.3] - 2026-02-09

### 🔧 **Stability Improvements**
- Enhanced error recovery for LLM timeouts
- Better handling of workspace folder detection
- Improved logging for diagnostic purposes

---

_For older versions, see `.archive/CHANGELOG-old.md`_
