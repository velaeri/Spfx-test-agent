# SPFX Test Agent - Ingeniero de QA Autónomo con Arquitectura LLM-First

**SPFX Test Agent** es una extensión revolucionaria para Visual Studio Code que transforma tu flujo de trabajo de desarrollo en SharePoint Framework.

No es un simple asistente de chat — es un **agente autónomo inteligente** que actúa como un ingeniero de QA senior. La extensión funciona como un **orquestador puro** donde el LLM analiza, decide, ejecuta, valida y reitera de forma completamente autónoma.

## 🚀 Novedades en v0.5.1 — **Arquitectura LLM-First Completa**

### 🧠 **Transformación Fundamental**
La versión 0.5.0 representa una **refactorización arquitectónica total**. La extensión ya no contiene lógica hardcoded para decisiones críticas — **el LLM decide todo**.

### ✨ **Nuevas Capacidades LLM-First**

#### 1. **Planificación Inteligente de Estrategia de Testing**
Antes de generar cualquier test, el LLM analiza tu código y decide:
- **Enfoque óptimo**: Unit / Integration / Component testing
- **Estrategia de mocking**: Minimal / Moderate / Extensive
- **Mocks específicos necesarios** para tu archivo
- **Cobertura esperada** y posibles problemas
- **Iteraciones de auto-reparación estimadas**

```text
🧠 Test Strategy Planned by LLM:
- Approach: component
- Mocking: moderate  
- Mocks needed: SPHttpClient, @microsoft/sp-core-library
- Est. iterations: 2
```

#### 2. **Configuración Jest Personalizada por LLM**
El comando `/setup` ya no usa templates hardcoded:
- **Analiza** tu `package.json`, `tsconfig.json`, y tests existentes
- **Detecta** automáticamente tu framework (SPFx, React, Angular, Next.js...)
- **Genera** una configuración Jest optimizada específicamente para tu proyecto
- **Crea** mocks personalizados según tus dependencias reales

#### 3. **Priorización Inteligente de Batch Generation**
El comando `/generate-all` ahora usa el LLM para decidir:
- **Qué archivos procesar primero** (críticos/fundacionales antes)
- **Cómo agruparlos** según dependencias y complejidad
- **Tiempo estimado** y concurrencia recomendada

```text
🧠 Batch Generation Plan (by LLM):
**Core Services** (Priority 1): 5 files
  _Foundation services used by other components_

**React Components** (Priority 2): 12 files  
  _UI components depending on services_
  
Estimated time: 8-12 minutes
Recommended concurrency: 2
```

#### 4. **Detección de Dependencias Sin Versiones Hardcoded**
**BREAKING CHANGE**: Eliminadas todas las versiones hardcoded de Jest y dependencias.
- El LLM detecta versiones compatibles dinámicamente
- 3 reintentos con feedback si falla
- Fallback a npm `"latest"` (NO versiones hardcoded)

---

## 🏗️ **Filosofía: LLM-First Architecture**

### **¿Qué significa LLM-First?**

La extensión es un **orquestador puro** — toda la lógica estratégica reside en el LLM:

**Antes (v0.4.x):**
```typescript
// ❌ Lógica hardcoded
const jestVersion = "^29.7.0"; // Versión fija
const config = DEFAULT_JEST_CONFIG; // Template fijo
processFiles(files); // Orden arbitrario
```

**Ahora (v0.5.x):**
```typescript
// ✅ LLM decide todo
const versions = await llm.detectDependencies(pkg); // Dinámico
const config = await llm.generateJestConfig(analysis); // Personalizado
const plan = await llm.planBatchGeneration(files); // Priorizado
const strategy = await llm.planTestStrategy(code); // Analizado
```

### **Flujo LLM-First:**
1. **ANALIZA** → LLM examina tu proyecto completo
2. **PLANIFICA** → LLM decide estrategia óptima
3. **EJECUTA** → Extension ejecuta el plan
4. **VALIDA** → LLM evalúa resultados
5. **REITERA** → LLM decide si repetir/ajustar

**Resultado**: Cero asunciones. Todo adaptado a TU proyecto específico.

---

## Características Principales

### 🔄 Ciclo de Vida Completamente Autónomo (LLM-First)
1. **Planifica** → LLM analiza código y define estrategia antes de generar
2. **Genera** → LLM escribe test siguiendo la estrategia planificada
3. **Ejecuta** → Jest corre el test en entorno aislado
4. **Analiza** → LLM diagnostica errores con contexto completo
5. **Repara** → LLM reescribe el test con correcciones específicas
6. **Reitera** → Hasta 3/5 veces según modo (fast/balanced/thorough)

