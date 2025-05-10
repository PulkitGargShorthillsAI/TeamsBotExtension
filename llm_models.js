const { GoogleGenerativeAI } = require('@google/generative-ai');

class BaseLLMModel {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async generateContent(prompt) {
    throw new Error('generateContent method must be implemented by child class');
  }

  getModel() {
    throw new Error('getModel method must be implemented by child class');
  }
}

class GeminiModel extends BaseLLMModel {
  constructor(apiKey) {
    super(apiKey);
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  getModel(modelName = 'gemini-2.0-flash') {
    return this.genAI.getGenerativeModel({ model: modelName });
  }

  async generateContent(prompt) {
    const model = this.getModel();
    const response = await model.generateContent(prompt);
    return response.response;
  }
}

let fetch;
async function getFetch() {
  if (!fetch) {
    fetch = (await import('node-fetch')).default;
  }
  return fetch;
}

class AzureOpenAIModel extends BaseLLMModel {
  constructor(apiKey, backendUrl = process.env.AZURE_OPENAI_BACKEND_URL || 'http://localhost:8000') {
    super(apiKey); // apiKey is not used, but kept for interface compatibility
    this.backendUrl = backendUrl;
  }

  async generateContent(prompt, options = {}) {
    const fetch = await getFetch();
    const temperature = options.temperature || 0.7;
    const url = `${this.backendUrl}/azure-openai`;
    const body = {
      prompt,
      temperature
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`AzureOpenAI backend error: ${res.status} ${errText}`);
    }
    const data = await res.json();
    
    // Extract token usage from the response
    const usageMetadata = {
      promptTokenCount: data.usage_metadata?.prompt_tokens || 0,
      candidatesTokenCount: data.usage_metadata?.completion_tokens || 0,
      totalTokenCount: data.usage_metadata?.total_tokens || 0
    };

    // Return a similar structure as Gemini for compatibility
    return {
      response: {
        text: () => data.text,
        usageMetadata: usageMetadata,
        candidates: [
          { content: { parts: [ { text: data.text } ] } }
        ]
      },
      usageMetadata: usageMetadata // Add this to match Gemini's structure
    };
  }
}

// Add more model classes here as needed
// Example:
// class OpenAIModel extends BaseLLMModel { ... }
// class AnthropicModel extends BaseLLMModel { ... }

// Factory function to create model instances
function createLLMModel(modelType, apiKey) {
  switch (modelType.toLowerCase()) {
    case 'gemini':
      return new GeminiModel(apiKey);
    case 'azure-openai':
      return new AzureOpenAIModel(apiKey);
    // Add more cases as new models are implemented
    // case 'openai':
    //   return new OpenAIModel(apiKey);
    // case 'anthropic':
    //   return new AnthropicModel(apiKey);
    default:
      throw new Error(`Unsupported model type: ${modelType}`);
  }
}

module.exports = {
  BaseLLMModel,
  GeminiModel,
  AzureOpenAIModel,
  createLLMModel
}; 