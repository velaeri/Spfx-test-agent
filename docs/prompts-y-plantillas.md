# Prompts y Plantillas — Referencia Rápida

> Este documento describe los prompts y plantillas derivados de la golden testing policy.
> La implementación real reside en `src/policies/GoldenPolicy.ts` y `src/services/PromptAssembler.ts`.

---

## 1. Prompt Base "POLICY" (System/Developer)

Usado como system prompt en TODAS las generaciones. Impone el estilo de la golden policy.

### Contenido (resumen — ver `GoldenPolicy.getPolicyText()` para texto completo)

- **Estilo**: describe/it con naming descriptivo, AAA implícito, sin comentarios de sección AAA
- **Quality Gates**: sin snapshots, sin `expect(true).toBe(true)`, sin tests de interfaces
- **Orden de fases**: Tier 1 (pure) → Tier 2 (services) → Tier 3 (components)
- **Restricciones**:
  - No inventar requisitos del source code
  - No inflar cobertura con tests sin señal
  - No añadir `data-testid` al código de producción
  - Datos de test determinísticos (hardcoded)
  - Usar `.mockResolvedValueOnce()` siempre
  - `beforeEach(() => jest.clearAllMocks())` obligatorio

---

## 2. Prompt One-Shot por Repo

Prompt completo que la extensión envía al LLM en cada ejecución de generación.
Incluye las fases 0-5 embebidas como instrucciones contextuales.

### Placeholders disponibles

| Placeholder | Descripción |
|-------------|-------------|
| `{{STACK_GUIDANCE}}` | Guía específica del framework (SPFx, React, etc.) |
| `{{SOURCE_CODE}}` | Código fuente a testear |
| `{{FILE_NAME}}` | Nombre del archivo fuente |
| `{{DEPENDENCY_CONTEXT}}` | Imports resueltos y código de dependencias |
| `{{EXISTING_PATTERNS}}` | Patrones de tests existentes en el repo |
| `{{LOCAL_RULES}}` | Reglas locales del repo si existen |
| `{{MOCK_INVENTORY}}` | Mocks existentes disponibles en el repo |
| `{{PLAN_CONTEXT}}` | Plan P0/P1/P2 item actual |
| `{{TIER}}` | Tier del test a generar (1, 2, o 3) |

---

## 3. Plantillas

### 3.1 Unit TS (Tier 1 — Pure Logic)

```typescript
/**
 * ═══════════════════════════════════════════════════
 * TIER 1 — Pure Logic — {{MODULE_NAME}}
 * ═══════════════════════════════════════════════════
 */

import { {{EXPORTS}} } from "{{IMPORT_PATH}}";

describe("{{MODULE_NAME}}", () => {
    {{#each METHODS}}
    describe("{{METHOD_NAME}}", () => {
        it("{{HAPPY_PATH_DESCRIPTION}}", () => {
            const input = {{INPUT_FIXTURE}};
            const result = {{MODULE_NAME}}.{{METHOD_NAME}}(input);
            expect(result).toEqual({{EXPECTED}});
        });

        it("handles empty/null input", () => {
            const result = {{MODULE_NAME}}.{{METHOD_NAME}}({{EMPTY_INPUT}});
            expect(result).toEqual({{EMPTY_EXPECTED}});
        });

        it("does not mutate the original input", () => {
            const original = {{INPUT_FIXTURE}};
            const copy = JSON.parse(JSON.stringify(original));
            {{MODULE_NAME}}.{{METHOD_NAME}}(original);
            expect(original).toEqual(copy);
        });

        {{#if HAS_EDGE_CASES}}
        it("{{EDGE_CASE_DESCRIPTION}}", () => {
            expect({{MODULE_NAME}}.{{METHOD_NAME}}({{EDGE_INPUT}})).toEqual({{EDGE_EXPECTED}});
        });
        {{/if}}
    });
    {{/each}}
});
```

### 3.2 Unit TSX (Tier 3 — Testing Library)

