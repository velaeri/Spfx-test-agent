# SPFX Test Agent - VS Code Chat Participant Extension

A Visual Studio Code extension that provides a chat participant for SharePoint Framework (SPFx) testing assistance.

## Features

- **Chat Participant**: Interact with the SPFX Test Agent directly in VS Code's chat interface
- **SPFx Expertise**: Get help with SharePoint Framework development and testing
- **Interactive Assistance**: Ask questions and receive guidance in real-time

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

1. Open the chat panel in VS Code (View > Chat or `Ctrl+Alt+I`)
2. Type `@spfx` to invoke the SPFX Test Agent
3. Ask your questions about SharePoint Framework development and testing

Example:
```
@spfx How do I test a SPFx web part?
```

## Development

### Prerequisites

- Node.js (v18 or higher)
- VS Code (v1.85.0 or higher)
- TypeScript

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
4. Open the chat panel and test the `@spfx` participant

## Project Structure

```
├── src/
│   └── extension.ts         # Main extension file with chat participant
├── .vscode/
│   ├── launch.json          # Debug configuration
│   └── tasks.json           # Build tasks
├── package.json             # Extension manifest and dependencies
├── tsconfig.json            # TypeScript configuration
├── webpack.config.js        # Webpack bundling configuration
└── README.md                # This file
```

## Contributing

This extension is designed to be customized with specific logic for SPFx testing assistance. The main logic is in `src/extension.ts` in the `generateResponse()` function.

## License

This project is open source and available under the MIT License.

## Notes

The current implementation provides a basic chat participant structure. The specific logic for handling SPFx-related queries will be implemented based on future requirements.