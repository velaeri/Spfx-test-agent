# Golden Testing Style Guide (Operativo)

> **Fuente de verdad** extraída de patrones observados en repositorios de producción.
> Cada regla proviene de patrones *observables* en código, no de opiniones.

---

## 1. Arquitectura de Tests — Pirámide Aplicada

### 1.1 Tiers observados

| Tier | Descripción | # Tests aprox. | % del total | Ejemplos |
|------|-------------|----------------|-------------|----------|
| **Tier 1 — Pure Logic** | Funciones puras, reducers, constantes. Sin mocks de framework. | ~65 | ~36% | `Utils.test.ts` (42), `FluentUIUtils.test.ts` (5), `HGConstantes.test.ts` (8), `StorageGropuedListReducer.test.ts` (10) |
| **Tier 2 — Services** | Servicios con dependencias externas (PnP, SP). Mock de boundaries. | ~43 | ~24% | `BaseSPManager.test.ts`, `HomeSPManager.test.ts`, `StorageSPManager.test.ts`, `VersioningSPManager.test.ts`, `TrashCleanerSPManager.test.ts`, `SharedSPManager.test.ts`, `adminSPManager.test.ts`, `pnpjsConfig.test.ts` |
| **Tier 3 — Components** | React components con Testing Library. Mocks de Fluent UI/recharts. | ~72 | ~40% | `HGLayout.test.tsx`, `NavBar.test.tsx`, `CardComponent/index.test.tsx`, `StorageGaugeComponent.test.tsx`, `ProgressTopSitesChart.test.tsx`, etc. |

### 1.2 Justificación (ROI real)

- **Tier 1 primero**: Mayor ROI por test. Sin mocks → cero fragilidad. Detecta regresiones en lógica de negocio inmediatamente.
- **Tier 2 segundo**: Requiere un patrón de mocking estable (mock de `BaseSPManager`). Una vez establecido, la inversión se amortiza en todos los managers.
- **Tier 3 último**: Requiere infraestructura completa de mocks (Fluent UI, recharts, strings). Más costoso de escribir pero verifica comportamiento de usuario.
- **No existe Tier E2E**: No hay tests end-to-end. No se justifican por el coste/beneficio dado el entorno SPFx.

---

## 2. Convenciones Exactas

### 2.1 Ubicación de tests

```
source.ts         ← archivo fuente
source.test.ts    ← test en el MISMO directorio
source.test.tsx   ← para componentes React
```

- **Co-locación obligatoria**: el test vive junto al archivo fuente.
- **No hay carpetas `__tests__/`** separadas.
- **Mocks globales**: `src/__mocks__/` (mocks compartidos a nivel de proyecto).
- **Test helpers**: `src/__testHelpers__/` (utilidades reutilizables como `pnpMock.ts`).
- **Root mock**: `__mocks__/fileMock.js` (mock de assets como imágenes).

### 2.2 Sufijos y patrones de archivo

| Tipo | Patrón | Ejemplo |
|------|--------|---------|
| Unit TS | `{ClassName}.test.ts` | `Utils.test.ts`, `BaseSPManager.test.ts` |
| Unit TSX | `{Component}.test.tsx` o `index.test.tsx` | `NavBar.test.tsx`, `CardComponent/index.test.tsx` |
| Config discovery | `<rootDir>/src/**/*.test.ts?(x)` | Configurado en `jest.config.js` `testMatch` |

### 2.3 Estructura de describe/it

```typescript
// ═══════════════════════════════════════════════════
// TIER 2 — Services — {NombreClase}
// ═══════════════════════════════════════════════════

describe("{NombreClase}", () => {
    // Setup compartido
    let instance: NombreClase;

    beforeEach(() => {
        jest.clearAllMocks();
        instance = new NombreClase();
    });

    describe("{nombreMétodo}", () => {
        it("describe el comportamiento esperado en condiciones normales", () => {
            // arrange
            const input = { /* datos hardcoded */ };
            // act
            const result = instance.nombreMétodo(input);
            // assert
            expect(result).toEqual(expected);
        });

        it("retorna valor por defecto cuando input es vacío/nulo", () => { ... });

        it("no muta el array/objeto original", () => { ... });
    });

    describe("{otroMétodo}", () => {
        it("rechaza/retorna undefined ante error", async () => { ... });
    });
});
```

### 2.4 Naming de casos (qué es "descriptivo")

**Fórmula observada**: `"[verbo] [resultado esperado] [condición]"`

