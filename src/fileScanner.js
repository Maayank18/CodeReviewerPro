import { promises as fs } from 'fs';
import path from 'path';
import * as vscode from 'vscode';

export class FileScanner {
    /**
     * Default exclude patterns
     */
    static DEFAULT_EXCLUDE_PATTERNS = [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        '**/.env*',
        '**/package-lock.json',
        '**/yarn.lock',
        '**/pnpm-lock.yaml',
        '**/*.min.js',
        '**/*.min.css',
        '**/*.bundle.js',
        '**/.vscode/**',
        '**/.idea/**',
        '**/coverage/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/out/**',
        '**/__pycache__/**',
        '**/*.pyc',
        '**/venv/**',
        '**/env/**'
    ];

    /**
     * Default included file extensions
     */
    static DEFAULT_INCLUDED_EXTENSIONS = [
        '.js',
        '.jsx',
        '.ts',
        '.tsx',
        '.html',
        '.css',
        '.less',
        '.json',
        '.vue',
        '.py',
        '.java',
        '.cpp',
        '.c'
    ];

    /**
     * Convert glob-like pattern (with *, **) to a RegExp.
     * This is a conservative converter that uses `/` as separator.
     */
    static patternToRegex(pattern) {
        // Normalize to forward slashes
        let p = pattern.replace(/\\/g, '/');

        // Escape regex special chars, then replace glob tokens
        // We split on '/' so '**' can be handled as full wildcard
        const segments = p.split('/').map(seg => {
            if (seg === '**') return '.*';
            // escape regex special chars in segment
            const escaped = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&');
            // now replace '*' and '?'
            return escaped.replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '.');
        });

