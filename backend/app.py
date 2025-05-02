from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
import logging
import os
import csv

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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000,reload=True)