Ejemplos reales:
- `"formats a US-style date with AM marker to DD/MM/YYYY"`
- `"returns B for values < 1024"`
- `"returns the top N sites sorted by (...) desc"`
- `"does not mutate the original array"`
- `"returns undefined on error"`
- `"queries the SiteMaster list ordered by UsedStorageHG desc"`
- `"should render the Card component with header and body"`
- `"should toggle body minimized class when header is clicked"`

**Regla**: el `it()` debe funcionar como documentación. Si lees solo los nombres, entiendes el contrato del módulo.

### 2.5 Comentarios de sección

Cada test file comienza con un banner JSDoc:
```typescript
/**
 * ═══════════════════════════════════════════════════
 * TIER {N} — {Categoría} — {NombreDelModulo}
 * ═══════════════════════════════════════════════════
 * {Descripción breve del propósito}
 */
```

---

## 3. Patrones de Utilidades

### 3.1 Test utils comunes

| Utilidad | Ubicación | Uso |
|----------|-----------|-----|
| `pnpMock.ts` | `src/__testHelpers__/pnpMock.ts` | Factory de mock para SPFI: `createMockSPFI()`, `setupServiceMocks()`, `pagedResult()` |
| `cssModuleMock.ts` | `src/__mocks__/cssModuleMock.ts` | Proxy que retorna el nombre de la clase CSS como string (`styles.foo → "foo"`) |
| `emptyModule.ts` | `src/__mocks__/emptyModule.ts` | `export {}` — neutraliza imports con side-effects (`@pnp/sp/files`, etc.) |
| `fluentuiReact.ts` | `src/__mocks__/fluentuiReact.ts` | Stub factory de ~30 componentes Fluent UI con `React.forwardRef` |
| `recharts.ts` | `src/__mocks__/recharts.ts` | Stub factory de ~20 componentes de charts |
| `WebPartStrings.ts` (o equivalente) | `src/__mocks__/` | Claves de localización como record plano |
| `ControlStrings.ts` | `src/__mocks__/` | Proxy que retorna el nombre de la propiedad para cualquier acceso |
| `fileMock.js` | `__mocks__/fileMock.js` | `module.exports = "test-file-stub"` |

### 3.2 Stub Factory Pattern

El patrón central para mocks de componentes UI:

```typescript
const createStub = (name: string) =>
    React.forwardRef((props: any, ref: any) => (
        <div data-testid={name} {...props} ref={ref}>
            {props.children}
        </div>
    ));

// Uso:
export const CommandBar = createStub("CommandBar");
export const DetailsList = createStub("DetailsList");
```

**Principio**: Los stubs renderizan `children` (composición testable) y exponen `data-testid` (selección precisa), pero NO replican lógica del componente real.

### 3.3 Data builders / fixtures

- **No hay data builders ni factory functions** explícitas.
- Los datos de test se definen **inline, hardcoded** en cada test.
- Ejemplo: `{ Title: "TC-001", Id: 1, SiteUrl: "https://test.sharepoint.com/sites/test" }`.
- **Razón**: los datos son simples records; no se necesita un builder para 3-5 campos.

### 3.4 Mock de BaseSPManager (patrón boundary)

```typescript
jest.mock("../../../shared/services/BaseSPManager", () => {
    const { spfi } = require("@pnp/sp");
    return {
        __esModule: true,
        default: class MockBase {
            protected spCache: any;
            constructor() {
                this.spCache = spfi();
            }
        },
    };
});
```

Este patrón es el **seam** entre servicios y red. Permite testear la lógica de query building sin hacer llamadas reales.

---

## 4. Política de Mocking y Boundaries

### 4.1 Qué se mockea SIEMPRE

| Boundary | Estrategia | Razón |
|----------|------------|-------|
| `@pnp/sp` y submódulos | `jest.mock()` + factory con SPFI chainable | Red / SharePoint API |
| `@pnp/graph` | `jest.mock(() => ({}))` | Graph API |
| `@pnp/logging` | `jest.mock()` con stubs de `LogLevel`, `PnPLogging` | Side effects log |
| `@fluentui/react` | `moduleNameMapper` → stub components | Componentes de terceros |
| `recharts` | `moduleNameMapper` → stub components | Componentes de terceros |
| `@microsoft/sp-core-library` | `jest.mock()` per test | SPFx runtime |
| `@microsoft/sp-webpart-base` | `jest.mock()` con class stub | SPFx runtime |
| `@microsoft/sp-property-pane` | `jest.mock(() => ({}))` | SPFx runtime |
| `@microsoft/sp-lodash-subset` | `jest.mock()` con stubs (`groupBy`, `cloneDeep`, `isEmpty`) | Utility de SPFx |
| `react-router-dom` | `jest.mock()` con `useNavigate` | Routing |
| CSS/SCSS modules | `moduleNameMapper` → Proxy | Estilos |
| Imágenes/assets | `moduleNameMapper` → `"test-file-stub"` | Assets estáticos |