```typescript
/**
 * ═══════════════════════════════════════════════════
 * TIER 3 — React Component — {{COMPONENT_NAME}}
 * ═══════════════════════════════════════════════════
 */

import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { {{COMPONENT_NAME}} } from "{{IMPORT_PATH}}";

{{MOCK_DECLARATIONS}}

describe("{{COMPONENT_NAME}}", () => {
    const defaultProps: {{PROPS_TYPE}} = {{DEFAULT_PROPS}};

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("renders with required props", () => {
        render(<{{COMPONENT_NAME}} {...defaultProps} />);
        expect(screen.getByTestId("{{TESTID}}")).toBeInTheDocument();
    });

    it("displays correct content from props", () => {
        render(<{{COMPONENT_NAME}} {...defaultProps} />);
        expect(screen.getByText("{{EXPECTED_TEXT}}")).toBeInTheDocument();
    });

    {{#if HAS_INTERACTION}}
    it("handles user interaction", () => {
        render(<{{COMPONENT_NAME}} {...defaultProps} />);
        fireEvent.click(screen.getByRole("button"));
        expect({{INTERACTION_ASSERT}}).toBeTruthy();
    });
    {{/if}}

    {{#if HAS_ASYNC}}
    it("loads data asynchronously", async () => {
        render(<{{COMPONENT_NAME}} {...defaultProps} />);
        await waitFor(() => {
            expect(screen.getByText("{{LOADED_CONTENT}}")).toBeInTheDocument();
        });
    });
    {{/if}}

    it("cleans up on unmount", () => {
        const { unmount } = render(<{{COMPONENT_NAME}} {...defaultProps} />);
        unmount();
        // Verify no lingering subscriptions/listeners
    });
});
```

### 3.3 Service con Boundary Mock (Tier 2)

```typescript
/**
 * ═══════════════════════════════════════════════════
 * TIER 2 — Service — {{SERVICE_NAME}}
 * ═══════════════════════════════════════════════════
 */

{{MOCK_DECLARATIONS}}

// Mock the base service / data layer boundary
jest.mock("{{BOUNDARY_PATH}}", () => {
    {{BOUNDARY_MOCK_FACTORY}}
});

import { {{SERVICE_NAME}} } from "{{IMPORT_PATH}}";

describe("{{SERVICE_NAME}}", () => {
    let service: {{SERVICE_NAME}};
    let mockQuery: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new {{SERVICE_NAME}}();
        mockQuery = {{QUERY_MOCK_REF}};
    });

    describe("{{METHOD_NAME}}", () => {
        it("returns mapped data from successful query", async () => {
            mockQuery.mockResolvedValueOnce({{SUCCESS_RESPONSE}});
            const result = await service.{{METHOD_NAME}}();
            expect(result).toEqual({{EXPECTED_MAPPED}});
        });

        it("returns undefined/empty on error", async () => {
            mockQuery.mockRejectedValueOnce(new Error("network error"));
            const result = await service.{{METHOD_NAME}}();
            expect(result).toBeUndefined();
        });

        {{#if HAS_PAGINATION}}
        it("handles pagination (hasNext=true)", async () => {
            mockQuery.mockResolvedValueOnce({
                results: {{PAGE_1}},
                hasNext: true,
                getNext: jest.fn().mockResolvedValueOnce({
                    results: {{PAGE_2}},
                    hasNext: false,
                    getNext: jest.fn(),
                }),
            });
            const result = await service.{{METHOD_NAME}}();
            expect(result).toHaveLength({{TOTAL_LENGTH}});
        });
        {{/if}}

        {{#if HAS_PURE_HELPER}}
        describe("{{PURE_HELPER_NAME}} (pure)", () => {
            it("processes data correctly", () => {
                const result = service.{{PURE_HELPER_NAME}}({{HELPER_INPUT}});
                expect(result).toEqual({{HELPER_EXPECTED}});
            });

            it("does not mutate the original array", () => {
                const original = [...{{HELPER_INPUT}}];
                const copy = JSON.parse(JSON.stringify(original));
                service.{{PURE_HELPER_NAME}}(original);
                expect(original).toEqual(copy);
            });
        });
        {{/if}}
    });
});
```

