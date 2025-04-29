// extension.js
const vscode = require('vscode');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { GoogleGenerativeAI } = require('@google/generative-ai');
const AzureDevOpsClient = require('./azureDevOpsClient');

let fetch; // Will be dynamically imported

async function initializeFetch() {
  if (!fetch) {
    const fetchModule = await import('node-fetch');
    fetch = fetchModule.default;
  }
  return fetch;
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function activate(context) {
  console.log('Teams Bot extension active');
  const provider = new ChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("teamsBot.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Listen for sign-in/sign-out events
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(async (e) => {
      if (e.provider.id === 'microsoft') {
        const session = await vscode.authentication.getSession('microsoft', ['email'], { createIfNone: false });
        if (!session) {
          // User signed out, reset the UI
          provider.resetUI();
        }
      }
    })
  );
}

function deactivate() {}

class ChatViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
    this.pendingTitle = null;
    this.lastBotMessage = '';
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this._getHtml();
  
    webviewView.webview.onDidReceiveMessage(async msg => {
      if (msg.command === 'resetPatToken') {
        await this._resetPatToken();
        this._postMessage({ command: 'clearDropdowns' });
      } else if (msg.command === 'fetchOrganizations') {
        const organizations = await this._getOrganizations();
        this._postMessage({ command: 'populateOrganizations', organizations });
      } else if (msg.command === 'fetchProjects') {
        const projects = await this._getProjects(msg.organization);
        this._postMessage({ command: 'populateProjects', projects });
      } else if (msg.command === 'sendMessage') {
        await this._getEmail();
        const { text, organization, project } = msg;
        if (!organization || !project) {
          this._post('❌ Please select both an organization and a project before proceeding.');
          return;
        }
        this._onUserMessage(text.trim(), organization, project);
      }
    });
  }


  resetUI() {
    // Clear the chat messages
    this._postMessage({ command: 'clearChat' });
  
    // Clear the dropdowns
    this._postMessage({ command: 'clearDropdowns' });
  
    // Show a message to the user
    this._post('You have been signed out. Please sign in again to continue using the chatbot.');
  }

  _postMessage(message) {
    this.view?.webview.postMessage(message);
  }

  _removeJsonWrapper(text) {
    // Check if the text starts with ```json and ends with ```
    const output = text.replace(/```json|```/g, '').trim();

    console.log('Output after removing JSON wrapper:', output);

    
    return output;
  }
  

  async _onUserMessage(text, organization, project) {
    try {
      const email = await this._getEmail();
      if (!email) {
        this._post('❌ Please log in with an authorized email to use the chatbot.');
        await this._logInteraction(email, text, '❌ Please log in with an authorized email to use the chatbot.');
        return;
      }

      if (!organization || !project) {
        this._post('❌ Please select both an organization and a project before proceeding.');
        await this._logInteraction(email, text, '❌ Please select both an organization and a project before proceeding.');
        return;
      }
  
      // Use GEMINI to classify the user's input into multiple commands
      const commands = await this._getCommandsFromGemini(text);
  
      if (!commands || commands.length === 0) {
        const errorMessage = "I couldn't understand your request. Please try again.";
        this._post(errorMessage);
        await this._logInteraction(email, text, errorMessage);
        return;
      }
  
      for (const command of commands) {
        if (command.startsWith('@create_ticket')) {
          const match = command.match(/^@create_ticket\s+(.+?)(?:\s+description\s+'(.+)')?$/i);
          if (match) {
            const title = match[1].trim();
            const description = match[2] ? match[2].trim() : null;
            this.pendingTitle = title;
            if (description) {
              const structured = await this._structureDesc(description);
              await this._makeTicket(title, structured, organization, project);
            } else {
              const message = `Got it! Title: <b>${title}</b><br>
                Please describe what needs to be done in simple terms, or type "skip", "leave it blank", or "leave blank" to proceed without a description.`;
              this._post(message);
              await this._logInteraction(email, text, message);
            }
          }
        } else if (command === '@help') {
          const helpMessage = `
            <b>Here are the commands you can use:</b><br>
            • <code>@create_ticket &lt;title&gt;</code> - Create a new ticket.<br>
            • <code>@view_tickets</code> - View your open tickets.<br>
            • <code>@view_tickets &lt;id&gt;</code> - View details of a specific ticket by ID.<br>
            • <code>#&lt;id&gt; @comment &lt;comment text&gt;</code> - Add a comment to a specific ticket by ID.<br>
            • <code>#&lt;id&gt; @update title "&lt;title&gt;" description "&lt;description&gt;"</code> - Update a ticket's title and description.<br>
            • <code>@board_summary</code> - Show summary of all tickets on the board.<br>
            • <code>@sprint_summary</code> - Show summary of tickets by sprint.<br>
            • <code>@query_tickets &lt;query&gt;</code> - Query tickets by name or sprint (e.g., "show me all tickets of John" or "show me tickets in sprint 2").<br>
            • <code>@help</code> - Get information about available commands.<br>
            Feel free to ask me anything related to these commands!
          `;
          this._post(helpMessage);
          await this._logInteraction(email, text, helpMessage);
        } else if (command === '@view_tickets') {
          await this._showTickets(organization, project);
        } else if (command.startsWith('@view_tickets')) {
          const match = command.match(/^@view_tickets\s+(\d+)$/i);
          if (match) {
            const workItemId = parseInt(match[1], 10);
            await this._showTickets(organization, project, workItemId);
          }
        } else if (command.startsWith('#') && command.includes('@comment')) {
          const match = command.match(/^#(\d+)\s+@comment\s+(.+)/i);
          if (match) {
            const workItemId = parseInt(match[1], 10);
            const commentText = match[2].trim();
            await this._addCommentToWorkItem(workItemId, commentText, organization, project);
          }
        } else if (command.startsWith('#') && command.includes('@update')) {
          const match = command.match(/^#(\d+)\s+@update\s+title\s+'(.+?)'\s+description\s+'(.+?)'/i);
          if (match) {
            const workItemId = parseInt(match[1], 10);
            const title = match[2].trim();
            const description = match[3].trim();
            await this._updateTicket(workItemId, title, description, organization, project);
          } else {
            const errorMessage = "❌ Invalid update command format. Please use: #<id> @update title \"<title>\" description \"<description>\"";
            this._post(errorMessage);
            await this._logInteraction(email, text, errorMessage);
          }
        } else if (command === '@board_summary') {
          await this._showBoardSummary(organization, project);
        } else if (command === '@sprint_summary') {
          await this._showSprintSummary(organization, project);
        } else if (command.startsWith('@query_tickets')) {
          const query = command.substring('@query_tickets '.length).trim();
          await this._processTicketQuery(query, organization, project);
        } else {
          const errorMessage = `I couldn't understand the command: ${command}`;
          this._post(errorMessage);
          await this._logInteraction(email, text, errorMessage);
        }
      }
    } catch (error) {
      console.error('Error handling user message:', error);
      const errorMessage = `❌ An error occurred: ${error.message}`;
      this._post(errorMessage);
      await this._logInteraction(email, text, errorMessage);
    }
  }

  _getLastBotMessage() {
    // Get the last message from the messages container
    const messages = document.getElementById('messages');
    if (!messages) return '';
    
    const botMessages = messages.getElementsByClassName('bot-message');
    if (botMessages.length === 0) return '';
    
    return botMessages[botMessages.length - 1].innerHTML;
  }

  async _getCommandsFromGemini(userMessage) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const prompt = `
      You are an intelligent command parser for a task management system. Your role is to map user messages into strict predefined commands.

      Available Commands:
      - @help → Provide help information.
      - @view_tickets → View all assigned tickets.
      - @view_tickets <id> → View a specific ticket by ID.
      - @create_ticket <title> description "<description>" → Create a new ticket.
      - #<id> @comment <comment text> → Add a comment to a ticket.
      - #<id> @update title "<title>" description "<description>" → Update a ticket.
      - @board_summary → Show summary of all tickets on the board.
      - @sprint_summary → Show summary of tickets by sprint.
      - @query_tickets <query> → Query tickets based on user name or sprint.

      Strict Rules:
      - If multiple commands are mentioned in a single message, split them into separate outputs in order.
      - Always output a JSON array of only command strings. No explanation or extra text.
      - If the user gives a casual or layman description for creating or updating a ticket:
        - Create a short, professional, formal title summarizing the task.
        - Write a clear, well-phrased formal description based on the user's input.
        - Avoid copying informal or casual language directly.
      - If details are missing, make reasonable formal assumptions based on the context.
      - For ticket queries, convert natural language into @query_tickets command with the exact query text.

      Examples:

      User: "Show me all tickets of John"
      Output: ["@query_tickets show me all tickets of John"]

      User: "Show me tickets of Sarah in sprint 2"
      Output: ["@query_tickets show me tickets of Sarah in sprint 2"]

      User: "Show me all tickets in sprint 3"
      Output: ["@query_tickets show me all tickets in sprint 3"]

      User: "Show my tickets"
      Output: ["@view_tickets"]

      User: "Show 1345"
      Output: ["@view_tickets 1345"]

      User: "Create a ticket, I built a chatbot using Gemini and Pinecone, tested it fully."
      Output: ["@create_ticket Chatbot Development Using Gemini and Pinecone description \'Developed a chatbot leveraging Gemini LLM and Pinecone as a vector store. Completed unit testing to ensure functionality.\'"]

      User: "Update ticket 1348, stored PAT token locally instead of MySQL"
      Output: ["#1348 @update title \'Store PAT Token Locally\' description \'Implemented functionality to securely store the PAT token locally within the VS Code extension, removing dependency on a remote MySQL server.\'"]

      User: "Comment on ticket 1234 that this needs urgent attention and then show it to me"
      Output: ["#1234 @comment this needs urgent attention", "@view_tickets 1234"]

      User: "Create a ticket for migrating database to MongoDB and show me my tickets"
      Output: ["@create_ticket Database Migration to MongoDB description \"Migrated existing database infrastructure to MongoDB to enhance scalability and flexibility.\"", "@view_tickets"]

      User: "Add a comment to ticket 5678 saying this issue is critical"
      Output: ["#5678 @comment this issue is critical"]

      User message:
      "${userMessage}"

      Instructions:
      - Parse the message following the above rules.
      - If the message implies multiple commands, output all commands separately in sequence.
      - Always generate a formal title and description if user message is casual.
      - Output only a clean JSON array of valid commands.
      `;

      const response = await model.generateContent(prompt);
      console.log(response.response.text());

      const commands = JSON.parse(this._removeJsonWrapper(response.response.text().trim()));
      return commands;
    } catch (error) {
      console.error('Error fetching commands from GEMINI:', error);
      return null;
    }
  }

  async _processTicketQuery(query, organization, project) {
    try {
      const email = await this._getEmail();
      // First get the sprint summary
      const pat = await this._getPatToken();
      const client = new AzureDevOpsClient(organization, project, pat);
      const workItems = await client.getBoardSummary();
      
      if (!workItems || workItems.length === 0) {
        const message = 'No work items found on the board.';
        this._post(message);
        await this._logInteraction(email, `@query_tickets ${query}`, message);
        return;
      }

      // Generate the sprint summary
      const sprintSummary = this._generateSprintSummary(workItems);

      // Use Gemini to interpret the query and find relevant tickets
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const prompt = `
      You are a Ticket Query Processor.

      Task:
      - Analyze the provided Sprint Summary and extract tickets relevant to the user's query.

      Sprint Summary:
      ${sprintSummary}

      User Query:
      "${query}"

      Instructions:
      1. Determine if the query is asking for:
        - A specific person's tickets
        - A specific sprint's tickets
        - Both person and sprint
      2. Search the sprint summary for matching tickets based on the query.
      3. Construct the output in **strict clean HTML**:
        - Start with a \`<h3>\` heading summarizing the results (example: "Tickets assigned to John Doe in Sprint 24")
        - Then with \`<h4\` heading tell the state active or new or closed
        - Then display a \`<ul>\` list on the basis of ticket state:
          - Each ticket as a \`<li>\` element showing:
            - Ticket ID (bold)
            - Ticket Title (normal)
      4. If **no tickets match**, output a \`<h4>\` heading stating no matches found, like "No matching tickets found for John Doe in Sprint 24".

      Output Format (important):
      - Return only the **pure HTML string**.
      - Do NOT wrap the HTML inside any Markdown code blocks (no \`\`\`html or \`\`\`).
      - No extra explanations, no extra text, no notes — **only** valid HTML.

      Example Outputs:

      If matches are found:
      <h2>Tickets assigned to John Doe in Sprint 24</h2>
      <ul>
        <li><b>#1234</b> Implement user authentication <i>(In Progress)</i></li>
        <li><b>#1256</b> Fix login bug <i>(Done)</i></li>
      </ul>

      If no matches:
      <h2>No matching tickets found for John Doe in Sprint 24</h2>

      Proceed carefully and format the HTML properly.

      `;

      const response = await model.generateContent(prompt);
      const result = response.response.text();
      const output = result.replace(/```html|```/g, '').trim();
      
      this._post(output);
      await this._logInteraction(email, `@query_tickets ${query}`, output);
    } catch (error) {
      const errorMessage = `❌ Error processing query: ${error.message}`;
      this._post(errorMessage);
      await this._logInteraction(email, `@query_tickets ${query}`, errorMessage);
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

  async _makeTicket(title, htmlDesc, organization, project) {
    try {
      const org = organization, proj = project, pat = await this._getPatToken();
      if (!org || !proj || !pat) throw new Error('Missing ORG/AZURE_PROJECT/AZURE_PAT');
      const email = await this._getEmail();

      if(email === null) {
        this._post(`❌ Error: You are not authorized to create tickets in this project. Please check your Azure DevOps permissions.`);
        return;
      }

      // Get the current iteration
      const client = new AzureDevOpsClient(org, proj, pat);
      const iterations = await client.getIterations();
      const currentIteration = iterations[0]; // Get the current iteration

      const patch = [
        { op: 'add', path: '/fields/System.Title', value: title },
        { op: 'add', path: '/fields/System.Description', value: htmlDesc },
        { op: 'add', path: '/fields/System.AssignedTo', value: email },
        { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: process.env.DEFAULT_EFFORT || 4 },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: process.env.DEFAULT_PRIORITY || 1 },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Activity', value: process.env.DEFAULT_ACTIVITY || 'Development' }
      ];

      // Add iteration path if available
      if (currentIteration) {
        patch.push({ 
          op: 'add', 
          path: '/fields/System.IterationPath', 
          value: currentIteration.path 
        });
        this._post(`ℹ️ Ticket will be assigned to current iteration: ${currentIteration.name}`);
      } else {
        this._post(`⚠️ No active iteration found for the current date. Ticket will be created without an iteration.`);
      }

      const wi = await client.createWorkItem('Task', patch);
      this._post(`✅ Created <b>#${wi.id}</b> "${title}"<br>${htmlDesc}`);
    } catch (e) {
      this._post(`❌ Error: You are not authorized to create tickets in this project. Please check your Azure DevOps permissions.`);
    }
  }

  async _showTickets(organization, project, workItemId = null) {
    try {
      const email = await this._getEmail();
      if (email === null) {
        const errorMessage = `❌ Error: You are not authorized to create tickets in this project. Please check your Azure DevOps permissions.`;
        this._post(errorMessage);
        await this._logInteraction(email, '@view_tickets', errorMessage);
        return;
      }

      const pat = await this._getPatToken();
      const client = new AzureDevOpsClient(organization, project, pat);

      if (workItemId) {
        // Fetch details of a specific work item
        const workItem = await client.getWorkItemDetails(workItemId);
        if (!workItem) {
          const errorMessage = `❌ Work item with ID <b>${workItemId}</b> not found.`;
          this._post(errorMessage);
          await this._logInteraction(email, `@view_tickets ${workItemId}`, errorMessage);
          return;
        }

        // Fetch history and format the work item
        const history = await this._getWorkItemHistory(organization, project, workItemId);
        const details = this._formatWorkItem(workItem, history);
        this._post(details);
        await this._logInteraction(email, `@view_tickets ${workItemId}`, details);
      } else {
        // Fetch all assigned work items
        const items = await client.getAssignedWorkItems(email);
        if (items.length === 0) {
          const message = 'You have no open tickets.';
          this._post(message);
          await this._logInteraction(email, '@view_tickets', message);
        } else {
          const list = items.map(w => {
            const workItemUrl = `https://dev.azure.com/${organization}/${project}/_workitems/edit/${w.id}`;
            return `<li><a href="${workItemUrl}" target="_blank">#${w.id} — ${w.fields['System.Title']}</a></li>`;
          }).join('');
          const message = `<b>Your Tickets:</b><ul>${list}</ul>`;
          this._post(message);
          await this._logInteraction(email, '@view_tickets', message);
        }
      }
    } catch (e) {
      const errorMessage = `❌ Couldn't fetch tickets: ${e.message}`;
      this._post(errorMessage);
      await this._logInteraction(email, '@view_tickets', errorMessage);
    }
  }

  async _chatReply(msg) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    return (await (await model.generateContent(msg)).response).text().trim();
  }

  async _getEmail() {
    try {
      const session = await vscode.authentication.getSession('microsoft', ['email'], { createIfNone: true });
      if(session.account && session.account.label && !session.account.label.endsWith('@shorthills.ai')) {
        return null;
      }
      return session.account.label;
    } catch {
      return null;
    }
  }

  _post(html) {
    this.lastBotMessage = html;
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
        overflow: hidden; /* Prevent double scrollbars */
      }

      .header {
        display: flex;
        flex-direction: column;
        position: sticky;
        top: 0;
        z-index: 1;
        background-color: var(--vscode-editor-background);
      }

      #dropdown-container {
        display: flex;
        padding: 10px;
        gap: 10px;
        border-bottom: 1px solid var(--vscode-input-border);
        background-color: var(--vscode-editor-background);
        flex-wrap: wrap;
      }

      select {
        padding: 8px;
        border: 1px solid var(--vscode-input-border);
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border-radius: 4px;
        font-size: 14px;
      }

      #chat-container {
        flex-grow: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        scroll-behavior: smooth;
      }

      #messages {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-height: 100%;
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
        position: sticky;
        bottom: 0;
        z-index: 1;
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

      #quick-actions {
              display: flex;
              padding: 10px 12px;
              border-bottom: 1px solid var(--vscode-input-border);
              background-color: var(--vscode-editor-background);
              gap: 8px;
              flex-wrap: wrap;
              position: sticky;
            }

      button:hover {
        background-color: var(--vscode-button-hoverBackground);
      }
    </style>
    </head>
    <body>
      <div class="header">
        <div id="header">
          <button id="reset-pat-button">Reset PAT Token</button>
        </div>
        <div id="dropdown-container">
          <select id="organization-dropdown">
            <option value="" disabled selected>Select Organization</option>
          </select>
          <select id="project-dropdown" disabled>
            <option value="" disabled selected>Select Project</option>
          </select>
        </div>
        <div id="quick-actions">
            <button class="quick-action" data-text="@view_tickets">View Tickets</button>
            <button class="quick-action" data-text="@help">Help</button>
            <button class="quick-action" data-text="@create_ticket">Create Ticket</button>
        </div>
      </div>
      <div id="chat-container">
        <div id="messages"></div>
      </div>

      <div id="input-container">
        <input type="text" id="message-input" placeholder="Type a message..." />
        <button id="send-button">Send</button>
      </div>
      
      <script>
        const vscode = acquireVsCodeApi();
        const orgDropdown = document.getElementById('organization-dropdown');
        const projectDropdown = document.getElementById('project-dropdown');
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-button');
        const quickActionButtons = document.querySelectorAll('.quick-action');
        const resetPatButton = document.getElementById('reset-pat-button');
        const chatContainer = document.getElementById('chat-container');
        let selectedOrganization = null;
        let selectedProject = null;
        let isProcessing = false; // Add loading state

        // Function to set processing state
        function setProcessingState(processing) {
          isProcessing = processing;
          sendButton.disabled = processing;
          messageInput.disabled = processing;
          if (processing) {
            sendButton.textContent = 'Sending...';
            sendButton.style.opacity = '0.7';
          } else {
            sendButton.textContent = 'Send';
            sendButton.style.opacity = '1';
          }
        }

        // Auto-resize textarea
        messageInput.addEventListener('input', function() {
          this.style.height = 'auto';
          this.style.height = (this.scrollHeight) + 'px';
        });

        // Auto-scroll to bottom when new messages are added
        function scrollToBottom() {
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function appendMessage(text, sender) {
          const messageElement = document.createElement('div');
          messageElement.classList.add('message', sender === 'user' ? 'user-message' : 'bot-message');
          messageElement.innerHTML = text;
          messagesContainer.appendChild(messageElement);
          scrollToBottom();
        }

        resetPatButton.addEventListener('click', () => {
          vscode.postMessage({ command: 'resetPatToken' });
          vscode.postMessage({ command: 'fetchOrganizations' });
        });

        orgDropdown.addEventListener('change', () => {
          selectedOrganization = orgDropdown.options[orgDropdown.selectedIndex].textContent;
          vscode.postMessage({ command: 'fetchProjects', organization: selectedOrganization });
        });

        projectDropdown.addEventListener('change', () => {
          selectedProject = projectDropdown.options[projectDropdown.selectedIndex].textContent;
        });

        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', event => {
          if (event.key === 'Enter' && !isProcessing) sendMessage();
        });

        function sendMessage() {
          if (isProcessing) return; // Prevent sending if already processing

          const text = messageInput.value.trim();
          if (!selectedOrganization || !selectedProject) {
            appendMessage('❌ Please select both an organization and a project before proceeding.', 'bot');
            if(selectedOrganization === null) {
              vscode.postMessage({command:'fetchOrganizations'});
            }
            else{
              vscode.postMessage({command:'fetchProjects', organization: selectedOrganization });
            }
            return;
          }
          if (text) {
            setProcessingState(true); // Set processing state to true
            appendMessage(text, 'user');
            vscode.postMessage({ command: 'sendMessage', text, organization: selectedOrganization, project: selectedProject });
            messageInput.value = '';
          }
        }

        // Fetch organizations and populate the dropdown
        vscode.postMessage({ command: 'fetchOrganizations' });

        window.addEventListener('message', event => {
          const message = event.data;

          if (message.command === 'populateOrganizations') {
            populateDropdown(orgDropdown, message.organizations);
          } else if (message.command === 'populateProjects') {
            populateDropdown(projectDropdown, message.projects);
            projectDropdown.disabled = false;
          } else if (message.command === 'receiveMessage') {
            appendMessage(message.text, 'bot');
            setProcessingState(false); // Reset processing state when response is received
          } else if (message.command === 'clearChat') {
            clearChat();
          } else if (message.command === 'clearDropdowns') {
            clearDropdowns();
          }
        });

        function clearChat() {
          messagesContainer.innerHTML = '';
          messageInput.value = '';
          setProcessingState(false); // Reset processing state when chat is cleared
        }

        function clearDropdowns() {
          orgDropdown.innerHTML = '<option value="" disabled selected>Select Organization</option>';
          projectDropdown.innerHTML = '<option value="" disabled selected>Select Project</option>';
          projectDropdown.disabled = true;
          selectedOrganization = null;
          selectedProject = null;
        }

        function populateDropdown(dropdown, items) {
          dropdown.innerHTML = '<option value="" disabled selected>Select</option>';
          items.forEach(item => {
            const option = document.createElement('option');
            option.value = item.id || item.name;
            option.textContent = item.name;
            dropdown.appendChild(option);
          });
        }

        quickActionButtons.forEach(button => {
          button.addEventListener('click', () => {
            if (!isProcessing) { // Only allow quick actions if not processing
              const text = button.getAttribute('data-text');
              messageInput.value = text;
              messageInput.focus();
            }
          });
        });
      </script>
    </body>
    </html>`;
  }  

  async _getWorkItemHistory(organization,project,workItemId) {
    try {
      const org = organization, proj = project, pat = process.env.AZURE_PAT;
      const client = new AzureDevOpsClient(org, proj, pat);
      const updatesUrl = `${client.baseUrl}/wit/workitems/${workItemId}/updates?api-version=${client.apiVersion}`;
      const response = await fetch(updatesUrl, { headers: client._getAuthHeader() });
      if (!response.ok) throw new Error(`Failed to fetch history: ${response.status}`);
      const data = await response.json();
      return data.value || [];
    } catch (error) {
      console.error("Error fetching work item history:", error);
      return [];
    }
  }

  _formatWorkItem(workItem, history = []) {
    const fields = workItem.fields || {};
    let formattedInfo = `<b>📄 WORK ITEM DETAILS</b><br><br>`;

    // Basic information
    formattedInfo += `<b>ID:</b> ${workItem.id}<br>`;
    formattedInfo += `<b>Title:</b> ${fields['System.Title'] || 'N/A'}<br>`;
    formattedInfo += `<b>State:</b> ${fields['System.State'] || 'N/A'}<br>`;
    formattedInfo += `<b>Type:</b> ${fields['System.WorkItemType'] || 'N/A'}<br>`;

    // People
    formattedInfo += `<b>Created By:</b> ${fields['System.CreatedBy']|| 'N/A'}<br>`;
    formattedInfo += `<b>Assigned To:</b> ${fields['System.AssignedTo']|| 'N/A'}<br>`;

    // Dates
    const createdDate = fields['System.CreatedDate'] ? new Date(fields['System.CreatedDate']).toLocaleString() : 'N/A';
    formattedInfo += `<b>Created Date:</b> ${createdDate}<br>`;

    if (fields['System.ChangedDate']) {
      const changedDate = new Date(fields['System.ChangedDate']).toLocaleString();
      formattedInfo += `<b>Last Updated:</b> ${changedDate}<br>`;
    }

    // Priority and effort
    if (fields['Microsoft.VSTS.Common.Priority']) {
      formattedInfo += `<b>Priority:</b> ${fields['Microsoft.VSTS.Common.Priority']}<br>`;
    }

    if (fields['Microsoft.VSTS.Scheduling.StoryPoints']) {
      formattedInfo += `<b>Story Points:</b> ${fields['Microsoft.VSTS.Scheduling.StoryPoints']}<br>`;
    }

    // Add iteration and area path if available
    if (fields['System.IterationPath']) {
      formattedInfo += `<b>Iteration Path:</b> ${fields['System.IterationPath']}<br>`;
    }

    if (fields['System.AreaPath']) {
      formattedInfo += `<b>Area Path:</b> ${fields['System.AreaPath']}<br>`;
    }

    // Description
    formattedInfo += `<br><b>Description:</b><br>`;
    formattedInfo += fields['System.Description'] ? this._stripHtml(fields['System.Description']) : 'No description provided.';

    // Acceptance Criteria
    if (fields['Microsoft.VSTS.Common.AcceptanceCriteria']) {
      formattedInfo += `<br><br><b>Acceptance Criteria:</b><br>`;
      formattedInfo += this._stripHtml(fields['Microsoft.VSTS.Common.AcceptanceCriteria']);
    }

    // Links to related work items
    if (workItem.relations && workItem.relations.length > 0) {
      const relatedItems = workItem.relations.filter(rel =>
        rel.rel === 'System.LinkTypes.Related' ||
        rel.rel === 'System.LinkTypes.Child' ||
        rel.rel === 'System.LinkTypes.Parent'
      );

      if (relatedItems.length > 0) {
        formattedInfo += `<br><br><b>Related Items:</b><br>`;
        relatedItems.forEach(item => {
          const relationType = item.rel.split('.').pop();
          const itemUrl = item.url;
          const itemId = itemUrl.substring(itemUrl.lastIndexOf('/') + 1);
          formattedInfo += `- ${relationType}: #${itemId}<br>`;
        });
      }
    }

    // Discussion
    let hasDiscussion = false;
    formattedInfo += `<br><br><b>Discussion:</b><br>`;

    if (history && history.length > 0) {
      const discussionEntries = history.filter(update =>
        update.fields &&
        (update.fields['System.History'] ||
          update.fields['System.CommentCount'])
      );

      if (discussionEntries.length > 0) {
        hasDiscussion = true;
        discussionEntries.forEach(entry => {
          if (entry.fields['System.History']) {
            formattedInfo += `<br>📝 <b>${entry.revisedBy?.displayName || 'Unknown'}:</b><br>`;
            formattedInfo += `${this._stripHtml(entry.fields['System.History'].newValue)}<br>`;
          }
        });
      }
    }

    if (!hasDiscussion) {
      formattedInfo += 'No comments or discussion found for this work item.';
    }

    return formattedInfo;
  }

  _stripHtml(html) {
    if (!html) return '';
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<li>/gi, '- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }

  async _addCommentToWorkItem(workItemId, commentText, organization, project) {
    try {
      const email = await this._getEmail();
      if (email === null) {
        const errorMessage = `❌ Error: You are not authorized to create tickets in this project. Please check your Azure DevOps permissions.`;
        this._post(errorMessage);
        await this._logInteraction(email, `#${workItemId} @comment ${commentText}`, errorMessage);
        return;
      }

      const pat = await this._getPatToken();
      const client = new AzureDevOpsClient(organization, project, pat);

      // Add the comment to the work item
      const response = await client.addComment(workItemId, commentText);
      if (response) {
        const message = `✅ Comment added to work item <b>#${workItemId}</b>: "${commentText}"`;
        this._post(message);
        await this._logInteraction(email, `#${workItemId} @comment ${commentText}`, message);
      } else {
        const errorMessage = `❌ Failed to add comment to work item <b>#${workItemId}</b>.`;
        this._post(errorMessage);
        await this._logInteraction(email, `#${workItemId} @comment ${commentText}`, errorMessage);
      }
    } catch (error) {
      const errorMessage = `❌ An error occurred while adding the comment: ${error.message}`;
      this._post(errorMessage);
      await this._logInteraction(email, `#${workItemId} @comment ${commentText}`, errorMessage);
    }
  }

  async _updateTicket(workItemId, title, description, organization, project) {
    try {
      const email = await this._getEmail();
      if (email === null) {
        const errorMessage = `❌ Error: You are not authorized to update tickets in this project. Please check your Azure DevOps permissions.`;
        this._post(errorMessage);
        await this._logInteraction(email, `#${workItemId} @update title "${title}" description "${description}"`, errorMessage);
        return;
      }

      const pat = await this._getPatToken();
      if (!pat) throw new Error('Missing AZURE_PAT');

      const client = new AzureDevOpsClient(organization, project, pat);
      const structuredDesc = await this._structureDesc(description);
      await client.updateWorkItem(workItemId, title, structuredDesc);
      const message = `✅ Updated ticket <b>#${workItemId}</b> with new title and description.`;
      this._post(message);
      await this._logInteraction(email, `#${workItemId} @update title "${title}" description "${description}"`, message);
    } catch (error) {
      const errorMessage = `❌ Error updating ticket: ${error.message}`;
      this._post(errorMessage);
      await this._logInteraction(email, `#${workItemId} @update title "${title}" description "${description}"`, errorMessage);
    }
  }

  async _getProjects(organizationName) {
    try {
      console.log('Attempting to fetch projects...');
      const pat = await this._getPatToken();
      if (!organizationName || !pat) {
        console.error('Missing organization name or PAT token');
        throw new Error('Missing organization name or AZURE_PAT.');
      }
      console.log(`Fetching projects for organization: ${organizationName}`);

      await initializeFetch();
      const url = `https://dev.azure.com/${organizationName}/_apis/projects?api-version=7.1-preview.4`;
      const authHeader = { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` };

      const response = await fetch(url, { headers: authHeader });
      if (!response.ok) {
        console.error('Failed to fetch projects:', response.status);
        throw new Error(`Failed to fetch projects: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log('Projects fetched successfully');
      return data.value.map(project => ({ id: project.id, name: project.name }));
    } catch (error) {
      console.error('Error fetching projects:', error);
      return [];
    }
  }

  async _getOrganizations() {
    try {
      console.log('Attempting to fetch organizations...');
      const pat = await this._getPatToken();
      if (!pat) {
        console.error('Missing PAT token');
        throw new Error('Missing AZURE_PAT in environment variables.');
      }
      console.log('PAT token retrieved successfully');

      await initializeFetch();
      const profileUrl = `https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1-preview.1`;
      const authHeader = { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` };
      console.log('Fetching user profile...');

      const profileResponse = await fetch(profileUrl, { headers: authHeader });
      if (!profileResponse.ok) {
        console.error('Failed to fetch user profile:', profileResponse.status);
        throw new Error('Failed to fetch user profile.');
      }

      const profileData = await profileResponse.json();
      const memberId = profileData.id;
      console.log('User profile fetched successfully');

      const orgsUrl = `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${memberId}&api-version=7.1-preview.1`;
      console.log('Fetching organizations...');

      const orgsResponse = await fetch(orgsUrl, { headers: authHeader });
      if (!orgsResponse.ok) {
        console.error('Failed to fetch organizations:', orgsResponse.status);
        throw new Error('Failed to fetch organizations.');
      }

      const orgsData = await orgsResponse.json();
      console.log('Organizations fetched successfully');
      return orgsData.value.map(org => ({ id: org.accountId, name: org.accountName }));
    } catch (error) {
      console.error('Error fetching organizations:', error);
      return [];
    }
  }

  async _getTeamMembers() {
    try {
      const org = process.env.ORG;
      const proj = process.env.AZURE_PROJECT;
      const pat = process.env.AZURE_PAT;
  
      if (!org || !proj || !pat) {
        throw new Error('Missing ORG, AZURE_PROJECT, or AZURE_PAT in environment variables.');
      }
  
      const authHeader = {
        Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
      };
  
      // Step 1: Fetch all teams in the project
      const teamsUrl = `https://dev.azure.com/${org}/${proj}/_apis/teams?api-version=7.1-preview.3`;
      const teamsResponse = await fetch(teamsUrl, { headers: authHeader });
  
      if (!teamsResponse.ok) {
        const errorText = await teamsResponse.text();
        throw new Error(`Failed to fetch teams: ${teamsResponse.status} ${teamsResponse.statusText} - ${errorText}`);
      }
  
      const teamsData = await teamsResponse.json();
      const teams = teamsData.value;
  
      if (!teams || teams.length === 0) {
        console.log('No teams found in the project.');
        this._post('No teams found in the project.');
        return;
      }
  
      const members = [];
  
      // Step 2: Fetch members of each team
      for (const team of teams) {
        const membersUrl = `https://dev.azure.com/${org}/_apis/teams/${team.id}/members?api-version=7.1-preview.1`;
        const membersResponse = await fetch(membersUrl, { headers: authHeader });
  
        if (!membersResponse.ok) {
          const errorText = await membersResponse.text();
          console.error(`Failed to fetch members for team ${team.name}: ${membersResponse.status} ${errorText}`);
          continue;
        }
  
        const membersData = await membersResponse.json();
        members.push(
          ...membersData.value.map(member => ({
            team: team.name,
            id: member.id,
            displayName: member.displayName,
            uniqueName: member.uniqueName
          }))
        );
      }
  
      if (members.length === 0) {
        console.log('No members found in the project.');
        this._post('No members found in the project.');
      } else {
        console.log('Project Members:', members);
        const memberList = members
          .map(member => `<li>${member.displayName} (${member.uniqueName}) - Team: ${member.team}</li>`)
          .join('');
        this._post(`<b>Project Members:</b><ul>${memberList}</ul>`);
      }
    } catch (error) {
      console.error('Error fetching team members:', error);
      this._post(`❌ Error fetching team members: ${error.message}`);
    }
  }

  async _storePatToken(patToken) {
    try {
      console.log('Attempting to store PAT token...');
      if (!patToken) {
        console.error('PAT token is missing');
        throw new Error('PAT token is required.');
      }

      const email = await this._getEmail();
      if (!email) {
        console.error('User email is missing');
        throw new Error('User email is required.');
      }
      console.log(`Storing PAT token for user: ${email}`);

      // Get existing PAT tokens
      const patTokens = vscode.workspace.getConfiguration().get('teamsBot.patTokens', {});
      console.log('Current PAT tokens:', Object.keys(patTokens));
      
      // Update or create new entry
      patTokens[email] = {
        pat: patToken,
        timestamp: new Date().toISOString()
      };

      // Store the updated PAT tokens
      await vscode.workspace.getConfiguration().update('teamsBot.patTokens', patTokens, vscode.ConfigurationTarget.Global);
      console.log(`Successfully stored PAT token for user: ${email}`);
      vscode.window.showInformationMessage('PAT token stored successfully.');
    } catch (error) {
      console.error('Error storing PAT token:', error);
      vscode.window.showErrorMessage('Failed to store PAT token.');
    }
  }

  async _getPatToken() {
    try {
      console.log('Attempting to retrieve PAT token...');
      const email = await this._getEmail();
      if (!email) {
        console.error('User email is missing');
        throw new Error('User email is required.');
      }
      console.log(`Retrieving PAT token for user: ${email}`);

      // Get all PAT tokens
      const patTokens = vscode.workspace.getConfiguration().get('teamsBot.patTokens', {});
      console.log('Available PAT tokens:', Object.keys(patTokens));
      const userPat = patTokens[email];

      if (!userPat) {
        console.log(`No existing PAT token found for user: ${email}`);
        // Prompt the user to enter the PAT token if not found
        const newPatToken = await vscode.window.showInputBox({
          prompt: 'Enter your Azure DevOps PAT token',
          password: true
        });

        if (!newPatToken) {
          console.error('User cancelled PAT token input');
          throw new Error('PAT token is required.');
        }

        console.log(`New PAT token received for user: ${email}`);
        // Store the new PAT token
        await this._storePatToken(newPatToken);
        return newPatToken;
      }

      console.log(`Successfully retrieved PAT token for user: ${email}`);
      return userPat.pat;
    } catch (error) {
      console.error('Error retrieving PAT token:', error);
      vscode.window.showErrorMessage('Failed to retrieve PAT token.');
      return null;
    }
  }

  async _resetPatToken() {
    try {
      console.log('Attempting to reset PAT token...');
      const email = await this._getEmail();
      if (!email) {
        console.error('User email is missing');
        throw new Error('User email is required.');
      }
      console.log(`Resetting PAT token for user: ${email}`);

      const newPatToken = await vscode.window.showInputBox({
        prompt: 'Enter your new Azure DevOps PAT token',
        password: true
      });

      if (!newPatToken) {
        console.log('User cancelled PAT token reset');
        vscode.window.showErrorMessage('PAT token reset canceled.');
        return;
      }

      // Get existing PAT tokens
      const patTokens = vscode.workspace.getConfiguration().get('teamsBot.patTokens', {});
      console.log('Current PAT tokens:', Object.keys(patTokens));
      
      // Update the PAT token for the current user
      patTokens[email] = {
        pat: newPatToken,
        timestamp: new Date().toISOString()
      };

      // Store the updated PAT tokens
      await vscode.workspace.getConfiguration().update('teamsBot.patTokens', patTokens, vscode.ConfigurationTarget.Global);
      console.log(`Successfully reset PAT token for user: ${email}`);
      vscode.window.showInformationMessage('PAT token reset successfully.');

      // Clear dropdowns
      this._postMessage({ command: 'clearDropdowns' });

      // Fetch and populate organizations immediately
      console.log('Fetching organizations with new PAT token...');
      const organizations = await this._getOrganizations();
      if (organizations && organizations.length > 0) {
        console.log('Populating organizations dropdown...');
        this._postMessage({ command: 'populateOrganizations', organizations });
      } else {
        console.error('No organizations found with new PAT token');
        this._post('❌ No organizations found. Please check your PAT token permissions.');
      }
    } catch (error) {
      console.error('Error resetting PAT token:', error);
      vscode.window.showErrorMessage(`Failed to reset PAT token: ${error.message}`);
    }
  }

  async _showBoardSummary(organization, project) {
    try {
      const email = await this._getEmail();
      const pat = await this._getPatToken();
      const client = new AzureDevOpsClient(organization, project, pat);
      
      const workItems = await client.getBoardSummary();
      if (!workItems || workItems.length === 0) {
        const message = 'No work items found on the board.';
        this._post(message);
        await this._logInteraction(email, '@board_summary', message);
        return;
      }

      const summary = this._generateOverallTicketSummary(workItems);
      this._post(summary);
      await this._logInteraction(email, '@board_summary', summary);
    } catch (error) {
      const errorMessage = `❌ Error generating board summary: ${error.message}`;
      this._post(errorMessage);
      await this._logInteraction(email, '@board_summary', errorMessage);
    }
  }

  async _showSprintSummary(organization, project) {
    try {
      const email = await this._getEmail();
      const pat = await this._getPatToken();
      const client = new AzureDevOpsClient(organization, project, pat);
      
      const workItems = await client.getBoardSummary();
      if (!workItems || workItems.length === 0) {
        const message = 'No work items found on the board.';
        this._post(message);
        await this._logInteraction(email, '@sprint_summary', message);
        return;
      }

      const summary = this._generateSprintSummary(workItems);
      this._post(summary);
      await this._logInteraction(email, '@sprint_summary', summary);
    } catch (error) {
      const errorMessage = `❌ Error generating sprint summary: ${error.message}`;
      this._post(errorMessage);
      await this._logInteraction(email, '@sprint_summary', errorMessage);
    }
  }

  _generateOverallTicketSummary(allWorkItems) {
    const total = allWorkItems.length;
    const stateCounts = {
      Active: 0,
      Closed: 0,
      Removed: 0,
      New: 0,
      Other: 0
    };

    const userStats = {};

    for (const wi of allWorkItems) {
      const state = wi.fields['System.State'];
      const assignedTo = wi.fields['System.AssignedTo']?.displayName || "Unassigned";

      if (stateCounts[state] !== undefined) {
        stateCounts[state]++;
      } else {
        stateCounts.Other++;
      }

      if (!userStats[assignedTo]) {
        userStats[assignedTo] = {};
      }
      if (!userStats[assignedTo][state]) {
        userStats[assignedTo][state] = 0;
      }
      userStats[assignedTo][state]++;
    }

    let summary = `<b>📊 Board Summary</b> - ${total} total tickets<br><br>`;
    summary += `- <b>Active</b>: ${stateCounts.Active}<br>`;
    summary += `- <b>Closed</b>: ${stateCounts.Closed}<br>`;
    summary += `- <b>Removed</b>: ${stateCounts.Removed || 0}<br>`;
    summary += `- <b>New</b>: ${stateCounts.New || 0}<br>`;
    if (stateCounts.Other > 0) {
      summary += `- <b>Other States</b>: ${stateCounts.Other}<br>`;
    }

    summary += `<br><b>Tickets per user:</b><br>`;
    for (const [user, states] of Object.entries(userStats)) {
      const userTotal = Object.values(states).reduce((a, b) => a + b, 0);
      summary += `- <b>${user}</b>: ${userTotal} tickets<br>`;
    }

    return summary;
  }

  _generateSprintSummary(workItems) {
    const sprintSummary = {};

    for (const wi of workItems) {
      const sprint = wi.fields['System.IterationPath'] || "Unassigned Sprint";
      const assignedTo = wi.fields['System.AssignedTo']?.displayName || "Unassigned";
      const title = wi.fields['System.Title'] || "Untitled";
      const state = wi.fields['System.State'] || "Unknown";
      const ticketNumber = wi.id;

      if (!sprintSummary[sprint]) {
        sprintSummary[sprint] = {};
      }

      if (!sprintSummary[sprint][assignedTo]) {
        sprintSummary[sprint][assignedTo] = {};
      }

      if (!sprintSummary[sprint][assignedTo][state]) {
        sprintSummary[sprint][assignedTo][state] = [];
      }

      sprintSummary[sprint][assignedTo][state].push(`${ticketNumber}: ${title}`);
    }

    let summary = `<b>📊 Sprint Summary</b><br><br>`;
    for (const [sprint, users] of Object.entries(sprintSummary)) {
      summary += `<b>Sprint: ${sprint}</b><br>`;
      for (const [user, states] of Object.entries(users)) {
        summary += `- <b>${user}</b>:<br>`;
        for (const [state, tickets] of Object.entries(states)) {
          summary += `  - <b>${state}</b> (${tickets.length} tickets):<br>`;
          for (const ticket of tickets) {
            summary += `    - ${ticket}<br>`;
          }
        }
      }
      summary += `<br>`;
    }

    return summary;
  }

  async _logInteraction(email, userInput, botOutput) {
    try {
      await initializeFetch();
      const logUrl = process.env.LOGGING_URL;
      if (!logUrl) {
        console.error('LOGGING_URL environment variable is not set.');
        return;
      }

      const response = await fetch(logUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email,
          user_input: userInput,
          bot_output: botOutput
        })
      });

      if (!response.ok) {
        console.error('Failed to log interaction:', await response.text());
      }
    } catch (error) {
      console.error('Error logging interaction:', error);
    }
  }
}
module.exports = { activate, deactivate };
