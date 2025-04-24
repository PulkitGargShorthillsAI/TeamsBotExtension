let fetch; // Declare fetch variable
let open; // Declare open variable

const querystring = require('querystring');
const http = require('http');

let accessToken = null;
let refreshToken = null;
let tokenExpiry = null;

const clientId = process.env.AZURE_CLIENT_ID;
const clientSecret = process.env.AZURE_CLIENT_SECRET;
const redirectUri = process.env.AZURE_REDIRECT_URI;
const tenantId = process.env.AZURE_TENANT_ID;

async function getFetch() {
  if (!fetch) {
    fetch = (await import('node-fetch')).default; // Dynamically import node-fetch
  }
  return fetch;
}

async function getOpen() {
  if (!open) {
    open = (await import('open')).default; // Dynamically import open
  }
  return open;
}

async function getOAuthToken() {
  if (accessToken && tokenExpiry && new Date() < tokenExpiry) {
    return accessToken; // Return cached token if valid
  }

  if (refreshToken) {
    // Refresh the token
    const tokenData = await refreshOAuthToken(refreshToken);
    return tokenData.access_token;
  }

  // Start the OAuth flow
  const tokenData = await startOAuthFlow();
  return tokenData.access_token;
}

async function startOAuthFlow() {
  return new Promise(async (resolve, reject) => {
    const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
      querystring.stringify({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: 'vso.profile vso.project',
        state: '12345' // Optional: Add a state parameter for security
      });

    // Open the authorization URL in the user's browser
    const open = await getOpen();
    open(authUrl);

    // Start a local server to listen for the redirect
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${process.env.PORT || 3000}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        reject(new Error(`OAuth Error: ${error}`));
        res.end('Authentication failed. Please close this window.');
        server.close();
        return;
      }

      if (!code) {
        reject(new Error('No authorization code received.'));
        res.end('Authentication failed. Please close this window.');
        server.close();
        return;
      }

      try {
        const tokenData = await exchangeCodeForToken(code);
        resolve(tokenData);
        res.end('Authentication successful. You can close this window.');
      } catch (err) {
        reject(err);
        res.end('Authentication failed. Please close this window.');
      } finally {
        server.close();
      }
    });

    server.listen(process.env.PORT || 3000, () => {
      console.log(`Listening for OAuth redirect on port ${process.env.PORT || 3000}`);
    });
  });
}

async function exchangeCodeForToken(code) {
  const fetch = await getFetch(); // Use dynamically imported fetch
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = querystring.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!response.ok) {
    throw new Error(`Failed to exchange code for token: ${response.statusText}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  refreshToken = data.refresh_token;
  tokenExpiry = new Date(Date.now() + data.expires_in * 1000);
  return data;
}

async function refreshOAuthToken(refreshToken) {
  const fetch = await getFetch(); // Use dynamically imported fetch
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = querystring.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: redirectUri
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh token: ${response.statusText}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  refreshToken = data.refresh_token;
  tokenExpiry = new Date(Date.now() + data.expires_in * 1000);
  return data;
}

module.exports = { getOAuthToken };