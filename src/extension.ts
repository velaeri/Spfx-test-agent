import * as vscode from 'vscode';
import * as path from 'path';
import { TestAgent } from './agent/TestAgent';

/**
 * SPFX Test Agent Extension
 * 
 * This extension implements an "Agentic Workflow" for automated test generation.
 * It uses GPT-4 via GitHub Copilot to generate, run, and self-heal unit tests
 * for SharePoint Framework components.
 */

// This method is called when the extension is activated
export function activate(context: vscode.ExtensionContext) {
    console.log('SPFX Test Agent extension is now active!');

    // Register the chat participant with ID 'spfx-tester'
    // This matches the configuration in package.json
    const chatParticipant = vscode.chat.createChatParticipant('spfx-tester', handleChatRequest);
    
    // Set metadata for the participant
    chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');

    context.subscriptions.push(chatParticipant);
}

// This method is called when the extension is deactivated
export function deactivate() {
    console.log('SPFX Test Agent extension is now deactivated');
}

/**
 * Handler for chat requests
 * 
 * This orchestrates the agentic workflow:
 * 1. Identifies the file to test
 * 2. Calls TestAgent to generate and heal tests
 * 3. Streams progress and results back to the user
 */
async function handleChatRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    
    // Check if the request was cancelled
    if (token.isCancellationRequested) {
        return { errorDetails: { message: 'Request cancelled' } };
    }

    try {
        // Get the currently open file
        const activeEditor = vscode.window.activeTextEditor;
        
        if (!activeEditor) {
            stream.markdown('⚠️ Please open a TypeScript/TSX file to generate tests for.\n\n');
            stream.markdown('**Usage:** Open an SPFx component file (e.g., `MyComponent.tsx`) and invoke `@spfx-tester generate`\n');
            return { metadata: { command: '' } };
        }

        const sourceFilePath = activeEditor.document.uri.fsPath;
        const fileName = path.basename(sourceFilePath);

        // Verify it's a TypeScript/TSX file
        if (!fileName.endsWith('.ts') && !fileName.endsWith('.tsx')) {
            stream.markdown('⚠️ This extension only generates tests for TypeScript (.ts) and TSX (.tsx) files.\n\n');
            return { metadata: { command: '' } };
        }

        // Verify it's not already a test file
        if (fileName.includes('.test.') || fileName.includes('.spec.')) {
            stream.markdown('⚠️ This is already a test file. Please open the source file instead.\n\n');
            return { metadata: { command: '' } };
        }

        // Get workspace root
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (!workspaceFolder) {
            stream.markdown('⚠️ No workspace folder found. Please open a workspace/folder.\n\n');
            return { metadata: { command: '' } };
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;

        // Show what we're doing
        stream.markdown(`## 🚀 Generating Tests for \`${fileName}\`\n\n`);
        stream.markdown(`Using agentic workflow with self-healing capabilities...\n\n`);

        // Create and run the test agent
        const agent = new TestAgent();
        
        try {
            const testFilePath = await agent.generateAndHealTest(
                sourceFilePath,
                workspaceRoot,
                stream
            );

            // Open the generated test file
            const testFileUri = vscode.Uri.file(testFilePath);
            const doc = await vscode.workspace.openTextDocument(testFileUri);
            await vscode.window.showTextDocument(doc, { preview: false });

            stream.markdown(`\n📝 Test file opened: \`${path.basename(testFilePath)}\`\n`);

            return { metadata: { command: 'generate' } };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
            
            stream.markdown(`\n❌ **Error:** ${errorMessage}\n\n`);
            
            // Log full error for debugging
            console.error('TestAgent error:', error);
            
            // Provide helpful guidance for common errors
            if (errorMessage.includes('Jest')) {
                stream.markdown('💡 **Tip:** Make sure Jest is installed: `npm install --save-dev jest @types/jest ts-jest`\n');
            } else if (errorMessage.includes('Copilot') || errorMessage.includes('model')) {
                stream.markdown('💡 **Tip:** Ensure GitHub Copilot is installed and you are signed in.\n');
            } else if (errorMessage.includes('Rate limit')) {
                stream.markdown('💡 **Tip:** Rate limit exceeded. Wait a few minutes and try again.\n');
            }

            return { errorDetails: { message: errorMessage } };
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        stream.markdown(`\n❌ **Unexpected error:** ${errorMessage}\n`);
        return { errorDetails: { message: errorMessage } };
    }
}
