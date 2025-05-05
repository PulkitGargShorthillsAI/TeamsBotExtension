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

  async getWorkItemDetails(workItemId) {
    await this._loadFetch();
    const url = `${this.baseUrl}/wit/workitems/${workItemId}?$expand=all&api-version=${this.apiVersion}`;
    const res = await fetch(url, {
      headers: this._getAuthHeader()
    });
    if (!res.ok) {
      if (res.status === 404) return null; // Work item not found
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    const workItem = await res.json();

    console.log(`Fetched work item ${workItemId}:`, workItem);
    

    // Extract Created By and Assigned To
    const createdByField = workItem.fields['System.CreatedBy']['displayName'];
    const assignedToField = workItem.fields['System.AssignedTo']['displayName'];
    workItem.fields['System.CreatedBy'] = createdByField || 'Unknown';
    workItem.fields['System.AssignedTo'] = assignedToField || 'Unassigned';

    // Fetch comments if available
    const commentsUrl = `${this.baseUrl}/wit/workitems/${workItemId}/comments?api-version=${this.apiVersion}`;
    const commentsRes = await fetch(commentsUrl, {
      headers: this._getAuthHeader()
    });
    if (commentsRes.ok) {
      const commentsData = await commentsRes.json();
      workItem.comments = commentsData.comments.map(c => ({
        text: c.text,
        createdBy: c.createdBy.displayName,
        createdDate: c.createdDate
      }));
    } else {
      workItem.comments = []; // No comments available
    }
    return workItem;
  }

  async addComment(workItemId, commentText) {
    await this._loadFetch();
    const url = `${this.baseUrl}/wit/workitems/${workItemId}/comments?api-version=7.1-preview`; // Use 7.1-preview
    const body = {
      text: commentText
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        "Content-Type": "application/json",
        ...this._getAuthHeader()
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    return res.json();
  }

  async updateWorkItem(workItemId, title, description) {
    await this._loadFetch();
    const url = `${this.baseUrl}/wit/workitems/${workItemId}?api-version=${this.apiVersion}`;
    const patchDocument = [
      { op: 'replace', path: '/fields/System.Title', value: title },
      { op: 'replace', path: '/fields/System.Description', value: description }
    ];
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

  async getBoardSummary() {
    await this._loadFetch();
    const wiqlUrl = `${this.baseUrl}/wit/wiql?api-version=${this.apiVersion}`;
    
    const wiqlQuery = {
      query: `
        SELECT [System.Id], [System.State], [System.AssignedTo], [System.Title], [System.IterationPath]
        FROM WorkItems
        WHERE [System.TeamProject] = @project
        ORDER BY [System.ChangedDate] DESC
      `
    };

    const response = await fetch(wiqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this._getAuthHeader()
      },
      body: JSON.stringify(wiqlQuery)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch board summary: ${response.status}`);
    }

    const data = await response.json();
    const workItemRefs = data.workItems || [];
    const workItemIds = workItemRefs.map(item => item.id);

    if (workItemIds.length === 0) {
      return [];
    }

    // Fetch work items in batches of 200
    const chunkSize = 200;
    const allWorkItems = [];

    for (let i = 0; i < workItemIds.length; i += chunkSize) {
      const chunk = workItemIds.slice(i, i + chunkSize).join(",");
      const batchUrl = `${this.baseUrl}/wit/workitems?ids=${chunk}&fields=System.State,System.AssignedTo,System.Title,System.IterationPath&api-version=${this.apiVersion}`;

      const batchResponse = await fetch(batchUrl, {
        headers: this._getAuthHeader()
      });

      if (!batchResponse.ok) {
        throw new Error(`Failed to fetch work item batch: ${batchResponse.status}`);
      }

      const batchData = await batchResponse.json();
      allWorkItems.push(...batchData.value);
    }

    return allWorkItems;
  }

  async getIterations() {
    await this._loadFetch();
    const url = `${this.baseUrl}/work/teamsettings/iterations?api-version=${this.apiVersion}`;
    
    const response = await fetch(url, {
      headers: this._getAuthHeader()
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch iterations: ${response.status}`);
    }

    const data = await response.json();
    const iterations = data.value || [];

    // Find the current iteration based on the current date
    const currentDate = new Date();
    console.log(currentDate);
    
    const currentIteration = iterations.find(iteration => {
      
      const startDate = new Date(iteration.attributes.startDate);
      console.log(startDate);
      
      const finishDate = new Date(iteration.attributes.finishDate);
      return currentDate >= startDate && currentDate <= finishDate;
    });

    return currentIteration ? [currentIteration] : [];
  }

  async getOverdueTickets(asOfDate = null) {
    await this._loadFetch();
    const wiqlUrl = `${this.baseUrl}/wit/wiql?api-version=${this.apiVersion}`;
    
    // Format the date for WIQL query
    let dateCondition = '';
    if (asOfDate) {
      // Format date to YYYY-MM-DD format for WIQL
      const formattedDate = asOfDate.toISOString().split('T')[0];
      dateCondition = `AND [Microsoft.VSTS.Scheduling.DueDate] <= '${formattedDate}'`;
      console.log('Using date condition:', dateCondition);
    } else {
      dateCondition = `AND [Microsoft.VSTS.Scheduling.DueDate] < @Today`;
      console.log('Using today condition');
    }
    
    const wiqlQuery = {
      query: `
        SELECT [System.Id], [System.State], [System.AssignedTo], [System.Title], [Microsoft.VSTS.Scheduling.DueDate]
        FROM WorkItems
        WHERE [System.TeamProject] = @project
        AND [System.State] IN ('Active', 'New')
        ${dateCondition}
        ORDER BY [Microsoft.VSTS.Scheduling.DueDate] ASC
      `
    };

    console.log('WIQL Query:', wiqlQuery.query);

    const response = await fetch(wiqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this._getAuthHeader()
      },
      body: JSON.stringify(wiqlQuery)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('WIQL Query Error:', errorText);
      throw new Error(`Failed to fetch overdue tickets: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const workItemRefs = data.workItems || [];
    const workItemIds = workItemRefs.map(item => item.id);

    if (workItemIds.length === 0) {
      return [];
    }

    // Fetch work items in batches of 200
    const chunkSize = 200;
    const allWorkItems = [];

    for (let i = 0; i < workItemIds.length; i += chunkSize) {
      const chunk = workItemIds.slice(i, i + chunkSize).join(",");
      const batchUrl = `${this.baseUrl}/wit/workitems?ids=${chunk}&fields=System.State,System.AssignedTo,System.Title,Microsoft.VSTS.Scheduling.DueDate&api-version=${this.apiVersion}`;

      const batchResponse = await fetch(batchUrl, {
        headers: this._getAuthHeader()
      });

      if (!batchResponse.ok) {
        const errorText = await batchResponse.text();
        console.error('Batch Fetch Error:', errorText);
        throw new Error(`Failed to fetch work item batch: ${batchResponse.status} - ${errorText}`);
      }

      const batchData = await batchResponse.json();
      allWorkItems.push(...batchData.value);
    }

    return allWorkItems;
  }

  async getEpicSummary(iterationPath) {
    await this._loadFetch();
    const wiqlUrl = `${this.baseUrl}/wit/wiql?api-version=${this.apiVersion}`;
    
    // Escape special characters in iteration path
    const escapedIterationPath = iterationPath.replace(/'/g, "''");
    
    const wiqlQuery = {
      query: `
        SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo], [System.Description], [Microsoft.VSTS.Scheduling.TargetDate]
        FROM WorkItems
        WHERE [System.TeamProject] = '${this.project}'
        AND [System.WorkItemType] = 'Epic'
        AND [System.IterationPath] = '${escapedIterationPath}'
        ORDER BY [System.Id] DESC
      `
    };

    console.log('Executing WIQL query:', wiqlQuery.query);

    const response = await fetch(wiqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this._getAuthHeader()
      },
      body: JSON.stringify(wiqlQuery)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('WIQL Query Error:', errorText);
      throw new Error(`Failed to fetch epics: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const epicRefs = data.workItems || [];
    const epicIds = epicRefs.map(item => item.id);

    if (epicIds.length === 0) {
      return [];
    }

    // Fetch epic details in batches
    const chunkSize = 200;
    const allEpics = [];

    for (let i = 0; i < epicIds.length; i += chunkSize) {
      const chunk = epicIds.slice(i, i + chunkSize).join(",");
      const batchUrl = `${this.baseUrl}/wit/workitems?ids=${chunk}&$expand=relations&api-version=${this.apiVersion}`;

      const batchResponse = await fetch(batchUrl, {
        headers: this._getAuthHeader()
      });

      if (!batchResponse.ok) {
        const errorText = await batchResponse.text();
        console.error('Batch Fetch Error:', errorText);
        throw new Error(`Failed to fetch epic batch: ${batchResponse.status} - ${errorText}`);
      }

      const batchData = await batchResponse.json();
      allEpics.push(...batchData.value);
    }

    // For each epic, fetch its child tasks in batches
    for (const epic of allEpics) {
      const childLinks = epic.relations?.filter(rel => 
        rel.rel === 'System.LinkTypes.Hierarchy-Forward' || 
        rel.rel === 'System.LinkTypes.Hierarchy-Reverse'
      ) || [];

      const childIds = childLinks.map(link => {
        const urlParts = link.url.split('/');
        return urlParts[urlParts.length - 1];
      });

      if (childIds.length > 0) {
        // Fetch child tasks in batches of 200
        const tasksChunkSize = 200;
        const allChildTasks = [];

        for (let i = 0; i < childIds.length; i += tasksChunkSize) {
          const chunk = childIds.slice(i, i + tasksChunkSize).join(',');
          const tasksUrl = `${this.baseUrl}/wit/workitems?ids=${chunk}&fields=System.Id,System.Title,System.State&api-version=${this.apiVersion}`;
          
          const tasksResponse = await fetch(tasksUrl, {
            headers: this._getAuthHeader()
          });

          if (!tasksResponse.ok) {
            const errorText = await tasksResponse.text();
            console.error('Tasks Fetch Error:', errorText);
            throw new Error(`Failed to fetch child tasks: ${tasksResponse.status} - ${errorText}`);
          }

          const tasksData = await tasksResponse.json();
          allChildTasks.push(...tasksData.value);
        }

        epic.childTasks = allChildTasks;
      } else {
        epic.childTasks = [];
      }
    }

    return allEpics;
  }
}

module.exports = AzureDevOpsClient;
