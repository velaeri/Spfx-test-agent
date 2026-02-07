# SPFX Test Agent - Agentic Workflow Extension

A Visual Studio Code extension that implements an **autonomous agentic workflow** for automated unit test generation in SharePoint Framework (SPFx) projects. This is not a simple chat assistant—it's a self-healing agent that generates tests, runs them, and automatically fixes errors.

## Features

- **🤖 Autonomous Test Generation**: Automatically creates comprehensive Jest unit tests for SPFx components
- **🔄 Self-Healing Loop**: Runs tests, analyzes failures, and iteratively fixes them (up to 3 attempts)
- **🧠 GPT-4 Powered**: Uses GitHub Copilot's GPT-4 model for intelligent code generation
- **🎯 SPFx-Optimized**: Built-in knowledge of SharePoint Framework patterns and best practices
- **🧹 Smart Error Parsing**: Cleans Jest output to reduce noise and token usage
- **⚡ Real-time Progress**: Watch the agent work through the chat interface

## Architecture

The extension implements an agentic workflow with three main components:

### 1. TestAgent (Core Logic)
- Orchestrates the test generation and healing loop
- Interfaces with GPT-4 via `vscode.lm.selectChatModels`
- Implements exponential backoff for rate limiting
- Manages up to 3 self-healing attempts

### 2. TestRunner (Execution)
- Wraps `child_process.exec` to run Jest tests
- Captures test output for analysis
- Validates Jest availability in the project

### 3. JestLogParser (Intelligence)
- Removes ANSI color codes from output
- Filters out noise from node_modules
- Extracts relevant error messages and stack traces
- Reduces token consumption when communicating with LLM

## Prerequisites

- **VS Code**: Version 1.85.0 or higher
- **GitHub Copilot**: Must be installed and activated
- **Node.js**: v18 or higher
- **Jest**: Must be installed in your SPFx project

## Installation

### From Source

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile the extension:
   ```bash
   npm run compile
   ```
4. Press F5 to open a new VS Code window with the extension loaded

## Usage

### Generating Tests

1. Open an SPFx component file (e.g., `MyWebPart.tsx`)
2. Open the chat panel in VS Code (View > Chat or `Ctrl+Alt+I`)
3. Type `@spfx-tester generate`
4. Watch the agent work:
   - 📖 Reads your source code
   - 🧠 Generates initial test using GPT-4
   - ✅ Runs the test with Jest
   - 🔄 If failed, analyzes errors and regenerates (up to 3 times)
   - 📝 Opens the final test file for you

### Example Workflow

```
You: @spfx-tester generate

Agent: 🚀 Generating Tests for MyWebPart.tsx
       Using agentic workflow with self-healing capabilities...
       
       ✅ Generated test file: MyWebPart.test.tsx
       Running test...
       
       ⚠️ Test failed on attempt 1. Analyzing errors...
       Error Summary: 1 failed, 0 passed
       
       🔄 Updated test file (attempt 2)
       Running test again...
       
       ✅ Test passed successfully!
       Final Results: 5 passed, 5 total
       
       📝 Test file opened: MyWebPart.test.tsx
```

## How It Works

### The Agentic Loop

```
1. Read Source Code
   ↓
2. Generate Test (GPT-4)
   ↓
3. Save Test File
   ↓
4. Run Jest
   ↓
5. Test Passed? → YES → ✅ Done
   ↓ NO
6. Parse Error (Clean)
   ↓
7. Attempts < 3? → YES → Back to Step 2 (with error context)
   ↓ NO
8. ❌ Report Final Status
```

### System Prompt (Built-in SPFx Knowledge)

The agent uses a specialized system prompt that includes:
- SPFx-specific mocking patterns (`@microsoft/sp-*`)
- Preference for React Testing Library over Enzyme
- TypeScript strict typing requirements
- Jest best practices
- Mock patterns for SharePoint context

## Development

### Building

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch

# Package for production
npm run package
```

### Debugging

1. Open the project in VS Code
2. Press F5 to start debugging
3. A new VS Code window will open with the extension loaded
4. Open an SPFx project in the new window
5. Open a component file and invoke `@spfx-tester generate`

## Project Structure

```
├── src/
│   ├── extension.ts              # Entry point, chat participant registration
│   ├── agent/
│   │   └── TestAgent.ts          # Core agentic loop logic
│   └── utils/
│       ├── TestRunner.ts         # Jest execution wrapper
│       └── JestLogParser.ts      # Error parsing and cleaning
├── .vscode/
│   ├── launch.json               # Debug configuration
│   └── tasks.json                # Build tasks
├── package.json                  # Extension manifest
├── tsconfig.json                 # TypeScript configuration
├── webpack.config.js             # Webpack bundling
└── README.md                     # This file
```

## Technical Details

### Model Selection

The extension explicitly uses GPT-4 via Copilot:
```typescript
const models = await vscode.lm.selectChatModels({
    vendor: 'copilot',
    family: 'gpt-4'
});
```

This ensures the highest quality code generation for complex test scenarios.

### Error Handling

- **Rate Limiting**: Exponential backoff (1s, 2s, 3s)
- **Missing Dependencies**: Clear error messages with installation instructions
- **Model Unavailable**: Validates GitHub Copilot is installed
- **Jest Errors**: Parses and cleans output for better LLM understanding

### Token Optimization

The JestLogParser reduces token usage by:
- Removing ANSI escape codes (~20% reduction)
- Filtering node_modules stack traces (~40% reduction)
- Extracting only relevant error messages (~60% reduction)
- Truncating to 1500 characters max

## Limitations

- Maximum 3 self-healing attempts per test
- Requires GitHub Copilot subscription
- Only supports TypeScript/TSX files
- Requires Jest to be configured in the project

## Troubleshooting

### "Jest is not installed"
```bash
npm install --save-dev jest @types/jest ts-jest
```

### "No GPT-4 model available"
- Ensure GitHub Copilot extension is installed
- Verify you're signed in to GitHub Copilot
- Check your Copilot subscription is active

### "Test keeps failing"
The agent will try 3 times. If it still fails:
1. Review the generated test manually
2. Check for missing dependencies or mocks
3. Ensure your source code follows SPFx patterns

## Contributing

This extension uses a modular architecture. To add new features:

1. **New Test Types**: Extend `TestAgent.buildSystemPrompt()`
2. **Better Parsing**: Enhance `JestLogParser.cleanJestOutput()`
3. **Alternative Runners**: Implement interface in `TestRunner.ts`

## License

This project is open source and available under the MIT License.

## Acknowledgments

Built with:
- VS Code Extension API
- GitHub Copilot Language Model API
- Jest Testing Framework
- TypeScript
