import "./styles.css";
import { migratePlaylist, parsePlaylistId } from "./api.js";
import {
  AuthenticationError,
  clearPendingTransfer,
  getConfigurationIssues,
  getPendingTransfer,
  handleSpotifyCallback,
  hasSpotifyCallback,
  hasSpotifySession,
  logout,
  removeCallbackParameters,
  savePendingTransfer,
  startSpotifyAuthorization,
} from "./auth.js";

const elements = {
  views: [...document.querySelectorAll(".view")],
  homeView: document.querySelector("#home-view"),
  processingView: document.querySelector("#processing-view"),
  errorView: document.querySelector("#error-view"),
  doneView: document.querySelector("#done-view"),
  form: document.querySelector("#transfer-form"),
  youtubePlaylist: document.querySelector("#youtube-playlist"),
  youtubePlaylistError: document.querySelector("#youtube-playlist-error"),
  spotifyPlaylistName: document.querySelector("#spotify-playlist-name"),
  spotifyPlaylistNameError: document.querySelector("#spotify-playlist-name-error"),
  submitButton: document.querySelector("#submit-button"),
  homeError: document.querySelector("#home-error"),
  progressMessage: document.querySelector("#progress-message"),
  migrationProgress: document.querySelector("#migration-progress"),
  indeterminateLoader: document.querySelector("#indeterminate-loader"),
  errorMessage: document.querySelector("#error-message"),
  errorHomeButton: document.querySelector("#error-home-button"),
  profileImageContainer: document.querySelector("#profile-image-container"),
  doneHeading: document.querySelector("#done-heading"),
  matchSummary: document.querySelector("#match-summary"),
  unmatchedDetails: document.querySelector("#unmatched-details"),
  unmatchedSummary: document.querySelector("#unmatched-summary"),
  unmatchedList: document.querySelector("#unmatched-list"),
  playlistLink: document.querySelector("#playlist-link"),
  anotherTransferButton: document.querySelector("#another-transfer-button"),
  logoutButton: document.querySelector("#logout-button"),
};

let migrationRunning = false;

function showView(view, focusHeading = true) {
  for (const candidate of elements.views) candidate.hidden = candidate !== view;
  if (focusHeading) view.querySelector("[data-view-heading]")?.focus();
}

function showHome(message = "", focusHeading = true) {
  const configurationIssues = getConfigurationIssues();
  const setupMessage = configurationIssues.length
    ? `Site setup is incomplete: ${configurationIssues.join(" ")}`
    : "";
  elements.homeError.textContent = message || setupMessage;
  elements.homeError.hidden = !(message || setupMessage);
  elements.submitButton.disabled = false;
  showView(elements.homeView, focusHeading);
  document.title = "YouTube2Spotify";
}

function setFieldError(input, messageElement, message) {
  input.classList.toggle("is-invalid", Boolean(message));
  input.setAttribute("aria-invalid", message ? "true" : "false");
  messageElement.textContent = message;
  messageElement.hidden = !message;
}

function readAndValidateTransfer() {
  const youtubePlaylist = elements.youtubePlaylist.value.trim();
  const spotifyPlaylistName = elements.spotifyPlaylistName.value.trim();
  let youtubeError = "";
  let spotifyError = "";

  if (!youtubePlaylist) {
    youtubeError = "YouTube playlist URL or ID is required.";
  } else {
    try {
      parsePlaylistId(youtubePlaylist);
    } catch (error) {
      youtubeError = error.message;
    }
  }

  if (!spotifyPlaylistName) {
    spotifyError = "Spotify playlist name is required.";
  } else if (spotifyPlaylistName.length > 100) {
    spotifyError = "Spotify playlist name must be 100 characters or fewer.";
  }

  setFieldError(elements.youtubePlaylist, elements.youtubePlaylistError, youtubeError);
  setFieldError(elements.spotifyPlaylistName, elements.spotifyPlaylistNameError, spotifyError);
  if (youtubeError) elements.youtubePlaylist.focus();
  else if (spotifyError) elements.spotifyPlaylistName.focus();
  return youtubeError || spotifyError ? null : { youtubePlaylist, spotifyPlaylistName };
}

function showProcessing(message = "Preparing your transfer…") {
  elements.progressMessage.textContent = message;
  elements.migrationProgress.hidden = true;
  elements.indeterminateLoader.hidden = false;
  showView(elements.processingView);
  document.title = "working… — YouTube2Spotify";
}

function updateProgress(progress) {
  const messages = {
    youtube: progress.message || "Reading the YouTube playlist…",
    spotify: progress.message || "Connecting to Spotify…",
    matching: `Matching songs with Spotify… ${progress.completed} of ${progress.total}`,
    creating: progress.message || "Creating your Spotify playlist…",
    adding: `Adding songs to your playlist… ${progress.completed} of ${progress.total}`,
  };
  elements.progressMessage.textContent = messages[progress.stage] || progress.message || "Working…";

  const determinate = Number.isFinite(progress.total) && progress.total > 0;
  elements.migrationProgress.hidden = !determinate;
  elements.indeterminateLoader.hidden = determinate;
  if (determinate) {
    elements.migrationProgress.max = progress.total;
    elements.migrationProgress.value = progress.completed;
  }
}

window.addEventListener("spotify-rate-limited", (event) => {
  if (elements.processingView.hidden) return;
  const seconds = Math.max(1, Math.ceil(event.detail.delayMilliseconds / 1000));
  elements.progressMessage.textContent = `Spotify asked us to slow down. Resuming in about ${seconds} seconds…`;
});