### 4.2 Qué se evita mockear

| Qué se deja real | Razón |
|-------------------|-------|
| El módulo bajo test | Siempre se testea el código real |
| Funciones puras internas | Sin side effects → no necesitan mock |
| `React.createContext` / `useContext` | Se testea la integración real |
| Reducers | Lógica pura, testarla real da más confianza |
| Constantes/enums del proyecto | Son estáticos, no vale la pena mockear |

### 4.3 Centralizado vs local

- **`moduleNameMapper`** (centralizado): para dependencias que SIEMPRE se mockean en TODOS los tests (Fluent UI, CSS, assets, recharts, PnP augmentations).
- **`jest.mock()` en el test file** (local): para dependencias específicas del módulo bajo test (`BaseSPManager`, `pnpjsConfig`, `react-router-dom`).
- **Regla**: si el mock lo necesitan ≥3 test files, va a `moduleNameMapper` o `src/__mocks__/`.

---

## 5. Anti-Flakiness

### 5.1 Limpieza entre tests

```typescript
beforeEach(() => {
    jest.clearAllMocks();  // SIEMPRE en cada describe con mocks
});

afterEach(() => {
    (console.error as jest.Mock).mockRestore();  // Si se espía console
});
```

### 5.2 Uso de `.mockResolvedValueOnce()` sobre `.mockResolvedValue()`

- Cada test define su propia respuesta mock con `Once`.
- Previene que datos de un test contaminen el siguiente.

### 5.3 `jest.resetModules()` para singletons

```typescript
beforeEach(() => {
    jest.resetModules();     // Limpiar cache de módulos
    jest.clearAllMocks();
});

it("creates a new instance on first call", () => {
    const { getSP } = require("../pnpjsConfig");  // Re-importar fresco
    // ...
});
```

### 5.4 Sin timers, sin random

- No se usa `jest.useFakeTimers()`.
- No hay `setTimeout`/`setInterval` en tests.
- Datos 100% determinísticos (hardcoded).

### 5.5 `waitFor()` selectivo

```typescript
await waitFor(() => {
    expect(screen.getByTestId("chart-container")).toBeInTheDocument();
});
```

- Solo se usa para operaciones async (data fetching en componentes).
- No se abusa como "esperemos a ver si funciona".

### 5.6 `act()` para updates de estado

```typescript
await act(async () => {
    render(<TemplateSitesChart data={mockData} />);
});
```

### 5.7 Inmutabilidad

Múltiples tests verifican explícitamente `"does not mutate the original input"`:
```typescript
it("does not mutate the original array", () => {
    const original = [...data];
    const copy = JSON.parse(JSON.stringify(data));
    manager.getTopSitesFromData(original, 3);
    expect(original).toEqual(copy);
});
```

### 5.8 Snapshots

- **No se usan snapshots** en ningún test.
- **Regla implícita**: los snapshots son frágiles y no comunican intención. Se prefieren asserts explícitos.

### 5.9 Window event cleanup

```typescript
it("cleans up resize listener on unmount", () => {
    const spy = jest.spyOn(window, "removeEventListener");
    const { unmount } = render(<HGLayout {...props} />);
    unmount();
    expect(spy).toHaveBeenCalledWith("resize", expect.any(Function));
    spy.mockRestore();
});
```

---

## 6. Quality Gates

### 6.1 Coverage thresholds

- **No hay `coverageThreshold` en jest.config.js** — no se aplican mínimos automáticos.
- **Coverage es informativo**: se genera con `--coverage` y se inspecciona manualmente.
- **Objetivo implícito**: archivos testeados deben estar >80% en statements/lines. Archivos con 100% son la norma para Tier 1 y muchos Tier 3.
- **Exclusiones explícitas de coverage**:
  - `*.d.ts` (declaraciones)
  - `*.test.{ts,tsx}` (tests mismos)
  - `index.ts` (re-exports)
  - `setupTests.ts`
  - `__mocks__/**`
  - `**/Models/I*.ts` y `**/models/I*.ts(x)` (interfaces puras)