        const regexString = '^' + segments.join('/') + '$';
        return new RegExp(regexString, 'i'); // case-insensitive
    }

    /**
     * Simple glob pattern matching applied to normalized paths.
     */
    static matchPattern(filePath, pattern) {
        if (!pattern) return false;
        const normalized = filePath.replace(/\\/g, '/');
        const regex = FileScanner.patternToRegex(pattern);
        return regex.test(normalized);
    }

    /**
     * Check if a file should be reviewed based on configuration
     */
    static shouldReviewFile(filePath, languageId = '') {
        try {
            const config = vscode.workspace.getConfiguration('aiCodeReviewer');
            const excludePatterns = config.get('excludePatterns', FileScanner.DEFAULT_EXCLUDE_PATTERNS);
            const includedTypes = config.get('includedFileTypes', FileScanner.DEFAULT_INCLUDED_EXTENSIONS);

            // Normalize includedTypes to lower-case extensions (ensure leading dot)
            const normalizedIncluded = (Array.isArray(includedTypes) ? includedTypes : FileScanner.DEFAULT_INCLUDED_EXTENSIONS)
                .map(ext => ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`);

            // Check exclude patterns first
            for (const pattern of excludePatterns) {
                if (FileScanner.matchPattern(filePath, pattern)) {
                    return false;
                }
            }

            // Check file extension
            const ext = (path.extname(filePath) || '').toLowerCase();
            if (!normalizedIncluded.includes(ext)) {
                return false;
            }

            // Skip some known non-source files by name
            const fileName = path.basename(filePath).toLowerCase();
            const skipFiles = new Set([
                'package-lock.json',
                'yarn.lock',
                'pnpm-lock.yaml',
                '.gitignore',
                '.eslintrc',
                '.prettierrc'
            ]);
            if (skipFiles.has(fileName)) return false;

            return true;
        } catch (err) {
            // on error, be conservative and skip the file
            console.warn('shouldReviewFile error:', err);
            return false;
        }
    }

    /**
     * Scan workspace for reviewable files
     * Returns an array of file paths.
     */
    static async scanWorkspace(workspacePath, maxFiles = 50) {
        try {
            // Reuse scanDirectory (it supports being called with only dirPath and returns array)
            const files = await FileScanner.scanDirectory(workspacePath, null, maxFiles, 0);
            return Array.isArray(files) ? files : [];
        } catch (error) {
            console.error('Error scanning workspace:', error);
            return [];
        }
    }

    /**
     * Recursively scan directory for files.
     *
     * Backwards-compatible signature:
     * - scanDirectory(dirPath) -> returns Promise<Array<string>>
     * - scanDirectory(dirPath, filesArray, maxFiles, depth) -> pushes into filesArray (old style)
     */
    static async scanDirectory(dirPath, files = null, maxFiles = 1000, depth = 0) {
        // If caller provided a files array (old signature), use that; otherwise create and return results
        const isLegacyCall = Array.isArray(files);
        const results = isLegacyCall ? files : [];

        // Safety limits
        if (depth > 20) return isLegacyCall ? undefined : results;

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (results.length >= maxFiles) break;

                const fullPath = path.join(dirPath, entry.name);

                // Quick skip for common heavy directories based on name
                if (entry.isDirectory()) {
                    const name = entry.name.toLowerCase();
                    if (/(node_modules|\.git|dist|build|coverage|venv|\.next|\.nuxt)/i.test(name)) {
                        continue;
                    }
                }

                // Check exclude patterns (use workspace config if available)
                const config = vscode.workspace.getConfiguration('aiCodeReviewer');
                const excludePatterns = config.get('excludePatterns', FileScanner.DEFAULT_EXCLUDE_PATTERNS);

                let shouldSkip = false;
                for (const pattern of excludePatterns) {
                    if (FileScanner.matchPattern(fullPath, pattern)) {
                        shouldSkip = true;
                        break;
                    }
                }
                if (shouldSkip) continue;

                if (entry.isDirectory()) {
                    await FileScanner.scanDirectory(fullPath, results, maxFiles, depth + 1);
                } else if (entry.isFile()) {
                    if (FileScanner.shouldReviewFile(fullPath)) {
                        results.push(fullPath);
                    }
                }
            }
        } catch (error) {
            // Skip directories we can't access - log to output if possible
            try {
                const output = vscode.window.createOutputChannel ? vscode.window.createOutputChannel('AI Code Reviewer Scanner') : null;
                if (output) output.appendLine(`⚠️ Cannot access directory: ${dirPath} — ${error.message}`);
            } catch (_) { /* ignore */ }
        }

        return isLegacyCall ? undefined : results;
    }

    /**
     * Get file stats and info
     */
    static async getFileInfo(filePath) {
        try {
            const stats = await fs.stat(filePath);
            const content = await fs.readFile(filePath, 'utf-8');

            return {
                path: filePath,
                name: path.basename(filePath),
                extension: path.extname(filePath),
                size: stats.size,
                lines: content.split('\n').length,
                lastModified: stats.mtime
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Find files by pattern in workspace
     */
    static async findFiles(pattern, workspacePath) {
        try {
            const allFiles = await FileScanner.scanWorkspace(workspacePath, 1000);
            // match pattern against file base name and full path for convenience
            return allFiles.filter(file => {
                const fileName = path.basename(file);
                return FileScanner.matchPattern(fileName, pattern) || FileScanner.matchPattern(file, pattern);
            });
        } catch (err) {
            console.warn('findFiles error:', err);
            return [];
        }
    }

    /**
     * Get project structure summary
     */
    static async getProjectStructure(workspacePath, maxDepth = 3) {
        const structure = {
            name: path.basename(workspacePath),
            type: 'directory',
            children: []
        };

        try {
            await FileScanner.buildStructureTree(workspacePath, structure, 0, maxDepth);
        } catch (error) {
            console.error('Error building project structure:', error);
        }

        return structure;
    }

    /**
     * Build directory tree structure
     */
    static async buildStructureTree(dirPath, node, depth, maxDepth) {
        if (depth >= maxDepth) {
            return;
        }

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                // Skip excluded directories by name
                if (entry.isDirectory()) {
                    const shouldSkip = ['node_modules', '.git', 'dist', 'build', 'coverage', 'venv', '.next', '.nuxt'].includes(entry.name);
                    if (shouldSkip) {
                        continue;
                    }
                }

                const childNode = {
                    name: entry.name,
                    type: entry.isDirectory() ? 'directory' : 'file',
                    children: []
                };

                if (entry.isDirectory()) {
                    const fullPath = path.join(dirPath, entry.name);
                    await FileScanner.buildStructureTree(fullPath, childNode, depth + 1, maxDepth);
                }

                node.children.push(childNode);
            }
        } catch (error) {
            // Skip inaccessible directories
        }
    }

    /**
     * Estimate review time based on file count and size
     */
    static estimateReviewTime(files) {
        // Rough estimate: ~10 seconds per file
        const estimatedSeconds = files.length * 10;
        const minutes = Math.ceil(estimatedSeconds / 60);

        if (minutes < 1) {
            return 'less than a minute';
        } else if (minutes === 1) {
            return '1 minute';
        } else if (minutes < 60) {
            return `${minutes} minutes`;
        } else {
            const hours = Math.floor(minutes / 60);
            const remainingMinutes = minutes % 60;
            return `${hours}h ${remainingMinutes}m`;
        }
    }
}
