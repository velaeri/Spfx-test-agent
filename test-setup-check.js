/**
 * Script de prueba para verificar la detección de dependencias
 * Ejecutar con: node test-setup-check.js
 */

const fs = require('fs');
const path = require('path');

const projectRoot = 'c:\\dev\\SPFX Versions POC\\spfx-1.18.2\\spfx-1.18.2-webpart';
const packageJsonPath = path.join(projectRoot, 'package.json');

console.log('=== Test: Verificando detección de dependencias ===\n');

// Leer package.json
if (!fs.existsSync(packageJsonPath)) {
    console.error('❌ No se encontró package.json en:', projectRoot);
    process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

// Combinar todas las dependencias
const allDeps = {
    ...packageJson.dependencies || {},
    ...packageJson.devDependencies || {}
};

console.log('📦 Dependencias encontradas en package.json:\n');
console.log('Total dependencies:', Object.keys(packageJson.dependencies || {}).length);
console.log('Total devDependencies:', Object.keys(packageJson.devDependencies || {}).length);
console.log('Total combinadas:', Object.keys(allDeps).length);
console.log('\n');

// Lista de dependencias que la extensión busca (Jest 29.x por defecto)
const REQUIRED_DEPS = {
    'jest': '^29.7.0',
    '@types/jest': '^29.5.11',
    'ts-jest': '^29.1.1',
    '@testing-library/react': '^14.1.2',
    '@testing-library/jest-dom': '^6.1.5',
    '@testing-library/user-event': '^14.5.1',
    'react-test-renderer': '^17.0.1',
    '@types/react-test-renderer': '^17.0.1',
    'identity-obj-proxy': '^3.0.0'
};

console.log('🔍 Verificando dependencias requeridas:\n');

const missing = [];
const found = [];

for (const [pkg, expectedVersion] of Object.entries(REQUIRED_DEPS)) {
    const installed = allDeps[pkg];
    
    if (!installed) {
        missing.push(pkg);
        console.log(`❌ ${pkg}: NO ENCONTRADO`);
    } else {
        found.push(pkg);
        console.log(`✅ ${pkg}: ${installed} (esperado: ${expectedVersion})`);
    }
}

console.log('\n');
console.log('=== RESUMEN ===');
console.log(`✅ Dependencias instaladas: ${found.length}/${Object.keys(REQUIRED_DEPS).length}`);
console.log(`❌ Dependencias faltantes: ${missing.length}`);

if (missing.length > 0) {
    console.log('\n📋 Dependencias faltantes:');
    missing.forEach(dep => console.log(`   - ${dep}`));
    
    const installCmd = `npm install --save-dev --legacy-peer-deps ${missing.map(dep => `${dep}@${REQUIRED_DEPS[dep]}`).join(' ')}`;
    console.log('\n📦 Comando de instalación:');
    console.log(installCmd);
} else {
    console.log('\n🎉 ¡Todas las dependencias están instaladas!');
}

// Verificar archivos de configuración
console.log('\n=== ARCHIVOS DE CONFIGURACIÓN ===');

const jestConfig = fs.existsSync(path.join(projectRoot, 'jest.config.js'));
const jestSetup = fs.existsSync(path.join(projectRoot, 'jest.setup.js'));
const mockDir = fs.existsSync(path.join(projectRoot, '__mocks__'));

console.log(`jest.config.js: ${jestConfig ? '✅' : '❌'}`);
console.log(`jest.setup.js: ${jestSetup ? '✅' : '❌'}`);
console.log(`__mocks__/: ${mockDir ? '✅' : '❌'}`);

if (jestConfig && jestSetup && mockDir && missing.length === 0) {
    console.log('\n✨ El proyecto está completamente configurado para Jest');
} else {
    console.log('\n⚠️ El proyecto necesita configuración adicional');
}
