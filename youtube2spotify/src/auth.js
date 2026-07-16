const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_SCOPES = "user-read-private playlist-modify-private";
const STORAGE_PREFIX = "youtube2spotify:";
const STORAGE_KEYS = {
  tokens: `${STORAGE_PREFIX}tokens`,
  verifier: `${STORAGE_PREFIX}pkce-verifier`,
  oauthState: `${STORAGE_PREFIX}oauth-state`,
  pendingTransfer: `${STORAGE_PREFIX}pending-transfer`,
};

export const spotifyClientId = (import.meta.env.VITE_SPOTIFY_CLIENT_ID ?? "").trim();
export const youtubeDeveloperKey = (import.meta.env.VITE_YOUTUBE_DEVELOPER_KEY ?? "").trim();

// `BASE_URL` is `./`, so this resolves to the deployed project root on GitHub Pages.
export const spotifyRedirectUri = new URL(import.meta.env.BASE_URL, window.location.href).href;

let refreshPromise = null;

export class AuthenticationError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "AuthenticationError";
    this.status = status;
    this.code = code;
  }
}

function readStorage(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    throw new AuthenticationError("Browser session storage is unavailable. Enable it and try again.");
  }
}

function writeStorage(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    throw new AuthenticationError("Browser session storage is unavailable. Enable it and try again.");
  }
}

function removeStorage(key) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // There is nothing useful to clean up if session storage is unavailable.
  }
}

function randomString(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const randomValues = window.crypto.getRandomValues(new Uint8Array(length));
  return Array.from(randomValues, (value) => alphabet[value % alphabet.length]).join("");
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary)
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

async function createCodeChallenge(verifier) {
  const encoded = new TextEncoder().encode(verifier);
  return base64UrlEncode(await window.crypto.subtle.digest("SHA-256", encoded));
}

function readTokens() {
  const rawTokens = readStorage(STORAGE_KEYS.tokens);
  if (!rawTokens) return null;
  try {
    const tokens = JSON.parse(rawTokens);
    return tokens?.accessToken ? tokens : null;
  } catch {
    removeStorage(STORAGE_KEYS.tokens);
    return null;
  }
}

function saveTokens(response, previousRefreshToken = null) {
  if (!response.access_token) {
    throw new AuthenticationError("Spotify did not return an access token.");
  }
  const lifetimeSeconds = Number(response.expires_in) || 3600;
  const tokens = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previousRefreshToken,
    expiresAt: Date.now() + Math.max(30, lifetimeSeconds - 60) * 1000,
  };
  writeStorage(STORAGE_KEYS.tokens, JSON.stringify(tokens));
  return tokens;
}

async function tokenRequest(parameters) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
    });
  } catch {
    throw new AuthenticationError(
      "Could not connect to Spotify while authenticating. Check your connection and retry.",
      { code: "network_error" },
    );
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.error_description || body.error || `HTTP ${response.status}`;
    throw new AuthenticationError(`Spotify authentication failed: ${detail}`, {
      status: response.status,
      code: body.error || null,
    });
  }
  return body;
}

export function getConfigurationIssues() {
  const issues = [];
  if (!spotifyClientId) issues.push("VITE_SPOTIFY_CLIENT_ID is not configured.");
  if (!youtubeDeveloperKey) issues.push("VITE_YOUTUBE_DEVELOPER_KEY is not configured.");
  return issues;
}

export function savePendingTransfer(transfer) {
  writeStorage(STORAGE_KEYS.pendingTransfer, JSON.stringify(transfer));
}

export function getPendingTransfer() {
  const rawTransfer = readStorage(STORAGE_KEYS.pendingTransfer);
  if (!rawTransfer) return null;
  try {
    const transfer = JSON.parse(rawTransfer);
    if (!transfer?.youtubePlaylist || !transfer?.spotifyPlaylistName) return null;
    return transfer;
  } catch {
    return null;
  }
}

export function clearPendingTransfer() {
  removeStorage(STORAGE_KEYS.pendingTransfer);
}

