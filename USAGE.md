# SPFX Test Agent - Usage Examples

This document provides practical examples of using the SPFX Test Agent extension.

## Prerequisites

Before using the agent, ensure your SPFx project has Jest configured:

```bash
npm install --save-dev jest @types/jest ts-jest @testing-library/react @testing-library/jest-dom
```

Create a `jest.config.js` in your project root:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
  ],
};
```

## Example 1: Simple React Component

### Source File: `HelloWorld.tsx`

```typescript
import * as React from 'react';

export interface IHelloWorldProps {
  name: string;
  onClick?: () => void;
}

export const HelloWorld: React.FC<IHelloWorldProps> = ({ name, onClick }) => {
  return (
    <div className="hello-world">
      <h1>Hello, {name}!</h1>
      {onClick && <button onClick={onClick}>Click Me</button>}
    </div>
  );
};
```

### Usage

1. Open `HelloWorld.tsx` in VS Code
2. Open Chat panel (`Ctrl+Alt+I` or `Cmd+Alt+I`)
3. Type: `@spfx-tester generate`
4. Watch the agent work!

### Expected Workflow

```
Agent: 🚀 Generating Tests for HelloWorld.tsx
       Using agentic workflow with self-healing capabilities...
       
       ✅ Generated test file: HelloWorld.test.tsx
       Running test...
       
       ✅ Test passed successfully!
       Final Results: 4 passed, 4 total
       
       📝 Test file opened: HelloWorld.test.tsx
```

### Generated Test Example

The agent will generate something like:

```typescript
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { HelloWorld } from './HelloWorld';