### 🛡️ Configuración Inteligente y Personalizada
- **Setup por LLM**: `/setup` genera `jest.config.js` optimizado para TU proyecto
- **Detección de Framework**: SPFx, React, Angular, Next.js, Vue identificados automáticamente
- **Mocks Personalizados**: Crea mocks específicos según tus dependencias reales
- **Scripts Optimizados**: Actualiza `package.json` con comandos Jest apropiados

### 🧠 Inteligencia Contextual Profunda
- **Análisis de Dependencias**: Lee archivos importados para entender tipos e interfaces reales
- **Detección de Patrones**: Identifica automáticamente WebParts, Extensiones, PnP JS, Fluent UI
- **Contexto de Configuración**: Interpreta `tsconfig.json` y `package.json` para adaptar tests
- **Patrones Existentes**: Aprende de tus tests actuales para mantener consistencia

### 🚀 Generación en Batch Inteligente
- **Priorización por LLM**: `/generate-all` procesa archivos en orden óptimo
- **Agrupación Inteligente**: Agrupa por dependencias y complejidad
- **Estimación de Tiempo**: Calcula duración y recomienda concurrencia
- **Coverage-Driven**: Itera automáticamente sobre archivos con baja cobertura

### 🤖 Soporte Multi-Proveedor LLM
- **GitHub Copilot**: Integración nativa sin configuración (GPT-4 Turbo)
- **Azure OpenAI**: Configura tu propio endpoint para modelos corporativos
- **Fallback Graceful**: Degrada elegantemente a defaults si LLM no disponible

## Instalación y Requisitos

**Requisitos Previos:**
- VS Code 1.85.0+
- Node.js v18+
- Una suscripción activa a **GitHub Copilot** (o acceso a Azure OpenAI)

**Instalación:**
1. Instala la extensión desde el Marketplace (o carga el `.vsix`).
2. Abre tu proyecto SPFx.

## Guía de Uso

### 1. Configuración Inicial
Si es tu primera vez probando este proyecto:
1. Abre el Chat de Copilot (`Ctrl+Alt+I`).
2. Escribe: `@spfx-tester /setup`
   - El agente instalará `jest`, `ts-jest`, `identity-obj-proxy` y configurará todo automáticamente.

### 2. Generar Tests
1. Abre cualquier archivo TypeScript/React (`.ts` o `.tsx`).
2. En el chat, escribe: `@spfx-tester /generate`
   - Opción: `@spfx-tester /generate --mode thorough` para 5 intentos de auto-reparación.

### 3. Ejemplo de Flujo Real

```text
Tú: @spfx-tester /generate

Agente: 🚀 Iniciando generación para HelloWorld.tsx
       📦 Analizadas 4 dependencias importadas
       🔍 Detectado: React Component, SPFx WebPart Context
       
       ✅ Test generado: HelloWorld.test.tsx
       Ejecutando Jest...
       
       ⚠️ El test falló (intento 1/3). 
       Error: "Text 'Welcome' not found in document"
       Analizando causa raíz...
       
       🔄 Corrigiendo test (intento 2)...
       Ajustando selector de testing-library...
       
       ✅ ¡Test Pasado! (Total: 4.2s)
       📊 1 passed, 0 failed
```

## Arquitectura Técnica

El agente opera mediante un sistema de **Inyección de Dependencias** y **Patrón Factoría**:

- **Core Agent**: Orquesta el ciclo de lectura-escritura-ejecución.
- **SourceContextCollector**: "Araña" el sistema de archivos para construir un mapa mental del código.
- **LLM Provider Factory**: Abstrae la inteligencia (Copilot o Azure OpenAI).
- **Test Runner Isolator**: Ejecuta Jest de forma quirúrgica sobre un solo archivo.

### Configuración Avanzada

Puedes personalizar el comportamiento en `settings.json`:
- `spfxTestAgent.maxHealingAttempts`: Número de intentos de auto-corrección (Default: 3).
- `spfxTestAgent.azureOpenAI`: Configuración para usar Azure en lugar de Copilot.
- `spfxTestAgent.testFilePattern`: Patrón de nombrado (ej: `${fileName}.test.${ext}`).

## Solución de Problemas

### "Jest command failed"
Asegúrate de haber ejecutado `@spfx-tester /setup` primero. El agente intentará detectar si faltan paquetes y te ofrecerá instalarlos.

### "Rate Limited"
Si usas la API pública de Copilot mucho, puedes sufrir limitaciones de velocidad. El agente tiene "backoff exponencial" (espera inteligente), pero puedes pausar unos segundos.

### Errores de "getVmContext"
Esto suele ser un conflicto entre Jest 29+ y JSDOM. El agente ahora detecta esto y lo arregla automáticamente instalando el entorno correcto.

---
**Desarrollado con ❤️ para la comunidad de SharePoint Framework.**
Licencia MIT.
