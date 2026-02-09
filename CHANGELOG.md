# Changelog

## [0.3.3] - 2026-02-09

### 🔧 Correcciones Críticas de UX

#### Eliminados Diálogos Modales Bloqueantes
- ❌ **Removido**: `vscode.window.showWarningMessage` que bloqueaba el flujo del chat
- ✅ **Ahora**: Todo el flujo es automático dentro del chat
- 🚀 **Resultado**: El usuario solo interactúa con el chat, sin modales inesperados

#### Detección Inteligente de Proyectos
- 🔍 **Busca automáticamente**: Proyectos Node.js (package.json) en todo el workspace
- 📁 **Múltiples proyectos**: Lista todos los encontrados y muestra cuál tiene Jest
- 🎯 **Selección automática**: Usa el primer proyecto encontrado
- ⚠️ **Error claro**: Si no encuentra package.json, sugiere abrir la carpeta correcta

#### Setup Automático Sin Confirmación
- ✨ **`/setup`**: Instala automáticamente sin pedir confirmación
- ✨ **`/generate` y `/generate-all`**: Ejecutan setup automáticamente si es necesario
- 📊 **Progreso visible**: Mensajes claros durante la instalación
- 💡 **Sin interrupciones**: El usuario solo ve el progreso en el chat

### 🐛 Bugs Corregidos
- Error "No se encontró package.json" cuando el workspace era la extensión misma
- Diálogos modales que aparecían fuera del contexto del chat
- Flujo confuso con múltiples ventanas de confirmación

## [0.3.2] - 2026-02-09

### ✨ Nuevo Comando: `/setup`

#### Comando Dedicado de Setup
- 🎯 **`@spfx-tester /setup`**: Nuevo comando para configurar el entorno Jest manualmente
- 📊 **Estado detallado**: Muestra qué está instalado y qué falta
- 🔧 **Configuración completa**: Instala dependencias y crea archivos de configuración
- ✅ **Feedback claro**: Indica si el entorno ya está configurado

#### Integración Automática
- 🚀 **`/generate` y `/generate-all` usan `/setup` automáticamente**: Si detectan entorno incompleto
- 💡 **Sugerencia visible**: Los comandos sugieren usar `/setup` manualmente
- 🔄 **Helper reutilizable**: `ensureJestEnvironment()` centraliza la lógica

#### Mejoras de UX
- 📋 **Lista todas las dependencias** que se van a instalar
- ⏱️ **Progreso visible** durante instalación
- 🎨 **Diálogo simplificado**: Solo "Sí, Instalar Ahora" o "Cancelar"

### 📝 Comandos Disponibles
```
@spfx-tester /setup         - Configura el entorno Jest
@spfx-tester /generate      - Genera test para archivo actual
@spfx-tester /generate-all  - Genera tests para todo el workspace
```

## [0.3.1] - 2026-02-09

### 🔧 Setup Automático Mejorado

#### Verificación Proactiva
- ✨ **Verifica el entorno Jest al inicio**: Detecta dependencias faltantes antes de generar tests
- 🎯 **Verificación única en /generate-all**: Se hace una vez al principio, no por cada archivo
- 📋 **Lista de dependencias**: Muestra qué se va a instalar antes de hacerlo

#### Diálogo Mejorado
- 💬 **Modal más claro**: Opciones explícitas ("Sí, Instalar Ahora", "Mostrar Detalles", "Cancelar")
- 📊 **Información detallada**: Muestra estado de Jest y cantidad de dependencias faltantes
- ⏱️ **Progreso visible**: Mensajes durante la instalación

#### Correcciones
- 🐛 Diálogo que se perdía en generación de múltiples archivos
- 🐛 Manejo correcto cuando el usuario cierra el diálogo sin seleccionar
- 🐛 Eliminada verificación duplicada en TestAgent

## [0.3.0] - 2026-02-09

### 🌍 Internacionalización y UX

#### Mensajes en Castellano
- ✨ **Interfaz de chat en español**: Todos los mensajes de la extensión ahora están en castellano
- 📋 Mensajes de progreso traducidos
- ⚠️ Errores y advertencias en español
- 💡 Consejos y sugerencias localizadas

#### Modelo de LLM Flexible
- 🎯 **Usa el modelo seleccionado por el usuario**: Ya no fuerza GPT-4
- ⚙️ Setting `llmFamily` ahora vacío por defecto (usa modelo activo del usuario)
- 📊 Logs muestran qué modelo se está usando
- 🔄 Compatible con cualquier modelo disponible en Copilot

