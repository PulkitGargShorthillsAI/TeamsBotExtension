const vscode = require('vscode');

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

  _handleUserMessage(text) {
    // Process the user's message and respond
    const botResponse = `I received your message: "${text}"`;
    
    // Send the bot's response back to the webview
    if (this.view) {
      this.view.webview.postMessage({ 
        command: 'receiveMessage', 
        text: botResponse 
      });
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