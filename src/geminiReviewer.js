import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import path from 'path';

export class GeminiReviewer {
    constructor(outputChannel) {
        this.outputChannel = outputChannel;
        this.genAI = null;
        this.model = null;
    }

    setApiKey(apiKey) {
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
            const files = await fs.readdir(dirPath);
            const fileDetails = await Promise.all(
                files.map(async (file) => {
                    const fullPath = path.join(dirPath, file);
                    try {
                        const stats = await fs.stat(fullPath);
                        return {
                            name: file,
                            isDirectory: stats.isDirectory(),
                            size: stats.size
                        };
                    } catch {
                        return { name: file, error: 'Cannot access' };
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
     * Tool: Find files by pattern
     */
    async findFile(pattern, directory = '.') {
        try {
            // Simple pattern matching for basic patterns
            const files = await fs.readdir(directory, { recursive: true });
            const matches = files.filter(file => {
                const fileName = path.basename(file);
                // Convert glob pattern to regex
                const regexPattern = pattern
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.');
                const regex = new RegExp(`^${regexPattern}$`);
                return regex.test(fileName);
            });
            
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
     */
    async reviewCode(filePath, code) {
        if (!this.model) {
            throw new Error('API key not set. Please set your Gemini API key first.');
        }

        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath);

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

            // Handle function calls iteratively
            let maxIterations = 5; // Prevent infinite loops
            let iterations = 0;

            while (response.functionCalls && iterations < maxIterations) {
                iterations++;
                this.outputChannel.appendLine(`🔧 AI is using tools to analyze your code...`);

                const functionCalls = response.functionCalls;
                const functionResponses = [];

                // Execute all function calls
                for (const call of functionCalls) {
                    this.outputChannel.appendLine(`   → Calling: ${call.name}(${JSON.stringify(call.args)})`);
                    const functionResult = await this.executeToolFunction(call.name, call.args);
                    
                    functionResponses.push({
                        functionResponse: {
                            name: call.name,
                            response: functionResult
                        }
                    });
                }

                // Send function results back to model
                result = await chat.sendMessage(functionResponses);
                response = result.response;
            }

            // Parse final response
            const reviewText = response.text();
            return this.parseReview(reviewText);

        } catch (error) {
            this.outputChannel.appendLine(`❌ Review error: ${error.message}`);
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

        // Extract sections from review
        const lines = reviewText.split('\n');
        let currentSection = 'summary';
        
        lines.forEach(line => {
            const lower = line.toLowerCase();
            
            if (lower.includes('overall assessment') || lower.includes('summary')) {
                currentSection = 'summary';
            } else if (lower.includes('issues found') || lower.includes('problems')) {
                currentSection = 'issues';
            } else if (lower.includes('suggestions') || lower.includes('improvements')) {
                currentSection = 'suggestions';
            } else if (lower.includes('can auto-fix') || lower.includes('automatically fix')) {
                review.canAutoFix = lower.includes('yes') || lower.includes('true');
            }

            // Add content to appropriate section
            if (line.trim() && !lower.includes('**') && currentSection !== 'summary') {
                if (currentSection === 'issues') {
                    review.issues.push(line.trim());
                } else if (currentSection === 'suggestions') {
                    review.suggestions.push(line.trim());
                }
            } else if (currentSection === 'summary' && line.trim()) {
                review.summary += line.trim() + ' ';
            }
        });

        review.summary = review.summary.trim() || reviewText.substring(0, 200);
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
        const fileExt = path.extname(filePath);

        const fixPrompt = `Based on the code review, generate the corrected version of this code.

Original File: ${fileName}
\`\`\`${fileExt}
${originalCode}
\`\`\`

Review Summary:
${review.summary}

Issues to Fix:
${review.issues.join('\n')}

Suggestions to Apply:
${review.suggestions.join('\n')}

Generate the complete corrected code. Return ONLY the code, no explanations or markdown formatting.`;

        try {
            const result = await this.model.generateContent(fixPrompt);
            const response = result.response;
            let fixedCode = response.text();

            // Clean up markdown code blocks if present
            fixedCode = fixedCode.replace(/```[a-z]*\n?/g, '').trim();

            return fixedCode;

        } catch (error) {
            this.outputChannel.appendLine(`❌ Fix generation error: ${error.message}`);
            throw error;
        }
    }
}