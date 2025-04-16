const vscode = require('vscode');


/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {


	console.log('Congratulations, your extension "teamsBot" is now active!');


	const disposable = vscode.commands.registerCommand('teamsBot.helloWorld', function () {

		vscode.window.showInformationMessage('Hello World from TeamsBot!');
	});


	const disposable1 = vscode.commands.registerCommand('teamsBot.sayHi', function () {

		vscode.window.showInformationMessage('Hello How Are You!');
	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(disposable1);
}

function deactivate() {}

module.exports = {
	activate,
	deactivate
}
