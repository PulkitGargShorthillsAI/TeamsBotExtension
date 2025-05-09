const getStructureDescPrompt = (layman) => `
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

const getTypeSpecificPrompt = (title, originalDesc, ticketType) => {
  switch (ticketType.toLowerCase()) {
    case 'design':
      return `
You are an assistant that helps write structured Azure DevOps tickets in HTML format.

Based on:
  Title: ${title}
  Description: ${originalDesc}

Generate a response in formatted HTML (without wrapping it in \`\`\`html or any code block fences). Use the following structure:

<b>Objective:</b><br>
(Define the objective of the feature or component to be designed)

<br><br><b>Description:</b><br>
<ul>
  <li>High-level overview of proposed architecture and data flow</li>
  <li>Error handling, logging, and monitoring mechanisms</li>
  <li>Key assumptions, known constraints, and limitations</li>
</ul>

<br><b>Performance And Scale:</b><br>
(Mention the scale it would handle)

<br><br><b>High Level Test Cases:</b><br>
<ul>
  <li>List of all use cases including edge and corner cases</li>
</ul>

<br><b>Dependencies:</b><br>
(List all dependencies)

<br><br><b>Impacted Area:</b><br>
(Mention the impacted modules/components)

<br><br><b>Conclusion:</b><br>
Recommend proceeding to the implementation phase post-approval.
`;

    case 'implementation':
      return `
You are an assistant that helps write structured Azure DevOps tickets in HTML format.

Based on:
Title: ${title}
Description: ${originalDesc}

Generate a response in formatted HTML (without wrapping it in \`\`\`html or any code block fences). Use the following structure:

<b>Objective:</b><br>
(Outline the modules/components being developed)

<br><br><b>Description:</b><br>
<ul>
  <li>Design Pattern followed</li>
  <li>Reference to Loop design document or mention of BugFix changes</li>
</ul>
`;

    case 'unit_test':
      return `
You are an assistant that helps write structured Azure DevOps tickets in HTML format.

Based on:
Title: ${title}
Description: ${originalDesc}

Generate a response in formatted HTML (without wrapping it in \`\`\`html or any code block fences). Use the following structure:

<b>Objective:</b><br>
(Purpose of unit testing for the developed modules/features/components)

<br><br><b>Description:</b><br>
<ul>
  <li>Testing plan and strategy (tools/frameworks)</li>
  <li>Scope of unit testing – list components/modules covered</li>
  <li>Coverage of edge cases, boundary conditions, and negative paths</li>
</ul>

<br><b>Conclusion:</b><br>
<ul>
  <li>Uncovered areas with action points</li>
  <li>Include screenshots of execution status and code coverage</li>
</ul>
`;

    case 'integration_test':
      return `
You are an assistant that helps write structured Azure DevOps tickets in HTML format.

Based on:
Title: ${title}
Description: ${originalDesc}

Generate a response in formatted HTML (without wrapping it in \`\`\`html or any code block fences). Use the following structure:

<b>Objective:</b><br>
(List of Sprint features being verified)

<br><br><b>Description:</b><br>
<ul>
  <li>Test environment overview</li>
  <li>Scope of integration testing</li>
</ul>

<br><b>Test Cases:</b><br>
(Reference to test case document: Test_Case_Document_Template.docx)

<br><br><b>Conclusion:</b><br>
Provide screenshot of test execution status from the document.
`;

    default:
      return originalDesc;
  }
};

const getCommitAnalysisPrompt = (commitSummary) => `
You are a senior software engineer helping a project manager create clear, outcome-driven Azure DevOps ticket titles and descriptions from Git commit data.

Your job is to:
- Understand the purpose behind the code changes
- Capture what was **achieved** from a feature or task perspective
- Write like a human who understands the business and engineering goals

Use the following commit summary:
${commitSummary}

Generate a JSON with:
1. "title": A short, formal title summarizing the main outcome or feature delivered (not just what was changed).
2. "description": A detailed yet clear summary including:
   - What functionality or requirement was achieved or fixed (project-facing summary)
   - Why this change was necessary (brief rationale)
   - A high-level overview of key file changes (not raw diffs, but what they accomplished)
   - Any technical details relevant for QA, deployment, or PMs to understand
   - (Optional) Mention of acceptance criteria if it can be inferred

Only return the JSON in this format:
{
  "title": "<title>",
  "description": "<description>"
}
`;

const getEpicSummaryPrompt = (doneTasks) => `
Write a business oriented 1 liner description in layment terms about what has been done in epic based on below tasks.
Use plain text only, no formatting or styling.
Completed tasks:
${doneTasks.map(task => `- ${task.fields['System.Title']}`).join('\n')}
`;

module.exports = {
  getStructureDescPrompt,
  getTypeSpecificPrompt,
  getCommitAnalysisPrompt,
  getEpicSummaryPrompt
}; 