import * as vscode from 'vscode';
import path from 'path';
import { promises as fsp } from 'fs';
import { GeminiReviewer } from './geminiReviewer.js';
import { FileScanner } from './fileScanner.js';

let outputChannel;
let geminiReviewer;

// Cancellation token source for the currently running review (if any)
let currentReviewCancellation = null;
// Status bar cancel button (created on activation)
let cancelStatusBarItem = null;

/**
 * Extension activation - called when extension is first activated
 */
export function activate(context) {
    console.log('AI Code Reviewer extension is now active');

    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('AI Code Reviewer');
    geminiReviewer = new GeminiReviewer(outputChannel);

    // Create a cancel status bar item (hidden by default)
    cancelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    cancelStatusBarItem.text = '$(debug-stop) Cancel Review';
    cancelStatusBarItem.command = 'ai-code-reviewer.cancelReview';
    cancelStatusBarItem.tooltip = 'Cancel the running code review';
    // hidden initially - we'll show when a review is active
    cancelStatusBarItem.hide();
    context.subscriptions.push(cancelStatusBarItem);

    // Command: Set API Key
    const setApiKeyCommand = vscode.commands.registerCommand(
        'ai-code-reviewer.setApiKey',
        async () => {
            const apiKey = await vscode.window.showInputBox({
                prompt: 'Enter your Gemini API Key',
                password: true,
                placeHolder: 'AIza...',
                ignoreFocusOut: true
            });

            if (apiKey) {
                await context.secrets.store('gemini-api-key', apiKey);
                vscode.window.showInformationMessage('✅ Gemini API Key saved securely!');
                geminiReviewer.setApiKey(apiKey);
            }
        }
    );

    // Command: Review Current File
    const reviewCurrentFileCommand = vscode.commands.registerCommand(
        'ai-code-reviewer.reviewCurrentFile',
        async () => {
            const editor = vscode.window.activeTextEditor;
            
            if (!editor) {
                vscode.window.showWarningMessage('No active file to review');
                return;
            }

            await reviewFile(editor.document, context);
        }
    );

    // Command: Review Multiple Files in Workspace
    const reviewWorkspaceCommand = vscode.commands.registerCommand(
        'ai-code-reviewer.reviewWorkspace',
        async () => {
            await reviewWorkspace(context);
        }
    );

    // Command: Review a specific file or directory (supports ../ relative paths and absolute paths)
    const reviewPathCommand = vscode.commands.registerCommand(
        'ai-code-reviewer.reviewPath',
        async () => {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                const workspaceRoot = workspaceFolders && workspaceFolders[0] ? workspaceFolders[0].uri.fsPath : undefined;

                // Let user choose typing a path or selecting via dialog
                const choice = await vscode.window.showQuickPick(['Type path', 'Pick via dialog'], {
                    placeHolder: 'Choose how to select the path to review'
                });
                if (!choice) return;

                let inputPath;
                if (choice === 'Type path') {
                    inputPath = await vscode.window.showInputBox({
                        prompt: 'Enter a file or directory path (relative to workspace or absolute). You can use ../ to go up.',
                        placeHolder: 'src/index.js or ../other-project/src'
                    });
                    if (!inputPath) return;
                } else {
                    const uris = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: true,
                        canSelectMany: false,
                        defaultUri: workspaceRoot ? vscode.Uri.file(workspaceRoot) : undefined
                    });
                    if (!uris || uris.length === 0) return;
                    inputPath = uris[0].fsPath;
                }

                // Resolve path relative to workspace if not absolute
                let resolvedPath;
                if (workspaceRoot && !path.isAbsolute(inputPath)) {
                    resolvedPath = path.resolve(workspaceRoot, inputPath);
                } else {
                    resolvedPath = path.resolve(inputPath);
                }

                // If resolved path is outside workspace, ask for confirmation
                if (workspaceRoot && !resolvedPath.startsWith(workspaceRoot)) {
                    const confirm = await vscode.window.showWarningMessage(
                        `The path is outside the workspace: ${resolvedPath}. This will allow the extension to read files outside your project. Proceed?`,
                        'Proceed',
                        'Cancel'
                    );
                    if (confirm !== 'Proceed') {
                        return;
                    }
                }

                // Check path exists and whether it's file or directory
                try {
                    const stat = await fsp.stat(resolvedPath);
                    if (stat.isDirectory()) {
                        outputChannel.clear();
                        outputChannel.show(true);
                        outputChannel.appendLine('='.repeat(80));
                        outputChannel.appendLine(`🔍 REVIEW PATH - Scanning directory: ${resolvedPath}`);
                        outputChannel.appendLine('='.repeat(80));
                        outputChannel.appendLine('');

                        // Attempt to use FileScanner.scanDirectory if available; otherwise use fallback
                        let files = [];
                        if (typeof FileScanner.scanDirectory === 'function') {
                            try {
                                // support new signature (returns array) or legacy signature that pushes into an array
                                const maybe = await FileScanner.scanDirectory(resolvedPath);
                                if (Array.isArray(maybe)) {
                                    files = maybe;
                                } else {
                                    // fallback: call legacy style
                                    files = [];
                                    await FileScanner.scanDirectory(resolvedPath, files, 1000, 0);
                                }
                            } catch (err) {
                                outputChannel.appendLine(`⚠️ FileScanner.scanDirectory failed: ${err.message}. Falling back to internal scanner.`);
                                files = [];
                            }
                        }

                        if (files.length === 0) {
                            // Fallback scanner (respects FileScanner.shouldReviewFile)
                            const maxFiles = 1000;
                            files = await scanDirectoryFallback(resolvedPath, maxFiles);
                        }

                        if (files.length === 0) {
                            vscode.window.showInformationMessage('No files found to review in the specified directory.');
                            return;
                        }

                        // Create cancellation token source for this run
                        const cts = new vscode.CancellationTokenSource();
                        currentReviewCancellation = cts;
                        cancelStatusBarItem.show();

                        // Review each discovered file with progress and cancellation support (with apply fixes)
                        let reviewedCount = 0;
                        let applyAll = false;
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `Reviewing ${files.length} files from selected path...`,
                            cancellable: true
                        }, async (progress, token) => {
                            for (let i = 0; i < files.length; i++) {
                                if (token.isCancellationRequested || cts.token.isCancellationRequested) {
                                    outputChannel.appendLine('\n⚠️ Review cancelled by user.');
                                    break;
                                }

                                const filePath = files[i];
                                try {
                                    const document = await vscode.workspace.openTextDocument(filePath);
                                    outputChannel.appendLine(`\n📁 File ${i + 1}/${files.length}: ${filePath.split(/[\\/]/).pop()}`);
                                    outputChannel.appendLine('-'.repeat(80));
                                    const code = document.getText();

                                    // Respect cancellation point before calling API
                                    if (token.isCancellationRequested || cts.token.isCancellationRequested) {
                                        outputChannel.appendLine('Cancellation requested before sending to API.');
                                        break;
                                    }

                                    const review = await geminiReviewer.reviewCode(filePath, code);
                                    outputChannel.appendLine(review.summary || String(review));

                                    // Print suggestions if any
                                    if (review.suggestions && review.suggestions.length > 0) {
                                        outputChannel.appendLine('\n💡 SUGGESTIONS:\n');
                                        review.suggestions.forEach((s, idx) => {
                                            outputChannel.appendLine(`${idx + 1}. ${s}`);
                                        });
                                    }

                                    // ✅ unified auto-fix detection (use suggestions OR explicit flag)
                                    const autoFixAvailable =
                                        review.canAutoFix ||
                                        (Array.isArray(review.suggestions) && review.suggestions.length > 0);

                                    // Prompt to apply fixes if available
                                    if (autoFixAvailable) {
                                        let applyChoice = null;
                                        if (!applyAll) {
                                            applyChoice = await vscode.window.showInformationMessage(
                                                `Auto-fix available for ${path.basename(filePath)}. Apply fixes?`,
                                                'Apply Fixes',
                                                'Skip',
                                                'Apply All'
                                            );
                                        } else {
                                            applyChoice = 'Apply Fixes';
                                        }

                                        if (applyChoice === 'Apply Fixes' || applyAll) {
                                            try {
                                                await applyFixesToFile(document, review, context);
                                                outputChannel.appendLine(`✅ Applied fixes to ${filePath}`);
                                            } catch (err) {
                                                outputChannel.appendLine(`❌ Failed to apply fixes to ${filePath}: ${err.message}`);
                                            }
                                        } else if (applyChoice === 'Apply All') {
                                            applyAll = true;
                                            try {
                                                await applyFixesToFile(document, review, context);
                                                outputChannel.appendLine(`✅ Applied fixes to ${filePath} (Apply All mode)`);
                                            } catch (err) {
                                                outputChannel.appendLine(`❌ Failed to apply fixes to ${filePath}: ${err.message}`);
                                            }
                                        } else {
                                            outputChannel.appendLine(`⏭️ Skipped applying fixes for ${filePath}`);
                                        }
                                    }

                                    reviewedCount++;
                                } catch (err) {
                                    outputChannel.appendLine(`❌ Skipping ${filePath}: ${err.message}`);
                                }
                                progress.report({ increment: (100 / files.length) });
                            }
                        });

                        // Clean up cancellation state
                        cts.dispose();
                        currentReviewCancellation = null;
                        cancelStatusBarItem.hide();

                        outputChannel.appendLine('\n' + '='.repeat(80));
                        outputChannel.appendLine(`✅ Review complete! Reviewed ${reviewedCount} files (or fewer if skipped).`);
                        outputChannel.appendLine('='.repeat(80));
                        vscode.window.showInformationMessage(`✅ Reviewed ${reviewedCount} files from the selected path. Check output panel for details.`);
                    } else if (stat.isFile()) {
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath));
                        // reuse single-file review (which shows suggestions and apply-fix prompt)
                        await reviewFile(document, context);
                    } else {
                        vscode.window.showErrorMessage('The specified path is neither a file nor a directory.');
                    }
                } catch (err) {
                    vscode.window.showErrorMessage(`Cannot access path: ${err.message}`);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Review Path failed: ${err.message}`);
                outputChannel.appendLine(`❌ ERROR (reviewPath): ${err.stack || err.message}`);
            }
        }
    );

    // Command: Cancel Review (programmatic)
    const cancelCommand = vscode.commands.registerCommand('ai-code-reviewer.cancelReview', () => {
        if (currentReviewCancellation) {
            try {
                currentReviewCancellation.cancel();
                vscode.window.showInformationMessage('Review cancellation requested.');
            } catch (err) {
                vscode.window.showErrorMessage('Failed to cancel review.');
            }
        } else {
            vscode.window.showInformationMessage('No active review to cancel.');
        }
    });

    // Command: Open GitHub issues page (report bug or feedback)
    const reportIssueCommand = vscode.commands.registerCommand('ai-code-reviewer.reportIssue', async () => {
        const repoIssueUrl = 'https://github.com/Maayank18/ai-code-reviewer/issues/new';
        await vscode.env.openExternal(vscode.Uri.parse(repoIssueUrl));
    });

    context.subscriptions.push(
        setApiKeyCommand,
        reviewCurrentFileCommand,
        reviewWorkspaceCommand,
        reviewPathCommand,
        cancelCommand,
        reportIssueCommand,
        outputChannel
    );
}

/**
 * Review a single file
 */
async function reviewFile(document, context) {
    try {
        // Check if API key exists
        const apiKey = await context.secrets.get('gemini-api-key');
        if (!apiKey) {
            const response = await vscode.window.showWarningMessage(
                'Gemini API Key not set. Would you like to set it now?',
                'Set API Key',
                'Cancel'
            );
            if (response === 'Set API Key') {
                await vscode.commands.executeCommand('ai-code-reviewer.setApiKey');
            }
            return;
        }

        geminiReviewer.setApiKey(apiKey);

        const filePath = document.uri.fsPath;
        const fileName = filePath.split(/[\\/]/).pop();
        
        // Check if file should be excluded
        if (!FileScanner.shouldReviewFile(filePath, document.languageId)) {
            vscode.window.showInformationMessage(`Skipping ${fileName} (excluded file type)`);
            return;
        }

        outputChannel.clear();
        outputChannel.show(true);
        outputChannel.appendLine('='.repeat(80));
        outputChannel.appendLine(`🔍 Reviewing: ${fileName}`);
        outputChannel.appendLine('='.repeat(80));
        outputChannel.appendLine('');

        // Create cancellation token source for this run
        const cts = new vscode.CancellationTokenSource();
        currentReviewCancellation = cts;
        cancelStatusBarItem.show();

        // Show progress — cancellable
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Reviewing ${fileName}...`,
            cancellable: true
        }, async (progress, token) => {
            progress.report({ increment: 0 });

            const code = document.getText();

            // honor cancellation before sending to API
            if (token.isCancellationRequested || cts.token.isCancellationRequested) {
                outputChannel.appendLine('⚠️ Review cancelled before sending to API.');
                return;
            }

            const review = await geminiReviewer.reviewCode(filePath, code);

            // honor cancellation after API call as well
            if (token.isCancellationRequested || cts.token.isCancellationRequested) {
                outputChannel.appendLine('⚠️ Review cancelled after receiving response.');
                return;
            }

            progress.report({ increment: 100 });

            // Display review results
            outputChannel.appendLine('📋 REVIEW RESULTS:\n');
            outputChannel.appendLine(review.summary || review);
            
            if (review.suggestions && review.suggestions.length > 0) {
                outputChannel.appendLine('\n💡 SUGGESTIONS:\n');
                review.suggestions.forEach((suggestion, index) => {
                    outputChannel.appendLine(`${index + 1}. ${suggestion}`);
                });
            }

            // ✅ unified auto-fix detection for single-file flow
            const autoFixAvailable =
                review.canAutoFix ||
                (Array.isArray(review.suggestions) && review.suggestions.length > 0);

            if (autoFixAvailable) {
                outputChannel.appendLine('\n✨ Auto-fix available!');
                const applyFix = await vscode.window.showInformationMessage(
                    'Code review complete! Apply suggested fixes?',
                    'Apply Fixes',
                    'View Only'
                );

                if (applyFix === 'Apply Fixes') {
                    await applyFixesToFile(document, review, context);
                }
            } else {
                vscode.window.showInformationMessage('✅ Code review complete! Check output panel.');
            }
        });

        // cleanup cancellation state
        try { cts.dispose(); } catch (_) {}
        currentReviewCancellation = null;
        cancelStatusBarItem.hide();

    } catch (error) {
        outputChannel.appendLine(`\n❌ ERROR: ${error.message}`);
        vscode.window.showErrorMessage(`Review failed: ${error.message}`);
        if (currentReviewCancellation) {
            try { currentReviewCancellation.dispose(); } catch (_) {}
            currentReviewCancellation = null;
            cancelStatusBarItem.hide();
        }
    }
}

