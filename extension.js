const vscode = require('vscode');
const AzureDevOpsClient = require('./azureDevOpsClient');  // Ensure this file exists and is in the correct location

const { GoogleGenerativeAI } = require('@google/generative-ai');


const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// Load API key securely
const API_KEY = process.env.GEMINI_API_KEY; // Store it in .env

const genAI = new GoogleGenerativeAI(API_KEY);

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log('Congratulations, your extension Teams Bot is now active!');

  // Register the original hello world command
  const helloWorldCommand = vscode.commands.registerCommand('teamsBot.helloWorld', function () {
    vscode.window.showInformationMessage('Hello World from TeamsBot!');
  });

  // Register the Chat View Provider
  const chatViewProvider = new ChatViewProvider(context.extensionUri);
  
  // Register the view
  const chatView = vscode.window.registerWebviewViewProvider(
    "teamsBot.chatView",
    chatViewProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }
  );

  context.subscriptions.push(helloWorldCommand, chatView);
}

// This method is called when your extension is deactivated
function deactivate() {}

/**
 * Chat view provider for the sidebar
 */
class ChatViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(
      message => {
        switch (message.command) {
          case 'sendMessage':
            this._handleUserMessage(message.text);
            return;
        }
      }
    );
  }

  async _getUserEmail() {
		try {
			// Get the authentication session for the Microsoft provider
			const session = await vscode.authentication.getSession('microsoft', ['email'], { createIfNone: true });

			if (session) {
				// Extract the email from the session's account information
				const email = session.account.label;
				console.log('User email:', email);
				return email;
			} else {
				console.error('No authentication session found.');
				return null;
			}
		} catch (error) {
			console.error('Failed to retrieve user email:', error);
			return null;
		}
	}


  async _generateAzureTicketDescription(title) {
	if (!title || typeof title !== 'string') {
	  return 'Invalid ticket title provided.';
	}
  
	try {
	  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  
	  const prompt = `
			You are an assistant that helps write structured Azure DevOps tickets.

			Given the title: "${title}"

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

  
	  const result = await model.generateContent(prompt);
	  const response = await result.response;
	  const description = response.text().trim();
  
	  return description;
	} catch (error) {
	  console.error('Gemini Error:', error.message);
	  return 'Failed to generate description.';
	}
  }

  async _handleUserMessage(text){

	try {
		// Replace the configuration values below with your actual values
		const organization = process.env.ORG;  // e.g. 'Contoso'
		const project = process.env.AZURE_PROJECT;            
		const workItemType = 'Task';   
		const personalAccessToken=process.env.AZURE_PAT;
		const assignedTo = await this._getUserEmail(); // Get the user's email from the authentication session
		// const assignedTo = process.env.ASSIGNED_TO; // Get the user's email from the authentication session


		if(assignedTo === null || !assignedTo.includes('@shorthills.ai')){
			if (this.view) {
				this.view.webview.postMessage({ 
					command: 'receiveMessage', 
					text: "You are not authorized to create tickets in Azure DevOps."
				});
			}
			return;
		}
		const description = await this._generateAzureTicketDescription(text);


		if (!organization || !project || !personalAccessToken) {
			throw new Error('Missing required environment variables: ORG, AZURE_PROJECT, AZURE_PAT');
		}
		
		// Instantiate the AzureDevOpsClient
		const client = new AzureDevOpsClient(organization, project, personalAccessToken);

		const effort = process.env.DEFAULT_EFFORT || 4; // Default to 8 if not set
		const priority = process.env.DEFAULT_PRIORITY || 1; // Default to 2 if not set
		const activity = process.env.DEFAULT_ACTIVITY || "Development"; // Default to "Development" if not set

		const patchDocument = [
			{
				"op": "add",
				"path": "/fields/System.Title",
				"value": `${text}`, // Title of the work item
			},
			{
				"op": "add",
				"path": "/fields/System.Description",
				"value": `${description}`, // Description of the work item
			},
			{
				"op": "add",
				"path": "/fields/System.AssignedTo",
				"value": assignedTo, // Assign the ticket to the specified user
			},
			{
				"op": "add",
				"path": "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate",
				"value": effort, // Set the Original Estimate (in hours)
			},
			{
				"op": "add",
				"path": "/fields/Microsoft.VSTS.Scheduling.CompletedWork",
				"value": 0, // Set the Completed Work (default to 0)
			},
			{
				"op": "add",
				"path": "/fields/Microsoft.VSTS.Common.Priority",
				"value": priority, // Set the Priority
			},
			{
				"op": "add",
				"path": "/fields/Microsoft.VSTS.Common.Activity",
				"value": activity, // Set the Activity
			}
		];

		console.log('Attempting to create a new work item in Azure DevOps...');
		
		// Call the createWorkItem() method which returns a promise.
		const workItem = await client.createWorkItem(workItemType, patchDocument);
		const message = `Work item created by ${assignedTo} successfully with ID: ${workItem.id} with title: ${text}`;
		console.log(message);

		const botResponse = `${message}`;
    
		// Send the bot's response back to the webview
		if (this.view) {
			this.view.webview.postMessage({ 
				command: 'receiveMessage', 
				text: botResponse 
			});
		}
		// vscode.window.showInformationMessage(message);
	} catch (error) {
		console.error('Failed to create the work item:', error);

		if (this.view) {
			this.view.webview.postMessage({ 
				command: 'receiveMessage', 
				text: error.message
			});
		}



		// vscode.window.showErrorMessage(`Failed to create work item: ${error.message}`);
	}

  }

  _getHtmlForWebview() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Chat Bot</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          color: var(--vscode-editor-foreground);
          background-color: var(--vscode-editor-background);
          padding: 0;
          display: flex;
          flex-direction: column;
          height: 100vh;
          margin: 0;
          box-sizing: border-box;
        }
        
        #chat-container {
          display: flex;
          flex-direction: column;
          flex-grow: 1;
          overflow: hidden;
          height: 100%;
        }
        
        #messages {
          flex-grow: 1;
          overflow-y: auto;
          padding: 10px;
          display: flex;
          flex-direction: column;
        }
        
        .message {
          margin-bottom: 10px;
          padding: 8px;
          border-radius: 4px;
          max-width: 85%;
          word-wrap: break-word;
        }
        
        .user-message {
          background-color: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground);
          align-self: flex-end;
        }
        
        .bot-message {
          background-color: var(--vscode-editor-inactiveSelectionBackground);
          align-self: flex-start;
        }
        
        #input-container {
          display: flex;
          padding: 10px;
          border-top: 1px solid var(--vscode-input-border);
        }
        
        #message-input {
          flex-grow: 1;
          padding: 6px 8px;
          margin-right: 8px;
          border: 1px solid var(--vscode-input-border);
          background-color: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border-radius: 4px;
        }
        
        button {
          padding: 6px 12px;
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        
        button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        
        .welcome-message {
          text-align: center;
          margin: 10px;
          color: var(--vscode-descriptionForeground);
        }
      </style>
    </head>
    <body>
      <div id="chat-container">
        <div id="messages">
          <div class="welcome-message">Welcome to Hello Bot! Ask me anything.</div>
        </div>
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
        
        // Send a message when the send button is clicked
        sendButton.addEventListener('click', sendMessage);
        
        // Also send a message when Enter is pressed in the input field
        messageInput.addEventListener('keypress', event => {
          if (event.key === 'Enter') {
            sendMessage();
          }
        });
        
        // Handle incoming messages from the extension
        window.addEventListener('message', event => {
          const message = event.data;
          
          switch (message.command) {
            case 'receiveMessage':
              appendMessage(message.text, 'bot');
              break;
          }
        });
        
        function sendMessage() {
          const text = messageInput.value.trim();
          if (text) {
            // Display the user's message in the chat
            appendMessage(text, 'user');
            
            // Send the message to the extension
            vscode.postMessage({
              command: 'sendMessage',
              text: text
            });
            
            // Clear the input field
            messageInput.value = '';
            // Focus back on the input for convenience
            messageInput.focus();
          }
        }
        
        function appendMessage(text, sender) {
          const messageElement = document.createElement('div');
          messageElement.classList.add('message');
          messageElement.classList.add(sender === 'user' ? 'user-message' : 'bot-message');
          messageElement.textContent = text;
          
          messagesContainer.appendChild(messageElement);
          
          // Scroll to the bottom
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        
        // Focus on input field initially
        messageInput.focus();
      </script>
    </body>
    </html>`;
  }
}

module.exports = {
  activate,
  deactivate
}