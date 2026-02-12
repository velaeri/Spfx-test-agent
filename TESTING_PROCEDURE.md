# Procedimiento de Prueba Honesta para Validar Funcionalidad de Análisis Inteligente

## Objetivo
Verificar que el agente realmente consulta al LLM cuando hay errores de dependencias y aplica las soluciones inteligentemente, en lugar de depender únicamente de versiones hardcoded.

## Pre-requisitos
- Extensión compilada y empaquetada (`npm run deploy`)
- Proyecto SPFx de prueba (cualquier versión 1.14+)
- GitHub Copilot activo y con créditos disponibles

## Pasos del Procedimiento

### 1. Preparar Entorno Limpio

Eliminar todas las dependencias de Jest del proyecto SPFx objetivo para forzar al agente a instalarlas desde cero:

```powershell
cd "ruta\al\proyecto\spfx"

# Editar package.json y eliminar estas dependencias de devDependencies:
# - jest
# - ts-jest
# - @types/jest
# - @testing-library/react
# - @testing-library/jest-dom
# - @testing-library/user-event
# - identity-obj-proxy
# - react-test-renderer
# - @types/react-test-renderer

# Eliminar archivos de configuración
Remove-Item jest.config.js -ErrorAction SilentlyContinue
Remove-Item jest.setup.js -ErrorAction SilentlyContinue

# Reinstalar dependencias (sin Jest)
npm install
```

### 2. Documentar Contexto del Proyecto

Antes de ejecutar, anota las versiones críticas que el LLM debería considerar:
- **React version**: (ej: 17.0.1, 18.2.0)
- **SPFx version**: (ej: 1.18.2, 1.19.0)
- **Node version**: `node --version`
- **TypeScript version**: del package.json

### 3. Ejecutar el Agente

1. Recargar VS Code para activar la nueva versión de la extensión:
   - `Ctrl+Shift+P` → "Developer: Reload Window"

2. Abrir un archivo fuente del WebPart (ej: `HelloWorldWebPart.ts`)

3. Abrir Chat de Copilot:
   - `Ctrl+Alt+I` (Windows/Linux)
   - `Cmd+Alt+I` (Mac)

4. Ejecutar comando:
   ```
   @spfx-tester /generate
   ```

### 4. Observar y Validar

Durante la ejecución, el chat debe mostrar **estos mensajes clave** si el sistema inteligente funciona:

#### ❌ Si NO funciona (sistema antiguo):
```
📦 Installing ts-jest...
✅ Dependencies installed
```
(No menciona análisis con IA, usa versiones hardcoded)

#### ✅ Si SÍ funciona (sistema inteligente):
```
📦 Installing ts-jest...
⚠️ Installation failed. Analyzing error with AI...
🧠 Consulting AI for solution (attempt 1/2)...
💡 **AI Diagnosis:** [descripción del problema encontrado por el LLM]
📦 Installing: [lista de paquetes con versiones recomendadas por IA]
✅ Applied AI-suggested fix
```

### 5. Verificar Compatibilidad de Versiones

Después de la ejecución exitosa, comprobar que las versiones instaladas son **realmente compatibles** con el contexto del proyecto:

```powershell
cat package.json | Select-String -Pattern "jest|ts-jest|@testing-library"
```

**Ejemplo de validación exitosa para SPFx 1.18.2 + React 17:**
- `jest`: debería ser `^28.x` (no `^29.x` que es incompatible con React 17)
- `ts-jest`: debería ser `^28.0.8`
- `@testing-library/react`: debería ser `^12.x` o `^13.x` (no `^14.x`)

### 6. Ejecutar Test Generado

```powershell
npm test
```

El test debe **compilar y ejecutarse sin errores** de dependencias.

## Criterios de Éxito

✅ **PASS**: El agente consultó al LLM, mostró el diagnóstico, instaló versiones compatibles según el contexto del proyecto, y el test funciona.

❌ **FAIL**: El agente instaló versiones incorrectas (ej: Jest 29 con React 17), o no consultó al LLM cuando falló la instalación inicial.

## Notas Importantes

- **Si el primer intento falla**, el agente tiene hasta 2 reintentos donde consulta al LLM con contexto actualizado.
- **El diagnóstico del LLM debe ser específico**: debe mencionar la versión de React, el conflicto de peerDependencies, etc.
- **No confundir**: Si Jest ya estaba instalado correctamente, el agente no debería consultar al LLM (solo lo hace cuando hay errores).

## Troubleshooting

### "No se ve el mensaje de AI analysis"
- Verifica que eliminaste TODAS las dependencias de Jest del package.json
- Asegúrate de que `jest` no está en node_modules: `ls node_modules\jest` → debe dar error

### "El LLM devuelve versiones incorrectas"
- El prompt del análisis incluye el package.json completo, debería ver las versiones de React/SPFx
- Si persiste, revisar el prompt en `CopilotProvider.analyzeAndFixError()`

### "La extensión no está actualizada"
- Verificar versión instalada: `code --list-extensions --show-versions | Select-String spfx-test-agent`
- Debe mostrar `0.4.27` o superior

---

**Última actualización**: Febrero 12, 2026  
**Versión del procedimiento**: 1.0  
**Autor**: Validación de sistema de análisis inteligente con LLM
