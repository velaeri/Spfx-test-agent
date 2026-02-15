# Pipeline Operativo — Algoritmo de Generación de Tests

> Algoritmo paso a paso para la extensión. Cada fase tiene entradas, salidas, gates y stop conditions.

---

## Inputs del Pipeline

| Input | Descripción | Obligatorio |
|-------|-------------|-------------|
| `repoPath` | Ruta del repo objetivo o workspace actual | Sí |
| `localRules` | Reglas locales del repo (si existen: `.testrc`, config custom) | No |
| `limits.maxTime` | Timeout global en ms (default: 300000 = 5 min) | No |
| `limits.maxIterations` | Máx iteraciones de repair loop por archivo (default: 3) | No |
| `limits.maxFilesPerRun` | Máx archivos a generar en una ejecución batch (default: 50) | No |
| `mode` | `execution-capable` (puede correr tests) o `dry-run` (solo genera) | Sí |

---

## Fase 0 — Repo Inspection

**Objetivo**: Descubrir stack tecnológico, tooling, rutas relevantes y scripts.

### Entradas
- `repoPath`

### Proceso
1. Leer `package.json` → `dependencies`, `devDependencies`, `scripts`
2. Detectar framework: SPFx / React / Angular / Vue / Next / Express / Node / VS Code Extension
3. Detectar test runner: Jest / Vitest / Mocha / Jasmine
4. Detectar UI library: React / Angular / Vue / Svelte / none
5. Detectar component library: Fluent UI / MUI / Ant Design / none
6. Detectar module system: CommonJS / ESM / mixed
7. Localizar rutas críticas:
   - `src/` (source root)
   - Config files: `tsconfig.json`, `jest.config.*`, `vitest.config.*`
   - Mocks existentes: `__mocks__/`, `src/__mocks__/`
   - Helpers existentes: `__testHelpers__/`, `test/helpers/`
   - Test patterns existentes (glob `**/*.test.{ts,tsx,js,jsx}`)
8. Leer scripts de test: `npm test`, `npm run test:coverage`

### Salidas
```typescript
interface RepoInspection {
    stack: ProjectStack;            // framework, language, testRunner, etc.
    paths: {
        sourceRoot: string;
        testConfigPath: string | null;
        mockDirs: string[];
        helperDirs: string[];
        existingTestFiles: string[];
        sourceFiles: string[];
    };
    scripts: {
        test: string | null;
        coverage: string | null;
        lint: string | null;
    };
    hasSetupFile: boolean;
    existingCoverageConfig: any | null;
}
```

### Gate
- Si no se detecta `package.json` → ABORT con error explícito.
- Si no se detecta test runner → marcar como "needs setup" y pasar a Fase 1.

---

## Fase 1 — Read Rules + Infrastructure

**Objetivo**: Leer reglas locales del repo y asegurar infraestructura mínima.

### Entradas
- `RepoInspection` de Fase 0
- `localRules` (si existen)

### Proceso
1. Buscar archivos de reglas locales:
   - `.testrc`, `.testrc.json`, `.testrc.yaml`
   - `testing.config.js`
   - Sección `"testing"` en `package.json`
   - `TESTING_DOCUMENTATION.md`, `SESSION_NOTES.md`
2. Si existen: parsear → generar checklist verificable
3. Si NO existen: aplicar **Golden Testing Policy** como default
4. Verificar infraestructura:
   - Jest/Vitest instalado? → si no, marcar para instalación
   - `jest.config.*` existe? → si no, preparar template
   - `setupTests.ts` existe? → si no, preparar template
   - Directorio `src/__mocks__/` existe? → si no, crear
5. Si `mode === 'execution-capable'`: instalar dependencias faltantes

### Salidas
```typescript
interface RulesChecklist {
    rules: Rule[];              // reglas extraídas o de golden policy
    infrastructure: {
        needsInstall: string[];  // packages a instalar
        needsConfig: boolean;    // jest.config necesario
        needsSetup: boolean;     // setupTests necesario
        needsMockDir: boolean;   // __mocks__/ necesario
    };
    checklist: ChecklistItem[];  // items verificables
}
```

