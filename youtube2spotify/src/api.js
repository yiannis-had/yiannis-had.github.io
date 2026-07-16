import {
  authorizedSpotifyFetch,
  youtubeDeveloperKey,
} from "./auth.js";
import {
  SongSearch,
  cleanChannelTitle,
  isValidMatch,
  parseSongTitle,
} from "./matcher.js";

const YOUTUBE_PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const SEARCH_CONCURRENCY = 4;
const PLAYLIST_BATCH_SIZE = 100;

let spotifyBlockedUntil = 0;

export class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The transfer was cancelled.", "AbortError");
}

function sleep(milliseconds, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForSpotifyAvailability(signal) {
  if (signal?.aborted) throw abortError(signal);
  while (spotifyBlockedUntil > Date.now()) {
    await sleep(spotifyBlockedUntil - Date.now(), signal);
  }
}

function pauseSpotifyRequests(milliseconds) {
  spotifyBlockedUntil = Math.max(spotifyBlockedUntil, Date.now() + milliseconds);
  window.dispatchEvent(new CustomEvent("spotify-rate-limited", {
    detail: { delayMilliseconds: milliseconds },
  }));
}

function retryDelay(response, attempt, fallbackMilliseconds = 1000) {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return fallbackMilliseconds * 2 ** attempt;
}

async function responseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function apiErrorMessage(service, response, body) {
  const detail = typeof body === "string"
    ? body
    : body?.error?.message || body?.error_description || body?.message || body?.error;
  const suffix = typeof detail === "string" && detail ? `: ${detail}` : "";

  if (service === "YouTube" && response.status === 403) {
    return `YouTube could not read this playlist${suffix}. Check that it is public, the Data API is enabled, and the API key's website restrictions include this site.`;
  }
  if (service === "YouTube" && response.status === 404) {
    return `YouTube playlist not found${suffix}. Check the playlist URL and make sure the playlist is public.`;
  }
  if (service === "Spotify" && response.status === 403) {
    return `Spotify refused this action${suffix}. Check the app's user allowlist and granted playlist permissions in the Spotify dashboard.`;
  }
  return `${service} API request failed (HTTP ${response.status})${suffix}`;
}

function spotifyOperation(path) {
  if (path === "/me") return "loading your Spotify profile";
  if (path === "/me/playlists") return "creating the Spotify playlist";
  if (path.startsWith("/search?")) return "searching Spotify for a track";
  if (path.startsWith("/playlists/")) return "adding tracks to the Spotify playlist";
  return "calling the Spotify API";
}

async function spotifyRequest(path, options = {}, maxRateLimitRetries = 5) {
  const method = (options.method || "GET").toUpperCase();
  const signal = options.signal;
  let networkAttempts = 0;
  let serverAttempts = 0;
  let rateLimitAttempts = 0;

  while (true) {
    await waitForSpotifyAvailability(signal);

    let response;
    try {
      response = await authorizedSpotifyFetch(`${SPOTIFY_API_URL}${path}`, options);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error instanceof TypeError && method === "GET" && networkAttempts < 4) {
        const delay = Math.min(1000 * 2 ** networkAttempts, 10000);
        networkAttempts += 1;
        await sleep(delay, signal);
        continue;
      }
      if (error instanceof TypeError) {
        throw new ApiError(
          `The browser received no response while ${spotifyOperation(path)}. This is not an HTTP 429 response. Check the browser Network panel for a blocked request to api.spotify.com, then try without privacy/ad-blocking extensions.`,
        );
      }
      throw error;
    }

    if (response.status === 429) {
      if (rateLimitAttempts >= maxRateLimitRetries) {
        const body = await responseBody(response);
        const message = apiErrorMessage("Spotify", response, body);
        throw new ApiError(`${message}. Spotify's rate limit did not clear after several coordinated pauses.`, 429);
      }
      const delay = retryDelay(response, rateLimitAttempts);
      rateLimitAttempts += 1;
      pauseSpotifyRequests(delay);
      await response.body?.cancel();
      continue;
    }

    if (response.status >= 500 && method === "GET" && serverAttempts < 3) {
      const delay = Math.min(2000 * 2 ** serverAttempts, 10000);
      serverAttempts += 1;
      await response.body?.cancel();
      await sleep(delay, signal);
      continue;
    }

    const body = await responseBody(response);
    if (!response.ok) throw new ApiError(apiErrorMessage("Spotify", response, body), response.status);
    return body;
  }
}

