
const path = require('path');

function getTestFilePath(sourceFilePath, pattern) {
    const ext = path.extname(sourceFilePath);
    const baseName = path.basename(sourceFilePath, ext);
    
    // Pattern replacement logic from the source
    let testFileName = pattern
        .replace('${fileName}', baseName)
        .replace('${ext}', ext.substring(1)); // Remove the dot
    
    // The fix logic
    const hasTestExtension = testFileName.match(/\.test\.(ts|tsx)$|\.spec\.(ts|tsx)$/);
    if (!hasTestExtension) {
        testFileName += ext;
    }
    
    return testFileName;
}

// Test cases
const cases = [
    { file: 'MyComponent.tsx', pattern: '${fileName}.test.${ext}', expected: 'MyComponent.test.tsx' },
    { file: 'MyComponent.tsx', pattern: '${fileName}.test', expected: 'MyComponent.test.tsx' }, // Should append ext
    { file: 'MyComponent.ts', pattern: '${fileName}.spec.${ext}', expected: 'MyComponent.spec.ts' },
    { file: 'MyComponent.ts', pattern: '${fileName}.test', expected: 'MyComponent.test.ts' },
    { file: 'Helper.ts', pattern: '${fileName}', expected: 'Helper.ts' } // Edge case, maybe? If it's not a test file, it appends extension.
];

console.log('Verifying fix...');
let failures = 0;
cases.forEach(c => {
    const result = getTestFilePath(c.file, c.pattern);
    if (result !== c.expected) {
        console.error(`FAIL: File=${c.file}, Pattern=${c.pattern}. Expected ${c.expected}, got ${result}`);
        failures++;
    } else {
        console.log(`PASS: ${c.file} -> ${result}`);
    }
});

if (failures === 0) {
    console.log('All checks passed.');
} else {
    process.exit(1);
}