### 6.2 "Test útil" vs "test de relleno" — señales claras

#### Un test es ÚTIL si:

| Señal | Ejemplo |
|-------|---------|
| Testea lógica de negocio real | `"formats a US-style date with AM marker to DD/MM/YYYY"` |
| Cubre error paths | `"returns undefined on error"` |
| Verifica edge cases | `"returns B for 0"`, `"handles empty array"` |
| Verifica inmutabilidad | `"does not mutate the original array"` |
| Verifica paginación | `"handles pagination (hasNext=true)"` |
| Verifica props pasadas a stubs | `expect(commandBarProps.items).toHaveLength(3)` |
| Verifica interacción de usuario | `fireEvent.click(header)` → class change |
| Puede fallar por un defecto real | Bug `isReadHG` vs `IsReadHG` detectado en test |

#### Un test es DE RELLENO si:

| Señal | Ejemplo eliminado |
|-------|-------------------|
| Testea existencia de interfaz | `expect(typeof IFoo).toBe('object')` — 21 archivos eliminados |
| Testea solo que renderiza | "renders without crashing" sin más asserts |
| Testea comportamiento de librería | Testing que `<Nav>` de Fluent UI genera links |
| `expect(true).toBe(true)` | Placeholder sin señal |
| Solo snapshot | Sin asserts explícitos sobre qué importa |

### 6.3 Qué NO se testea (bajo ROI) y por qué

| Categoría | Ejemplo | Razón |
|-----------|---------|-------|
| Componentes con alta densidad de deps externas | `GenericComponent.tsx` (74 líneas) | Renderiza componentes dinámicos según JSON; mockear todo anula el valor |
| Componentes donde la lógica ES el rendering | `CategoryGroupedList.tsx` | Depende del grouping de `ShimmeredDetailsList`; mockear la librería elimina lo que se testea |
| Archivos < 10 líneas ejecutables | `searchSPManager.ts` (12 líneas) | ROI marginal; pass-through simple |
| Interfaces puras (`I*.ts`) | Todos los modelos | Solo tipos, no hay runtime code |
| Re-exports (`index.ts`) | `src/index.ts` | Solo barrel files |

---

## 7. Procedimiento Retro-TDD Observado

### 7.1 Estado inicial documentado

- 51 archivos de test auto-generados por tooling.
- 0 tests pasaban.
- Tests tenían anti-patrones: tipos en `jest.mock()`, asserts sobre interfaces, mocks incorrectos.

### 7.2 Proceso de remediación aplicado

```
1. TRIAGE
   ├── DELETE: 21 test files de interfaces + 2 tests de comportamiento de librería
   ├── REWRITE: 6 tests con asserts incorrectos o anti-patrones
   └── FIX: Correcciones menores (imports, text matching)

2. INFRAESTRUCTURA (una sola vez)
   ├── jest.config.js: moduleNameMapper completo
   ├── tsconfig para ts-jest: esModuleInterop=false, jsx=react
   ├── src/__mocks__/: cssModuleMock, fluentuiReact, recharts, emptyModule, strings
   └── src/__testHelpers__/pnpMock.ts

3. GENERACIÓN TIER-BY-TIER (bottom-up)
   ├── Tier 1: funciones puras (Utils, reducers, constantes)
   ├── Tier 2: servicios (mock boundary en BaseSPManager)
   └── Tier 3: componentes (con infraestructura de mocks ya lista)

4. REPAIR LOOP POR ARCHIVO
   ├── Escribir test → ejecutar → parsear error
   ├── Si falla por mock: ajustar mock
   ├── Si falla por import: ajustar moduleNameMapper
   ├── Si falla por tipo: quitar types de jest.mock()
   └── Repetir hasta green
```

### 7.3 Bug descubierto por testing

- `item.isReadHG` vs `item.IsReadHG` (casing) en `HomeSPManager`.
- Flujo: escribir test → test falla con `undefined` → inspeccionar source → encontrar casing bug → fix source → green.

### 7.4 Tests de caracterización implícitos

- Los tests de servicios actúan como tests de caracterización: documentan qué queries se hacen y qué transformaciones se aplican a los datos.
- Ejemplo: `"queries the SiteMaster list ordered by UsedStorageHG desc"` — verifica el contrato actual con SharePoint.

---

## 8. Configuración Técnica de Referencia