export function parsePlaylistId(value) {
  const input = value.trim();
  if (/^[\w-]{10,}$/.test(input)) return input;

  let url;
  try {
    url = new URL(input);
  } catch {
    try {
      url = new URL(`https://${input}`);
    } catch {
      throw new ApiError("Enter a valid YouTube playlist URL or playlist ID.");
    }
  }

  const playlistId = url.searchParams.get("list");
  if (!playlistId || !/^[\w-]{10,}$/.test(playlistId)) {
    throw new ApiError("This URL does not contain a valid YouTube playlist ID (`list=...`).");
  }
  return playlistId;
}

async function youtubeRequest(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(url);
    } catch {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new ApiError("Could not connect to YouTube. Check your connection and try again.");
    }

    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await sleep(retryDelay(response, attempt));
      continue;
    }
    const body = await responseBody(response);
    if (!response.ok) throw new ApiError(apiErrorMessage("YouTube", response, body), response.status);
    return body;
  }
  throw new ApiError("YouTube did not respond after several attempts.");
}

export async function fetchYouTubePlaylistItems(playlistInput) {
  if (!youtubeDeveloperKey) {
    throw new ApiError("The YouTube developer key is not configured.");
  }

  const playlistId = parsePlaylistId(playlistInput);
  const items = [];
  let pageToken = null;
  do {
    const url = new URL(YOUTUBE_PLAYLIST_ITEMS_URL);
    url.search = new URLSearchParams({
      part: "snippet",
      maxResults: "50",
      playlistId,
      key: youtubeDeveloperKey,
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const page = await youtubeRequest(url);
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);

  if (!items.length) {
    throw new ApiError("The YouTube playlist is empty or has no accessible videos.");
  }
  return items;
}

async function findTrackUri(video, signal) {
  const title = video?.snippet?.title ?? "";
  let search = parseSongTitle(title);
  if (!search) return null;

  if (!search.artists.length) {
    const channelArtist = cleanChannelTitle(video?.snippet?.videoOwnerChannelTitle);
    if (channelArtist) search = new SongSearch(search.track, [channelArtist]);
  }

  for (const query of search.queries()) {
    const parameters = new URLSearchParams({ q: query, type: "track", limit: "10" });
    const results = await spotifyRequest(`/search?${parameters}`, { signal });
    const match = results?.tracks?.items?.find((track) => isValidMatch(search, track));
    if (match?.uri) return match.uri;
  }
  return null;
}

async function mapWithConcurrency(items, concurrency, mapper, onItemComplete) {
  const results = new Array(items.length);
  const controller = new AbortController();
  let nextIndex = 0;
  let completed = 0;
  let firstError = null;

  async function worker() {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], controller.signal, index);
        completed += 1;
        onItemComplete?.(completed, items.length);
      } catch (error) {
        if (!firstError) {
          firstError = error;
          controller.abort(error);
        }
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

async function addItemsToPlaylist(playlistId, trackUris, onProgress) {
  for (let offset = 0; offset < trackUris.length; offset += PLAYLIST_BATCH_SIZE) {
    const uris = trackUris.slice(offset, offset + PLAYLIST_BATCH_SIZE);
    await spotifyRequest(`/playlists/${encodeURIComponent(playlistId)}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris }),
    });
    onProgress?.({
      stage: "adding",
      completed: Math.min(offset + uris.length, trackUris.length),
      total: trackUris.length,
    });
  }
}

export async function migratePlaylist(transfer, onProgress) {
  onProgress?.({ stage: "youtube", message: "Reading the YouTube playlist…" });
  const videos = await fetchYouTubePlaylistItems(transfer.youtubePlaylist);

  onProgress?.({ stage: "spotify", message: "Checking your Spotify connection…" });
  const profile = await spotifyRequest("/me");

  onProgress?.({ stage: "matching", completed: 0, total: videos.length });
  const trackUris = await mapWithConcurrency(
    videos,
    SEARCH_CONCURRENCY,
    findTrackUri,
    (completed, total) => onProgress?.({ stage: "matching", completed, total }),
  );

  const matchedUris = trackUris.filter(Boolean);
  const unmatchedTitles = videos
    .filter((_, index) => !trackUris[index])
    .map((video) => video?.snippet?.title || "Unavailable video");

  // Delay playlist creation until searches succeed so a transient search failure
  // does not leave an empty duplicate playlist behind.
  onProgress?.({ stage: "creating", message: "Creating your Spotify playlist…" });
  const playlist = await spotifyRequest("/me/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: transfer.spotifyPlaylistName,
      public: false,
      description: "Transferred from YouTube with YouTube2Spotify",
    }),
  });

  if (matchedUris.length) {
    onProgress?.({ stage: "adding", completed: 0, total: matchedUris.length });
    await addItemsToPlaylist(playlist.id, matchedUris, onProgress);
  }

  return {
    profile,
    playlist,
    matchedCount: matchedUris.length,
    totalCount: videos.length,
    unmatchedTitles,
  };
}