### Gate
- Si `mode === 'execution-capable'` y la instalación falla → degradar a `dry-run` con warning.
- La infraestructura debe estar lista antes de continuar.

---

## Fase 2 — Inventory

**Objetivo**: Catalogar tests existentes, verificar cuáles pasan/fallan, identificar causas.

### Entradas
- `RepoInspection` de Fase 0
- `RulesChecklist` de Fase 1

### Proceso
1. Listar todos los archivos `.test.{ts,tsx,js,jsx}` existentes
2. Para cada test:
   - Si `mode === 'execution-capable'`: ejecutar y capturar resultado
   - Si `mode === 'dry-run'`: analizar estáticamente (imports, mocks, asserts)
3. Clasificar:
   - ✅ PASSING: funciona correctamente
   - ❌ FAILING: con causa raíz clasificada:
     - `MOCK_ERROR`: mock incorrecto/faltante
     - `IMPORT_ERROR`: módulo no encontrado
     - `TYPE_ERROR`: error de tipos en jest.mock
     - `ASSERTION_ERROR`: assert incorrecto
     - `RUNTIME_ERROR`: error en ejecución
   - 🗑️ FILLER: test sin señal (interfaz, snapshot solo, `expect(true)`)
   - 📂 ORPHAN: test sin source file correspondiente
4. Calcular coverage baseline si es posible

### Salidas
```typescript
interface TestInventory {
    total: number;
    passing: TestFileInfo[];
    failing: TestFileInfo[];     // con categoría de fallo
    filler: TestFileInfo[];      // candidatos a eliminar
    orphan: TestFileInfo[];
    uncovered: SourceFileInfo[]; // source files sin test
    coverageBaseline: CoverageReport | null;
}
```

### Gate
- Si todos los tests existentes pasan → saltar reparación, ir a Fase 3 (Plan)
- Si hay failing tests → priorizarlos en el plan de reparación

---

## Fase 3 — Plan (P0/P1/P2)

**Objetivo**: Generar plan de acción con prioridades y lista exacta de archivos.

### Entradas
- `TestInventory` de Fase 2
- `RulesChecklist` de Fase 1
- `RepoInspection` de Fase 0

### Proceso de priorización

```
P0 — CRÍTICO (hacer primero)
├── Reparar tests existentes que fallan (inversión mínima, valor inmediato)
├── Eliminar tests de relleno (reducir ruido)
├── Pure functions / utils / reducers (Tier 1 — máximo ROI)
└── Classes/services con lógica de negocio core (Tier 2 — alto ROI)

P1 — IMPORTANTE (hacer después)
├── Servicios con boundaries (API, DB, CMS)
├── Componentes con lógica significativa (Tier 3)
├── Error paths y edge cases para P0
└── Configuración/singletons testables

P2 — NICE TO HAVE (si queda tiempo)
├── Componentes de presentación pura
├── Integración ligera (multi-módulo)
├── Coverage gaps residuales con señal
└── Tests de regresión para bugs conocidos
```

### Criterios de decisión para "qué test escribir primero"

1. **Complejidad ciclomática**: archivos con más branches → más valor por test
2. **Dependencias entrantes** (fan-in): módulos que más módulos importan → regresión más impactante
3. **Líneas de código ejecutable**: archivos con >50 LOC ejecutables antes que <10
4. **Framework purity**: funciones puras antes que componentes con side effects
5. **Mock cost**: menos mocks requeridos → crear primero

### Detección de "código difícil de testear"

| Señal | Acción |
|-------|--------|
| Módulo con >5 dependencias externas | Considerar extract pure functions primero |
| Singleton con estado global | Sugerir `jest.resetModules()` pattern |
| Side effects en constructor | Sugerir DI o factory refactor |
| Tightly coupled to framework (ej: lógica dentro de JSX) | Sugerir extract logic to hook/util |
| Sin exports testables (todo privado) | Marcar como "low ROI, skip" |

