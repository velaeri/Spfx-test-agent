# FASE 1 — Auditoría de la Extensión SPFx Test Agent

> Fecha: 2026-02-13  
> Estado: Auditoría completada. Pendiente implementación de mejoras.

---

## 1. Evidencia Revisada

| Módulo | Función | Estado |
|---|---|---|
| `src/extension.ts` | Entry point, Chat Participant, comandos `/setup`, `/generate-all` | ✅ Funcional |
| `src/ChatHandlers.ts` | Orquesta setup, generate-single, generate-all, manejo de errores | ✅ Funcional |
| `src/agent/TestAgent.ts` | Workflow agéntico: generate → run → heal loop | ✅ Funcional |
| `src/utils/TestRunner.ts` | Ejecución segura de Jest con validación de paths y auto-install ts-jest | ✅ Funcional |
| `src/utils/FileScanner.ts` | Descubrimiento de archivos TS/TSX en workspace | ✅ Funcional |
| `src/utils/SourceContextCollector.ts` | Resolución de imports, detección de patrones SPFx | ✅ Existe, ❌ NO SE USA |
| `src/utils/JestLogParser.ts` | Parser de output Jest (clean, summary, extractErrors) | ✅ Funcional |
| `src/utils/GenerationMode.ts` | Modos fast/balanced/thorough con config de intentos | ✅ Funcional |
| `src/utils/constants.ts` | Versiones fallback de dependencias Jest 28/29 | ✅ Funcional |
| `src/utils/prompts.ts` | Prompts SYSTEM, GENERATE_TEST, FIX_TEST para LLM | ⚠️ Hardcoded SPFx |
| `src/utils/QueueCommands.ts` | Comandos de cola: pause/resume/skip/cancel/retry | ✅ Funcional |
| `src/services/ProjectSetupService.ts` | Verificar y crear configs Jest en proyecto target | ✅ Funcional |
| `src/services/DependencyDetectionService.ts` | Detección de deps con LLM + heurística fallback | ✅ Funcional |
| `src/services/JestConfigurationService.ts` | Crear/validar jest.config.js con ts-jest | ✅ Funcional |
| `src/services/PackageInstallationService.ts` | npm install con --legacy-peer-deps | ✅ Funcional |
| `src/services/QueueService.ts` | Cola persistente con pause/resume/state | ✅ Funcional |
| `src/services/ConfigService.ts` | Settings de la extensión con cache | ✅ Funcional |
| `src/services/StateService.ts` | Persistencia workspace/global state (historial) | ✅ Funcional |
| `src/services/CacheService.ts` | Cache in-memory con TTL | ✅ Funcional |
| `src/services/Logger.ts` | Output channel logging multi-nivel | ✅ Funcional |
| `src/services/TelemetryService.ts` | Telemetría anónima de uso | ✅ Funcional |
| `src/providers/CopilotProvider.ts` | LLM via VS Code Language Model API | ✅ Funcional |
| `src/providers/AzureOpenAIProvider.ts` | LLM via Azure OpenAI SDK | ✅ Funcional |
| `src/interfaces/ILLMProvider.ts` | Interfaz: generateTest, fixTest, detectDependencies, analyzeAndFixError | ✅ Definida |
| `src/factories/LLMProviderFactory.ts` | Factory para selección de provider según config | ✅ Funcional |
| `src/errors/CustomErrors.ts` | Jerarquía de errores custom (Security, RateLimit, etc.) | ✅ Funcional |

---

## 2. Gaps Críticos (ordenados por impacto)

### G1 — Sin medición de cobertura (🔴 CRÍTICO)

- **Problema**: La extensión genera tests y verifica si pasan (`TestRunner.runTest()`), pero NUNCA mide cobertura. No existe ningún servicio ni lógica que ejecute Jest con `--coverage` y parsee los resultados.
- **Impacto**: Es IMPOSIBLE saber si se alcanzó ≥80% de cobertura. El usuario no tiene feedback cuantitativo.
- **Dónde falta**: No existe `CoverageService`. `TestRunner` usa `--no-coverage` hardcoded.
- **Solución**: Crear `CoverageService` que ejecute Jest con `--coverage --coverageReporters=json-summary`, parsee `coverage-summary.json`, y devuelva métricas por archivo y globales.

### G2 — Sin descubrimiento de stack (🔴 CRÍTICO)

