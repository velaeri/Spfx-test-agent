/**
 * Comprehensive VS Code API mock for unit testing.
 * This provides stubs for all vscode APIs used across the extension.
 */

// ─── URI ────────────────────────────────────────────────────────────────────
export class Uri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    readonly fsPath: string;

    private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
        this.scheme = scheme;
        this.authority = authority;
        this.path = path;
        this.query = query;
        this.fragment = fragment;
        this.fsPath = path.replace(/\//g, '\\'); // Windows-style for testing
    }

    static file(path: string): Uri {
        return new Uri('file', '', path, '', '');
    }

    static parse(value: string): Uri {
        return new Uri('file', '', value, '', '');
    }

    static joinPath(base: Uri, ...pathSegments: string[]): Uri {
        const joined = [base.path, ...pathSegments].join('/');
        return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
    }

    toString(): string {
        return `${this.scheme}://${this.path}`;
    }

    with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
        return new Uri(
            change.scheme ?? this.scheme,
            change.authority ?? this.authority,
            change.path ?? this.path,
            change.query ?? this.query,
            change.fragment ?? this.fragment
        );
    }
}

// ─── Enums ──────────────────────────────────────────────────────────────────
export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3
}

export enum ProgressLocation {
    SourceControl = 1,
    Window = 10,
    Notification = 15
}

// ─── CancellationToken ─────────────────────────────────────────────────────
export const CancellationTokenSource = jest.fn().mockImplementation(() => ({
    token: {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn()
    },
    cancel: jest.fn(),
    dispose: jest.fn()
}));

// ─── LanguageModelChatMessage ───────────────────────────────────────────────
export class LanguageModelChatMessage {
    role: string;
    content: string;

    constructor(role: string, content: string) {
        this.role = role;
        this.content = content;
    }

    static User(content: string): LanguageModelChatMessage {
        return new LanguageModelChatMessage('user', content);
    }

    static Assistant(content: string): LanguageModelChatMessage {
        return new LanguageModelChatMessage('assistant', content);
    }
}

// ─── Disposable ─────────────────────────────────────────────────────────────
export class Disposable {
    private callOnDispose: () => void;
    constructor(callOnDispose: () => void) {
        this.callOnDispose = callOnDispose;
    }
    dispose(): void {
        this.callOnDispose();
    }
    static from(...disposables: { dispose: () => void }[]): Disposable {
        return new Disposable(() => disposables.forEach(d => d.dispose()));
    }
}

// ─── EventEmitter ───────────────────────────────────────────────────────────
export class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void): Disposable => {
        this.listeners.push(listener);
        return new Disposable(() => {
            const idx = this.listeners.indexOf(listener);
            if (idx >= 0) this.listeners.splice(idx, 1);
        });
    };
    fire(data: T): void {
        this.listeners.forEach(l => l(data));
    }
    dispose(): void {
        this.listeners = [];
    }
}

// ─── RelativePattern ────────────────────────────────────────────────────────
export class RelativePattern {
    base: string;
    pattern: string;
    constructor(base: any, pattern: string) {
        this.base = typeof base === 'string' ? base : base.uri?.fsPath ?? '';
        this.pattern = pattern;
    }
}

// ─── OutputChannel ──────────────────────────────────────────────────────────
function createMockOutputChannel(): any {
    return {
        appendLine: jest.fn(),
        append: jest.fn(),
        clear: jest.fn(),
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn(),
        name: 'Mock Output Channel'
    };
}

// ─── workspace ──────────────────────────────────────────────────────────────
const mockConfiguration: Record<string, any> = {};

function createMockWorkspaceConfiguration(): any {
    return {
        get: jest.fn((key: string, defaultValue?: any) => {
            return mockConfiguration[key] ?? defaultValue;
        }),
        has: jest.fn((key: string) => key in mockConfiguration),
        inspect: jest.fn(),
        update: jest.fn()
    };
}

