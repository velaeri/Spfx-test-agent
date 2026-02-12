@echo off
echo ================================================
echo   ELIMINANDO TODOS LOS ARCHIVOS *.test.*
echo ================================================
echo.

echo [1/2] Limpiando EXTENSION (Spfx-test-agent)...
cd /d "C:\dev\cv\spfx_test_agent\Spfx-test-agent"

for /R "src" %%f in (*.test.*) do (
    echo Eliminando: %%~nxf
    del /F /Q "%%f" 2>nul
)

del /F /Q "jest.config.js" 2>nul

echo.
echo [2/2] Limpiando PROYECTO WEBPART...
cd /d "C:\dev\SPFX Versions POC\spfx-1.18.2\spfx-1.18.2-webpart"

for /R %%f in (*.test.*) do (
    echo Eliminando: %%~nxf
    del /F /Q "%%f" 2>nul
)

echo.
echo ================================================
echo   ✅ LIMPIEZA COMPLETA
echo ================================================

pause
