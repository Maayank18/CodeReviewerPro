import * as vscode from 'vscode';
import { GeminiReviewer } from './geminiReviewer.js';
import { FileScanner } from './fileScanner.js';

let outputChannel;
let geminiReviewer;

/**
 * Extension activation - called when extension is first activated
 */
export function activate(context) {
    console.log('AI Code Reviewer extension is now active');

    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('AI Code Reviewer');
    geminiReviewer = new GeminiReviewer(outputChannel);

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

    context.subscriptions.push(
        setApiKeyCommand,
        reviewCurrentFileCommand,
        reviewWorkspaceCommand,
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

        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Reviewing ${fileName}...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0 });

            const code = document.getText();
            const review = await geminiReviewer.reviewCode(filePath, code);

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

            if (review.canAutoFix) {
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

    } catch (error) {
        outputChannel.appendLine(`\n❌ ERROR: ${error.message}`);
        vscode.window.showErrorMessage(`Review failed: ${error.message}`);
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

        // Review each file
        let reviewedCount = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Reviewing ${i + 1}/${files.length} files...`,
                cancellable: false
            }, async (progress) => {
                try {
                    const document = await vscode.workspace.openTextDocument(file);
                    const code = document.getText();
                    
                    outputChannel.appendLine(`\n📁 File ${i + 1}/${files.length}: ${file.split(/[\\/]/).pop()}`);
                    outputChannel.appendLine('-'.repeat(80));
                    
                    const review = await geminiReviewer.reviewCode(file, code);
                    outputChannel.appendLine(review.summary || review);
                    
                    reviewedCount++;
                    progress.report({ increment: (100 / files.length) });
                } catch (error) {
                    outputChannel.appendLine(`❌ Error reviewing file: ${error.message}`);
                }
            });
        }

        outputChannel.appendLine('\n' + '='.repeat(80));
        outputChannel.appendLine(`✅ Review complete! Reviewed ${reviewedCount} files.`);
        outputChannel.appendLine('='.repeat(80));
        
        vscode.window.showInformationMessage(`✅ Reviewed ${reviewedCount} files. Check output panel for details.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Workspace review failed: ${error.message}`);
        outputChannel.appendLine(`\n❌ ERROR: ${error.message}`);
    }
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}