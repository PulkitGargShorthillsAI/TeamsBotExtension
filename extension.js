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
  
    webviewView.webview.onDidReceiveMessage(async msg => {
      if (msg.command === 'fetchOrganizations') {
        const organizations = await this._getOrganizations();
        this._postMessage({ command: 'populateOrganizations', organizations });
      } else if (msg.command === 'fetchProjects') {
        const projects = await this._getProjects(msg.organization);
        this._postMessage({ command: 'populateProjects', projects });
      } else if (msg.command === 'sendMessage') {
        const { text, organization, project } = msg;
        if (!organization || !project) {
          this._post('❌ Please select both an organization and a project before proceeding.');
          return;
        }
        this._onUserMessage(text.trim(), organization, project);
      }
    });
  }

  _postMessage(message) {
    this.view?.webview.postMessage(message);
  }

  _removeJsonWrapper(text) {
    // Check if the text starts with ```json and ends with ```
    if (text.startsWith("```json") && text.endsWith("```")) {
      const lines = text.split("\n");
      return lines.slice(1, -1).join("\n"); // Remove the first and last line
    }
    return text;
  }
  

  async _onUserMessage(text, organization, project) {
    try {
      if (!organization || !project) {
        this._post('❌ Please select both an organization and a project before proceeding.');
        return;
      }
  
      // Use GEMINI to classify the user's input into multiple commands
      const commands = await this._getCommandsFromGemini(text);
  
      if (!commands || commands.length === 0) {
        this._post("I couldn't understand your request. Please try again.");
        return;
      }
  
      for (const command of commands) {
        if (command.startsWith('@create_ticket')) {
          const match = command.match(/^@create_ticket\s+(.+?)(?:\s+description\s+"(.+)")?$/i);
          if (match) {
            const title = match[1].trim();
            const description = match[2] ? match[2].trim() : null;
            this.pendingTitle = title;
            if (description) {
              const structured = await this._structureDesc(description);
              await this._makeTicket(title, structured, organization, project);
            } else {
              this._post(`Got it! Title: <b>${title}</b><br>
                Please describe what needs to be done in simple terms, or type "skip", "leave it blank", or "leave blank" to proceed without a description.`);
            }
          }
        } else if (command === '@help') {
          this._post(`
            <b>Here are the commands you can use:</b><br>
            • <code>@create_ticket &lt;title&gt;</code> - Create a new ticket.<br>
            • <code>@view_tickets</code> - View your open tickets.<br>
            • <code>@view_tickets &lt;id&gt;</code> - View details of a specific ticket by ID.<br>
            • <code>#&lt;id&gt; @comment &lt;comment text&gt;</code> - Add a comment to a specific ticket by ID.<br>
            • <code>@help</code> - Get information about available commands.<br>
            Feel free to ask me anything related to these commands!
          `);
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
        } else {
          this._post(`I couldn't understand the command: ${command}`);
        }
      }
    } catch (error) {
      console.error('Error handling user message:', error);
      this._post(`❌ An error occurred: ${error.message}`);
    }
  }

  async _getCommandsFromGemini(userMessage) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const prompt = `
      You are an intelligent assistant that interprets user messages and maps them to predefined commands.
      If the user provides multiple commands in one message, split them into separate commands.

      Available commands:
      - @help: Provide help information about available commands.
      - @view_tickets: View all tickets assigned to the user.
      - @view_tickets <id>: View details of a specific ticket by ID.
      - @create_ticket <title> description "<description>": Create a new ticket with the given title and description.
      - #<id> @comment <comment text>: Add a comment to a specific ticket by ID.

      User message: "${userMessage}"

      Return only the commands as a JSON array. Do not include any additional text or explanation. Example:
      ["@view_tickets", "#1269 @comment good job"]
    `;

      const response = await model.generateContent(prompt);
      console.log(response.response.text());

      
      const commands = JSON.parse(this._removeJsonWrapper(response.response.text().trim()));
      return commands;
    } catch (error) {
      console.error('Error fetching commands from GEMINI:', error);
      return null; // Return null if GEMINI fails
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
      const org = organization, proj = project, pat = process.env.AZURE_PAT;
      if (!org || !proj || !pat) throw new Error('Missing ORG/AZURE_PROJECT/AZURE_PAT');
      const email = await this._getEmail();

      if(email === null) {
        this._post(`❌ Error: You are not authorized to create tickets in this project. Please check your Azure DevOps permissions.`);
        return;
      }
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
      this._post(`❌ Error: You are not authorized to create tickets in this project. Please check your Azure DevOps permissions.`);
    }
  }

  async _showTickets(organization, project, workItemId = null) {
    try {
      
      const org = organization, proj = project, pat = process.env.AZURE_PAT;
      const client = new AzureDevOpsClient(org, proj, pat);
      const email = await this._getEmail();
        if (email === null) {
        this._post(`❌ Error: You are not authorized to create tickets in this project. Please check your Azure DevOps permissions.`);
        return;
      }

      if (workItemId) {
        // Fetch details of a specific work item
        const workItem = await client.getWorkItemDetails(workItemId);
        if (!workItem) {
          this._post(`❌ Work item with ID <b>${workItemId}</b> not found.`);
          return;
        }

        // Fetch history and format the work item
        const history = await this._getWorkItemHistory(org,proj,workItemId);
        const details = this._formatWorkItem(workItem, history);

        this._post(details);
      } else {
        // Fetch all assigned work items
        const items = await client.getAssignedWorkItems(email);
        if (items.length === 0) {
          this._post('You have no open tickets.');
        } else {
          const list = items.map(w => {
            const workItemUrl = `https://dev.azure.com/${org}/${proj}/_workitems/edit/${w.id}`;
            return `<li><a href="${workItemUrl}" target="_blank">#${w.id} — ${w.fields['System.Title']}</a></li>`;
          }).join('');
          this._post(`<b>Your Tickets:</b><ul>${list}</ul>`);
        }
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
      if(session.account && session.account.label && !session.account.label.endsWith('@shorthills.ai')) {
        return null;
      }
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

        #dropdown-container {
          display: flex;
          padding: 10px;
          gap: 10px;
          border-bottom: 1px solid var(--vscode-input-border);
          background-color: var(--vscode-editor-background);
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
          margin-right: 8px;
        }

        button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }

        #quick-actions {
          display: flex;
          padding: 10px 12px;
          border-bottom: 1px solid var(--vscode-input-border);
          background-color: var(--vscode-editor-background);
          gap: 8px;
          flex-wrap: wrap;
        }
      </style>
    </head>
    <body>
      <div id="dropdown-container">
        <select id="organization-dropdown">
          <option value="" disabled selected>Select Organization</option>
        </select>
        <select id="project-dropdown" disabled>
          <option value="" disabled selected>Select Project</option>
        </select>
      </div>
      <div id="chat-container">
        <div id="quick-actions">
          <button class="quick-action" data-text="@view_tickets">View Tickets</button>
          <button class="quick-action" data-text="@help">Help</button>
          <button class="quick-action" data-text="@create_ticket">Create Ticket</button>
          <button class="quick-action" data-text="#<id> @comment">Comment</button>
        </div>
        <div id="messages"></div>
        <div id="input-container">
          <input type="text" id="message-input" placeholder="Type a message..." />
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

        let selectedOrganization = null;
        let selectedProject = null;

        orgDropdown.addEventListener('change', () => {
          selectedOrganization = orgDropdown.options[orgDropdown.selectedIndex].textContent; // Get the organization name
          vscode.postMessage({ command: 'fetchProjects', organization: selectedOrganization });
        });

        projectDropdown.addEventListener('change', () => {
          selectedProject = projectDropdown.options[projectDropdown.selectedIndex].textContent; // Get the project name
        });

        sendButton.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', event => {
          if (event.key === 'Enter') sendMessage();
        });

        function sendMessage() {
          const text = messageInput.value.trim();
          if (!selectedOrganization || !selectedProject) {
            appendMessage('❌ Please select both an organization and a project before proceeding.', 'bot');
            return;
          }
          if (text) {
            appendMessage(text, 'user');
            vscode.postMessage({ command: 'sendMessage', text, organization: selectedOrganization, project: selectedProject });
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
          }
        });

        function populateDropdown(dropdown, items) {
          dropdown.innerHTML = '<option value="" disabled selected>Select</option>';
          items.forEach(item => {
            const option = document.createElement('option');
            option.value = item.id || item.name;
            option.textContent = item.name;
            dropdown.appendChild(option);
          });
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
      const org = organization, proj = project, pat = process.env.AZURE_PAT;
      const client = new AzureDevOpsClient(org, proj, pat);

      const email = await this._getEmail();

      if(email === null) {
        this._post(`❌ Error: You are not authorized to create tickets in this project. Please check your Azure DevOps permissions.`);
        return;
      }

      // Add the comment to the work item
      const response = await client.addComment(workItemId, commentText);
      if (response) {
        this._post(`✅ Comment added to work item <b>#${workItemId}</b>: "${commentText}"`);
      } else {
        this._post(`❌ Failed to add comment to work item <b>#${workItemId}</b>.`);
      }
    } catch (error) {
      console.error('Error adding comment to work item:', error);
      this._post(`❌ An error occurred while adding the comment: ${error.message}`);
    }
  }


  async _getProjects(organizationName) {
    try {
      const pat = process.env.AZURE_PAT;
      if (!organizationName || !pat) throw new Error('Missing organization name or AZURE_PAT.');
  
      const url = `https://dev.azure.com/${organizationName}/_apis/projects?api-version=7.1-preview.4`;
      const authHeader = { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` };
  
      const response = await fetch(url, { headers: authHeader });
      if (!response.ok) throw new Error(`Failed to fetch projects: ${response.status} ${response.statusText}`);
  
      const data = await response.json();
      return data.value.map(project => ({ id: project.id, name: project.name }));
    } catch (error) {
      console.error('Error fetching projects:', error);
      return [];
    }
  }






  async _getOrganizations() {
    try {
      const pat = process.env.AZURE_PAT;
      if (!pat) throw new Error('Missing AZURE_PAT in environment variables.');
  
      const profileUrl = `https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1-preview.1`;
      const authHeader = { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` };
  
      const profileResponse = await fetch(profileUrl, { headers: authHeader });
      if (!profileResponse.ok) throw new Error('Failed to fetch user profile.');
  
      const profileData = await profileResponse.json();
      const memberId = profileData.id;
  
      const orgsUrl = `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${memberId}&api-version=7.1-preview.1`;
      const orgsResponse = await fetch(orgsUrl, { headers: authHeader });
      if (!orgsResponse.ok) throw new Error('Failed to fetch organizations.');
  
      const orgsData = await orgsResponse.json();
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
}

module.exports = { activate, deactivate };