/**
 * Apply fixes to file
 */
async function applyFixesToFile(document, review, context) {
    try {
        const apiKey = await context.secrets.get('gemini-api-key');
        geminiReviewer.setApiKey(apiKey);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Applying fixes...',
            cancellable: false
        }, async () => {
            const fixedCode = await geminiReviewer.generateFixedCode(
                document.uri.fsPath,
                document.getText(),
                review
            );

            // Apply the edit
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            edit.replace(document.uri, fullRange, fixedCode);
            
            await vscode.workspace.applyEdit(edit);
            await document.save();

            vscode.window.showInformationMessage('✅ Fixes applied successfully!');
            outputChannel.appendLine('\n✅ Fixes applied and file saved.');
        });

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to apply fixes: ${error.message}`);
        outputChannel.appendLine(`\n❌ Fix application failed: ${error.message}`);
    }
}

/**
 * Review multiple files in workspace
 */
async function reviewWorkspace(context) {
    try {
        const apiKey = await context.secrets.get('gemini-api-key');
        if (!apiKey) {
            const response = await vscode.window.showWarningMessage(
                'Gemini API Key not set. Would you like to set it now?',
                'Set API Key',
                'Cancel'
            );
            if (response === 'Set API Key') {
                await vscode.commands.executeCommand('ai-code-reviewer.setApiKey');
            }
            return;
        }

        geminiReviewer.setApiKey(apiKey);

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showWarningMessage('No workspace folder open');
            return;
        }

        outputChannel.clear();
        outputChannel.show(true);

        // Scan for files
        const files = await FileScanner.scanWorkspace(workspaceFolders[0].uri.fsPath);
        
        if (files.length === 0) {
            vscode.window.showInformationMessage('No files found to review');
            return;
        }

        outputChannel.appendLine('='.repeat(80));
        outputChannel.appendLine(`🔍 WORKSPACE REVIEW - Found ${files.length} files`);
        outputChannel.appendLine('='.repeat(80));
        outputChannel.appendLine('');

        // Create cancellation token source for this run
        const cts = new vscode.CancellationTokenSource();
        currentReviewCancellation = cts;
        cancelStatusBarItem.show();

        // Review each file (with suggestions + apply-fixes support)
        let reviewedCount = 0;
        let applyAll = false; // if user chooses "Apply All" we auto-apply for remaining files
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Reviewing ${files.length} files...`,
            cancellable: true
        }, async (progress, token) => {
            for (let i = 0; i < files.length; i++) {
                if (token.isCancellationRequested || cts.token.isCancellationRequested) {
                    outputChannel.appendLine('\n⚠️ Review cancelled by user.');
                    break;
                }

                const file = files[i];
                
                try {
                    const document = await vscode.workspace.openTextDocument(file);
                    const code = document.getText();
                    
                    outputChannel.appendLine(`\n📁 File ${i + 1}/${files.length}: ${file.split(/[\\/]/).pop()}`);
                    outputChannel.appendLine('-'.repeat(80));
                    
                    // Cancellation check before sending
                    if (token.isCancellationRequested || cts.token.isCancellationRequested) {
                        outputChannel.appendLine('Cancellation requested before sending to API.');
                        break;
                    }

                    const review = await geminiReviewer.reviewCode(file, code);
                    // Print summary (same as before)
                    outputChannel.appendLine(review.summary || String(review));

                    // Print suggestions (if any)
                    if (review.suggestions && review.suggestions.length > 0) {
                        outputChannel.appendLine('\n💡 SUGGESTIONS:\n');
                        review.suggestions.forEach((suggestion, idx) => {
                            outputChannel.appendLine(`${idx + 1}. ${suggestion}`);
                        });
                    }

                    // unified auto-fix detection
                    const autoFixAvailable =
                        review.canAutoFix ||
                        (Array.isArray(review.suggestions) && review.suggestions.length > 0);

                    // If auto-fix possible, prompt the user (or auto-apply if they chose Apply All)
                    if (autoFixAvailable) {
                        let applyChoice = null;
                        if (!applyAll) {
                            applyChoice = await vscode.window.showInformationMessage(
                                `Auto-fix available for ${path.basename(file)}. Apply fixes?`,
                                'Apply Fixes',
                                'Skip',
                                'Apply All'
                            );
                        } else {
                            // if applyAll already enabled, emulate Apply Fixes
                            applyChoice = 'Apply Fixes';
                        }

                        if (applyChoice === 'Apply Fixes' || applyAll) {
                            try {
                                await applyFixesToFile(document, review, context);
                                outputChannel.appendLine(`✅ Applied fixes to ${file}`);
                            } catch (err) {
                                outputChannel.appendLine(`❌ Failed to apply fixes to ${file}: ${err.message}`);
                            }
                        } else if (applyChoice === 'Apply All') {
                            applyAll = true;
                            try {
                                await applyFixesToFile(document, review, context);
                                outputChannel.appendLine(`✅ Applied fixes to ${file} (Apply All mode)`);
                            } catch (err) {
                                outputChannel.appendLine(`❌ Failed to apply fixes to ${file}: ${err.message}`);
                            }
                        } else {
                            outputChannel.appendLine(`⏭️ Skipped applying fixes for ${file}`);
                        }
                    }

                    reviewedCount++;
                    progress.report({ increment: (100 / files.length) });
                } catch (error) {
                    outputChannel.appendLine(`❌ Error reviewing file: ${error.message}`);
                }
            }
        });

        // Clean up cancellation state
        cts.dispose();
        currentReviewCancellation = null;
        cancelStatusBarItem.hide();

        outputChannel.appendLine('\n' + '='.repeat(80));
        outputChannel.appendLine(`✅ Review complete! Reviewed ${reviewedCount} files.`);
        outputChannel.appendLine('='.repeat(80));
        
        vscode.window.showInformationMessage(`✅ Reviewed ${reviewedCount} files. Check output panel for details.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Workspace review failed: ${error.message}`);
        outputChannel.appendLine(`\n❌ ERROR: ${error.message}`);

        // clear cancel state if any error
        if (currentReviewCancellation) {
            try { currentReviewCancellation.dispose(); } catch (_) {}
            currentReviewCancellation = null;
            cancelStatusBarItem.hide();
        }
    }
}