function trustedHttpsUrl(value, allowedHosts = null) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (allowedHosts && !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function renderProfile(profile) {
  const displayName = profile.display_name || "there";
  const profileUrl = trustedHttpsUrl(profile.external_urls?.spotify, ["spotify.com"]);
  elements.doneHeading.replaceChildren(document.createTextNode("hey "));
  const nameElement = profileUrl ? document.createElement("a") : document.createElement("span");
  nameElement.textContent = displayName;
  if (profileUrl) {
    nameElement.href = profileUrl;
    nameElement.target = "_blank";
    nameElement.rel = "noopener noreferrer";
  }
  elements.doneHeading.append(nameElement, document.createTextNode(", your playlist is ready."));

  elements.profileImageContainer.className = "";
  elements.profileImageContainer.replaceChildren();
  const imageUrl = trustedHttpsUrl(profile.images?.[0]?.url);
  if (imageUrl) {
    const image = document.createElement("img");
    image.className = "avatar";
    image.src = imageUrl;
    image.alt = `${displayName}'s Spotify profile`;
    elements.profileImageContainer.append(image);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "avatar-fallback";
    fallback.setAttribute("aria-hidden", "true");
    fallback.textContent = "?";
    elements.profileImageContainer.append(fallback);
  }
}

function renderDone(result) {
  renderProfile(result.profile);
  elements.matchSummary.textContent = `${result.matchedCount} of ${result.totalCount} songs matched.`;

  elements.unmatchedList.replaceChildren();
  elements.unmatchedDetails.hidden = result.unmatchedTitles.length === 0;
  if (result.unmatchedTitles.length) {
    elements.unmatchedSummary.textContent = `show unmatched songs (${result.unmatchedTitles.length})`;
    for (const title of result.unmatchedTitles) {
      const item = document.createElement("li");
      item.textContent = title;
      elements.unmatchedList.append(item);
    }
  }

  const playlistUrl = trustedHttpsUrl(result.playlist.external_urls?.spotify, ["spotify.com"]);
  if (playlistUrl) {
    elements.playlistLink.href = playlistUrl;
    elements.playlistLink.textContent = playlistUrl;
    elements.playlistLink.hidden = false;
  } else {
    elements.playlistLink.removeAttribute("href");
    elements.playlistLink.textContent = "Playlist created, but Spotify did not return a link.";
  }

  clearPendingTransfer();
  showView(elements.doneView);
  document.title = "done — YouTube2Spotify";
}

function renderError(error) {
  const fallback = "An unexpected error occurred during the transfer.";
  elements.errorMessage.textContent = error instanceof Error && error.message ? error.message : fallback;
  elements.submitButton.disabled = false;
  showView(elements.errorView);
  document.title = "error — YouTube2Spotify";
}

async function runMigration(transfer) {
  if (migrationRunning) return;
  migrationRunning = true;
  showProcessing();
  try {
    renderDone(await migratePlaylist(transfer, updateProgress));
  } catch (error) {
    renderError(error);
  } finally {
    migrationRunning = false;
  }
}

async function beginTransfer(transfer) {
  const configurationIssues = getConfigurationIssues();
  if (configurationIssues.length) {
    showHome(`Site setup is incomplete: ${configurationIssues.join(" ")}`);
    return;
  }

  savePendingTransfer(transfer);
  if (hasSpotifySession()) {
    await runMigration(transfer);
  } else {
    elements.submitButton.disabled = true;
    try {
      await startSpotifyAuthorization(transfer);
    } catch (error) {
      elements.submitButton.disabled = false;
      showHome(error.message);
    }
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (elements.submitButton.disabled) return;
  const transfer = readAndValidateTransfer();
  if (transfer) await beginTransfer(transfer);
});

elements.youtubePlaylist.addEventListener("input", () => {
  setFieldError(elements.youtubePlaylist, elements.youtubePlaylistError, "");
});

elements.spotifyPlaylistName.addEventListener("input", () => {
  setFieldError(elements.spotifyPlaylistName, elements.spotifyPlaylistNameError, "");
});

elements.errorHomeButton.addEventListener("click", () => {
  if (hasSpotifyCallback()) removeCallbackParameters();
  const pending = getPendingTransfer();
  if (pending) {
    elements.youtubePlaylist.value = pending.youtubePlaylist;
    elements.spotifyPlaylistName.value = pending.spotifyPlaylistName;
  }
  showHome();
});

elements.anotherTransferButton.addEventListener("click", () => {
  clearPendingTransfer();
  elements.form.reset();
  showHome();
  elements.youtubePlaylist.focus();
});

elements.logoutButton.addEventListener("click", () => {
  logout();
  elements.form.reset();
  showHome("Spotify was disconnected from this browser tab.");
});

async function initialize() {
  const pending = getPendingTransfer();
  if (pending) {
    elements.youtubePlaylist.value = pending.youtubePlaylist;
    elements.spotifyPlaylistName.value = pending.spotifyPlaylistName;
  }

  if (!hasSpotifyCallback()) {
    showHome("", false);
    return;
  }

  showProcessing("Finishing Spotify login…");
  try {
    await handleSpotifyCallback();
    removeCallbackParameters();
    const transfer = getPendingTransfer();
    if (!transfer) {
      throw new AuthenticationError("Playlist details were lost during login. Please enter them again.");
    }
    await runMigration(transfer);
  } catch (error) {
    renderError(error);
  }
}

initialize();
