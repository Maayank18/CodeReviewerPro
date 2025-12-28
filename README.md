# AI Code Reviewer 🚀

A professional **AI-powered code review extension for Visual Studio Code**, built using the **Google Gemini API**.
It helps you **analyze, review, and automatically fix code** in files, folders, or entire projects.

---

## ✨ Features (One-line Overview)

1. **Review Current File** – Reviews only the file currently open in the editor.
2. **Review Workspace** – Scans and reviews all supported files in the open project.
3. **Review Any Path** – Reviews a specific file or folder using a relative (`../`) or absolute path.
4. **AI Code Suggestions** – Detects bugs, bad practices, and improvement opportunities.
5. **Auto-Fix Support** – Applies AI-generated fixes with a single click.
6. **Cancellation Support** – Allows you to stop an ongoing review at any time.
7. **Secure API Key Storage** – Stores your Gemini API key securely using VS Code Secrets API.

---

## 🛠️ Installation

### Option 1: VS Code Marketplace (Recommended)

1. Open **Visual Studio Code**
2. Go to **Extensions** (`Ctrl + Shift + X`)
3. Search for **AI Code Reviewer**
4. Click **Install**

---

### Option 2: Install via VSIX (Manual)

```bash
code --install-extension ai-code-reviewer-pro-mg.vsix
```

> 💡 Use this method if you received the `.vsix` file directly from the developer.

---

## 🔑 First-Time Setup (Required)

1. Open **Command Palette** (`Ctrl + Shift + P`)
2. Run **AI Code Reviewer: Set Gemini API Key**
3. Paste your **Google Gemini API key**
4. Press **Enter**

✔ Your key is stored securely
✔ You only need to do this **once**

---

## ▶️ How to Use the Extension

### 1️⃣ Review Current File

* Open any file in the editor
* Press `Ctrl + Shift + P`
* Select **AI Code Reviewer: Review Current File**

---

### 2️⃣ Review Entire Workspace

* Open a project folder in VS Code
* Press `Ctrl + Shift + P`
* Select **AI Code Reviewer: Review Workspace**

---

### 3️⃣ Review a Specific File or Folder (Path Review)

* Press `Ctrl + Shift + P`
* Select **AI Code Reviewer: Review Path**
* Enter a path such as:

  * `../src`
  * `./calculator`
  * `/absolute/path/to/file`

✔ Supports both **files and folders**

---

## 🛠️ Applying Auto-Fixes

* After review completes, if fixes are available:

  * Click **Apply Fixes**
  * Or choose **View Only** to review suggestions manually

✔ Changes are applied safely
✔ File is saved automatically

---

## ⛔ Canceling a Review

* If a review is taking too long:

  * Click **Cancel** on the progress notification
* The scan stops immediately

---

## 🚫 Ignored Files & Folders

By default, the extension **automatically ignores**:

* `node_modules`
* `dist`, `build`
* `.env` files
* Minified or bundled files

You can customize this in **VS Code Settings**.

---

## 📦 Supported File Types

* JavaScript / TypeScript
* HTML / CSS
* JSON
* Python
* React / Vue files

---

## 🔗 Sharing the Extension

### Marketplace Link

```
https://marketplace.visualstudio.com/items?itemName=mayank-garg.ai-code-reviewer-pro-mg
```

### Share via VSIX

* Send the `.vsix` file directly
* User installs using:

```bash
code --install-extension ai-code-reviewer-pro-mg.vsix
```

---

## 🧠 Tips for Best Results

* Review **small files first** for faster results
* Use **path review** for focused analysis
* Apply fixes only after reviewing suggestions

---

## 📩 Feedback

Feedback, issues, and feature requests are welcome via GitHub.