/**
 * Fallback directory scanner (recursively collects files up to maxFiles).
 * Uses FileScanner.shouldReviewFile to filter.
 */
async function scanDirectoryFallback(dirPath, maxFiles = 1000) {
    const results = [];
    async function walker(currentPath) {
        if (results.length >= maxFiles) return;
        let entries;
        try {
            entries = await fsp.readdir(currentPath, { withFileTypes: true });
        } catch (err) {
            outputChannel.appendLine(`⚠️ Failed to read directory ${currentPath}: ${err.message}`);
            return;
        }
        for (const entry of entries) {
            if (results.length >= maxFiles) break;
            const full = path.join(currentPath, entry.name);
            try {
                if (entry.isDirectory()) {
                    // Basic skip for common heavy directories
                    if (/(node_modules|\.git|dist|build)/i.test(entry.name)) {
                        continue;
                    }
                    await walker(full);
                } else if (entry.isFile()) {
                    if (FileScanner.shouldReviewFile(full, '')) {
                        results.push(full);
                    }
                }
            } catch (err) {
                outputChannel.appendLine(`⚠️ Error processing ${full}: ${err.message}`);
            }
        }
    }
    await walker(dirPath);
    return results;
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
    if (cancelStatusBarItem) {
        cancelStatusBarItem.dispose();
    }
    if (currentReviewCancellation) {
        try { currentReviewCancellation.dispose(); } catch (_) {}
    }
}
