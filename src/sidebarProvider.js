// src/sidebarProvider.js
import * as vscode from 'vscode';

/**
 * Enhanced SidebarProvider: Complete control center for AI Code Reviewer
 * All commands integrated - no need for command palette!
 */
export class SidebarProvider {
  constructor(context, extensionUri) {
    this.context = context;
    this.extensionUri = extensionUri;
    this.view = null;
    this.reviewInProgress = false;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.command) {
          case 'getApiKey': {
            const key = await this.context.secrets.get('gemini-api-key');
            webviewView.webview.postMessage({ 
              command: 'apiKeyLoaded', 
              value: key || '',
              hasKey: !!key 
            });
            break;
          }

          case 'setApiKey': {
            if (msg.value) {
              await this.context.secrets.store('gemini-api-key', msg.value);
              vscode.window.showInformationMessage('✅ API key saved securely.');
              webviewView.webview.postMessage({ 
                command: 'apiKeySaved', 
                hasKey: true 
              });
            } else {
              await this.context.secrets.delete('gemini-api-key');
              vscode.window.showInformationMessage('✅ API key cleared.');
              webviewView.webview.postMessage({ 
                command: 'apiKeySaved', 
                hasKey: false 
              });
            }
            break;
          }

          case 'reviewCurrentFile': {
            this.updateReviewStatus(true);
            await vscode.commands.executeCommand('ai-code-reviewer.reviewCurrentFile');
            this.updateReviewStatus(false);
            break;
          }

          case 'reviewWorkspace': {
            this.updateReviewStatus(true);
            await vscode.commands.executeCommand('ai-code-reviewer.reviewWorkspace');
            this.updateReviewStatus(false);
            break;
          }

          case 'reviewPath': {
            const path = msg.path || await this.pickPath();
            if (path) {
              this.updateReviewStatus(true);
              await vscode.commands.executeCommand('ai-code-reviewer.reviewPath', path);
              this.updateReviewStatus(false);
            }
            break;
          }

          case 'pickPath': {
            const path = await this.pickPath();
            if (path) {
              webviewView.webview.postMessage({ 
                command: 'pathPicked', 
                path 
              });
            }
            break;
          }

          case 'cancelReview': {
            await vscode.commands.executeCommand('ai-code-reviewer.cancelReview');
            this.updateReviewStatus(false);
            break;
          }

          case 'reportIssue': {
            await vscode.commands.executeCommand('ai-code-reviewer.reportIssue');
            break;
          }

          case 'openSettings': {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'aiCodeReviewer');
            break;
          }

