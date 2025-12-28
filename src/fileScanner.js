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
     * Check if a file should be reviewed based on configuration
     */
    static shouldReviewFile(filePath, languageId = '') {
        const config = vscode.workspace.getConfiguration('aiCodeReviewer');
        const excludePatterns = config.get('excludePatterns', FileScanner.DEFAULT_EXCLUDE_PATTERNS);
        const includedTypes = config.get('includedFileTypes', FileScanner.DEFAULT_INCLUDED_EXTENSIONS);

        // Check exclude patterns
        for (const pattern of excludePatterns) {
            if (FileScanner.matchPattern(filePath, pattern)) {
                return false;
            }
        }

        // Check if file extension is included
        const ext = path.extname(filePath).toLowerCase();
        if (!includedTypes.includes(ext)) {
            return false;
        }

        // Additional checks for specific files to skip
        const fileName = path.basename(filePath).toLowerCase();
        const skipFiles = [
            'package-lock.json',
            'yarn.lock',
            'pnpm-lock.yaml',
            '.gitignore',
            '.eslintrc',
            '.prettierrc'
        ];

        if (skipFiles.includes(fileName)) {
            return false;
        }

        return true;
    }

    /**
     * Simple glob pattern matching
     */
    static matchPattern(filePath, pattern) {
        // Convert glob pattern to regex
        const regexPattern = pattern
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '.')
            .replace(/\./g, '\\.');

        const regex = new RegExp(regexPattern);
        return regex.test(filePath);
    }

    /**
     * Scan workspace for reviewable files
     */
    static async scanWorkspace(workspacePath, maxFiles = 50) {
        const files = [];
        
        try {
            await FileScanner.scanDirectory(workspacePath, files, maxFiles);
        } catch (error) {
            console.error('Error scanning workspace:', error);
        }

        return files;
    }

    /**
     * Recursively scan directory for files
     */
    static async scanDirectory(dirPath, files, maxFiles, depth = 0) {
        // Prevent too deep recursion
        if (depth > 10 || files.length >= maxFiles) {
            return;
        }

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                if (files.length >= maxFiles) {
                    break;
                }

                const fullPath = path.join(dirPath, entry.name);

                // Skip if matches exclude pattern
                const shouldSkip = FileScanner.DEFAULT_EXCLUDE_PATTERNS.some(pattern => {
                    if (pattern.includes('**')) {
                        return FileScanner.matchPattern(fullPath, pattern);
                    }
                    return entry.name === pattern.replace(/\*/g, '');
                });

                if (shouldSkip) {
                    continue;
                }

                if (entry.isDirectory()) {
                    // Recursively scan subdirectory
                    await FileScanner.scanDirectory(fullPath, files, maxFiles, depth + 1);
                } else if (entry.isFile()) {
                    // Check if file should be reviewed
                    if (FileScanner.shouldReviewFile(fullPath)) {
                        files.push(fullPath);
                    }
                }
            }
        } catch (error) {
            // Skip directories we can't access
            console.warn(`Cannot access directory: ${dirPath}`);
        }
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
        const allFiles = await FileScanner.scanWorkspace(workspacePath, 1000);
        return allFiles.filter(file => {
            const fileName = path.basename(file);
            return FileScanner.matchPattern(fileName, pattern);
        });
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
                // Skip excluded directories
                if (entry.isDirectory()) {
                    const shouldSkip = ['node_modules', '.git', 'dist', 'build'].includes(entry.name);
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