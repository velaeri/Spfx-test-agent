import * as vscode from 'vscode';

// This method is called when the extension is activated
export function activate(context: vscode.ExtensionContext) {
    console.log('SPFX Test Agent extension is now active!');

    // Register the chat participant
    const chatParticipant = vscode.chat.createChatParticipant('spfx-test-agent.chat', handleChatRequest);
    
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
        // Get the user's message
        const userMessage = request.prompt;

        // Send a progress message
        stream.progress('Thinking...');

        // TODO: Implement the actual logic for processing the request
        // For now, provide a basic response
        const response = generateResponse(userMessage);

        // Stream the response
        stream.markdown(response);

        return { metadata: { command: '' } };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return { errorDetails: { message: errorMessage } };
    }
}

/**
 * Generate a response based on the user's message
 * TODO: Replace this with the actual logic that will be provided later
 */
function generateResponse(userMessage: string): string {
    // Basic response for now - will be replaced with actual logic
    const response = `
Hello! I'm the SPFX Test Agent, your assistant for SharePoint Framework testing.

You asked: "${userMessage}"

I'm currently set up and ready to help you with:
- SharePoint Framework (SPFx) development questions
- Testing strategies for SPFx solutions
- Best practices for SPFx development
- Code examples and guidance

**Note:** The specific logic for this chat participant will be implemented based on requirements provided later.

How can I help you with your SPFx testing today?
`;
    
    return response;
}
