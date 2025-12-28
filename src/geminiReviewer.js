import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import path from 'path';

export class GeminiReviewer {
    constructor(outputChannel) {
        this.outputChannel = outputChannel;
        this.genAI = null;
        this.model = null;
        this.apiKey = null;
    }

    setApiKey(apiKey) {
        // store key and initialize client (depends on SDK)
        this.apiKey = apiKey;
        try {
            this.genAI = new GoogleGenerativeAI(apiKey);
            this.model = this.genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 8192,
                }
            });
        } catch (err) {
            // SDK initialization issues should be surfaced but not crash
            this.outputChannel && this.outputChannel.appendLine(`⚠️ Gemini init warning: ${err.message}`);
        }
    }

    /**
     * Define tools/functions that Gemini can use
     */
    getToolDefinitions() {
        return [
            {
                name: 'read_file',
                description: 'Read the contents of a file at the specified path. Use this when you need to examine related files or dependencies.',
                parameters: {
                    type: 'object',
                    properties: {
                        file_path: {
                            type: 'string',
                            description: 'The relative or absolute path to the file to read'
                        }
                    },
                    required: ['file_path']
                }
            },
            {
                name: 'list_directory',
                description: 'List all files in a directory. Useful for understanding project structure.',
                parameters: {
                    type: 'object',
                    properties: {
                        directory_path: {
                            type: 'string',
                            description: 'The path to the directory to list'
                        }
                    },
                    required: ['directory_path']
                }
            },
            {
                name: 'find_file',
                description: 'Search for files by name pattern in the project. Returns matching file paths.',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: {
                            type: 'string',
                            description: 'File name pattern to search for (e.g., "*.config.js" or "package.json")'
                        },
                        directory: {
                            type: 'string',
                            description: 'Directory to search in (optional, defaults to project root)'
                        }
                    },
                    required: ['pattern']
                }
            }
        ];
    }

    /**
     * Execute tool functions called by Gemini
     */
    async executeToolFunction(functionName, args) {
        try {
            switch (functionName) {
                case 'read_file':
                    return await this.readFile(args.file_path);

                case 'list_directory':
                    return await this.listDirectory(args.directory_path);

                case 'find_file':
                    return await this.findFile(args.pattern, args.directory);

                default:
                    return `Error: Unknown function ${functionName}`;
            }
        } catch (error) {
            return `Error executing ${functionName}: ${error.message}`;
        }
    }

    /**
     * Tool: Read file contents
     */
    async readFile(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return {
                success: true,
                path: filePath,
                content: content,
                size: content.length
            };
        } catch (error) {
            return {
                success: false,
                error: `Cannot read file: ${error.message}`
            };
        }
    }

    /**
     * Tool: List directory contents
     */
    async listDirectory(dirPath) {
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            const fileDetails = await Promise.all(
                entries.map(async (entry) => {
                    const fullPath = path.join(dirPath, entry.name);
                    try {
                        const stats = await fs.stat(fullPath);
                        return {
                            name: entry.name,
                            isDirectory: entry.isDirectory(),
                            size: stats.size
                        };
                    } catch {
                        return { name: entry.name, error: 'Cannot access' };
                    }
                })
            );
            return {
                success: true,
                directory: dirPath,
                files: fileDetails
            };
        } catch (error) {
            return {
                success: false,
                error: `Cannot list directory: ${error.message}`
            };
        }
    }

    /**
     * Helper: recursively walk a directory and collect file paths
     */
    async _walkDirectory(dir, maxFiles = 1000) {
        const results = [];
        async function walker(current) {
            if (results.length >= maxFiles) return;
            let entries;
            try {
                entries = await fs.readdir(current, { withFileTypes: true });
            } catch (err) {
                return;
            }
            for (const entry of entries) {
                if (results.length >= maxFiles) break;
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    // skip common heavy dirs
                    if (/(node_modules|\.git|dist|build|coverage|venv|\.next|\.nuxt)/i.test(entry.name)) continue;
                    await walker(full);
                } else if (entry.isFile()) {
                    results.push(full);
                }
            }
        }
        await walker(dir);
        return results;
    }

    /**
     * Tool: Find files by pattern (supports simple glob * and ?)
     */
    async findFile(pattern, directory = '.') {
        try {
            const dirToSearch = directory || '.';
            const allFiles = await this._walkDirectory(dirToSearch, 5000);

            // Convert a simple glob to regex (filename only)
            const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                                   .replace(/\*/g, '.*')
                                   .replace(/\?/g, '.');
            const regex = new RegExp(`^${escaped}$`, 'i');

            const matches = allFiles.filter(f => regex.test(path.basename(f)));
            return {
                success: true,
                pattern: pattern,
                matches: matches
            };
        } catch (error) {
            return {
                success: false,
                error: `Cannot search files: ${error.message}`
            };
        }
    }

    /**
     * Main code review function
     *
     * options: { signal } optionally accepts an AbortSignal (best-effort if underlying SDK supports it)
     */
    async reviewCode(filePath, code, options = {}) {
        if (!this.model) {
            throw new Error('API key not set. Please set your Gemini API key first.');
        }

        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath) || '';

        const prompt = `You are an expert code reviewer. Review the following ${fileExt} file and provide:

1. **Overall Assessment**: Brief summary of code quality (1-2 sentences)
2. **Issues Found**: List any bugs, security vulnerabilities, performance issues, or bad practices
3. **Suggestions**: Concrete improvements with examples
4. **Severity**: Rate each issue as Critical, High, Medium, or Low
5. **Can Auto-Fix**: Indicate if issues can be automatically fixed

File: ${fileName}
\`\`\`${fileExt}
${code}
\`\`\`

If you need to check related files, imports, or project structure, use the available tools:
- read_file(file_path): Read another file
- list_directory(directory_path): List directory contents
- find_file(pattern, directory): Find files by pattern

Provide a structured review with actionable feedback.`;

        try {
            // Start chat with tools
            const chat = this.model.startChat({
                tools: this.getToolDefinitions(),
                history: []
            });

            let result = await chat.sendMessage(prompt);
            let response = result.response;

            // Handle function calls iteratively (best-effort)
            let maxIterations = 6;
            let iterations = 0;

            while (response && response.functionCalls && iterations < maxIterations) {
                iterations++;
                this.outputChannel && this.outputChannel.appendLine(`🔧 AI is using tools to analyze your code...`);

                const functionCalls = response.functionCalls;
                const functionResponses = [];

                for (const call of functionCalls) {
                    this.outputChannel && this.outputChannel.appendLine(`   → Calling: ${call.name}(${JSON.stringify(call.args)})`);
                    const functionResult = await this.executeToolFunction(call.name, call.args);

                    // The SDK may require a different shape; we forward minimal useful data
                    functionResponses.push({
                        name: call.name,
                        result: functionResult
                    });
                }

                // Send function results back to model (SDK specifics may vary)
                result = await chat.sendMessage(functionResponses);
                response = result.response;
            }

            // Parse final response into text (SDK specifics may vary)
            const reviewText = response && typeof response.text === 'function' ? response.text() : (response && response.content) || (typeof result === 'string' ? result : '');

            return this.parseReview(String(reviewText || '').trim());

        } catch (error) {
            this.outputChannel && this.outputChannel.appendLine(`❌ Review error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Parse review response into structured format
     */
    parseReview(reviewText) {
        const review = {
            summary: '',
            issues: [],
            suggestions: [],
            canAutoFix: false,
            rawText: reviewText
        };

        // Extract sections from review in a best-effort manner
        const lines = reviewText.split('\n');
        let currentSection = 'summary';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            const lower = line.toLowerCase();

            if (!line) continue;

            if (lower.includes('overall assessment') || lower.includes('summary') || lower.startsWith('overall:')) {
                currentSection = 'summary';
                continue;
            } else if (lower.includes('issues found') || lower.includes('issues:') || lower.startsWith('bugs')) {
                currentSection = 'issues';
                continue;
            } else if (lower.includes('suggestions') || lower.includes('improvements') || lower.startsWith('suggestion')) {
                currentSection = 'suggestions';
                continue;
            } else if (lower.includes('can auto-fix') || lower.includes('automatically fix')) {
                if (lower.includes('yes') || lower.includes('true')) review.canAutoFix = true;
                continue;
            }

            if (currentSection === 'summary') {
                review.summary += (review.summary ? ' ' : '') + line;
            } else if (currentSection === 'issues') {
                review.issues.push(line);
            } else if (currentSection === 'suggestions') {
                review.suggestions.push(line);
            }
        }

        review.summary = (review.summary || '').trim() || (reviewText.substring(0, 200)).trim();
        return review;
    }

    /**
     * Generate fixed code based on review
     */
    async generateFixedCode(filePath, originalCode, review) {
        if (!this.model) {
            throw new Error('API key not set');
        }

        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath) || '';

        const fixPrompt = `Based on the code review, generate the corrected version of this code.

Original File: ${fileName}
\`\`\`${fileExt}
${originalCode}
\`\`\`

Review Summary:
${review.summary}

Issues to Fix:
${(review.issues || []).join('\n')}

Suggestions to Apply:
${(review.suggestions || []).join('\n')}

Generate the complete corrected code. Return ONLY the code, no explanations or markdown formatting.`;

        try {
            // SDK specifics vary; using a best-effort generic call
            const result = await this.model.generateContent(fixPrompt);
            const response = result && (result.response || result);
            const text = response && typeof response.text === 'function' ? response.text() : (response && response.content) || String(response || '');

            // Clean up markdown code fences if present
            let fixedCode = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
            return fixedCode;
        } catch (error) {
            this.outputChannel && this.outputChannel.appendLine(`❌ Fix generation error: ${error.message}`);
            throw error;
        }
    }
}