          default:
            console.warn('Unknown sidebar command:', msg.command);
        }
      } catch (err) {
        console.error('Sidebar error:', err);
        vscode.window.showErrorMessage(`Sidebar error: ${err.message}`);
        this.updateReviewStatus(false);
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refresh();
      }
    });
  }

  async pickPath() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const defaultUri = workspaceFolders?.[0]?.uri;
    
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri,
      title: 'Select File or Folder to Review'
    });
    
    return uris?.[0]?.fsPath;
  }

  updateReviewStatus(inProgress) {
    this.reviewInProgress = inProgress;
    if (this.view) {
      this.view.webview.postMessage({ 
        command: 'reviewStatusChanged', 
        inProgress 
      });
    }
  }

  refresh() {
    if (this.view) {
      this.view.webview.postMessage({ command: 'refresh' });
    }
  }

  getHtmlForWebview(webview) {
    return /* html */`
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AI Code Reviewer</title>
<style>
  * { box-sizing: border-box; }
  
  :root {
    --bg-primary: #1e1e1e;
    --bg-secondary: #252526;
    --bg-tertiary: #2d2d30;
    --border: #3e3e42;
    --text-primary: #cccccc;
    --text-secondary: #999999;
    --accent: #0e639c;
    --accent-hover: #1177bb;
    --success: #4ec9b0;
    --warning: #ce9178;
    --error: #f48771;
  }

  html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    font-size: 13px;
    color: var(--text-primary);
    background: transparent;
    overflow-x: hidden;
  }

  .container {
    padding: 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .logo {
    width: 40px;
    height: 40px;
    background: linear-gradient(135deg, var(--accent), var(--success));
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
  }

  .header-text h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .header-text p {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--text-secondary);
  }

  /* Section */
  .section {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
  }

  .section-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .section-title .icon {
    font-size: 16px;
  }

  /* Form Elements */
  label {
    display: block;
    font-size: 11px;
    color: var(--text-secondary);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  select, input[type="text"], input[type="password"] {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    font-size: 13px;
    transition: border-color 0.2s;
  }

  select:focus, input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .input-group {
    position: relative;
    margin-bottom: 12px;
  }

  .input-with-icon {
    position: relative;
  }

  .input-with-icon input {
    padding-right: 36px;
  }

  .input-icon {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.7;
    transition: opacity 0.2s;
  }

  .input-icon:hover {
    opacity: 1;
  }

  /* Buttons */
  .btn {
    width: 100%;
    padding: 10px 16px;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--accent);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--bg-primary);
  }

  .btn-success {
    background: var(--success);
    color: var(--bg-primary);
  }

  .btn-success:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-danger {
    background: var(--error);
    color: white;
  }

  .btn-danger:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-group {
    display: flex;
    gap: 8px;
  }

  .btn-group .btn {
    flex: 1;
  }

  /* Actions Grid */
  .actions-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .action-btn {
    padding: 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .action-btn:hover:not(:disabled) {
    background: var(--bg-primary);
    border-color: var(--accent);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-icon {
    font-size: 20px;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent);
    border-radius: 4px;
    flex-shrink: 0;
  }

  .action-content {
    flex: 1;
    text-align: left;
  }

  .action-content .title {
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 2px;
  }

  .action-content .desc {
    font-size: 11px;
    color: var(--text-secondary);
  }

  /* Status Badge */
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
  }

  .status-badge.success {
    background: rgba(78, 201, 176, 0.15);
    color: var(--success);
  }

  .status-badge.warning {
    background: rgba(206, 145, 120, 0.15);
    color: var(--warning);
  }

  .status-badge.active {
    background: rgba(14, 99, 156, 0.15);
    color: var(--accent);
  }

  /* Progress Indicator */
  .progress-bar {
    width: 100%;
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 8px;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    width: 0%;
    transition: width 0.3s;
    animation: progress-indeterminate 1.5s ease-in-out infinite;
  }

  @keyframes progress-indeterminate {
    0% { width: 0%; margin-left: 0%; }
    50% { width: 50%; margin-left: 25%; }
    100% { width: 0%; margin-left: 100%; }
  }

  /* Footer */
  .footer {
    display: flex;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
    font-size: 11px;
  }

  .footer-link {
    color: var(--accent);
    text-decoration: none;
    cursor: pointer;
    transition: opacity 0.2s;
  }

  .footer-link:hover {
    opacity: 0.8;
  }

  /* Utility */
  .hidden {
    display: none !important;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div class="logo">🤖</div>
      <div class="header-text">
        <h1>AI Code Reviewer</h1>
        <p id="headerStatus">Ready to review your code</p>
      </div>
    </div>

    <!-- API Configuration Section -->
    <div class="section" id="apiSection">
      <div class="section-title">
        <span class="icon">🔑</span>
        <span>API Configuration</span>
        <span id="apiStatusBadge" class="status-badge warning hidden">No Key</span>
      </div>
      
      <div class="input-group">
        <label for="provider">AI Provider</label>
        <select id="provider">
          <option value="google">Google Gemini</option>
          <option value="openai">OpenAI (Coming Soon)</option>
          <option value="custom">Custom (Coming Soon)</option>
        </select>
      </div>

      <div class="input-group">
        <label for="apiKey">API Key</label>
        <div class="input-with-icon">
          <input id="apiKey" type="password" placeholder="Enter your API key..." />
          <button class="input-icon" id="toggleKey" title="Show/Hide">
            <span id="eyeIcon">👁️</span>
          </button>
        </div>
      </div>

      <div class="btn-group">
        <button id="saveKeyBtn" class="btn btn-success">
          <span>💾</span>
          <span>Save Key</span>
        </button>
        <button id="clearKeyBtn" class="btn btn-secondary">
          <span>🗑️</span>
          <span>Clear</span>
        </button>
      </div>
    </div>

    <!-- Review Actions Section -->
    <div class="section" id="actionsSection">
      <div class="section-title">
        <span class="icon">⚡</span>
        <span>Quick Actions</span>
      </div>

      <div class="actions-grid">
        <button class="action-btn" id="reviewCurrentBtn" disabled>
          <div class="action-icon">📄</div>
          <div class="action-content">
            <div class="title">Review Current File</div>
            <div class="desc">Analyze the active file in editor</div>
          </div>
        </button>

        <button class="action-btn" id="reviewWorkspaceBtn" disabled>
          <div class="action-icon">📁</div>
          <div class="action-content">
            <div class="title">Review Workspace</div>
            <div class="desc">Scan all project files</div>
          </div>
        </button>

        <button class="action-btn" id="reviewPathBtn" disabled>
          <div class="action-icon">🎯</div>
          <div class="action-content">
            <div class="title">Review Custom Path</div>
            <div class="desc">Select specific file or folder</div>
          </div>
        </button>
      </div>

      <div id="progressSection" class="hidden" style="margin-top: 12px;">
        <div class="status-badge active">
          <span class="spinner"></span>
          <span>Reviewing code...</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill"></div>
        </div>
        <button class="btn btn-danger" id="cancelBtn" style="margin-top: 8px;">
          <span>⏹️</span>
          <span>Cancel Review</span>
        </button>
      </div>
    </div>

    <!-- Settings & Help Section -->
    <div class="section">
      <div class="section-title">
        <span class="icon">⚙️</span>
        <span>Settings & Help</span>
      </div>

      <div class="actions-grid">
        <button class="action-btn" id="settingsBtn">
          <div class="action-icon" style="background: var(--text-secondary);">⚙️</div>
          <div class="action-content">
            <div class="title">Extension Settings</div>
            <div class="desc">Configure exclusions and options</div>
          </div>
        </button>

        <button class="action-btn" id="feedbackBtn">
          <div class="action-icon" style="background: var(--success);">💬</div>
          <div class="action-content">
            <div class="title">Report Issue / Feedback</div>
            <div class="desc">Help us improve the extension</div>
          </div>
        </button>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <span style="color: var(--text-secondary);">v1.1.0</span>
      <span style="color: var(--border);">•</span>
      <a class="footer-link" id="docsLink">Documentation</a>
      <span style="color: var(--border);">•</span>
      <a class="footer-link" id="githubLink">GitHub</a>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();

  // Elements
  const elements = {
    provider: document.getElementById('provider'),
    apiKey: document.getElementById('apiKey'),
    toggleKey: document.getElementById('toggleKey'),
    eyeIcon: document.getElementById('eyeIcon'),
    saveKeyBtn: document.getElementById('saveKeyBtn'),
    clearKeyBtn: document.getElementById('clearKeyBtn'),
    apiStatusBadge: document.getElementById('apiStatusBadge'),
    headerStatus: document.getElementById('headerStatus'),
    reviewCurrentBtn: document.getElementById('reviewCurrentBtn'),
    reviewWorkspaceBtn: document.getElementById('reviewWorkspaceBtn'),
    reviewPathBtn: document.getElementById('reviewPathBtn'),
    progressSection: document.getElementById('progressSection'),
    cancelBtn: document.getElementById('cancelBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    feedbackBtn: document.getElementById('feedbackBtn'),
    docsLink: document.getElementById('docsLink'),
    githubLink: document.getElementById('githubLink')
  };

  let hasApiKey = false;
  let reviewInProgress = false;

  // Initialize
  vscode.postMessage({ command: 'getApiKey' });

  // Toggle password visibility
  elements.toggleKey.addEventListener('click', () => {
    const isPassword = elements.apiKey.type === 'password';
    elements.apiKey.type = isPassword ? 'text' : 'password';
    elements.eyeIcon.textContent = isPassword ? '🙈' : '👁️';
  });

  // Save API Key
  elements.saveKeyBtn.addEventListener('click', () => {
    const key = elements.apiKey.value.trim();
    if (!key) {
      vscode.postMessage({ command: 'setApiKey', value: '' });
    } else {
      vscode.postMessage({ command: 'setApiKey', value: key });
    }
  });

  // Clear API Key
  elements.clearKeyBtn.addEventListener('click', () => {
    elements.apiKey.value = '';
    vscode.postMessage({ command: 'setApiKey', value: '' });
  });

  // Review Actions
  elements.reviewCurrentBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'reviewCurrentFile' });
  });

  elements.reviewWorkspaceBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'reviewWorkspace' });
  });

  elements.reviewPathBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'reviewPath' });
  });

  elements.cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'cancelReview' });
  });

  // Settings & Help
  elements.settingsBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'openSettings' });
  });

  elements.feedbackBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'reportIssue' });
  });

  elements.docsLink.addEventListener('click', () => {
    vscode.postMessage({ command: 'reportIssue' });
  });

  elements.githubLink.addEventListener('click', () => {
    vscode.postMessage({ command: 'reportIssue' });
  });

  // Update UI based on API key status
  function updateUIState() {
    const actionButtons = [
      elements.reviewCurrentBtn,
      elements.reviewWorkspaceBtn,
      elements.reviewPathBtn
    ];

    actionButtons.forEach(btn => {
      btn.disabled = !hasApiKey || reviewInProgress;
    });

    if (hasApiKey) {
      elements.apiStatusBadge.className = 'status-badge success';
      elements.apiStatusBadge.textContent = '✓ Key Saved';
      elements.apiStatusBadge.classList.remove('hidden');
      elements.headerStatus.textContent = 'Ready to review your code';
    } else {
      elements.apiStatusBadge.className = 'status-badge warning';
      elements.apiStatusBadge.textContent = 'No Key';
      elements.apiStatusBadge.classList.remove('hidden');
      elements.headerStatus.textContent = 'Please set up your API key';
    }

    if (reviewInProgress) {
      elements.progressSection.classList.remove('hidden');
      elements.headerStatus.textContent = 'Review in progress...';
    } else {
      elements.progressSection.classList.add('hidden');
    }
  }

  // Handle messages from extension
  window.addEventListener('message', event => {
    const msg = event.data;
    
    switch (msg.command) {
      case 'apiKeyLoaded':
        elements.apiKey.value = msg.value || '';
        hasApiKey = msg.hasKey;
        updateUIState();
        break;

      case 'apiKeySaved':
        hasApiKey = msg.hasKey;
        updateUIState();
        break;

      case 'reviewStatusChanged':
        reviewInProgress = msg.inProgress;
        updateUIState();
        break;

      case 'refresh':
        vscode.postMessage({ command: 'getApiKey' });
        break;

      default:
        break;
    }
  });

  // Initial state
  updateUIState();
</script>
</body>
</html>
    `;
  }
}