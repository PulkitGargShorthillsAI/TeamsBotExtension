// azureDevOpsClient.js
let fetch; // Declare fetch variable

class AzureDevOpsClient {
  /**
   * Initializes the client with organization, project, and PAT details.
   * @param {string} organization - The Azure DevOps organization name.
   * @param {string} project - The Azure DevOps project name.
   * @param {string} personalAccessToken - Your Azure DevOps Personal Access Token (PAT).
   * @param {string} [apiVersion='7.1'] - The API version to use.
   */
  constructor(organization, project, personalAccessToken, apiVersion = '7.1') {
    this.organization = organization;
    this.project = project;
    this.apiVersion = apiVersion;
    this.personalAccessToken = personalAccessToken;
    this.baseUrl = `https://dev.azure.com/${this.organization}/${this.project}/_apis`;
  }

  /**
   * Private method to dynamically load fetch.
   */
  async _loadFetch() {
    if (!fetch) {
      fetch = (await import('node-fetch')).default; // Dynamically import node-fetch
    }
  }

  /**
   * Private method to get the authorization header.
   * @returns {Object} Authorization header object.
   */
  _getAuthHeader() {
    // The username is blank, so we use ":<PAT>".
    const encodedPAT = Buffer.from(`:${this.personalAccessToken}`).toString('base64');
    return { "Authorization": `Basic ${encodedPAT}` };
  }

  /**
   * Creates a new work item (ticket) in Azure DevOps.
   * @param {string} workItemType - The type of work item (e.g., Task, Bug, User Story).
   * @param {Array<Object>} patchDocument - The JSON patch document for the work item.
   * @returns {Promise<Object>} The created work item object.
   */
  async createWorkItem(workItemType, patchDocument) {
    await this._loadFetch(); // Ensure fetch is loaded
    const url = `${this.baseUrl}/wit/workitems/$${workItemType}?api-version=${this.apiVersion}`;
    // Combine required headers.
    const headers = {
      "Content-Type": "application/json-patch+json",
      ...this._getAuthHeader()
    };

    try {
      console.log(`Sending PATCH request to: ${url}`);
      const response = await fetch(url, {
        method: 'PATCH',
        headers: headers,
        body: JSON.stringify(patchDocument)
      });

      if (!response.ok) {
        // Read response text for error details.
        const errorText = await response.text();
        console.error(`Error creating work item - ${response.status}: ${response.statusText}`);
        console.error(`Response: ${errorText}`);
        throw new Error(`Failed to create work item. HTTP status: ${response.status}`);
      }

      const data = await response.json();
      console.log(`Work item created successfully with ID: ${data.id}`);
      return data;
    } catch (error) {
      console.error(`Exception in createWorkItem: ${error.message}`);
      throw error;
    }
  }
}

module.exports = AzureDevOpsClient;