#### Limpieza de Documentación
- 🧹 **Solo documentación esencial**: README.md, CHANGELOG.md, LICENSE
- 🗑️ Eliminados archivos temporales de desarrollo
- 📦 Package más limpio y pequeño
- ✅ .vscodeignore actualizado para excluir documentos innecesarios

### 🔧 Technical Changes
- Modified `CopilotProvider` constructor to accept optional `family` parameter
- Empty `family` string uses user's currently selected model
- Updated `selectChatModels` calls to be dynamic
- All user-facing messages translated to Spanish
- Removed 11 documentation files from package

### 📝 User Experience
- Logs now show model ID and name being used
- Better error message when LLM is not available
- Clearer indication of which model is active

## [0.2.0] - 2026-02-09

### 🎉 Major New Features

#### Automated Project Setup
- ✨ **ProjectSetupService**: New service that validates and configures Jest environment
  - Checks for missing dependencies (Jest, Testing Library, ts-jest, etc.)
  - Automatically installs all required packages with correct versions
  - Creates jest.config.js with optimal SPFx configuration
  - Creates jest.setup.js for @testing-library/jest-dom
  - Creates __mocks__ directory for static assets
  - Updates package.json with test scripts (test, test:watch, test:coverage)
  
- 🔍 **Pre-generation Validation**: Agent now checks project setup before generating tests
  - Shows clear warnings when dependencies are missing
  - Offers "Setup Now", "Show Details", or "Continue Anyway" options
  - Progress notifications during installation
  
- 📋 **New Commands**:
  - `SPFX Test Agent: Setup Jest Environment` - Run setup manually
  - `SPFX Test Agent: Check Jest Environment Setup` - View current setup status

#### Required Dependencies Auto-Install
Automatically installs (if missing):
- jest ^29.7.0
- @types/jest ^29.5.11
- ts-jest ^29.1.1
- @testing-library/react ^14.1.2
- @testing-library/jest-dom ^6.1.5
- @testing-library/user-event ^14.5.1
- react-test-renderer ^17.0.1
- @types/react-test-renderer ^17.0.1
- identity-obj-proxy ^3.0.0

### 🔧 Technical Improvements
- Integrated setup validation into test generation workflow
- Better error messages for missing project configuration
- Workspace-aware setup (uses first workspace folder)

### 📝 User Experience
- Clear progress indicators during setup
- Modal dialogs with detailed status information
- Option to continue without setup (for advanced users)
- Command palette integration for manual setup

## [0.1.1] - 2026-02-09

### 🐛 Critical Fixes

#### Mock Generation - Babel Syntax Error
- 🔧 **Fixed TypeScript in jest.mock()**: Resolved SyntaxError caused by type annotations in mock factory functions
- 📋 **Enhanced System Prompt**: Added "CRITICAL MOCK RULES" section with explicit instructions
  - Prohibits TypeScript type annotations inside `jest.mock()` callbacks
  - Provides correct and incorrect examples
  - Explains Babel/Jest transformation limitations
- 🎯 **Improved Fix Prompt**: Added automatic error pattern detection
  - Detects SyntaxError + mock + type annotation pattern
  - Provides specific fix guidance for this common issue
  - Shows exact before/after code examples

### 📝 Technical Details
- Modified `CopilotProvider.buildSystemPrompt()` to prevent LLM from generating invalid mock syntax
- Enhanced `CopilotProvider.buildFixPrompt()` with pattern detection and targeted fix instructions
- Error patterns detected: SyntaxError, jest.mock references, TypeScript type annotations

## [0.1.0] - 2026-02-09

### 🎉 Nuevas Funcionalidades

#### Generación de Tests en Lote
- ✨ **Nuevo comando `generate-all`**: Genera tests para todos los archivos .ts/.tsx en el workspace
- 🔍 **Escaneo inteligente**: Detecta automáticamente archivos sin tests
- 📁 **Multi-proyecto**: Agrupa archivos por proyecto (detectando package.json)
- ⏸️ **Rate limiting inteligente**: Espera 2 segundos entre archivos para evitar límites de API
- 📊 **Reporte de progreso**: Muestra [X/Y] archivos procesados en tiempo real
- ✅ **Resumen final**: Estadísticas de éxito/fallo al finalizar

#### Mejoras en Jest Execution
- 🎯 **Detección de project root**: Busca el package.json más cercano al archivo de test
- ⚙️ **Jest sin config**: Funciona sin jest.config.js (usa --passWithNoTests)
- 🔧 **Flags inteligentes**: Agrega --testEnvironment=node cuando no hay config
- 📂 **Multi-folder workspace**: Soporte para workspaces con múltiples carpetas

### 🐛 Correcciones de Bugs

