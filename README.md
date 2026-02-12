# SPFX Test Agent - Ingeniero de QA Autónomo para SharePoint

**SPFX Test Agent** es una extensión revolucionaria para Visual Studio Code que transforma tu flujo de trabajo de desarrollo en SharePoint Framework.

No es un simple asistente de chat — es un **agente autónomo inteligente** que actúa como un ingeniero de QA senior. Entiende la arquitectura de tu proyecto, analiza las dependencias de tus archivos, genera pruebas unitarias robustas en Jest y **se auto-repara** cuando algo falla.

## 🚀 Novedades en v0.4.26 (Actual)

### 🧠 Inteligencia Contextual Profunda (Nuevo)
El agente ya no "adivina" los mocks. Ahora lee y entiende tu proyecto completo:
- **Análisis de Dependencias**: Lee los archivos importados para entender interfaces y tipos reales (`SourceContextCollector`).
- **Detección de Patrones SPFx**: Identifica automáticamente si es un WebPart, una Extensión, o usa PnP JS / Fluent UI.
- **Contexto de Configuración**: Lee tu `tsconfig.json` y `package.json` para adaptar los tests a tu entorno exacto.

### 🔧 Auto-Reparación de Infraestructura (Nuevo)
El agente distingue entre "tu código está mal" y "tu entorno está mal configured":
- **Fix Automático de JSDOM**: Detecta errores comunes como `getVmContext` y corrige versiones de `jest-environment-jsdom` automáticamente.
- **Gestión de Versiones**: Sugiere e instala versiones de librerías compatibles con tu versión de SPFx (soporte para SPFx 1.14 - 1.18+).

### 🤖 Soporte Multi-Proveedor LLM
- **GitHub Copilot**: Integración nativa sin configuración extra.
- **Azure OpenAI**: (Nuevo) Puedes configurar tu propio endpoint de Azure OpenAI si prefieres usar tus modelos corporativos.

## Características Principales

### 🔄 Ciclo de Vida Autónomo
1. **Analiza**: Lee tu código fuente y navega por sus importaciones.
2. **Genera**: Escribe un test completo usando patrones de mocking específicos para SPFx.
3. **Ejecuta**: Lanza Jest en un proceso aislado solo para ese archivo.
4. **Repara**: Si falla, analiza el error, lee el código del test actual y aplica correcciones (hasta 3/5 intentos según modo).

### 🛡️ Entorno Robusto
- **Setup Inteligente**: El comando `/setup` no solo instala paquetes, sino que configura `jest.config.js`, `jest.setup.js` y scripts de `package.json` optimizados para SharePoint.
- **Limpieza de Ruido**: Los logs de Jest son procesados para que el LLM se enfoque solo en el error real, ignorando ruido de consola.

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