- **Problema**: La extensión asume que TODO proyecto es SPFx. El prompt SYSTEM dice "SPFx testing", las dependencias detectadas son siempre las de Jest para SPFx, y la estrategia de mocks es solo para `@microsoft/sp-*`.
- **Impacto**: Para proyectos que no son SPFx (Node puro, React apps, VS Code extensions, Angular, etc.), genera tests con mocks incorrectos y referencias a APIs que no existen.
- **Dónde falta**: No hay servicio de detección de stack. `DependencyDetectionService` solo detecta versiones de Jest.
- **Solución**: Crear `StackDiscoveryService` que analice `package.json`, configs (`angular.json`, `.eslintrc`, `vite.config.*`, etc.), estructura de carpetas → clasifique el proyecto (SPFx, React, Node, Angular, VSCode ext, etc.) y su toolchain.

### G3 — SourceContextCollector existe pero NO se usa (🟡 ALTO)

- **Problema**: `SourceContextCollector` puede resolver imports locales, leer tsconfig, detectar patrones SPFx, y construir un contexto completo para el LLM. **Pero `TestAgent.generateAndHealTest()` no lo llama.**
- **Impacto**: El LLM genera tests sin ver las dependencias del archivo (interfaces, tipos, clases base, helpers). Esto causa mocks incorrectos que el healing loop intenta arreglar iterativamente.
- **Dónde falta**: `TestAgent.ts` línea ~132 — llama directamente a `llmProvider.generateTest({ sourceCode, fileName })` sin dependency context.
- **Solución**: Integrar `SourceContextCollector.collectContext()` en `TestAgent` y pasar el contexto al prompt del LLM.

### G4 — Prompts hardcoded para SPFx (🟡 ALTO)

- **Problema**: `prompts.ts` tiene el SYSTEM prompt hardcoded con "SharePoint Framework (SPFx) testing", `@microsoft/sp-*`, `@fluentui/react`, y reglas específicas de SPFx.
- **Impacto**: Para proyectos no-SPFx, el LLM sigue generando mocks de SPFx que dan errores.
- **Dónde falta**: `src/utils/prompts.ts` — todo el archivo.
- **Solución**: Hacer prompts dinámicos que reciban el stack detectado (G2) y adapten las instrucciones (imports, mocks, patrones de test).

### G5 — Sin iteración guiada por cobertura (🔴 CRÍTICO)

- **Problema**: `/generate-all` procesa los archivos sin test, genera uno por archivo, y para. No mide si la cobertura es suficiente ni vuelve a generar donde falta.
- **Impacto**: No hay bucle "medir → generar → medir" que garantice ≥80%.
- **Dónde falta**: `ChatHandlers.ts` → `handleGenerateAllRequest()`.
- **Solución**: Tras cada oleada de generación, ejecutar coverage global → identificar archivos bajo threshold → regenerar/extender tests → repetir hasta target.

### G6 — FIX_TEST perdió `currentTestCode` (🟡 MEDIO)

- **Problema**: El refactor de `prompts.ts` cambió `FIX_TEST` de 7 args a 5 args, eliminando el parámetro `currentTestCode`. Ahora cuando el LLM intenta arreglar un test fallido, no ve el código del test actual — solo ve el error y el source original.
- **Impacto**: El LLM tiene que regenerar el test desde cero en vez de corregir el existente. Menos eficiente y más propenso a errores nuevos.
- **Dónde falta**: `src/utils/prompts.ts` → `FIX_TEST`, `src/agent/TestAgent.ts` → llamada a `fixTest()`.
- **Solución**: Restaurar `currentTestCode` como parámetro de `FIX_TEST` y pasar `fs.readFileSync(testFilePath)` en la llamada.

---

## 3. Plan de Cambios (Must / Should / Nice)

### MUST — Sin estos no se cumple la misión

