# 🧪 Guía de Prueba - SPFX Test Agent Extension

## ✅ Cambios Implementados

### Problema Identificado
La extensión estaba solicitando instalar dependencias aunque ya estaban instaladas. Esto ocurría porque:
1. El LLM podía recomendar paquetes adicionales no listados en las constantes predeterminadas
2. La lógica no diferenciaba entre "Jest instalado con algunas deps faltantes" vs "Jest no instalado"

### Solución Implementada
1. **Agregado logging detallado** para debug en `ProjectSetupService.ts`
2. **Nueva lógica de verificación inteligente**:
   - Si Jest YA está instalado → Solo verifica 3 dependencias CRÍTICAS (`jest`, `@types/jest`, `ts-jest`)
   - Si Jest NO está instalado → Verifica TODAS las dependencias necesarias
3. **Manejo de errores mejorado** cuando el LLM falla o retorna datos inesperados

### Archivos Modificados
- ✅ `src/services/ProjectSetupService.ts` - Lógica de verificación mejorada
- ✅ Agregadas constantes `CRITICAL_DEPENDENCIES` para verificación mínima

---

## 🚀 Cómo Probar la Extensión

### Paso 1: Iniciar la Extensión en Modo Debug

1. En VS Code, asegúrate de estar en la carpeta `Spfx-test-agent`
2. Presiona **F5** (o `Run > Start Debugging`)
3. Esto abrirá una nueva ventana de VS Code con el título `[Extension Development Host]`
4. En la ventana original, verás la consola de debug activa

### Paso 2: Abrir el Proyecto de Prueba

En la ventana de **Extension Development Host**:

1. `File > Open Folder`
2. Selecciona: `c:\dev\SPFX Versions POC\spfx-1.18.2\spfx-1.18.2-webpart`
3. Espera a que VS Code cargue el proyecto

### Paso 3: Verificar Detección de Dependencias

1. Abre el **Copilot Chat** (Ctrl+Alt+I o desde el ícono de chat)
2. Escribe: `@spfx-tester /setup`
3. **Resultado Esperado**:
   ```
   ✅ El entorno Jest ya está completamente configurado!
   Puedes usar @spfx-tester /generate para generar tests.
   ```

4. **Si muestra que faltan dependencias**:
   - Abre `View > Output`
   - Selecciona "SPFX Test Agent" del dropdown
   - Busca logs que digan:
     - `Jest is installed. Checking only critical dependencies...`
     - `Missing critical dependency: <nombre>`
   - **Comparte los logs conmigo para debug**

### Paso 4: Generar Test para un Archivo Individual

1. Abre el archivo: `src/webparts/helloWorld/components/HelloWorld.tsx`
2. En el Copilot Chat, escribe: `@spfx-tester /generate`
3. **Observa el progreso**:
   - Debería decir `✅ Entorno Jest listo`
   - Luego `Generando inicial test...`
   - Luego `Running test...`
4. **Resultado Esperado**:
   - Se crea un archivo `HelloWorld.test.tsx` en la misma carpeta
   - El test se ejecuta automáticamente
   - Si falla, el agente intenta auto-repararlo (hasta 3 intentos)

### Paso 5: Verificar el Test Generado

1. Abre el archivo generado `HelloWorld.test.tsx`
2. En la terminal integrada, ejecuta:
   ```bash
   npm test -- HelloWorld.test.tsx
   ```
3. **Resultado Esperado**:
   - El test debería pasar ✅
   - O el agente debería haber intentado repararlo

### Paso 6: Generar Tests para Todos los Archivos (Opcional)

⚠️ **Advertencia**: Esto puede tomar varios minutos y consumir muchos tokens de API

1. En el Copilot Chat, escribe: `@spfx-tester /generate-all`
2. Confirma cuando te lo pida
3. Observa el progreso en el chat

### Paso 7: Revisar Logs Detallados

1. `View > Output`
2. Selecciona "SPFX Test Agent" del dropdown
3. Verifica:
   - ✅ `Jest is installed. Checking only critical dependencies...`
   - ✅ `All critical Jest dependencies are installed`
   - ✅ `Entorno Jest listo`

---

## 🐛 Posibles Problemas y Soluciones

### Problema: "Faltan X dependencias"

**Diagnóstico**:
1. Revisa el Output Channel "SPFX Test Agent"
2. Busca líneas que digan `Missing dependency detected: <nombre>`
3. Verifica si la dependencia REALMENTE está en `package.json` del proyecto

**Solución**:
- Si la dependencia está instalada pero no se detecta → Bug en la extensión
- Si la dependencia NO está instalada → Ejecuta el comando que sugiere la extensión

### Problema: El LLM no genera código válido

**Síntomas**:
- El test generado tiene errores de sintaxis
- La extensión intenta repararlo pero falla repetidamente

**Solución**:
1. Revisa el Output Channel para ver qué está generando el LLM
2. Considera aumentar `spfx-tester.maxHealingAttempts` en Settings
3. Verifica que Copilot esté activo y tenga acceso a GPT-4

### Problema: Rate Limit Exceeded

**Síntomas**:
- `❌ Límite de Velocidad Excedido`
- `⏸️ Rate limit encountered`

**Solución**:
- Espera unos minutos antes de reintentar
- Reduce el número de archivos en `/generate-all`
- Verifica tu plan de Copilot

---

## 📊 Checklist de Prueba

- [ ] Extensión se inicia sin errores (F5)
- [ ] Proyecto spfx-1.18.2 se abre correctamente
- [ ] `/setup` detecta que Jest YA está instalado ✅
- [ ] `/setup` NO pide instalar dependencias
- [ ] `/generate` genera un test para HelloWorld.tsx
- [ ] El test generado se ejecuta correctamente
- [ ] Si el test falla, el agente intenta repararlo
- [ ] `/generate-all` puede procesar múltiples archivos
- [ ] Los logs en Output Channel son claros y útiles

---

## 📝 Notas Adicionales

### Verificación Manual de Dependencias

Puedes ejecutar este comando para verificar manualmente:

```powershell
cd "c:\dev\SPFX Versions POC\spfx-1.18.2\spfx-1.18.2-webpart"
npm list jest @types/jest ts-jest @testing-library/react @testing-library/jest-dom @testing-library/user-event react-test-renderer @types/react-test-renderer identity-obj-proxy --depth=0
```

### Script de Verificación

También puedes ejecutar el script de prueba:

```powershell
cd "c:\dev\cv\spfx_test_agent\Spfx-test-agent"
node test-setup-check.js
```

Este script verifica manualmente las dependencias sin usar la extensión.

---

## ✅ Resultado Esperado Final

Después de todas las correcciones:

1. ✅ La extensión detecta correctamente que Jest está instalado
2. ✅ NO solicita instalar dependencias que ya están presentes
3. ✅ Genera tests automáticamente para componentes SPFx
4. ✅ El agente puede auto-reparar tests con errores (self-healing)
5. ✅ Los logs son claros y útiles para debug

---

**¿Encontraste algún error?** 
- Comparte los logs del Output Channel "SPFX Test Agent"
- Indica en qué paso falló
- Proporciona el mensaje de error exacto
