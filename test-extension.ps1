# Script de prueba automatizada de la extensión
$ErrorActionPreference = "Continue"

Write-Host "=== TEST SPFX TEST AGENT EXTENSION ===" -ForegroundColor Cyan
Write-Host ""

$projectPath = "c:\dev\SPFX Versions POC\spfx-1.18.2\spfx-1.18.2-webpart"

# 1. Verificar estado actual
Write-Host "1. Estado del proyecto SPFx:" -ForegroundColor Yellow
Write-Host "   Path: $projectPath" -ForegroundColor Gray

Set-Location $projectPath

# 2. Verificar package.json
Write-Host "2. Dependencias actuales:" -ForegroundColor Yellow
$packageJson = Get-Content "package.json" | ConvertFrom-Json
$hasJest = $packageJson.devDependencies.PSObject.Properties.Name -contains "jest"
$hasTsJest = $packageJson.devDependencies.PSObject.Properties.Name -contains "ts-jest"
$hasTestingLibrary = $packageJson.devDependencies.PSObject.Properties.Name -contains "@testing-library/react"

Write-Host "   - jest: $(if($hasJest){'✅ ' + $packageJson.devDependencies.jest}else{'❌ NO INSTALADO'})" -ForegroundColor $(if($hasJest){'Green'}else{'Red'})
Write-Host "   - ts-jest: $(if($hasTsJest){'✅ ' + $packageJson.devDependencies.'ts-jest'}else{'❌ NO INSTALADO'})" -ForegroundColor $(if($hasTsJest){'Green'}else{'Red'})
Write-Host "   - @testing-library/react: $(if($hasTestingLibrary){'✅'}else{'❌ NO INSTALADO'})" -ForegroundColor $(if($hasTestingLibrary){'Green'}else{'Red'})

# 3. Intentar ejecutar test
Write-Host ""
Write-Host "3. Intentando ejecutar test sin dependencias:" -ForegroundColor Yellow
$testResult = npx jest src/index.test.ts 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✅ Test ejecutado correctamente" -ForegroundColor Green
} else {
    Write-Host "   ❌ Test falló (esperado sin ts-jest):" -ForegroundColor Red
    Write-Host "   $testResult" -ForegroundColor Gray
}

# 4. Simular comando de instalación que generaría el LLM
Write-Host ""
Write-Host "4. Comando que debería generar la extensión:" -ForegroundColor Yellow
$installCmd = "npm install --save-dev --legacy-peer-deps jest@^28.1.3 ts-jest@^28.0.8 @types/jest@^28.1.8 @testing-library/react@^13.4.0 @testing-library/jest-dom@^5.16.5 @testing-library/user-event@^14.4.3 react-test-renderer@^17.0.1 @types/react-test-renderer@^17.0.1 identity-obj-proxy@^3.0.0"
Write-Host "   $installCmd" -ForegroundColor Cyan

# 5. Preguntar si instalar
Write-Host ""
$response = Read-Host "¿Ejecutar instalación de dependencias? (s/n)"
if ($response -eq 's') {
    Write-Host "   Instalando dependencias..." -ForegroundColor Yellow
    Invoke-Expression $installCmd
    
    Write-Host ""
    Write-Host "5. Verificando instalación:" -ForegroundColor Yellow
    $packageJson = Get-Content "package.json" | ConvertFrom-Json
    $hasTsJest = $packageJson.devDependencies.PSObject.Properties.Name -contains "ts-jest"
    Write-Host "   - ts-jest: $(if($hasTsJest){'✅ INSTALADO'}else{'❌ FALLO'})" -ForegroundColor $(if($hasTsJest){'Green'}else{'Red'})
    
    # 6. Intentar ejecutar test nuevamente
    Write-Host ""
    Write-Host "6. Intentando ejecutar test CON dependencias:" -ForegroundColor Yellow
    $testResult = npx jest src/index.test.ts 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ Test ejecutado correctamente" -ForegroundColor Green
    } else {
        Write-Host "   ⚠️ Test ejecutado pero con errores:" -ForegroundColor Yellow
        Write-Host "   $testResult" -ForegroundColor Gray
    }
} else {
    Write-Host "   ⏭️ Instalación omitida" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=== FIN DEL TEST ===" -ForegroundColor Cyan
