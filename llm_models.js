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

// Add more model classes here as needed
// Example:
// class OpenAIModel extends BaseLLMModel { ... }
// class AnthropicModel extends BaseLLMModel { ... }

// Factory function to create model instances
function createLLMModel(modelType, apiKey) {
  switch (modelType.toLowerCase()) {
    case 'gemini':
      return new GeminiModel(apiKey);
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
  createLLMModel
}; 