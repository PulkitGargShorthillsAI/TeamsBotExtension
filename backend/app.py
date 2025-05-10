from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
import logging
import os
import csv
import requests
from dotenv import load_dotenv

load_dotenv()

# Configure logging
log_dir = "logs"
if not os.path.exists(log_dir):
    os.makedirs(log_dir)

# Create CSV file if it doesn't exist
csv_file = os.path.join(log_dir, 'chatbot_interactions.csv')
if not os.path.exists(csv_file):
    with open(csv_file, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['timestamp', 'email', 'total_input_tokens', 'total_output_tokens'])

app = FastAPI(docs_url="/")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatLog(BaseModel):
    email: str
    total_input_tokens: int
    total_output_tokens: int

# Add import for AzureChatOpenAI
try:
    from langchain_community.chat_models import AzureChatOpenAI
except ImportError:
    AzureChatOpenAI = None

class AzureOpenAIRequest(BaseModel):
    prompt: str
    temperature: float = 0.7

@app.post("/log")
async def log_interaction(chat_log: ChatLog):
    try:
        # Get current timestamp
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        
        # Write to CSV file
        with open(csv_file, 'a', newline='') as f:
            writer = csv.writer(f)
            writer.writerow([timestamp, chat_log.email, chat_log.total_input_tokens, chat_log.total_output_tokens])
        
        return {"status": "success", "message": "Log entry created"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

@app.post("/azure-openai")
async def azure_openai_completion(req: AzureOpenAIRequest):
    if AzureChatOpenAI is None:
        raise HTTPException(status_code=500, detail="langchain_community is not installed.")
    try:
        api_key = os.getenv("AZURE_OPENAI_API_KEY")
        api_version = os.getenv("AZURE_OPENAI_API_VERSION")
        azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        user_id = os.getenv("USER_ID")
        print(user_id)
        deployment_name = "gpt-4o-mini"
        model_name = "gpt-4o-mini"
        llm = AzureChatOpenAI(
            api_key=api_key,
            api_version=api_version,
            azure_endpoint=azure_endpoint,
            deployment_name=deployment_name,
            model_name=model_name,
            temperature=0.7,
            default_headers={"User-Id": user_id},
        )
        # Call the model
        result = llm.invoke(req.prompt)
        print(result)
        
        # Extract text content
        text = getattr(result, 'content', str(result))
        
        # Extract token usage from response_metadata
        token_usage = {}
        if hasattr(result, 'response_metadata') and result.response_metadata:
            metadata = result.response_metadata
            if 'token_usage' in metadata:
                token_usage = {
                    'prompt_tokens': metadata['token_usage'].get('prompt_tokens', 0),
                    'completion_tokens': metadata['token_usage'].get('completion_tokens', 0),
                    'total_tokens': metadata['token_usage'].get('total_tokens', 0)
                }
        
        return {
            "text": text,
            "usage_metadata": token_usage
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000,reload=True)
