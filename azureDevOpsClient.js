// azureDevOpsClient.js
let fetch; // will be dynamically imported

class AzureDevOpsClient {
  constructor(organization, project, personalAccessToken, apiVersion = '7.1') {
    this.organization = organization;
    this.project = project;
    this.apiVersion = apiVersion;
    this.personalAccessToken = personalAccessToken;
    this.baseUrl = `https://dev.azure.com/${this.organization}/${this.project}/_apis`;
  }

  async _loadFetch() {
    if (!fetch) {
      fetch = (await import('node-fetch')).default;
    }
  }

  _getAuthHeader() {
    const encoded = Buffer.from(`:${this.personalAccessToken}`).toString('base64');
    return { "Authorization": `Basic ${encoded}` };
  }

  async createWorkItem(workItemType, patchDocument) {
    await this._loadFetch();
    const url = `${this.baseUrl}/wit/workitems/$${workItemType}?api-version=${this.apiVersion}`;
    const headers = {
      "Content-Type": "application/json-patch+json",
      ...this._getAuthHeader()
    };
    const res = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patchDocument)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    return res.json();
  }

  /**
   * Fetch all non‑closed work items assigned to the given email.
   * @param {string} assignedToEmail 
   * @returns {Promise<Array<{ id: number, fields: object }>>}
   */
  async getAssignedWorkItems(assignedToEmail) {
    await this._loadFetch();
    // 1) Run a WIQL query
    const wiqlUrl = `${this.baseUrl}/wit/wiql?api-version=${this.apiVersion}`;
    const wiqlBody = {
      query: `
        SELECT [System.Id]
        FROM workitems
        WHERE [System.AssignedTo] = '${assignedToEmail}'
          AND [System.State] <> 'Closed'
        ORDER BY [System.Id] DESC
      `
    };
    const wiqlRes = await fetch(wiqlUrl, {
      method: 'POST',
      headers: {
        "Content-Type": "application/json",
        ...this._getAuthHeader()
      },
      body: JSON.stringify(wiqlBody)
    });
    if (!wiqlRes.ok) {
      const t = await wiqlRes.text();
      throw new Error(`WIQL failed: ${wiqlRes.status} ${t}`);
    }
    const wiqlData = await wiqlRes.json();
    const ids = wiqlData.workItems.map(w => w.id);
    if (ids.length === 0) return [];

    // 2) Batch‑fetch the details
    const batchUrl = `${this.baseUrl}/wit/workitems?ids=${ids.join(',')}&api-version=${this.apiVersion}`;
    const batchRes = await fetch(batchUrl, {
      headers: this._getAuthHeader()
    });
    if (!batchRes.ok) {
      const t = await batchRes.text();
      throw new Error(`Batch fetch failed: ${batchRes.status} ${t}`);
    }
    const batchData = await batchRes.json();
    return batchData.value;  // array of { id, fields, ... }
  }
}

module.exports = AzureDevOpsClient;