### 8.1 jest.config.js (completo)

```javascript
module.exports = {
    preset: "ts-jest",
    testEnvironment: "jsdom",
    setupFilesAfterSetup: ["<rootDir>/src/setupTests.ts"],
    testMatch: ["<rootDir>/src/**/*.test.ts?(x)"],
    moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
    transformIgnorePatterns: ["node_modules/(?!(@pnp)/)"],
    transform: {
        "^.+\\.tsx?$": ["ts-jest", {
            diagnostics: { warnOnly: true },
            tsconfig: {
                jsx: "react",
                esModuleInterop: false,
                allowSyntheticDefaultImports: true,
                module: "commonjs",
                target: "es2015",
                strict: false,
                noImplicitAny: false,
                types: ["jest", "node"]
            }
        }]
    },
    moduleNameMapper: {
        "\\.(css|less|scss|sass)$": "<rootDir>/src/__mocks__/cssModuleMock.ts",
        "\\.(jpg|jpeg|png|gif|svg)$": "<rootDir>/__mocks__/fileMock.js",
        "^WebPartStrings$": "<rootDir>/src/__mocks__/WebPartStrings.ts",
        "^ControlStrings$": "<rootDir>/src/__mocks__/ControlStrings.ts",
        "^@pnp/sp/.+$": "<rootDir>/src/__mocks__/emptyModule.ts",
        "^@pnp/logging$": "<rootDir>/src/__mocks__/emptyModule.ts",
        "^@fluentui/react/lib/Styling$": "<rootDir>/src/__mocks__/fluentuiStyling.ts",
        "^@fluentui/react$": "<rootDir>/src/__mocks__/fluentuiReact.ts",
        "^@fluentui/react-components$": "<rootDir>/src/__mocks__/fluentuiReact.ts",
        "^office-ui-fabric-react$": "<rootDir>/src/__mocks__/fluentuiReact.ts",
        "^office-ui-fabric-react/lib/(.*)$": "<rootDir>/src/__mocks__/fluentuiReact.ts",
        "^recharts$": "<rootDir>/src/__mocks__/recharts.ts"
    },
    collectCoverageFrom: [
        "src/**/*.{ts,tsx}",
        "!src/**/*.d.ts",
        "!src/**/*.test.{ts,tsx}",
        "!src/index.ts",
        "!src/setupTests.ts",
        "!src/__mocks__/**",
        "!src/**/Models/I*.ts",
        "!src/**/models/I*.ts",
        "!src/**/models/I*.tsx"
    ]
};
```

### 8.2 Dependencias de test

| Paquete | Versión |
|---------|---------|
| `jest` | ^29.6.4 |
| `ts-jest` | ^29.1.1 |
| `jest-environment-jsdom` | ^29.6.4 |
| `@testing-library/react` | ^12.1.5 |
| `@testing-library/jest-dom` | ^5.17.0 |
| `@types/jest` | ^29.5.3 |

### 8.3 setupTests.ts

```typescript
import "@testing-library/jest-dom";
```

Mínimo. Solo importa matchers extendidos. Sin lógica global.

---

## 9. Checklist de Reproducibilidad

Para reproducir este estándar de calidad en cualquier proyecto:

- [ ] Tests co-locados junto al source (`.test.ts(x)`)
- [ ] `jest.config.js` con `ts-jest`, `jsdom`, y `moduleNameMapper` para CSS/assets/UI libs
- [ ] Mocks centralizados en `src/__mocks__/` para deps globales
- [ ] Helpers en `src/__testHelpers__/` para factories compartidas
- [ ] `beforeEach(() => jest.clearAllMocks())` en TODOS los describe con mocks
- [ ] `.mockResolvedValueOnce()` en vez de `.mockResolvedValue()`
- [ ] Naming: `"describe NombreClase > describe método > it comportamiento esperado"`
- [ ] AAA implícito (sin comentarios, pero separación clara)
- [ ] Sin snapshots
- [ ] Sin timers/random en tests
- [ ] Edge cases: empty input, error path, boundary values, inmutabilidad
- [ ] Coverage exclusions: `*.d.ts`, `I*.ts`, `index.ts`, `setupTests.ts`, `__mocks__/`
- [ ] Tier 1 primero (pure logic), luego Tier 2 (services/boundary), luego Tier 3 (components)
- [ ] Eliminar tests de relleno: no testear interfaces, no testear libs, no `expect(true).toBe(true)`