| ID | Cambio | Archivos | Riesgo | Depende de |
|---|---|---|---|---|
| **M1** | **CoverageService**: ejecutar Jest con `--coverage`, parsear `coverage-summary.json`, devolver métricas por archivo y globales | Nuevo: `src/services/CoverageService.ts` | Bajo | — |
| **M2** | **StackDiscoveryService**: analizar `package.json`, configs, estructura → detectar framework, runner, UI lib, TS vs JS | Nuevo: `src/services/StackDiscoveryService.ts` | Bajo | — |
| **M3** | **Prompts dinámicos**: el SYSTEM prompt se adapta al stack detectado (SPFx, Node, React, Angular, VSCode ext, etc.) | Modificar: `src/utils/prompts.ts` | Medio | M2 |
| **M4** | **Integrar SourceContextCollector** en `TestAgent`: pasar dependency context al LLM para generación más precisa | Modificar: `src/agent/TestAgent.ts` | Bajo | — |
| **M5** | **Coverage-driven loop** en `handleGenerateAllRequest`: tras generar, medir cobertura → si < target → priorizar archivos sin cobertura → repetir | Modificar: `src/ChatHandlers.ts` | Medio | M1 |
| **M6** | **Restaurar `currentTestCode`** en prompt `FIX_TEST` para que el LLM corrija el test existente en vez de regenerar | Modificar: `src/utils/prompts.ts`, `src/agent/TestAgent.ts` | Bajo | — |

### SHOULD — Mejoran significativamente la experiencia

| ID | Cambio | Archivos | Riesgo |
|---|---|---|---|
| **S1** | Dashboard de cobertura en chat: tabla por archivo con % statements/branches/lines y delta respecto a iteración anterior | `src/ChatHandlers.ts` | Bajo |
| **S2** | Priorización por ROI de cobertura: archivos con más líneas uncovered primero, no orden alfabético | `src/ChatHandlers.ts` | Bajo |
| **S3** | Soporte para `coverageThreshold` configurable en settings de la extensión | `src/services/ConfigService.ts` | Bajo |

### NICE — Mejoras opcionales

| ID | Cambio | Archivos | Riesgo |
|---|---|---|---|
| **N1** | Soporte multi-runner (Vitest además de Jest) | Varios | Alto |
| **N2** | Generación automática de scripts CI (`npm test` en GitHub Actions / Azure Pipelines) | Nuevo servicio | Bajo |
| **N3** | Detección de flakiness: ejecutar cada test 3x y marcar inconsistentes | `TestRunner.ts` | Medio |

---

## 4. Orden de Implementación Propuesto

```
Fase 1: Fundamentos de detección
  M2 → StackDiscoveryService (independiente)
  M1 → CoverageService (independiente)
  M4 → Integrar SourceContextCollector (independiente)
  M6 → Restaurar currentTestCode en FIX_TEST (independiente)

Fase 2: Inteligencia adaptativa
  M3 → Prompts dinámicos (depende de M2)

Fase 3: Loop de cobertura
  M5 → Coverage-driven loop (depende de M1, M3)
  S1 → Dashboard de cobertura (depende de M1)
  S2 → Priorización ROI (depende de M1)
```

---

## 5. Estado Actual del Código

### Cambios uncommitted (refactor v0.5.0 del usuario + fixes de compilación):
- `src/ChatHandlers.ts` — refactor del handler con targetPath param
- `src/agent/TestAgent.ts` — refactor del workflow agéntico
- `src/providers/AzureOpenAIProvider.ts` — adaptado a nuevo API de prompts
- `src/providers/CopilotProvider.ts` — adaptado a nuevo API de prompts
- `src/utils/prompts.ts` — simplificación de prompts (GENERATE_TEST 2-arg, FIX_TEST 5-arg)

### Archivos no trackeados (ignorados o sin commitear):
- `jest.config.js`, `tsconfig.test.json`, `src/__mocks__/vscode.ts` — infra de test de la propia extensión (puede eliminarse si no se necesita)
- `COMPILE-GUIDE.md`, `EXECUTIVE-SUMMARY.md`, `IMPLEMENTATION-V0.5.0.md`, `PHASE-4-5-6-PROGRESS.md` — documentación del refactor

### Compilación: ✅ Limpia (`npx tsc --noEmit` sin errores)

---

## 6. Notas para Próxima Sesión

- Comenzar por M2 (StackDiscoveryService) y M1 (CoverageService) en paralelo — son independientes
- M4 y M6 son quick wins que se pueden hacer en 5 min cada uno
- M3 (prompts dinámicos) es el cambio más delicado — necesita el resultado de M2
- M5 (coverage loop) es el cambio más complejo — es la pieza que cierra el bucle agéntico
- La extensión compila limpio, no hay tests del propio repo (los *.test.ts están gitignored)