### 3.4 Reducer / State Manager (Tier 1)

```typescript
/**
 * ═══════════════════════════════════════════════════
 * TIER 1 — Reducer — {{REDUCER_NAME}}
 * ═══════════════════════════════════════════════════
 */

import { {{REDUCER_NAME}}, {{ACTION_TYPES}} } from "{{IMPORT_PATH}}";

describe("{{REDUCER_NAME}}", () => {
    const initialState: {{STATE_TYPE}} = {{INITIAL_STATE}};

    it("returns initial state for unknown action", () => {
        const result = {{REDUCER_NAME}}(initialState, { type: "UNKNOWN" } as any);
        expect(result).toEqual(initialState);
    });

    {{#each ACTIONS}}
    it("handles {{ACTION_TYPE}}", () => {
        const action = { type: {{ACTION_TYPE}}, payload: {{PAYLOAD}} };
        const result = {{REDUCER_NAME}}(initialState, action);
        expect(result.{{CHANGED_FIELD}}).toEqual({{EXPECTED_VALUE}});
    });
    {{/each}}

    it("does not mutate the previous state", () => {
        const prevState = { ...initialState };
        const copy = JSON.parse(JSON.stringify(prevState));
        {{REDUCER_NAME}}(prevState, { type: {{FIRST_ACTION}}, payload: {{FIRST_PAYLOAD}} });
        expect(prevState).toEqual(copy);
    });
});
```

### 3.5 Constants / Contract Tests (Tier 1)

```typescript
/**
 * ═══════════════════════════════════════════════════
 * TIER 1 — Constants Contract — {{MODULE_NAME}}
 * ═══════════════════════════════════════════════════
 */

import { {{EXPORTS}} } from "{{IMPORT_PATH}}";

describe("{{MODULE_NAME}}", () => {
    it("exports expected constants", () => {
        {{#each CONSTANTS}}
        expect({{CONSTANT_NAME}}).toBeDefined();
        expect(typeof {{CONSTANT_NAME}}).toBe("{{TYPE}}");
        {{/each}}
    });

    {{#if HAS_COMPUTED}}
    it("computed values are consistent", () => {
        {{COMPUTED_ASSERTIONS}}
    });
    {{/if}}
});
```

---

## 4. Assert Rules Alineadas con la Golden Policy

| Tipo de Test | Asserts Obligatorios | Asserts Prohibidos |
|--------------|---------------------|--------------------|
| Pure function | `toEqual`, `toBe`, `toHaveLength`, inmutabilidad | `toMatchSnapshot`, `toBeTruthy` solo |
| Service | `toEqual` resultado, `toBeUndefined` en error, mock `.toHaveBeenCalledWith()` | `toBeDefined` sin más |
| Component | `toBeInTheDocument`, `getByText/Role/TestId`, `fireEvent` + assert | Solo `not.toBeNull` |
| Reducer | `toEqual` nuevo estado, inmutabilidad, default case | Snapshot de estado |
| Constants | `toBeDefined`, `typeof`, valores específicos si son críticos | Solo existencia |

---

## 5. Reglas de Mocking por Tier

| Tier | Qué mockear | Cómo |
|------|-------------|------|
| 1 | NADA (o mínimo: `DefaultPalette` si usa constantes de Fluent) | `jest.mock()` puntual |
| 2 | Base class / data layer boundary | `jest.mock()` con factory class |
| 2 | External SDKs (`@pnp/sp`, APIs) | `jest.mock()` con chainable methods |
| 3 | UI components de terceros | `moduleNameMapper` → stub factory |
| 3 | CSS/SCSS modules | `moduleNameMapper` → Proxy |
| 3 | Assets (imágenes, fuentes) | `moduleNameMapper` → `"test-file-stub"` |
| 3 | Localization strings | `moduleNameMapper` → record object |
| ALL | Router, navigation | `jest.mock()` local por file |
