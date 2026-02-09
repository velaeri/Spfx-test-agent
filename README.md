# SPFX Test Agent - Agentic Workflow Extension

Extensión de Visual Studio Code que implementa un **workflow agéntico autónomo** para generación automática de tests unitarios en proyectos SharePoint Framework (SPFx). No es un simple asistente de chat—es un agente auto-reparable que genera tests, los ejecuta y corrige errores automáticamente.

## ✨ Novedades en v0.3.0

### 🌍 Interfaz en Castellano
- Todos los mensajes ahora en español
- Errores, advertencias y consejos localizados
- Mejor experiencia para usuarios hispanohablantes

### 🎯 Modelo Flexible
- **Usa tu modelo seleccionado**: Ya no fuerza GPT-4
- Compatible con cualquier modelo disponible en Copilot
- Configuración automática del modelo del usuario

### 📦 Versión Anterior (v0.2.0)
- Auto-instalación de dependencias Jest
- Configuración automática de proyecto
- Generación por lotes de tests

## Características

### Capacidades Principales
- **🤖 Generación Autónoma**: Crea tests Jest completos para componentes SPFx automáticamente
- **🔄 Auto-Reparación**: Ejecuta tests, analiza fallos y los corrige iterativamente (hasta 3 intentos)
- **🧠 Powered by AI**: Usa GitHub Copilot para generación inteligente de código
- **🎯 Optimizado para SPFx**: Conocimiento built-in de patrones SharePoint Framework

### Características v0.3.0
- **🌍 Interfaz en Castellano**: Mensajes, errores y ayudas en español
- **🎯 Modelo Dinámico**: Usa el modelo que tengas seleccionado en Copilot
- **📦 Auto-Setup**: Detecta dependencias faltantes y las instala automáticamente
- **🔧 Configuración Inteligente**: Crea jest.config.js óptimo para SPFx
- **📋 Comandos Manuales**: Setup de Jest via Command Palette
- **🔍 Generación Masiva**: Genera tests para todo el workspace con `@spfx-tester generate-all`

### Características Técnicas
- **🧹 Parsing Inteligente**: Limpia output de Jest reduciendo ruido
- **⚡ Progreso en Tiempo Real**: Observa el agente trabajar via chat
- **🛡️ Seguridad**: Usa spawn en lugar de exec para prevenir inyección
- **📊 Gestión de Estado**: Rastrea historial de generación
- **🎨 Configurable**: 11+ settings para personalizar comportamiento

## Requisitos

- **VS Code**: Version 1.85.0 o superior
- **GitHub Copilot**: Debe estar instalado y activado
- **Node.js**: v18 o superior
- **Jest**: ~~Debe estar instalado~~ → **¡Ahora se auto-instala!** 🎉

## Instalación

### Desde Código Fuente

1. Clona este repositorio
2. Instala dependencias:
   ```bash
   npm install
   ```
3. Compila la extensión:
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
