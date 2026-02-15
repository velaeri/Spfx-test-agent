import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger';

/**
 * Represents a node in the dependency graph (a source file)
 */
export interface GraphNode {
    /** Absolute path to the file */
    filePath: string;
    /** Relative path from project root */
    relativePath: string;
    /** Files this file imports (outgoing edges) */
    imports: string[];
    /** Files that import this file (incoming edges) */
    importedBy: string[];
    /** Number of local dependencies (outgoing edges count) */
    dependencyCount: number;
    /** Number of files that depend on this file */
    dependentCount: number;
    /** Topological depth (0 = leaf with no local deps) */
    depth: number;
    /** Whether this file is a leaf node (no local imports) */
    isLeaf: boolean;
    /** Exported symbols (function/class names) extracted via regex */
    exports: string[];
}

/**
 * Result of building the dependency graph
 */
export interface DependencyGraph {
    /** All nodes indexed by absolute file path */
    nodes: Map<string, GraphNode>;
    /** Files sorted by priority: leaves first, then ascending depth */
    prioritizedOrder: string[];
    /** Topological layers: layer 0 = leaves, layer 1 = depends only on leaves, etc. */
    layers: string[][];
    /** Total files in graph */
    totalFiles: number;
    /** Build timestamp */
    timestamp: string;
}

/**
 * DependencyGraphService — Builds a file-level dependency DAG from import/export
 * statements to enable intelligent test generation ordering.
 * 
 * Strategy: Start testing leaf nodes (files with no local imports) first,
 * then work up the tree. This ensures that when we test a file, its dependencies
 * have already been tested and their mocks are well-understood.
 */
export class DependencyGraphService {
    private logger: Logger;

    constructor() {
        this.logger = Logger.getInstance();
    }

