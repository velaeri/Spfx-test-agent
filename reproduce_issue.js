const path = require('path');

function getTestFilePath(sourceFilePath, pattern) {
    const dir = path.dirname(sourceFilePath);
    const ext = path.extname(sourceFilePath);
    const baseName = path.basename(sourceFilePath, ext);
    
    // Parse pattern: ${fileName}.test.${ext}
    // Default pattern creates MyComponent.test.tsx from MyComponent.tsx
    let testFileName = pattern
        .replace('${fileName}', baseName)
        .replace('${ext}', ext.substring(1)); // Remove the dot
    
    console.log(`Debug: source=${sourceFilePath}, pattern=${pattern}`);
    console.log(`Debug: ext=${ext}, baseName=${baseName}`);
    console.log(`Debug: testFileName before check=${testFileName}`);
    console.log(`Debug: endsWith(${ext})=${testFileName.endsWith(ext)}`);

    // Ensure proper extension
    if (!testFileName.endsWith(ext)) {
        testFileName += ext;
    }
    
    const testFilePath = path.join(dir, testFileName);
    return testFilePath;
}

// Scenarios
console.log('1. Standard tsx:', getTestFilePath('src/MyComponent.tsx', '${fileName}.test.${ext}'));
console.log('2. Standard ts:', getTestFilePath('src/utils.ts', '${fileName}.test.${ext}'));
console.log('3. Pattern without ext var:', getTestFilePath('src/MyComponent.tsx', '${fileName}.test'));
console.log('4. Hardcoded ext in pattern:', getTestFilePath('src/MyComponent.tsx', '${fileName}.test.tsx'));
console.log('5. Hardcoded ext mismatch:', getTestFilePath('src/MyComponent.ts', '${fileName}.test.tsx'));

// Potential problematic cases
console.log('6. Case sensitivity:', getTestFilePath('src/MyComponent.TSX', '${fileName}.test.${ext}'));
console.log('7. Case sensitivity hardcoded:', getTestFilePath('src/MyComponent.TSX', '${fileName}.test.tsx'));