- ✅ **Error "Could not find a config file"**: Solucionado usando project root en lugar de workspace root
- ✅ **"No active editor found"**: Ahora sugiere usar `/generate-all` cuando no hay archivo abierto
- ✅ **Multi-project detection**: Detecta correctamente proyectos anidados

### 🏗️ Arquitectura

#### Nuevos Archivos
- `src/utils/FileScanner.ts` - Utilidades para escanear workspace y detectar proyectos

#### Funcionalidades de FileScanner
- `findSourceFiles()` - Encuentra todos los .ts/.tsx (excluyendo tests y node_modules)
- `findClosestPackageJson()` - Busca package.json subiendo en el árbol de directorios
- `findProjectRoot()` - Detecta la raíz del proyecto
- `hasTestFile()` - Verifica si un archivo ya tiene tests
- `filterFilesWithoutTests()` - Filtra archivos que necesitan tests
- `groupFilesByProject()` - Agrupa archivos por proyecto para mejor ejecución

### 📝 Comandos

#### `@spfx-tester generate` (Original)
Genera test para el archivo actualmente abierto en el editor.

**Uso:**
1. Abre un archivo `.ts` o `.tsx`
2. Abre Copilot Chat
3. Escribe `@spfx-tester generate`

#### `@spfx-tester /generate-all` (Nuevo)
Genera tests para todos los archivos del workspace.

**Uso:**
1. Abre Copilot Chat
2. Escribe `@spfx-tester /generate-all`
3. Espera el escaneo y confirmación
4. Observa el progreso en tiempo real

**Características:**
- Escanea todos los workspaces
- Filtra archivos con tests existentes
- Agrupa por proyecto
- Delay de 2s entre archivos
- Cancelable en cualquier momento
- Continúa con el siguiente archivo si uno falla

### ⚙️ Configuración

Sin cambios en configuraciones existentes. Todas las 11 configuraciones previas siguen disponibles.

### 🔧 Mejoras Internas

#### TestRunner
- Usa `projectRoot` en lugar de `workspaceRoot` para ejecutar Jest
- Detecta automáticamente presencia de jest.config
- Agrega flags apropiados según configuración del proyecto
- Mejor logging de paths y configuraciones

#### Extension
- Refactorizado en tres funciones:
  - `handleChatRequest()` - Router principal
  - `handleGenerateSingleRequest()` - Archivo único (original)
  - `handleGenerateAllRequest()` - Batch processing (nuevo)
- Mejor manejo de errores por comando
- Mensajes más informativos

### 📊 Ejemplo de Uso

```bash
# Workspace con estructura:
project-root/
├── spfx-project-1/
│   ├── package.json
│   └── src/
│       ├── Component1.tsx      # Necesita test
│       └── Component2.tsx      # Necesita test
└── spfx-project-2/
    ├── package.json
    └── src/
        └── Component3.tsx      # Necesita test

# Resultado con /generate-all:
# 🚀 Generating Tests for Entire Workspace
# Found 3 source files
# 3 files need tests
# 📁 Found 2 project(s)
#
# ### Project: spfx-project-1
# [1/3] Component1.tsx
# ✅ Success
# [2/3] Component2.tsx
# ✅ Success
#
# ### Project: spfx-project-2
# [3/3] Component3.tsx
# ✅ Success
#
# 📊 Summary
# - ✅ Successfully generated: 3 tests
# - ❌ Failed: 0 tests
# - 📝 Total processed: 3 files
```

### 🚀 Actualización

Para actualizar desde v0.0.1:

```bash
# Desinstalar versión anterior
code --uninstall-extension velaeri.spfx-test-agent

# Instalar nueva versión
code --install-extension spfx-test-agent-0.1.0.vsix
```

### 🔮 Próximas Versiones

Planeado para v0.2.0:
- [ ] Configuración de exclusiones personalizadas
- [ ] Comando para regenerar tests existentes
- [ ] Estimación de tiempo para batch generation
- [ ] Pausa/Resume de batch generation
- [ ] UI para ver historial de generaciones
- [ ] Soporte para patrones de test personalizados

---

## [0.0.1] - 2026-02-09

### 🎉 Lanzamiento Inicial

- ✨ Generación automática de tests para SPFx
- 🔄 Self-healing con hasta 3 intentos
- 📊 Sistema de logging estructurado
- ⚙️ 11 configuraciones personalizables
- 🔒 Validación de seguridad
- 💾 Estado persistente con historial
- 🏗️ Arquitectura modular con LLM provider abstraction
- 📦 Sistema de errores custom
- 🎯 Manejo de errores mejorado con guías

Ver `IMPROVEMENTS.md` para detalles completos de la arquitectura inicial.