    /**
     * Build a dependency graph for all given source files.
     * 
     * @param filePaths - Absolute paths to source files to include in the graph
     * @param projectRoot - Root directory of the project
     * @returns DependencyGraph with prioritized ordering
     */
    buildGraph(filePaths: string[], projectRoot: string): DependencyGraph {
        this.logger.info(`Building dependency graph for ${filePaths.length} files`);

        const nodes = new Map<string, GraphNode>();
        const normalizedRoot = path.normalize(projectRoot);

        // Phase 1: Create nodes and parse imports for each file
        for (const filePath of filePaths) {
            const normalizedPath = path.normalize(filePath);
            const relativePath = path.relative(normalizedRoot, normalizedPath).replace(/\\/g, '/');
            const imports = this.parseImports(normalizedPath, normalizedRoot);
            const exports = this.parseExports(normalizedPath);

            nodes.set(normalizedPath, {
                filePath: normalizedPath,
                relativePath,
                imports: [],
                importedBy: [],
                dependencyCount: 0,
                dependentCount: 0,
                depth: 0,
                isLeaf: true,
                exports
            });
        }

        // Phase 2: Resolve import paths to actual files in the graph
        const fileSet = new Set(filePaths.map(f => path.normalize(f)));

        for (const [filePath, node] of nodes) {
            const rawImports = this.parseImports(filePath, normalizedRoot);

            for (const imp of rawImports) {
                const resolved = this.resolveImportPath(imp, filePath, normalizedRoot);
                if (resolved && fileSet.has(resolved) && resolved !== filePath) {
                    node.imports.push(resolved);
                    // Add reverse edge
                    const targetNode = nodes.get(resolved);
                    if (targetNode) {
                        targetNode.importedBy.push(filePath);
                    }
                }
            }

            node.dependencyCount = node.imports.length;
            node.isLeaf = node.imports.length === 0;
        }

        // Update dependentCount
        for (const node of nodes.values()) {
            node.dependentCount = node.importedBy.length;
        }

        // Phase 3: Compute topological depth using BFS from leaves
        this.computeDepths(nodes);

        // Phase 4: Build layers and prioritized order
        const layers = this.buildLayers(nodes);
        const prioritizedOrder = layers.flat();

        this.logger.info('Dependency graph built', {
            totalFiles: nodes.size,
            layers: layers.length,
            leaves: layers[0]?.length ?? 0
        });

        return {
            nodes,
            prioritizedOrder,
            layers,
            totalFiles: nodes.size,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Parse import statements from a file using regex.
     * Returns raw import specifiers (relative paths only, ignoring node_modules).
     */
    private parseImports(filePath: string, projectRoot: string): string[] {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const imports: string[] = [];

            // Match: import ... from './path' | import ... from '../path'
            // Also: export ... from './path'
            // Also: import('./path') dynamic imports
            // Also: require('./path')
            const patterns = [
                /import\s+(?:[\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]/g,
                /export\s+(?:[\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]/g,
                /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
                /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g
            ];

            for (const pattern of patterns) {
                let match;
                while ((match = pattern.exec(content)) !== null) {
                    const importPath = match[1];
                    // Only include relative imports (local files)
                    if (importPath.startsWith('.')) {
                        imports.push(importPath);
                    }
                }
            }

            return [...new Set(imports)];
        } catch {
            return [];
        }
    }

    /**
     * Parse exported symbols from a file using regex (lightweight AST alternative).
     * Extracts function names, class names, interface names, and const exports.
     */
    private parseExports(filePath: string): string[] {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const exports: string[] = [];

            // export function name
            const funcPattern = /export\s+(?:async\s+)?function\s+(\w+)/g;
            // export class name
            const classPattern = /export\s+(?:abstract\s+)?class\s+(\w+)/g;
            // export interface name
            const ifacePattern = /export\s+interface\s+(\w+)/g;
            // export type name
            const typePattern = /export\s+type\s+(\w+)/g;
            // export const/let/var name
            const constPattern = /export\s+(?:const|let|var)\s+(\w+)/g;
            // export default class/function name
            const defaultPattern = /export\s+default\s+(?:class|function)\s+(\w+)/g;
            // export enum name
            const enumPattern = /export\s+enum\s+(\w+)/g;

            const allPatterns = [funcPattern, classPattern, ifacePattern, typePattern, constPattern, defaultPattern, enumPattern];

            for (const pattern of allPatterns) {
                let match;
                while ((match = pattern.exec(content)) !== null) {
                    exports.push(match[1]);
                }
            }

            return [...new Set(exports)];
        } catch {
            return [];
        }
    }

    /**
     * Resolve a relative import specifier to an absolute file path.
     * Handles: .ts, .tsx, .js, .jsx extensions and /index.* barrel files.
     */
    private resolveImportPath(importSpecifier: string, fromFile: string, projectRoot: string): string | null {
        const dir = path.dirname(fromFile);
        const basePath = path.resolve(dir, importSpecifier);

        const extensions = ['.ts', '.tsx', '.js', '.jsx'];

        // Try exact match with extensions
        for (const ext of extensions) {
            const candidate = basePath + ext;
            if (fs.existsSync(candidate)) {
                return path.normalize(candidate);
            }
        }

        // Try as directory with index file
        for (const ext of extensions) {
            const candidate = path.join(basePath, `index${ext}`);
            if (fs.existsSync(candidate)) {
                return path.normalize(candidate);
            }
        }

        // Try exact path (already has extension)
        if (fs.existsSync(basePath)) {
            return path.normalize(basePath);
        }

        return null;
    }

    /**
     * Compute topological depth for all nodes using BFS from leaves.
     * Leaf nodes (no local imports) get depth 0.
     * A node's depth = max(depth of its imports) + 1.
     */
    private computeDepths(nodes: Map<string, GraphNode>): void {
        // Initialize: leaves at depth 0
        const queue: string[] = [];
        const processed = new Set<string>();

        for (const [filePath, node] of nodes) {
            if (node.isLeaf) {
                node.depth = 0;
                queue.push(filePath);
                processed.add(filePath);
            }
        }

        // BFS: process dependents
        while (queue.length > 0) {
            const current = queue.shift()!;
            const currentNode = nodes.get(current)!;

            for (const dependent of currentNode.importedBy) {
                const depNode = nodes.get(dependent);
                if (!depNode) { continue; }

                // Update depth: max of all import depths + 1
                const newDepth = currentNode.depth + 1;
                if (newDepth > depNode.depth) {
                    depNode.depth = newDepth;
                }

                // Check if all imports of this dependent are processed
                const allImportsProcessed = depNode.imports.every(imp => processed.has(imp));
                if (allImportsProcessed && !processed.has(dependent)) {
                    processed.add(dependent);
                    queue.push(dependent);
                }
            }
        }

        // Handle cycles: any unprocessed node gets max depth + 1
        const maxDepth = Math.max(...Array.from(nodes.values()).map(n => n.depth), 0);
        for (const node of nodes.values()) {
            if (!processed.has(node.filePath)) {
                node.depth = maxDepth + 1;
                this.logger.debug(`Cycle detected: ${node.relativePath} assigned depth ${node.depth}`);
            }
        }
    }

    /**
     * Build layers from computed depths. Layer 0 = leaves, layer N = deepest.
     * Within each layer, sort by dependentCount descending (most-imported first).
     */
    private buildLayers(nodes: Map<string, GraphNode>): string[][] {
        const layerMap = new Map<number, GraphNode[]>();

        for (const node of nodes.values()) {
            if (!layerMap.has(node.depth)) {
                layerMap.set(node.depth, []);
            }
            layerMap.get(node.depth)!.push(node);
        }

        // Sort layer indices ascending (0, 1, 2, ...)
        const sortedLayers = Array.from(layerMap.entries())
            .sort(([a], [b]) => a - b);

        const layers: string[][] = [];

        for (const [_depth, layerNodes] of sortedLayers) {
            // Within layer: sort by dependentCount descending (most-imported first = higher value)
            layerNodes.sort((a, b) => b.dependentCount - a.dependentCount);
            layers.push(layerNodes.map(n => n.filePath));
        }

        return layers;
    }

    /**
     * Format the dependency graph as markdown for chat display.
     */
    formatGraphAsMarkdown(graph: DependencyGraph): string {
        const lines: string[] = [];

        lines.push(`### 🔗 Dependency Graph Analysis\n`);
        lines.push(`| Metric | Value |`);
        lines.push(`|---|---|`);
        lines.push(`| Total files | **${graph.totalFiles}** |`);
        lines.push(`| Layers | **${graph.layers.length}** |`);
        lines.push(`| Leaf nodes (no deps) | **${graph.layers[0]?.length ?? 0}** |`);
        lines.push(``);

        lines.push(`**Processing order (leaves → roots):**\n`);
        for (let i = 0; i < graph.layers.length && i < 5; i++) {
            const layer = graph.layers[i];
            const fileNames = layer.slice(0, 5).map(f => {
                const node = graph.nodes.get(f)!;
                return `\`${node.relativePath}\``;
            });
            const overflow = layer.length > 5 ? ` +${layer.length - 5} more` : '';
            lines.push(`- **Layer ${i}** (${layer.length} files): ${fileNames.join(', ')}${overflow}`);
        }
        if (graph.layers.length > 5) {
            lines.push(`- ... +${graph.layers.length - 5} more layers`);
        }
        lines.push(``);

        return lines.join('\n');
    }
}