export const workspace = {
    workspaceFolders: undefined as any[] | undefined,
    getWorkspaceFolder: jest.fn(),
    getConfiguration: jest.fn(() => createMockWorkspaceConfiguration()),
    findFiles: jest.fn().mockResolvedValue([]),
    openTextDocument: jest.fn().mockResolvedValue({
        getText: jest.fn(() => ''),
        uri: Uri.file('/mock/file.ts'),
        languageId: 'typescript',
        lineCount: 10
    }),
    onDidChangeConfiguration: jest.fn(() => new Disposable(() => {})),
    fs: {
        readFile: jest.fn(),
        writeFile: jest.fn(),
        stat: jest.fn(),
        delete: jest.fn(),
        readDirectory: jest.fn()
    }
};

// ─── window ─────────────────────────────────────────────────────────────────
export const window = {
    activeTextEditor: undefined as any,
    showTextDocument: jest.fn(),
    showInformationMessage: jest.fn().mockResolvedValue(undefined),
    showWarningMessage: jest.fn().mockResolvedValue(undefined),
    showErrorMessage: jest.fn().mockResolvedValue(undefined),
    showQuickPick: jest.fn(),
    showInputBox: jest.fn(),
    createOutputChannel: jest.fn(() => createMockOutputChannel()),
    withProgress: jest.fn(async (_options: any, task: any) => {
        const progress = { report: jest.fn() };
        const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
        return await task(progress, token);
    }),
    createStatusBarItem: jest.fn(() => ({
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn(),
        text: '',
        tooltip: '',
        command: ''
    }))
};

// ─── commands ───────────────────────────────────────────────────────────────
export const commands = {
    registerCommand: jest.fn((_command: string, _callback: (...args: any[]) => any) => {
        return new Disposable(() => {});
    }),
    executeCommand: jest.fn()
};

// ─── chat ───────────────────────────────────────────────────────────────────
export const chat = {
    createChatParticipant: jest.fn((_id: string, _handler: any) => ({
        iconPath: undefined,
        dispose: jest.fn()
    }))
};

// ─── lm (Language Model) ───────────────────────────────────────────────────
export const lm = {
    selectChatModels: jest.fn().mockResolvedValue([])
};

// ─── extensions ─────────────────────────────────────────────────────────────
export const extensions = {
    getExtension: jest.fn(),
    all: []
};

// ─── env ────────────────────────────────────────────────────────────────────
export const env = {
    machineId: 'test-machine-id',
    sessionId: 'test-session-id',
    language: 'en',
    appName: 'VS Code Test',
    uriScheme: 'vscode'
};

// ─── Helpers for tests ──────────────────────────────────────────────────────

/**
 * Reset all mock functions to their initial state.
 * Call this in beforeEach() to ensure test isolation.
 */
export function __resetAllMocks(): void {
    workspace.workspaceFolders = undefined;
    workspace.getWorkspaceFolder.mockReset();
    workspace.getConfiguration.mockReturnValue(createMockWorkspaceConfiguration());
    workspace.findFiles.mockResolvedValue([]);
    workspace.onDidChangeConfiguration.mockReturnValue(new Disposable(() => {}));

    window.activeTextEditor = undefined;
    window.showTextDocument.mockReset();
    window.showInformationMessage.mockReset().mockResolvedValue(undefined);
    window.showWarningMessage.mockReset().mockResolvedValue(undefined);
    window.showErrorMessage.mockReset().mockResolvedValue(undefined);
    window.createOutputChannel.mockReturnValue(createMockOutputChannel());
    window.withProgress.mockImplementation(async (_options: any, task: any) => {
        const progress = { report: jest.fn() };
        const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
        return await task(progress, token);
    });

    commands.registerCommand.mockImplementation((_cmd: string) => new Disposable(() => {}));
    commands.executeCommand.mockReset();

    chat.createChatParticipant.mockReturnValue({
        iconPath: undefined,
        dispose: jest.fn()
    });

    lm.selectChatModels.mockResolvedValue([]);
}