export function hasSpotifySession() {
  const tokens = readTokens();
  return Boolean(tokens?.accessToken && (tokens.expiresAt > Date.now() || tokens.refreshToken));
}

export async function startSpotifyAuthorization(transfer) {
  if (!spotifyClientId) {
    throw new AuthenticationError("The Spotify client ID is not configured.");
  }
  savePendingTransfer(transfer);

  const verifier = randomString(96);
  const state = randomString(48);
  writeStorage(STORAGE_KEYS.verifier, verifier);
  writeStorage(STORAGE_KEYS.oauthState, state);

  const authorizationUrl = new URL(AUTHORIZE_URL);
  authorizationUrl.search = new URLSearchParams({
    client_id: spotifyClientId,
    response_type: "code",
    redirect_uri: spotifyRedirectUri,
    scope: SPOTIFY_SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: await createCodeChallenge(verifier),
    show_dialog: "true",
  }).toString();
  window.location.assign(authorizationUrl);
}

export function hasSpotifyCallback() {
  const parameters = new URLSearchParams(window.location.search);
  return parameters.has("code") || parameters.has("error");
}

export async function handleSpotifyCallback() {
  const parameters = new URLSearchParams(window.location.search);
  const code = parameters.get("code");
  const error = parameters.get("error");
  if (!code && !error) return false;

  const expectedState = readStorage(STORAGE_KEYS.oauthState);
  const returnedState = parameters.get("state");
  if (!expectedState || !returnedState || expectedState !== returnedState) {
    throw new AuthenticationError("Spotify login could not be verified. Please start the transfer again.");
  }

  if (error) {
    removeStorage(STORAGE_KEYS.verifier);
    removeStorage(STORAGE_KEYS.oauthState);
    if (error === "access_denied") {
      throw new AuthenticationError("Spotify connection was cancelled. Please authorize the app to continue.");
    }
    throw new AuthenticationError(`Spotify authorization failed: ${error}`);
  }

  const verifier = readStorage(STORAGE_KEYS.verifier);
  if (!verifier) {
    throw new AuthenticationError("The Spotify login session expired. Please start the transfer again.");
  }

  const response = await tokenRequest({
    client_id: spotifyClientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: spotifyRedirectUri,
    code_verifier: verifier,
  });
  saveTokens(response);
  removeStorage(STORAGE_KEYS.verifier);
  removeStorage(STORAGE_KEYS.oauthState);
  return true;
}

export function removeCallbackParameters() {
  const cleanUrl = new URL(spotifyRedirectUri);
  window.history.replaceState({}, document.title, cleanUrl);
}

async function refreshAccessToken() {
  const tokens = readTokens();
  if (!tokens?.refreshToken) {
    clearSpotifySession();
    throw new AuthenticationError("Your Spotify session expired. Please connect Spotify again.");
  }

  try {
    const response = await tokenRequest({
      client_id: spotifyClientId,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    });
    return saveTokens(response, tokens.refreshToken).accessToken;
  } catch (error) {
    // A temporary network/5xx/429 failure does not invalidate the refresh token.
    if (error instanceof AuthenticationError && error.code === "invalid_grant") {
      clearSpotifySession();
    }
    throw error;
  }
}

async function getAccessToken(forceRefresh = false) {
  const tokens = readTokens();
  if (!tokens) {
    throw new AuthenticationError("Spotify is not connected. Please log in again.");
  }
  if (!forceRefresh && tokens.expiresAt > Date.now()) return tokens.accessToken;

  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function authorizedSpotifyFetch(url, options = {}) {
  const request = async (forceRefresh) => {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${await getAccessToken(forceRefresh)}`);
    return fetch(url, { ...options, headers });
  };

  let response = await request(false);
  if (response.status === 401) response = await request(true);
  return response;
}

export function clearSpotifySession() {
  removeStorage(STORAGE_KEYS.tokens);
  removeStorage(STORAGE_KEYS.verifier);
  removeStorage(STORAGE_KEYS.oauthState);
}

export function logout() {
  clearSpotifySession();
  clearPendingTransfer();
}
