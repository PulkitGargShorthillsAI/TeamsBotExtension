// extension.js
const vscode = require('vscode');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { GoogleGenerativeAI } = require('@google/generative-ai');
const AzureDevOpsClient = require('./azureDevOpsClient');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function activate(context) {
  console.log('Teams Bot extension active');
  const provider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("teamsBot.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
}

function deactivate() {}

class ChatViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
    this.pendingTitle = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this._getHtml();

    // Send initial instructions to the user
    webviewView.webview.postMessage({
      command: 'receiveMessage',
      text: `
        <b>Welcome to Teams Bot!</b><br>
        Here are some commands you can use:<br>
        • <code>@create_ticket &lt;title&gt;</code> - Create a new ticket.<br>
        • <code>@view_tickets</code> - View your open tickets.<br>
        Feel free to ask me anything else!
      `
    });

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'sendMessage') {
        this._onUserMessage(msg.text.trim());
      }
    });
  }

  async _onUserMessage(text) {
    try {
      // 1) Handle greetings
      if (/^(hi|hello|hey)$/i.test(text)) {
        this._post('Hello! How can I assist you today?');
        return;
      }

      // 2) Handle @help command
      if (/^@help$/i.test(text)) {
        this._post(`
          <b>Here are the commands you can use:</b><br>
          • <code>@create_ticket &lt;title&gt;</code> - Create a new ticket.<br>
          • <code>@view_tickets</code> - View your open tickets.<br>
          Feel free to ask me anything related to these commands!
        `);
        return;
      }

      // 3) Handle @create_ticket flow
      if (this.pendingTitle) {
        const description = text.trim();
        if (description && !/^(skip|leave it blank|leave blank)$/i.test(description)) {
          const structured = await this._structureDesc(description);
          await this._makeTicket(this.pendingTitle, structured);
        } else {
          await this._makeTicket(this.pendingTitle, "");
        }
        this.pendingTitle = null;
        return;
      }

      const createMatch = text.match(/^@create_ticket\s+(.+)/i);
      if (createMatch) {
        this.pendingTitle = createMatch[1].trim();
        this._post(`Got it! Title: <b>${this.pendingTitle}</b><br>
          Please describe what needs to be done in simple terms, or type "skip", "leave it blank", or "leave blank" to proceed without a description.`);
        return;
      }

      // 4) Handle @view_tickets command
      if (/^@view_tickets$/i.test(text)) {
        await this._showTickets();
        return;
      }

      // 5) Fallback for unrelated questions
      this._post("I am sorry, I don't know the answer.");
    } catch (error) {
      console.error('Error handling user message:', error);
      this._post(`❌ An error occurred: ${error.message}`);
    }
  }

  async _structureDesc(layman) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = `
			You are an assistant that helps write structured Azure DevOps tickets.

			Given that the user says: "${layman}"

			Generate a response in formatted HTML (without wrapping it in \`\`\`html or any code block fences). Use the following structure:

			<b>Aim:</b><br>
			(a short, one-line summary of the task)

			<br><br><b>Acceptance Criteria:</b><br>
			<ul>
			<li>List of concrete requirements that define when this ticket is complete</li>
			</ul>

			<br><b>Outcomes:</b><br>
			<ul>
			<li>What changes or results will be produced once this ticket is done</li>
			</ul>
		`;

    const res = await (await model.generateContent(prompt)).response;
    return res.text().trim();
  }

  async _makeTicket(title, htmlDesc) {
    try {
      const org = process.env.ORG, proj = process.env.AZURE_PROJECT, pat = process.env.AZURE_PAT;
      if (!org || !proj || !pat) throw new Error('Missing ORG/AZURE_PROJECT/AZURE_PAT');
      const email = await this._getEmail();
      const client = new AzureDevOpsClient(org, proj, pat);
      const patch = [
        { op: 'add', path: '/fields/System.Title', value: title },
        { op: 'add', path: '/fields/System.Description', value: htmlDesc },
        { op: 'add', path: '/fields/System.AssignedTo', value: email },
        { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: process.env.DEFAULT_EFFORT || 4 },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: process.env.DEFAULT_PRIORITY || 1 },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Activity', value: process.env.DEFAULT_ACTIVITY || 'Development' }
      ];
      const wi = await client.createWorkItem('Task', patch);
      this._post(`✅ Created <b>#${wi.id}</b> "${title}"<br>${htmlDesc}`);
    } catch (e) {
      this._post(`❌ Error: ${e.message}`);
    }
  }

  async _showTickets() {
    try {
      const org = process.env.ORG, proj = process.env.AZURE_PROJECT, pat = process.env.AZURE_PAT;
      const email = await this._getEmail();
      const client = new AzureDevOpsClient(org, proj, pat);
      const items = await client.getAssignedWorkItems(email);
      if (items.length === 0) {
        this._post('You have no open tickets.');
      } else {
        const list = items.map(w => `<li>#${w.id} — ${w.fields['System.Title']}</li>`).join('');
        this._post(`<b>Your Tickets:</b><ul>${list}</ul>`);
      }
    } catch (e) {
      this._post(`❌ Couldn’t fetch tickets: ${e.message}`);
    }
  }

  async _chatReply(msg) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    return (await (await model.generateContent(msg)).response).text().trim();
  }

  async _getEmail() {
    try {
      const session = await vscode.authentication.getSession('microsoft', ['email'], { createIfNone: true });
      return session.account.label;
    } catch {
      return null;
    }
  }

  _post(html) {
    this.view?.webview.postMessage({ command: 'receiveMessage', text: html });
  }

  _getHtml() {
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
	  <meta charset="UTF-8">
	  <meta name="viewport" content="width=device-width, initial-scale=1.0">
	  <title>Teams Bot</title>
	  <style>
		body {
		  font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
		  color: var(--vscode-editor-foreground);
		  background-color: var(--vscode-editor-background);
		  padding: 0;
		  margin: 0;
		  display: flex;
		  flex-direction: column;
		  height: 100vh;
		}
  
		#chat-container {
		  display: flex;
		  flex-direction: column;
		  height: 100%;
		}
  
		#messages {
		  flex-grow: 1;
		  overflow-y: auto;
		  padding: 16px;
		  display: flex;
		  flex-direction: column;
		  gap: 12px;
		}
  
		.message {
		  padding: 10px 14px;
		  border-radius: 16px;
		  max-width: 75%;
		  word-wrap: break-word;
		  font-size: 14px;
		  line-height: 1.4;
		  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
		}
  
		.user-message {
		  background-color: var(--vscode-badge-background);
		  color: var(--vscode-badge-foreground);
		  align-self: flex-end;
		  border-bottom-right-radius: 4px;
		}
  
		.bot-message {
		  background-color: var(--vscode-editor-inactiveSelectionBackground);
		  align-self: flex-start;
		  border-bottom-left-radius: 4px;
		}
  
		#input-container {
		  display: flex;
		  padding: 10px 12px;
		  border-top: 1px solid var(--vscode-input-border);
		  background-color: var(--vscode-editor-background);
		}
  
		#message-input {
		  flex-grow: 1;
		  padding: 8px 12px;
		  margin-right: 10px;
		  border: 1px solid var(--vscode-input-border);
		  background-color: var(--vscode-input-background);
		  color: var(--vscode-input-foreground);
		  border-radius: 20px;
		  font-size: 14px;
		}
  
		button {
		  padding: 8px 16px;
		  background-color: var(--vscode-button-background);
		  color: var(--vscode-button-foreground);
		  border: none;
		  border-radius: 20px;
		  cursor: pointer;
		  font-size: 14px;
		}
  
		button:hover {
		  background-color: var(--vscode-button-hoverBackground);
		}
	  </style>
	</head>
	<body>
	  <div id="chat-container">
		<div id="messages"></div>
		<div id="input-container">
		  <input type="text" id="message-input" placeholder="Type a message..." />
		  <button id="send-button">Send</button>
		</div>
	  </div>
	  <script>
		const vscode = acquireVsCodeApi();
		const messagesContainer = document.getElementById('messages');
		const messageInput = document.getElementById('message-input');
		const sendButton = document.getElementById('send-button');
  
		sendButton.addEventListener('click', sendMessage);
		messageInput.addEventListener('keypress', event => {
		  if (event.key === 'Enter') sendMessage();
		});
  
		window.addEventListener('message', event => {
		  const message = event.data;
		  if (message.command === 'receiveMessage') appendMessage(message.text, 'bot');
		});
  
		function sendMessage() {
		  const text = messageInput.value.trim();
		  if (text) {
			appendMessage(text, 'user');
			vscode.postMessage({ command: 'sendMessage', text });
			messageInput.value = '';
		  }
		}
  
		function appendMessage(text, sender) {
		  const messageElement = document.createElement('div');
		  messageElement.classList.add('message', sender === 'user' ? 'user-message' : 'bot-message');
		  messageElement.innerHTML = text;
		  messagesContainer.appendChild(messageElement);
		  messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	  </script>
	</body>
	</html>`;
  }  
}

module.exports = { activate, deactivate };
