// extension.js
const vscode = require('vscode');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { GoogleGenerativeAI } = require('@google/generative-ai');
const AzureDevOpsClient = require('./azureDevOpsClient');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

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
        } else {
          // User signed in, fetch organizations
          const organizations = await provider._getOrganizations();
          if (organizations && organizations.length > 0) {
            provider._postMessage({ command: 'populateOrganizations', organizations });
          }
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
    this.chatMemoryKey = 'teamsBot.chatHistory';
    this.maxAgeHours = 48; // 2 days in hours
  }

  // Chat memory management methods
  async _loadChatHistory() {
    try {
      // Request chat history from webview
      this._postMessage({ command: 'getChatHistory' });
      return []; // Return empty array as webview will handle the display
    } catch (error) {
      console.error('Error loading chat history:', error);
      return [];
    }
  }

  async _saveChatHistory(messages) {
    try {
      // Send messages to webview for storage
      this._postMessage({ 
        command: 'saveChatHistory',
        messages: messages
      });
    } catch (error) {
      console.error('Error saving chat history:', error);
    }
  }

  async _addToChatHistory(role, text, timestamp = Date.now()) {
    try {
      // Send new message to webview for storage
      this._postMessage({ 
        command: 'addToChatHistory',
        message: {
          timestamp,
          role,
          text
        }
      });
    } catch (error) {
      console.error('Error adding to chat history:', error);
    }
  }

  async _displayChatHistory() {
    try {
      // Request chat history from webview
      this._postMessage({ command: 'getChatHistory' });
    } catch (error) {
      console.error('Error displaying chat history:', error);
    }
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this._getHtml();
  
    webviewView.webview.onDidReceiveMessage(async msg => {
      console.log('Received message in extension:', msg); // Debug log
      if (msg.command === 'resetPatToken') {
        await this._resetPatToken();
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
        // Add user message to chat history
        await this._addToChatHistory('user', text);
        this._onUserMessage(text.trim(), organization, project);
      } else if (msg.command === 'copyToClipboard') {
        console.log('Attempting to copy to clipboard:', msg.text); // Debug log
        try {
          await vscode.env.clipboard.writeText(msg.text);
          console.log('Successfully copied to clipboard'); // Debug log
          webviewView.webview.postMessage({ 
            command: 'copyToClipboardResponse',
            success: true
          });
        } catch (error) {
          console.error('Failed to copy to clipboard:', error);
          webviewView.webview.postMessage({ 
            command: 'copyToClipboardResponse',
            success: false
          });
        }
      }
    });

    // Check if user is already signed in and fetch organizations
    this._checkAndFetchOrganizations();
  }

  async _checkAndFetchOrganizations() {
    const session = await vscode.authentication.getSession('microsoft', ['email'], { createIfNone: false });
    if (session) {
      const organizations = await this._getOrganizations();
      if (organizations && organizations.length > 0) {
        this._postMessage({ command: 'populateOrganizations', organizations });
      }
    }
  }

  _post(html) {
    this.lastBotMessage = html;
    // Add bot message to chat history with current timestamp
    this._addToChatHistory('bot', html, Date.now());
    this.view?.webview.postMessage({ command: 'receiveMessage', text: html, role: 'bot', timestamp: Date.now() });
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
    let email = null;
    try {
      email = await this._getEmail();
      if (!email) {
        this._post('❌ Please log in with an authorized email to use the chatbot.');
        await this._logInteraction('unknown', text, '❌ Please log in with an authorized email to use the chatbot.');
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
        if (command === '@create_ticket_from_last_commit') {
          await this._createTicketFromLastCommit(organization, project, email, text);
        }
        else if (command.startsWith('@create_ticket_from_commit')) {
          const match = command.match(/^@create_ticket_from_commit\s+([a-f0-9]+)$/i);
          if (match) {
            const commitId = match[1].trim();
            await this._createTicketFromLastCommit(organization, project, email, text, commitId);
          } else {
            const errorMessage = "❌ Invalid commit ID format. Please provide a valid commit hash.";
            this._post(errorMessage);
            await this._logInteraction(email, text, errorMessage);
          }
        }
        else if (command.startsWith('@create_ticket')) {
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
        }
        else if (command === '@help') {
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
            • <code>@overdue_tickets</code> - Show tickets that are past their due date but still active or new.<br>
            • <code>@help</code> - Get information about available commands.<br>
            Feel free to ask me anything related to these commands!
          `;
          this._post(helpMessage);
          await this._logInteraction(email, text, helpMessage);
        }
        else if (command.startsWith('@overdue_tickets')) {
          const params = await this._parseOverdueTicketsCommand(command);
          await this._showOverdueTickets(organization, project, params);
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
        } else if (command.startsWith('@epic_summary')) {
          const iterationPath = command.substring('@epic_summary '.length).trim();
          if (!iterationPath) {
            const errorMessage = "❌ Please specify an iteration path. Example: @epic_summary Sprint 9";
            this._post(errorMessage);
            await this._logInteraction(email, text, errorMessage);
            return;
          }
          await this._showEpicSummary(organization, project, iterationPath);
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
      await this._logInteraction(email || 'unknown', text, errorMessage);
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
      - @create_ticket <title> description '<description>' → Create a new ticket.
      - @create_ticket_from_last_commit → Create a ticket based on the last git commit in the workspace.
      - @create_ticket_from_commit <commit_id> → Create a ticket based on a specific git commit ID.
      - #<id> @comment <comment text> → Add a comment to a ticket.
      - #<id> @update title '<title>' description '<description>' → Update a ticket.
      - @board_summary → Show summary of all tickets on the board.
      - @sprint_summary → Show summary of tickets by sprint.
      - @epic_summary <iteration_path> → Show summary of epics and their completed tasks for a specific iteration.
      - @overdue_tickets → Show tickets that are past their due date but still active or new.
      - @overdue_tickets of <name> → Show overdue tickets for a specific person.
      - @overdue_tickets my → Show your own overdue tickets.
      - @overdue_tickets as of <date> → Show overdue tickets as of a specific date (e.g., "1st May" or "20 Jan" or "3 May 2024").
      - @overdue_tickets of <name> as of <date> → Show overdue tickets for a specific person as of a specific date.
      - @query_tickets <query> → Query tickets based on name or sprint (for non-overdue tickets).
      - @help → Get information about available commands.

      Strict Rules:
      - If multiple commands are mentioned in a single message, split them into separate outputs in order.
      - Always output a JSON array of only command strings. No explanation or extra text.
      - For overdue tickets:
        - Use @overdue_tickets for general overdue ticket queries
        - Use @overdue_tickets of <name> when specifically asking about someone's overdue tickets
        - Use @overdue_tickets my when asking about own overdue tickets
        - Use @overdue_tickets as of <date> for date-based queries
        - Use @overdue_tickets of <name> as of <date> for combined person and date queries
        - CRITICAL: For date-based queries:
          - ALWAYS include the exact date from the user's message
          - NEVER use today's date unless the user explicitly says "today"
          - Preserve the exact date format (e.g., "3rd May", "1st Jan", "20th March")
          - If the user says "as of 3rd May", use exactly that date, not today
          - If the user says "as of today", use today's date
        - The date in the output must match exactly what the user specified
      - For regular ticket queries (non-overdue):
        - Use @query_tickets for general ticket queries about assignments or sprints
        - Do NOT use @query_tickets for overdue ticket queries
      - If the user gives a casual or layman description for creating or updating a ticket:
        - Create a short, professional, formal title summarizing the task.
        - Write a clear, well-phrased formal description based on the user's input.
        - Avoid copying informal or casual language directly.
      - If details are missing, make reasonable formal assumptions based on the context.
      -If you are not confident that the message matches one of the defined commands, return an empty JSON array. Do not guess or hallucinate commands.

      Examples:

      User: "Show me all overdue tickets"
      Output: ["@overdue_tickets"]

      User: "Show me Pulkit's overdue tickets"
      Output: ["@overdue_tickets of Pulkit"]

      User: "Show my overdue tickets"
      Output: ["@overdue_tickets my"]

      User: "Show overdue tickets as of 1st May"
      Output: ["@overdue_tickets as of 1st May"]

      User: "Show overdue tickets as of 20 Jan"
      Output: ["@overdue_tickets as of 20 Jan"]

      User: "Show overdue tickets as of 3rd May 2024"
      Output: ["@overdue_tickets as of 3rd May 2024"]

      User: "Show overdue tickets as of today"
      Output: ["@overdue_tickets as of today"]

      User: "Show Pulkit's overdue tickets as of 3rd May"
      Output: ["@overdue_tickets of Pulkit as of 3rd May"]

      User: "Show my overdue tickets as of 20th Jan"
      Output: ["@overdue_tickets my as of 20th Jan"]

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
      Output: ["@create_ticket Chatbot Development Using Gemini and Pinecone description 'Developed a chatbot leveraging Gemini LLM and Pinecone as a vector store. Completed unit testing to ensure functionality.'"]

      User: "Update ticket 1348, stored PAT token locally instead of MySQL"
      Output: ["#1348 @update title 'Store PAT Token Locally' description 'Implemented functionality to securely store the PAT token locally within the VS Code extension, removing dependency on a remote MySQL server.'"]

      User: "Comment on ticket 1234 that this needs urgent attention and then show it to me"
      Output: ["#1234 @comment this needs urgent attention", "@view_tickets 1234"]

      User: "Create a ticket for migrating database to MongoDB and show me my tickets"
      Output: ["@create_ticket Database Migration to MongoDB description \"Migrated existing database infrastructure to MongoDB to enhance scalability and flexibility.\"", "@view_tickets"]

      User: "Add a comment to ticket 5678 saying this issue is critical"
      Output: ["#5678 @comment this issue is critical"]

      User: "Create a ticket from my last commit"
      Output: ["@create_ticket_from_last_commit"]

      User: "Create a ticket from commit abc123"
      Output: ["@create_ticket_from_commit abc123"]

      User: "what is a monkey"
      Output: []

      User: "sbdjnreoi"
      Output: []

      User: "pizza toppings"
      Output: []
      
      User: "how are you?"
      Output: []

      User: "Show epic summary for Sprint 1"
      Output: ["@epic_summary Sprint 1"]

      User message:
      "${userMessage}"

      Instructions:
      - Parse the message following the above rules.
      - If the message implies multiple commands, output all commands separately in sequence.
      - Always generate a formal title and description if user message is casual.
      - For date-based queries:
        - ALWAYS preserve the exact date from the user's message
        - NEVER use today's date unless explicitly mentioned
        - Keep ordinal numbers (1st, 2nd, 3rd, etc.) in the date
        - The date in the output must match exactly what the user specified
      - Output only a clean JSON array of valid commands.
      `;

      const response = await model.generateContent(prompt);
      console.log('Full Gemini Response:', JSON.stringify(response, null, 2));
      
      const result = response.response;
      
      // Get token counts from the usageMetadata
      const inputTokens = result.usageMetadata?.promptTokenCount || 0;
      const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;

      console.log('Token Counts:', { inputTokens, outputTokens });

      // Store token counts for logging
      this.lastInteractionTokens = {
        input: inputTokens,
        output: outputTokens
      };

      const commands = JSON.parse(this._removeJsonWrapper(result.candidates[0].content.parts[0].text));
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

			<b>Aim:</b>
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

    const response = await model.generateContent(prompt);
    console.log('Structure Desc Response:', JSON.stringify(response, null, 2));
    
    const result = response.response;
    console.log('Structure Desc Result:', JSON.stringify(result, null, 2));
    
    // Get token counts from the usageMetadata
    const inputTokens = result.usageMetadata?.promptTokenCount || 0;
    const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;

    console.log('Structure Desc Token Counts:', { inputTokens, outputTokens });

    // Store token counts for logging
    this.lastInteractionTokens = {
      input: inputTokens,
      output: outputTokens
    };

    return result.candidates[0].content.parts[0].text;
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

      // Set due date to 12:30 AM of next day
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1); // Set to tomorrow
      tomorrow.setHours(0, 30, 0, 0); // Set to 12:30 AM
      const dueDate = tomorrow.toISOString();

      const patch = [
        { op: 'add', path: '/fields/System.Title', value: title },
        { op: 'add', path: '/fields/System.Description', value: htmlDesc },
        { op: 'add', path: '/fields/System.AssignedTo', value: email },
        { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: process.env.DEFAULT_EFFORT || 4 },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: process.env.DEFAULT_PRIORITY || 1 },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Activity', value: process.env.DEFAULT_ACTIVITY || 'Development' },
        { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.DueDate', value: dueDate }
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
      this._post(`✅ Created <b>#${wi.id}</b> "${title}"<br>${htmlDesc}<br>Due date set to today at 7 PM.`);
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
        console.log(workItem);
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
          // Group tickets by state
          const ticketsByState = items.reduce((acc, ticket) => {
            const state = ticket.fields['System.State'] || 'Unassigned';
            if (!acc[state]) {
              acc[state] = [];
            }
            acc[state].push(ticket);
            return acc;
          }, {});

          // Create HTML for each state group
          let message = '<b>Your Tickets:</b><br><br>';
          
          // Define the order of states to display
          const stateOrder = ['Active', 'Doing', 'New', 'Unassigned', 'Closed', 'Resolved', 'Removed', 'Completed'];
          
          // Add each state group in the defined order
          stateOrder.forEach(state => {
            if (ticketsByState[state] && ticketsByState[state].length > 0) {
              message += `<b>${state}</b><br>`;
              const list = ticketsByState[state].map(w => {
                const workItemUrl = `https://dev.azure.com/${organization}/${project}/_workitems/edit/${w.id}`;
                return `<li> <b>#${w.id}</b> — <a href="${workItemUrl}" target="_blank"> ${w.fields['System.Title']}</a></li>`;
              }).join('');
              message += `<ul>${list}</ul><br>`;
            }
          });

          // Add any remaining states that weren't in the predefined order
          Object.keys(ticketsByState).forEach(state => {
            if (!stateOrder.includes(state) && ticketsByState[state].length > 0) {
              message += `<b>${state}</b><br>`;
              const list = ticketsByState[state].map(w => {
                const workItemUrl = `https://dev.azure.com/${organization}/${project}/_workitems/edit/${w.id}`;
                return `<li> <b>#${w.id}</b> — <a href="${workItemUrl}" target="_blank"> ${w.fields['System.Title']}</a></li>`;
              }).join('');
              message += `<ul>${list}</ul><br>`;
            }
          });

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
    const response = await model.generateContent(msg);
    const result = response.response;
    
    // Get token counts from the usageMetadata
    const inputTokens = result.usageMetadata?.promptTokenCount || 0;
    const outputTokens = result.usageMetadata?.candidatesTokenCount || 0;

    console.log('Chat Reply Token Counts:', { inputTokens, outputTokens });

    // Store token counts for logging
    this.lastInteractionTokens = {
      input: inputTokens,
      output: outputTokens
    };

    return result.candidates[0].content.parts[0].text;
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

      #header{
        display: flex;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid var(--vscode-input-border);
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
        width: 200px;
      }

      select option {
        color: var(--vscode-input-foreground);
        background-color: var(--vscode-input-background);
      }

      select option:first-child {
        color: var(--vscode-input-placeholderForeground);
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
        display: flex;
        flex-direction: column;
        gap: 4px;
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
        align-items: end;
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


      #submit-container {
        display: flex;
        align-items: center;
        max-height: 30px;
      }

      .date-separator {
        text-align: center;
        margin: 16px 0;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        position: relative;
      }

      .date-separator::before,
      .date-separator::after {
        content: '';
        position: absolute;
        top: 50%;
        width: 30%;
        height: 1px;
        background-color: var(--vscode-input-border);
      }

      .date-separator::before {
        left: 0;
      }

      .date-separator::after {
        right: 0;
      }

      .message-content {
        flex: 1;
      }

      .message-timestamp {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        opacity: 0.8;
        align-self: flex-end;
      }

      .user-message .message-timestamp {
        text-align: right;
      }

      .bot-message .message-timestamp {
        text-align: left;
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
        <textarea id="message-input" placeholder="Type a message..." rows="1"></textarea>
        <div id="submit-container">
          <button id="send-button">Send</button>
        </div>
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
        let isProcessing = false;

        // Chat history management
        const MAX_AGE_HOURS = 48;
        let chatHistories = {}; // Object to store chat histories for each org-project combination

        // Initialize state
        const state = vscode.getState() || {};
        if (state.selectedOrganization && state.selectedProject) {
          selectedOrganization = state.selectedOrganization;
          selectedProject = state.selectedProject;
        }
        if (state.chatHistories) {
          chatHistories = state.chatHistories;
        }

        // Clear messages on initial load
        messagesContainer.innerHTML = '';

        function getCurrentChatKey() {
          if (!selectedOrganization || !selectedProject) return null;
          return selectedOrganization + ':' + selectedProject;
        }

        function getCurrentChatHistory() {
          const key = getCurrentChatKey();
          return key ? (chatHistories[key] || []) : [];
        }

        function pruneOldMessages(history) {
          const now = Date.now();
          const maxAgeMs = MAX_AGE_HOURS * 60 * 60 * 1000;
          return history.filter(msg => (now - msg.timestamp) <= maxAgeMs);
        }

        function saveState() {
          // Only save state if both org and project are selected
          if (selectedOrganization && selectedProject) {
            // Prune old messages from all histories
            Object.keys(chatHistories).forEach(key => {
              chatHistories[key] = pruneOldMessages(chatHistories[key]);
            });

            vscode.setState({
              selectedOrganization,
              selectedProject,
              chatHistories
            });
          } else {
            // Clear state if either org or project is missing
            vscode.setState({
              selectedOrganization: null,
              selectedProject: null,
              chatHistories
            });
          }
        }

        function formatTimestamp(timestamp) {
          try {
            const date = new Date(timestamp);
            if (isNaN(date.getTime())) {
              return new Date().toLocaleTimeString();
            }
            return date.toLocaleTimeString();
          } catch (error) {
            return new Date().toLocaleTimeString();
          }
        }

        function appendMessage(text, sender, timestamp) {
          const messageElement = document.createElement('div');
          messageElement.classList.add('message', sender === 'user' ? 'user-message' : 'bot-message');
          
          // Create message content container
          const messageContent = document.createElement('div');
          messageContent.classList.add('message-content');
          messageContent.innerHTML = text;
          
          // Create timestamp element
          const timeElement = document.createElement('div');
          timeElement.classList.add('message-timestamp');
          timeElement.textContent = formatTimestamp(timestamp);
          
          // Add both elements to message
          messageElement.appendChild(messageContent);
          messageElement.appendChild(timeElement);
          
          messagesContainer.appendChild(messageElement);
          scrollToBottom();
        }

        function displayCurrentChatHistory() {
          messagesContainer.innerHTML = '';
          
          if (!selectedOrganization || !selectedProject) {
            return; // Don't show any message if org/project not selected
          }

          const history = getCurrentChatHistory();
          if (history.length === 0) {
            return; // Don't show any message if there's no history
          }

          let currentDate = null;
          for (const msg of history) {
            const messageDate = new Date(msg.timestamp);
            const messageDateStr = messageDate.toLocaleDateString();
            
            // Add date separator if date changes
            if (currentDate !== messageDateStr) {
              currentDate = messageDateStr;
              const dateSeparator = document.createElement('div');
              dateSeparator.classList.add('date-separator');
              dateSeparator.textContent = messageDateStr;
              messagesContainer.appendChild(dateSeparator);
            }

            appendMessage(msg.text, msg.role, msg.timestamp);
          }
          scrollToBottom();
        }

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

        resetPatButton.addEventListener('click', () => {
          vscode.postMessage({ command: 'resetPatToken' });
          vscode.postMessage({ command: 'fetchOrganizations' });
        });

        orgDropdown.addEventListener('change', () => {
          selectedOrganization = orgDropdown.options[orgDropdown.selectedIndex].textContent;
          saveState();
          if (selectedOrganization) {
            vscode.postMessage({ command: 'fetchProjects', organization: selectedOrganization });
            projectDropdown.disabled = true; // Disable project dropdown when organization changes
            projectDropdown.innerHTML = '<option value="" disabled selected>Select Project</option>'; // Reset project dropdown
          } else {
            projectDropdown.disabled = true;
            projectDropdown.innerHTML = '<option value="" disabled selected>Select Project</option>';
          }
        });

        projectDropdown.addEventListener('change', () => {
          selectedProject = projectDropdown.options[projectDropdown.selectedIndex].textContent;
          saveState();
          displayCurrentChatHistory();
        });

        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', event => {
          if (event.key === 'Enter' && !isProcessing) sendMessage();
        });

        function sendMessage() {
          if (isProcessing) return;

          const text = messageInput.value.trim();
          if (!selectedOrganization || !selectedProject) {
            appendMessage('❌ Please select both an organization and a project before proceeding.', 'bot', Date.now());
            if(!selectedOrganization) {
              vscode.postMessage({command:'fetchOrganizations'});
            }
            else if(selectedOrganization && !selectedProject) {
              vscode.postMessage({command:'fetchProjects', organization: selectedOrganization });
            }
            return;
          }
          if (text) {
            setProcessingState(true);
            appendMessage(text, 'user', Date.now());
            vscode.postMessage({ command: 'sendMessage', text, organization: selectedOrganization, project: selectedProject });
            messageInput.value = '';
            messageInput.style.height = 'auto';
          }
        }

        // Fetch organizations and populate the dropdown
        vscode.postMessage({ command: 'fetchOrganizations' });

        window.addEventListener('message', event => {
          const message = event.data;

          if (message.command === 'populateOrganizations') {
            populateDropdown(orgDropdown, message.organizations);
          } else if (message.command === 'populateProjects') {
            if (selectedOrganization) {
              populateDropdown(projectDropdown, message.projects);
              projectDropdown.disabled = false; // Enable project dropdown only when projects are populated and organization is selected
            }
          } else if (message.command === 'receiveMessage') {
            appendMessage(message.text, message.role || 'bot', message.timestamp || Date.now());
            setProcessingState(false);
          } else if (message.command === 'clearChat') {
            clearChat();
          } else if (message.command === 'clearDropdowns') {
            clearDropdowns();
          } else if (message.command === 'addToChatHistory') {
            const key = getCurrentChatKey();
            if (key) {
              if (!chatHistories[key]) {
                chatHistories[key] = [];
              }
              chatHistories[key].push(message.message);
              saveState();
            }
          } else if (message.command === 'saveChatHistory') {
            const key = getCurrentChatKey();
            if (key) {
              chatHistories[key] = message.messages;
              saveState();
            }
          } else if (message.command === 'getChatHistory') {
            displayCurrentChatHistory();
          }
        });

        function clearChat() {
          messagesContainer.innerHTML = '';
          messageInput.value = '';
          setProcessingState(false);
          
          const key = getCurrentChatKey();
          if (key) {
            chatHistories[key] = [];
            saveState();
          }
        }

        function clearDropdowns() {
          orgDropdown.innerHTML = '<option value="" disabled selected>Select Organization</option>';
          projectDropdown.innerHTML = '<option value="" disabled selected>Select Project</option>';
          projectDropdown.disabled = true;
          selectedOrganization = null;
          selectedProject = null;
          saveState();
          messagesContainer.innerHTML = ''; // Clear messages without showing any message
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
            if (!isProcessing) {
              const text = button.getAttribute('data-text');
              messageInput.value = text;
              messageInput.focus();
            }
          });
        });

        // Add event listener for DOMContentLoaded to ensure elements are ready
        window.addEventListener('DOMContentLoaded', function() {
          console.log('DOM fully loaded and parsed');
          initializeCopyButton();
        });

        // Add logging to the copy button initialization
        function initializeCopyButton() {
          console.log('Initializing copy button');
          const copyButton = document.getElementById('copyButton');
          const summaryContent = document.getElementById('summaryContent');

          if (!copyButton || !summaryContent) {
            console.error('Required elements not found');
            return;
          }

          // Add click handler with logging
          copyButton.addEventListener('click', function() {
            console.log('Copy button clicked');
            try {
              const text = formatTableForClipboard();
              console.log('Formatted text:', text);

              vscode.postMessage({
                command: 'copyToClipboard',
                text: text
              });
              console.log('Message sent to extension:', { command: 'copyToClipboard', text });

              copyButton.textContent = 'Copying...';
              copyButton.style.backgroundColor = 'var(--vscode-badge-background)';
            } catch (err) {
              console.error('Error in click handler:', err);
              copyButton.textContent = 'Error occurred';
              setTimeout(() => {
                copyButton.textContent = 'Copy to Clipboard';
              }, 2000);
            }
          });

          console.log('Copy functionality initialized');
        }
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
      this._postMessage({ command: 'fetchOrganizations' });

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

      // Use the stored token counts from the last Gemini interaction
      const inputTokens = this.lastInteractionTokens?.input || 0;
      const outputTokens = this.lastInteractionTokens?.output || 0;

      console.log('Last Interaction Tokens:', this.lastInteractionTokens);
      console.log('Logging tokens:', { inputTokens, outputTokens });

      const response = await fetch(logUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email,
          total_input_tokens: inputTokens,
          total_output_tokens: outputTokens
        })
      });

      if (!response.ok) {
        console.error('Failed to log interaction:', await response.text());
      }

      // Reset the token counts after logging
      this.lastInteractionTokens = null;
    } catch (error) {
      console.error('Error logging interaction:', error);
    }
  }

  async _showOverdueTickets(organization, project, params = {}) {
    let email = null;
    try {
      email = await this._getEmail();
      const pat = await this._getPatToken();
      const client = new AzureDevOpsClient(organization, project, pat);
      
      // Handle error from command parsing
      if (params.error) {
        this._post(`❌ ${params.error}`);
        await this._logInteraction(email || 'unknown', '@overdue_tickets', params.error);
        return;
      }

      console.log('Params for overdue tickets:', params);
      const workItems = await client.getOverdueTickets(params.date);
      if (!workItems || workItems.length === 0) {
        const message = params.date 
          ? `No overdue tickets found as of ${params.date.toLocaleDateString()}.`
          : 'No overdue tickets found.';
        this._post(message);
        await this._logInteraction(email || 'unknown', '@overdue_tickets', message);
        return;
      }

      // Filter out tickets with missing or invalid due dates
      const validWorkItems = workItems.filter(ticket => {
        const dueDate = ticket.fields['Microsoft.VSTS.Scheduling.DueDate'];
        return dueDate && !isNaN(new Date(dueDate).getTime());
      });

      if (validWorkItems.length === 0) {
        const message = params.date
          ? `No overdue tickets with valid due dates found as of ${params.date.toLocaleDateString()}.`
          : 'No overdue tickets with valid due dates found.';
        this._post(message);
        await this._logInteraction(email || 'unknown', '@overdue_tickets', message);
        return;
      }

      // Filter work items if assignee is specified
      let filteredWorkItems = validWorkItems;
      if (params.assignee) {
        filteredWorkItems = validWorkItems.filter(ticket => {
          const assignedTo = ticket.fields['System.AssignedTo']?.displayName || 'Unassigned';
          // Check if the assignee matches either full name or first name
          return assignedTo.toLowerCase().includes(params.assignee.toLowerCase());
        });
      }

      if (filteredWorkItems.length === 0) {
        const message = params.assignee
          ? params.date
            ? `No overdue tickets found for ${params.assignee} as of ${params.date.toLocaleDateString()}.`
            : `No overdue tickets found for ${params.assignee}.`
          : params.date
            ? `No overdue tickets found as of ${params.date.toLocaleDateString()}.`
            : 'No overdue tickets found.';
        this._post(message);
        await this._logInteraction(email || 'unknown', '@overdue_tickets', message);
        return;
      }

      // Group tickets by assignee first, then by state
      const ticketsByAssignee = filteredWorkItems.reduce((acc, ticket) => {
        const assignee = ticket.fields['System.AssignedTo']?.displayName || 'Unassigned';
        const state = ticket.fields['System.State'] || 'Unknown';
        
        if (!acc[assignee]) {
          acc[assignee] = {
            Active: [],
            New: []
          };
        }
        
        if (state === 'Active') {
          acc[assignee].Active.push(ticket);
        } else if (state === 'New') {
          acc[assignee].New.push(ticket);
        }
        
        return acc;
      }, {});

      let message = '<b>📅 Overdue Tickets</b>';
      if (params.date) {
        message += ` (as of ${params.date.toLocaleDateString()})`;
      }
      message += '<br><br>';
      
      // Display tickets grouped by assignee and state
      for (const [assignee, states] of Object.entries(ticketsByAssignee)) {
        message += `<b>${assignee}</b><br>`;
        
        // Active tickets
        message += 'Active<br>';
        if (states.Active.length > 0) {
          const activeList = states.Active.map(w => {
            const workItemUrl = `https://dev.azure.com/${organization}/${project}/_workitems/edit/${w.id}`;
            const dueDate = new Date(w.fields['Microsoft.VSTS.Scheduling.DueDate']);
            // Subtract 5.5 hours from the due date
            dueDate.setHours(dueDate.getHours() - 5, dueDate.getMinutes() - 30);
            return `<li><b>#${w.id}</b> — <a href="${workItemUrl}" target="_blank">${w.fields['System.Title']}</a> (Due: ${dueDate.toLocaleString()})</li>`;
          }).join('');
          message += `<ul>${activeList}</ul>`;
        } else {
          message += 'No overdue tickets<br>';
        }

        // New tickets
        message += 'New<br>';
        if (states.New.length > 0) {
          const newList = states.New.map(w => {
            const workItemUrl = `https://dev.azure.com/${organization}/${project}/_workitems/edit/${w.id}`;
            const dueDate = new Date(w.fields['Microsoft.VSTS.Scheduling.DueDate']);
            // Subtract 5.5 hours from the due date
            dueDate.setHours(dueDate.getHours() - 5, dueDate.getMinutes() - 30);
            return `<li><b>#${w.id}</b> — <a href="${workItemUrl}" target="_blank">${w.fields['System.Title']}</a> (Due: ${dueDate.toLocaleString()})</li>`;
          }).join('');
          message += `<ul>${newList}</ul>`;
        } else {
          message += 'No overdue tickets<br>';
        }

        message += '<br><br><br>';
      }

      this._post(message);
      await this._logInteraction(email || 'unknown', '@overdue_tickets', message);
    } catch (error) {
      const errorMessage = `❌ Error fetching overdue tickets: ${error.message}`;
      this._post(errorMessage);
      await this._logInteraction(email || 'unknown', '@overdue_tickets', errorMessage);
    }
  }

  async _parseOverdueTicketsCommand(text) {
    const email = await this._getEmail();
    if (!email) return null;

    // Extract name from email
    const nameParts = email.split('@')[0].split('.');
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts[1] : '';
    const fullName = lastName ? `${firstName} ${lastName}` : firstName;

    // Check for "my overdue tickets" with date
    const myTicketsDateMatch = text.match(/@overdue_tickets\s+my\s+as of\s+(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[a-z]*\s*(?:\d{4})?)/i);
    if (myTicketsDateMatch) {
      const dateStr = myTicketsDateMatch[1].trim();
      // If no year is specified, use current year
      const currentYear = new Date().getFullYear();
      const dateWithYear = dateStr.match(/\d{4}$/) ? dateStr : `${dateStr} ${currentYear}`;
      
      // Remove ordinal indicators (st, nd, rd, th)
      const cleanDateStr = dateWithYear.replace(/(\d+)(st|nd|rd|th)/, '$1');
      
      const date = new Date(cleanDateStr);
      if (isNaN(date.getTime())) {
        return { error: 'Invalid date format. Please use format like "1st May" or "20 Jan" or "3 May 2024"' };
      }
      return { assignee: fullName, date };
    }

    // Check for "my overdue tickets" without date
    if (text.match(/@overdue_tickets\s+my/i)) {
      return { assignee: fullName };
    }

    // Check for both assignee and date first (this needs to be checked before individual patterns)
    const assigneeDateMatch = text.match(/@overdue_tickets\s+of\s+([^"]+)\s+as of\s+(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[a-z]*\s*(?:\d{4})?)/i);
    if (assigneeDateMatch) {
      const assignee = assigneeDateMatch[1].trim();
      const dateStr = assigneeDateMatch[2].trim();
      // If no year is specified, use current year
      const currentYear = new Date().getFullYear();
      const dateWithYear = dateStr.match(/\d{4}$/) ? dateStr : `${dateStr} ${currentYear}`;
      
      // Remove ordinal indicators (st, nd, rd, th)
      const cleanDateStr = dateWithYear.replace(/(\d+)(st|nd|rd|th)/, '$1');
      
      const date = new Date(cleanDateStr);
      if (isNaN(date.getTime())) {
        return { error: 'Invalid date format. Please use format like "1st May" or "20 Jan" or "3 May 2024"' };
      }
      return { assignee, date };
    }

    // Check for specific person's overdue tickets
    const assigneeMatch = text.match(/@overdue_tickets\s+of\s+([^"]+)/i);
    if (assigneeMatch) {
      return { assignee: assigneeMatch[1].trim() };
    }

    // Check for date-based queries
    const dateMatch = text.match(/@overdue_tickets\s+as of\s+(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[a-z]*\s*(?:\d{4})?)/i);
    if (dateMatch) {
      const dateStr = dateMatch[1].trim();
      // If no year is specified, use current year
      const currentYear = new Date().getFullYear();
      const dateWithYear = dateStr.match(/\d{4}$/) ? dateStr : `${dateStr} ${currentYear}`;
      
      // Remove ordinal indicators (st, nd, rd, th)
      const cleanDateStr = dateWithYear.replace(/(\d+)(st|nd|rd|th)/, '$1');
      
      const date = new Date(cleanDateStr);
      if (isNaN(date.getTime())) {
        return { error: 'Invalid date format. Please use format like "1st May" or "20 Jan" or "3 May 2024"' };
      }
      return { date };
    }

    // Default case: show all overdue tickets
    return {};
  }

  async _createTicketFromLastCommit(organization, project, email, userText, commitId = null) {
    try {
      // 1. Get the current workspace folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder found. Please open a workspace first.');
      }

      // 2. Find the git repository root
      let gitRoot;
      try {
        const { stdout } = await execAsync('git rev-parse --show-toplevel', { 
          cwd: workspaceFolders[0].uri.fsPath 
        });
        gitRoot = stdout.trim();
      } catch (error) {
        if (error.message.includes('not a git repository')) {
          throw new Error('This workspace is not a git repository. Please initialize git first.');
        }
        throw error;
      }

      // 3. Get commit message and detailed changes
      try {
        // Get commit message - use specific commit ID if provided, otherwise get last commit
        const commitCommand = commitId ? `git log ${commitId} -1 --pretty=%B` : 'git log -1 --pretty=%B';
        const { stdout: commitMsg } = await execAsync(commitCommand, { cwd: gitRoot });
        
        // Get detailed changes for each file
        const showCommand = commitId ? `git show ${commitId} --name-status` : 'git show --name-status';
        const { stdout: fileChanges } = await execAsync(showCommand, { cwd: gitRoot });
        
        // Get detailed diff for each file
        const diffCommand = commitId ? `git show ${commitId} -p` : 'git show -p';
        const { stdout: detailedDiff } = await execAsync(diffCommand, { cwd: gitRoot });
        
        if (!commitMsg || !fileChanges || !detailedDiff) {
          throw new Error('No commit information found. Make sure you have at least one commit in your repository.');
        }

        const commitSummary = `
          Commit Message:
          ${commitMsg}

          Files Changed:
          ${fileChanges}

          Detailed Changes:
          ${detailedDiff}
        `;

        console.log(fileChanges);
        console.log(detailedDiff);
        
        // 4. Use Gemini to generate title/description
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const prompt = `
          You are an assistant that writes Azure DevOps ticket titles and descriptions from git commit info.

          Given this commit info:
          ${commitSummary}

          Generate:
          1. A short, formal title summarizing the main change.
          2. A clear, professional description that:
             - Summarizes what was changed and why
             - Lists the files that were modified
             - Explains the key changes in each file
             - Highlights any important technical details or considerations

          Output as JSON:
          {
            "title": "<title>",
            "description": "<description>"
          }
        `;
        const response = await model.generateContent(prompt);
        const result = response.response;
        const json = JSON.parse(this._removeJsonWrapper(result.candidates[0].content.parts[0].text));
        const title = json.title;
        const description = json.description;

        // 5. Structure the description
        const structuredDesc = await this._structureDesc(description);

        // 6. Create the ticket
        await this._makeTicket(title, structuredDesc, organization, project);

        // 7. Log interaction
        const commitRef = commitId ? `commit ${commitId}` : 'last commit';
        await this._logInteraction(email, userText, `Created ticket from ${commitRef}: ${title}`);
        this._post(`✅ Created ticket from ${commitRef}: "${title}"`);
      } catch (gitError) {
        if (gitError.message.includes('No commit information found')) {
          throw new Error('No commits found in this repository. Please make at least one commit first.');
        } else if (gitError.message.includes('unknown revision')) {
          throw new Error(`Commit ID "${commitId}" not found. Please provide a valid commit ID.`);
        } else {
          throw new Error(`Git error: ${gitError.message}`);
        }
      }
    } catch (error) {
      const errorMessage = `❌ Error creating ticket from commit: ${error.message}`;
      this._post(errorMessage);
      await this._logInteraction(email, userText, errorMessage);
    }
  }

  async _showEpicSummary(organization, project, iterationPath) {
    let email = null;
    try {
      email = await this._getEmail();
      if (email === null) {
        const errorMessage = `❌ Error: You are not authorized to view epics in this project. Please check your Azure DevOps permissions.`;
        this._post(errorMessage);
        await this._logInteraction('unknown', `@epic_summary ${iterationPath}`, errorMessage);
        return;
      }

      const pat = await this._getPatToken();
      const client = new AzureDevOpsClient(organization, project, pat);

      // First, get all iterations to validate the path
      const iterations = await client.getAllIterations();
      const validIteration = iterations.find(iter => 
        iter.name.toLowerCase() === iterationPath.toLowerCase()
      );

      if (!validIteration) {
        const availableIterations = iterations.map(iter => iter.name).join(', ');
        const errorMessage = `❌ Invalid iteration path: "${iterationPath}". Available iterations are: ${availableIterations}`;
        this._post(errorMessage);
        await this._logInteraction(email, `@epic_summary ${iterationPath}`, errorMessage);
        return;
      }

      // Use the full iteration path from the valid iteration
      const fullIterationPath = validIteration.path;
      
      const epics = await client.getEpicSummary(fullIterationPath);
      if (!epics || epics.length === 0) {
        const message = `No epics found in iteration ${validIteration.name}.`;
        this._post(message);
        await this._logInteraction(email, `@epic_summary ${iterationPath}`, message);
        return;
      }

      // Process each epic
      const epicSummaries = [];
      for (const epic of epics) {
        const totalTasks = epic.childTasks.length;
        const doneTasks = epic.childTasks.filter(task => task.fields['System.State'] === 'Done');
        const completionPercentage = totalTasks > 0 ? Math.round((doneTasks.length / totalTasks) * 100) : 0;
        
        // Format the target date
        let formattedTargetDate = 'Not set';
        if (epic.fields['Microsoft.VSTS.Scheduling.TargetDate']) {
          const targetDate = new Date(epic.fields['Microsoft.VSTS.Scheduling.TargetDate']);
          if (!isNaN(targetDate.getTime())) {
            formattedTargetDate = targetDate.toLocaleDateString('en-GB', {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric'
            }).replace(/\//g, '-');
          }
        }

        // Get Gemini summary for done tasks
        let remarks = 'No completed tasks to summarize.';
        if (doneTasks.length > 0) {
          const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
          const prompt = `
            Write a business oriented 1 liner description in layment terms about what has been done in epic based on below tasks.
            Use plain text only, no formatting or styling.
            Completed tasks:
            ${doneTasks.map(task => `- ${task.fields['System.Title']}`).join('\n')}
          `;
          const response = await model.generateContent(prompt);
          const result = response.response;
          remarks = result.candidates[0].content.parts[0].text;
        }

        epicSummaries.push({
          id: epic.id,
          title: epic.fields['System.Title'],
          description: epic.fields['System.Description'] || 'No description provided.',
          owner: epic.fields['System.AssignedTo']?.displayName || 'Unassigned',
          status: epic.fields['System.State'],
          completionPercentage,
          targetDate: formattedTargetDate,
          remarks
        });
      }

      // Generate HTML table
      let html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body>
          <h3>Epic Summary for ${validIteration.name}</h3>
          <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
            <thead>
              <tr style="background-color: var(--vscode-editor-inactiveSelectionBackground);">
                <th style="padding: 8px; border: 1px solid var(--vscode-input-border);">Type</th>
                <th style="padding: 8px; border: 1px solid var(--vscode-input-border);">ID</th>
                <th style="padding: 8px; border: 1px solid var(--vscode-input-border);">Description</th>
                <th style="padding: 8px; border: 1px solid var(--vscode-input-border);">Owner</th>
                <th style="padding: 8px; border: 1px solid var(--vscode-input-border);">Status</th>
                <th style="padding: 8px; border: 1px solid var(--vscode-input-border);">Completion %</th>
                <th style="padding: 8px; border: 1px solid var(--vscode-input-border);">Expected Completion</th>
                <th style="padding: 8px; border: 1px solid var(--vscode-input-border);">Remarks</th>
              </tr>
            </thead>
            <tbody>
      `;

      for (const epic of epicSummaries) {
        html += `
          <tr>
            <td style="padding: 8px; border: 1px solid var(--vscode-input-border);">Epic</td>
            <td style="padding: 8px; border: 1px solid var(--vscode-input-border);">${epic.id}</td>
            <td style="padding: 8px; border: 1px solid var(--vscode-input-border);">${epic.title}</td>
            <td style="padding: 8px; border: 1px solid var(--vscode-input-border);">${epic.owner}</td>
            <td style="padding: 8px; border: 1px solid var(--vscode-input-border);">${epic.status}</td>
            <td style="padding: 8px; border: 1px solid var(--vscode-input-border);">${epic.completionPercentage}%</td>
            <td style="padding: 8px; border: 1px solid var(--vscode-input-border);">${epic.targetDate}</td>
            <td style="padding: 8px; border: 1px solid var(--vscode-input-border);">${epic.remarks}</td>
          </tr>
        `;
      }

      html += `
              </tbody>
            </table>
          </body>
        </html>
      `;

      this._post(html);
      await this._logInteraction(email, `@epic_summary ${iterationPath}`, html);
    } catch (error) {
      const errorMessage = `❌ Error generating epic summary: ${error.message}`;
      this._post(errorMessage);
      await this._logInteraction(email || 'unknown', `@epic_summary ${iterationPath}`, errorMessage);
    }
  }
}
module.exports = { activate, deactivate };