describe('HelloWorld', () => {
  it('renders with the provided name', () => {
    render(<HelloWorld name="World" />);
    expect(screen.getByText('Hello, World!')).toBeInTheDocument();
  });

  it('renders button when onClick is provided', () => {
    const handleClick = jest.fn();
    render(<HelloWorld name="World" onClick={handleClick} />);
    expect(screen.getByRole('button', { name: 'Click Me' })).toBeInTheDocument();
  });

  it('calls onClick when button is clicked', () => {
    const handleClick = jest.fn();
    render(<HelloWorld name="World" onClick={handleClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Click Me' }));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('does not render button when onClick is not provided', () => {
    render(<HelloWorld name="World" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
```

## Example 2: SPFx Web Part with Context

### Source File: `DocumentViewer.tsx`

```typescript
import * as React from 'react';
import { WebPartContext } from '@microsoft/sp-webpart-base';

export interface IDocumentViewerProps {
  context: WebPartContext;
  libraryUrl: string;
}

export const DocumentViewer: React.FC<IDocumentViewerProps> = ({ context, libraryUrl }) => {
  const [documents, setDocuments] = React.useState<string[]>([]);

  React.useEffect(() => {
    // Fetch documents from SharePoint
    context.spHttpClient.get(libraryUrl, SPHttpClient.configurations.v1)
      .then(response => response.json())
      .then(data => setDocuments(data.value.map((item: any) => item.Title)));
  }, [libraryUrl]);

  return (
    <div className="document-viewer">
      <h2>Documents</h2>
      <ul>
        {documents.map((doc, index) => (
          <li key={index}>{doc}</li>
        ))}
      </ul>
    </div>
  );
};
```

### Usage

1. Open `DocumentViewer.tsx`
2. Type: `@spfx-tester generate`

### What the Agent Does

The agent knows about SPFx patterns and will:
- Mock `@microsoft/sp-webpart-base`
- Mock `@microsoft/sp-http` for SPHttpClient
- Handle async operations properly
- Test the React lifecycle hooks

### Self-Healing Example

If the first test fails (e.g., missing mock), the agent will:

```
Agent: ⚠️ Test failed on attempt 1. Analyzing errors...
       Error Summary: 1 failed, 0 passed
       
       Error: Cannot find module '@microsoft/sp-http'
       
       🔄 Updated test file (attempt 2)
       Running test again...
       
       ✅ Test passed successfully!
       Final Results: 3 passed, 3 total
```

## Example 3: Complex Component with Multiple Dependencies

### Source File: `UserProfile.tsx`

```typescript
import * as React from 'react';
import { SPHttpClient } from '@microsoft/sp-http';
import { PersonaSize, Persona } from '@fluentui/react/lib/Persona';
import { IPersonaProps } from '@fluentui/react/lib/Persona';

export interface IUserProfileProps {
  userId: string;
  httpClient: SPHttpClient;
  onProfileLoad?: (user: any) => void;
}

export const UserProfile: React.FC<IUserProfileProps> = ({ 
  userId, 
  httpClient, 
  onProfileLoad 
}) => {
  const [user, setUser] = React.useState<IPersonaProps | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setLoading(true);
    httpClient.get(`/_api/web/getuserbyid(${userId})`, SPHttpClient.configurations.v1)
      .then(response => {
        if (!response.ok) throw new Error('Failed to fetch user');
        return response.json();
      })
      .then(data => {
        const persona: IPersonaProps = {
          text: data.Title,
          secondaryText: data.Email,
          imageUrl: data.PictureUrl,
        };
        setUser(persona);
        onProfileLoad?.(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [userId, httpClient]);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!user) return null;

  return <Persona {...user} size={PersonaSize.large} />;
};
```

### Agent Workflow

```
Agent: 🚀 Generating Tests for UserProfile.tsx
       
       ✅ Generated test file: UserProfile.test.tsx
       Running test...
       
       ⚠️ Test failed on attempt 1. Analyzing errors...
       Error Summary: 2 failed, 3 passed
       
       Error: SPHttpClient.configurations is undefined
       
       🔄 Updated test file (attempt 2)
       Running test again...
       
       ✅ Test passed successfully!
       Final Results: 5 passed, 5 total
```

The agent will automatically:
- Mock `@microsoft/sp-http` with proper SPHttpClient structure
- Mock `@fluentui/react` components
- Handle async fetch operations
- Test loading, error, and success states
- Test the optional callback

## Tips for Best Results

### 1. Keep Components Focused

The agent works best with components that have a single responsibility:
- ✅ Good: `DocumentList.tsx` - displays a list of documents
- ❌ Harder: `Dashboard.tsx` - displays lists, charts, forms, and modals

### 2. Explicit Props Types

Define clear TypeScript interfaces:
```typescript
// ✅ Good - Clear types
export interface IMyComponentProps {
  title: string;
  count: number;
  onSave: (data: any) => void;
}

// ❌ Harder - Implicit types
export const MyComponent = ({ title, count, onSave }: any) => { ... }
```

### 3. Separate Business Logic

Extract complex logic into separate functions:
```typescript
// ✅ Good - Logic is testable separately
export const calculateTotal = (items: Item[]): number => {
  return items.reduce((sum, item) => sum + item.price, 0);
};

export const ShoppingCart = ({ items }: Props) => {
  const total = calculateTotal(items);
  return <div>Total: ${total}</div>;
};
```

### 4. Standard SPFx Patterns

Follow SPFx conventions:
- Use `WebPartContext` for context
- Use `SPHttpClient` for API calls
- Use Fluent UI components

## Troubleshooting

### Issue: Tests keep failing after 3 attempts

**Solution:**
1. Check if Jest is properly configured
2. Verify all dependencies are installed
3. Review the generated test manually
4. Check for circular dependencies

### Issue: "No GPT-4 model available"

**Solution:**
1. Install GitHub Copilot extension
2. Sign in to GitHub Copilot
3. Verify your subscription is active
4. Restart VS Code

### Issue: Rate limit errors

**Solution:**
- The agent handles this automatically with exponential backoff
- If it persists, wait a few minutes before trying again
- Consider generating tests for fewer components at once

## Advanced Usage

### Customizing the System Prompt

If you need specialized test patterns, you can modify `src/agent/TestAgent.ts`:

```typescript
private buildSystemPrompt(): string {
  return `You are an expert in SharePoint Framework (SPFx) development and testing.
  
  // Add your custom rules here
  - Use custom matchers: expect(element).toHaveCustomProperty()
  - Follow our naming convention: describe('ComponentName - functionality')
  `;
}
```

### Running Tests in CI/CD

Generated tests work in any CI/CD pipeline:

```yaml
# GitHub Actions example
- name: Run Tests
  run: |
    npm install
    npm test
```

## FAQ

**Q: Can I use this with other testing frameworks?**
A: Currently, only Jest is supported. Other frameworks would require modifications to `TestRunner.ts`.

**Q: Does it work with JavaScript files?**
A: The extension focuses on TypeScript/TSX files for better type safety and code generation.

**Q: Can I regenerate tests for the same file?**
A: Yes! The agent will overwrite the existing test file. Make sure to backup any manual changes.

**Q: How long does it take?**
A: Typically 10-30 seconds for simple components. Complex components with self-healing may take 1-2 minutes.

## Examples Repository

For more examples, check out the [examples directory](./examples) with real-world SPFx components and their generated tests.