### Salidas
```typescript
interface TestPlan {
    p0: TestPlanItem[];   // crítico
    p1: TestPlanItem[];   // importante
    p2: TestPlanItem[];   // nice to have
    fillerToDelete: string[];  // tests de relleno a eliminar
    failingToRepair: TestPlanItem[];  // tests rotos a reparar
    estimatedTime: number;  // ms estimado
    refactorSuggestions: RefactorSuggestion[];  // seams/DI a aplicar
}

interface TestPlanItem {
    sourceFile: string;
    testFile: string;       // path del test a crear/modificar
    tier: 1 | 2 | 3;
    priority: 'P0' | 'P1' | 'P2';
    reason: string;
    estimatedMocks: string[];
    estimatedTests: number;
    action: 'create' | 'repair' | 'extend';
}
```

### Gate
- El plan debe tener al menos 1 item en P0
- Si el plan excede `limits.maxFilesPerRun`, truncar P2 primero, luego P1

---

## Fase 4 — Generate

**Objetivo**: Crear tests siguiendo la golden policy (ubicación/naming/patrones).

### Entradas
- `TestPlan` de Fase 3
- `RulesChecklist` de Fase 1
- Golden Testing Policy

### Proceso por archivo (secuencial, tier-by-tier)

```
Para cada item en plan (ordenado por prioridad):
  1. Leer source file completo
  2. Resolver imports (2 niveles de profundidad)
  3. Detectar qué mockear (aplicar policy de mocking)
  4. Ensamblar prompt:
     - System: Golden Policy + stack guidance
     - User: source + deps + plan item context + templates
  5. Llamar al LLM para generar test
  6. Post-procesar:
     - Verificar estructura describe/it
     - Verificar presencia de beforeEach(clearAllMocks)
     - Verificar naming convention
     - Verificar no snapshot, no expect(true).toBe(true)
  7. Escribir test file en ubicación co-locada
  8. Si mode === 'execution-capable': ejecutar test
     - Si pasa → marcar success, siguiente archivo
     - Si falla → entra en Repair Loop (Fase 5)
  9. Si mode === 'dry-run': análisis estático del output
     - Verificar imports resolvibles
     - Verificar mocks de módulos existentes
     - Marcar como "generated, needs validation"
```

### Gate
- Si la generación falla para un archivo (LLM error, timeout) → skip con warning, seguir con el siguiente
- Si >50% de archivos fallan en generación → ABORT con reporte parcial

---

## Fase 5 — Repair Loop

**Objetivo**: Ejecutar tests, parsear fallos, aplicar parches mínimos, iterar.

### Entradas
- Test file generado
- Source file
- Error output de Jest/Vitest
- `limits.maxIterations` (default: 3)

### Proceso

```
iteration = 0
WHILE test falla AND iteration < maxIterations:
    1. Parsear error output:
       - Extraer tipo de error (MOCK, IMPORT, TYPE, ASSERTION, RUNTIME)
       - Extraer archivo y línea del error
       - Extraer mensaje de error
    2. Clasificar error:
       - QUICK_FIX: import path, typo, mock shape → parche determinístico
       - LLM_FIX: lógica incorrecta, mock incompleto → enviar a LLM
       - UNFIXABLE: dependencia faltante, error de compilación global → skip
    3. Aplicar fix:
       - QUICK_FIX: aplicar parche sin LLM (más rápido, determinístico)
       - LLM_FIX: enviar context (source + test + error + attempt#) al LLM
    4. Escribir test actualizado
    5. Re-ejecutar test
    6. iteration++
    7. CONTROL de cambios:
       - Si el fix no cambió nada del test → BREAK (loop detectado)
       - Si el fix introdujo más errores que antes → REVERT + BREAK
```

### Stop Conditions

| Condición | Acción |
|-----------|--------|
| Test pasa | ✅ EXIT loop |
| `iteration >= maxIterations` | ❌ EXIT con informe de fallos pendientes |
| Fix no produce cambios (diff vacío) | 🔄 BREAK — LLM atascado |
| Fix produce más errores | ⏪ REVERT al mejor intento anterior |
| Error clasificado como UNFIXABLE | ⏩ SKIP archivo, siguiente |
| Timeout global alcanzado | ⏹️ ABORT pipeline |

