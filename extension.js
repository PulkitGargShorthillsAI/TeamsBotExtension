const vscode = require('vscode');
const AzureDevOpsClient = require('./azureDevOpsClient');  // Ensure this file exists and is in the correct location
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	console.log('Congratulations, your extension "teamsBot" is now active!');

	// Existing command: Hello World
	const disposableHello = vscode.commands.registerCommand('teamsBot.helloWorld', function () {
		vscode.window.showInformationMessage('Hello World from TeamsBot!');
	});
	
	// Existing command: Say Hi
	const disposableSayHi = vscode.commands.registerCommand('teamsBot.sayHi', function () {
		vscode.window.showInformationMessage('Hello How Are You!');
	});

    // New command: Create Work Item in Azure DevOps
	const disposableCreateWorkItem = vscode.commands.registerCommand('teamsBot.createWorkItem', async function () {
		try {
			// Replace the configuration values below with your actual values
			const organization = process.env.ORG;  // e.g. 'Contoso'
			const project = process.env.AZURE_PROJECT;            
			const workItemType = 'Task';   
			const personalAccessToken=process.env.AZURE_PAT;
			if (!organization || !project || !personalAccessToken) {
				throw new Error('Missing required environment variables: ORG, AZURE_PROJECT, AZURE_PAT');
			}
			
			// Instantiate the AzureDevOpsClient
			const client = new AzureDevOpsClient(organization, project, personalAccessToken);

			// Define the JSON patch document to set the work item's fields.
			const patchDocument = [
				{
					"op": "add",
					"path": "/fields/System.Title",
					"value": "New Work Item from VS Code Extension"
				},
				{
					"op": "add",
					"path": "/fields/System.Description",
					"value": "This work item was created automatically via the Azure DevOps REST API."
				}
                // Additional fields can be added here.
			];

			console.log('Attempting to create a new work item in Azure DevOps...');
			
			// Call the createWorkItem() method which returns a promise.
			const workItem = await client.createWorkItem(workItemType, patchDocument);
			const message = `Work item created successfully with ID: ${workItem.id}`;
			console.log(message);
			vscode.window.showInformationMessage(message);
		} catch (error) {
			console.error('Failed to create the work item:', error);
			vscode.window.showErrorMessage(`Failed to create work item: ${error.message}`);
		}
	});

	// Push the command disposables into the extension's subscriptions
	context.subscriptions.push(disposableHello, disposableSayHi, disposableCreateWorkItem);
}

function deactivate() {}

module.exports = {
	activate,
	deactivate
};