### Salidas
```typescript
interface RepairResult {
    testFile: string;
    passed: boolean;
    attempts: number;
    finalError: string | null;
    history: RepairAttempt[];
}

interface RepairAttempt {
    iteration: number;
    errorType: string;
    fixStrategy: 'quick_fix' | 'llm_fix';
    errorsBefore: number;
    errorsAfter: number;
    diffSize: number;
}
```

---

## Fase 6 — Coverage

**Objetivo**: Verificar thresholds sin inflar; rellenar gaps con tests con señal.

### Entradas
- Resultados de Fase 4 + Fase 5
- `TestPlan` (P0/P1/P2 completados)
- Coverage baseline de Fase 2

### Proceso

1. Ejecutar `npx jest --coverage --coverageReporters=json-summary`
2. Parsear `coverage-summary.json`
3. Comparar con baseline:
   - Delta por archivo
   - Delta global
4. Identificar gaps significativos:
   - Archivos con <50% statements que NO están en exclusiones
   - Branches no cubiertas en archivos ya testeados
5. Para cada gap significativo:
   - Evaluar si tiene señal (lógica testable, no solo rendering)
   - Si sí → generar tests adicionales (volver a Fase 4 para esos archivos)
   - Si no → documentar como "low ROI, excluded"
6. **Anti-inflado**: NO generar tests que solo suban el % sin verificar comportamiento real

### Criterio anti-inflado
Un test "inflado" es uno que:
- Ejecuta código sin hacer asserts significativos
- Solo hace `expect(fn).toBeDefined()`
- Importa un módulo solo para coverage sin testear behavior

### Gate
- Si coverage global no mejora respecto a baseline → warning pero no bloqueo
- Si coverage de archivos P0 < 80% → intentar repair, no bloquear

---

## Fase 7 — Report

**Objetivo**: Generar reporte final con lista de cambios, comandos y próximos pasos.

### Entradas
- Resultados de todas las fases

### Salidas

```markdown
## Test Generation Report

### Summary
- Tests created: {n}
- Tests repaired: {n}
- Tests deleted (filler): {n}
- Tests passing: {n}/{total}
- Coverage: {before}% → {after}%

### Files Changed
| File | Action | Status | Coverage |
|------|--------|--------|----------|
| src/utils/Utils.test.ts | created | ✅ passing | 99% |
| src/services/Foo.test.ts | created | ❌ failing | - |

### Commands
- Run all tests: `npx jest`
- Run with coverage: `npx jest --coverage`
- Run single: `npx jest src/path/to/file.test.ts`

### Risks
- {archivo}: mock de {dep} puede ser frágil si API cambia
- {archivo}: test de caracterización, no verifica intención

### Next Steps
- [ ] Revisar tests generados manualmente
- [ ] Ejecutar `npm test` para validar
- [ ] Considerar tests para: {archivos P2 skipped}
```

---

## Cuándo NO Escribir Tests (regla de la golden policy)

| Patrón | Acción |
|--------|--------|
| Interfaces puras (`I*.ts`) | Skip — solo tipos |
| Re-exports (`index.ts` barrel files) | Skip — sin lógica |
| Archivos < 10 LOC ejecutables | Skip — ROI marginal |
| Componentes donde lógica = rendering puro | Skip — mock anula el valor |
| Componentes con >5 deps externas sin lógica extractable | Skip o sugerir refactor primero |
| Archivos de configuración estáticos | Skip |
| Declaraciones de tipos (`*.d.ts`) | Skip |

## Cuándo Parar (Stop Conditions Globales)

1. **Timeout global**: `limits.maxTime` alcanzado → Report parcial
2. **Max files**: `limits.maxFilesPerRun` alcanzado → Report parcial
3. **>50% fallo en generación**: algo sistémico está mal → ABORT + diagnóstico
4. **Cancelación del usuario**: VS Code `CancellationToken` → Stop inmediato
5. **Plan completado**: todos los items P0+P1 procesados → Report final
