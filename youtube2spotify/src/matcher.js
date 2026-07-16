const BRACKETS = /\[[^\]]*\]/g;
const FEATURE_PAREN = /\(([^)]*(?:ft\.?|feat\.?|featuring|cover|by)[^)]*)\)/gi;
const OTHER_PAREN = /\([^)]*\)/g;
const SEGMENT_SPLIT = /\s+[-–—−]+\s*|\s*[-–—−]+\s+|\s*\|\s*|\s*[•·]\s*/;
const ARTIST_SPLIT = /\s*(?:&|\+|,)\s*|\s+x\s+|\s+vs\.?\s+/i;
const FEAT_SPLIT = /\s*\bfeaturing\b\s*|\s*\bfeat\.?\s*|\s*\bft\.?\s*|\s*\bcover(?:ed)?(?:\s+by)?\b\s*|\s*\bprod\.?\s*|\s*\bprod(?:duced)?\s+by\b\s*|\s*\bw\/\s*/i;
const TRAILING_NOISE = new RegExp(
  String.raw`(?:\s+(?:official|music\s+video|video|audio|lyrics?|with\s+lyrics|visualizer|teaser|trailer|preview|hd|hq|4k|1080p?|mv|m\/?v|full|extended|mix|remix|edit|vip|bootleg|remaster(?:ed)?|cover|topic|explicit|clean|eurovision(?:\s+song\s+contest)?|world\s+cup(?:\s+song)?|live|performance|karaoke|\d{4}|kpop|demon\s+hunters|lyric\s+video|sped\s+up))+\s*$`,
  "i",
);
const DOTS = /\b(?:[a-z]\.)+[a-z]\b/g;
const EMOJIS = /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]+/gu;
const SPOTIFY_TRACK_NOISE = /\s*[-–(]\s*(?:\d{4}\s*(?:remaster(?:ed)?|version|mix|edit|release)|remaster(?:ed)?(?:\s+\d{4})?|radio\s+edit|single\s+version|album\s+version|original\s+(?:mix|version)|deluxe(?:\s+edition)?|explicit|clean)\s*\)?\s*$/i;
const INSTRUMENT_COVER = /\s+(?:piano|guitar|acoustic\s+guitar|violin|cello|flute|sax(?:ophone)?|trumpet|drums?|bass|organ|keyboard|synth(?:esizer)?|harmonica|ukulele|banjo|mandolin|harp)\s+cover\s*$/i;

const GENRES = new Set([
  "house", "deep house", "tech house", "electro house", "progressive house",
  "future house", "bass house", "dubstep", "drumstep", "electronic", "edm", "trap",
  "trance", "techno", "dnb", "drum and bass", "drum & bass", "ambient",
  "pop", "rock", "hip hop", "hip-hop", "rap", "metal", "jazz", "classical",
  "folk", "country", "r&b", "rnb", "soul", "indie", "lofi", "lo-fi",
  "phonk", "garage", "synthwave", "vaporwave", "hardstyle", "psytrance",
]);

const QUOTE_PAIRS = new Map([
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
]);

const HTML_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
]);

function decodeHtmlEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (entity, code) => {
    const normalized = code.toLowerCase();
    if (normalized.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    }
    if (normalized.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    }
    return HTML_ENTITIES.get(normalized) ?? entity;
  });
}

function cleanSegment(value) {
  let segment = value.trim();
  const closingQuote = QUOTE_PAIRS.get(segment[0]);
  if (segment.length >= 2 && closingQuote && segment.at(-1) === closingQuote) {
    segment = segment.slice(1, -1);
  }

  return segment
    .replace(/["“][^"”]*["”]|[‘][^’]*[’]/g, " ")
    .replace(INSTRUMENT_COVER, "")
    .replace(TRAILING_NOISE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanChannelTitle(channelTitle) {
  if (!channelTitle) return "";
  return decodeHtmlEntities(channelTitle)
    .replace(/\s+-\s+topic$/i, "")
    .replace(/\s+(?:official|music|channel|records|vevo)$/i, "")
    .trim();
}

function extractArtists(segment) {
  const artists = [];
  for (const part of segment.split(FEAT_SPLIT)) {
    for (let name of part.split(ARTIST_SPLIT)) {
      name = name.trim();
      const words = name.split(/\s+/);
      if (words.length > 1 && GENRES.has(words.at(-1).toLowerCase())) {
        name = words.slice(0, -1).join(" ");
      }
      if (name) artists.push(name);
    }
  }
  return artists;
}

function parseTrackSegment(segment) {
  const parts = segment.split(FEAT_SPLIT, 2);
  return {
    track: parts[0].trim(),
    featured: parts.length > 1 && parts[1].trim() ? extractArtists(parts[1]) : [],
  };
}

function stripBracketsAndParens(value) {
  return value
    .replace(BRACKETS, " ")
    .replace(FEATURE_PAREN, (_, contents) => ` ${contents} `)
    .replace(OTHER_PAREN, " ");
}

/** A parsed track title and the possible credited artists. */
export class SongSearch {
  constructor(track, artists = []) {
    this.track = track;
    this.artists = artists;
  }

  queries() {
    if (!this.artists.length) return [this.track];
    return [
      `${this.track} ${this.artists.join(" ")}`,
      `${this.artists[0]} ${this.track}`,
      `artist:"${this.artists[0]}" track:"${this.track}"`,
    ];
  }
}

export function parseSongTitle(title) {
  if (!title || ["private video", "deleted video"].includes(title.trim().toLowerCase())) {
    return null;
  }

  const cleaned = stripBracketsAndParens(decodeHtmlEntities(title));
  const segments = cleaned
    .split(SEGMENT_SPLIT)
    .map(cleanSegment)
    .filter((segment) => segment && segment.length <= 100);

  while (segments.length && GENRES.has(segments[0].toLowerCase())) {
    segments.shift();
  }
  if (!segments.length) return null;

  let artistSegment;
  let trackSegment;
  if (segments.length === 1) {
    let match = segments[0].match(/^(.*?)\s+(['"].*)$/);
    if (match) {
      [, artistSegment, trackSegment] = match;
    } else {
      match = segments[0].match(/^(.*?)\s*(?::|~|\/\/|,)\s*(.*)$/);
      if (match) {
        [, artistSegment, trackSegment] = match;
      } else {
        match = segments[0].match(/^(.*)\s+by\s+(.*)$/i);
        if (match) {
          trackSegment = match[1];
          artistSegment = match[2];
        } else {
          const { track, featured } = parseTrackSegment(segments[0]);
          return new SongSearch(track, featured);
        }
      }
    }
    artistSegment = cleanSegment(artistSegment);
    trackSegment = cleanSegment(trackSegment);
  } else {
    [artistSegment, trackSegment] = segments;
  }

  const artists = extractArtists(artistSegment);
  const { track, featured } = parseTrackSegment(trackSegment);
  artists.push(...featured);
  return new SongSearch(track, artists);
}

export function normalize(value) {
  return value
    .replace(EMOJIS, " ")
    .toLowerCase()
    .replaceAll("$", "s")
    .replace(/[´`’‘]/g, "'")
    .replace(DOTS, (match) => match.replaceAll(".", ""))
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .replace(/[^\p{Letter}\p{Number}_\s']/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stripSpotifyNoise(name) {
  return name.replace(SPOTIFY_TRACK_NOISE, "").trim();
}

export function tokensInOrder(needles, haystack) {
  const meaningful = needles.filter((needle) => needle.length >= 2);
  if (!meaningful.length) return false;
  let index = 0;
  for (const token of haystack) {
    if (index < meaningful.length && token === meaningful[index]) index += 1;
  }
  return index === meaningful.length;
}

// RapidFuzz's ratio is a normalized Indel similarity, equivalent to an LCS ratio.
function ratio(left, right) {
  if (!left.length && !right.length) return 100;
  const previous = new Uint16Array(right.length + 1);
  const current = new Uint16Array(right.length + 1);
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = left[row - 1] === right[column - 1]
        ? previous[column - 1] + 1
        : Math.max(previous[column], current[column - 1]);
    }
    previous.set(current);
    current.fill(0);
  }
  return (200 * previous[right.length]) / (left.length + right.length);
}

function tokenSortRatio(left, right) {
  const sortTokens = (value) => value.split(/\s+/).filter(Boolean).sort().join(" ");
  return ratio(sortTokens(left), sortTokens(right));
}

function trackMatches(expected, spotifyName) {
  const parts = expected.split(/\s+x\s+|\s+vs\.?\s+|\s*\/\s*/i);
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    const expectedNormalized = normalize(part);
    const actualNormalized = normalize(spotifyName);
    if (expectedNormalized === actualNormalized) return true;

    const expectedStripped = normalize(stripSpotifyNoise(part));
    const actualStripped = normalize(stripSpotifyNoise(spotifyName));
    if (expectedStripped && expectedStripped === actualStripped) return true;

    const expectedTokens = expectedNormalized.split(" ");
    const actualTokens = actualNormalized.split(" ");
    if (!expectedTokens.length) continue;
    if (expectedTokens.length > 1 && tokensInOrder(expectedTokens, actualTokens)) return true;
    if (expectedTokens.length === 1) {
      const [token] = expectedTokens;
      if (actualTokens[0] === token && actualTokens.includes(token)) return true;
    }
    if (expectedStripped.length > 4 && ratio(expectedStripped, actualStripped) > 80) return true;
  }
  return false;
}

function artistMatches(expected, spotifyArtists) {
  const expectedNormalized = normalize(expected);
  const expectedTokens = expectedNormalized.split(" ");
  for (const name of spotifyArtists) {
    const normalized = normalize(name);
    if (normalized === expectedNormalized) return true;

    const spotifyTokens = normalized.split(" ");
    if (expectedTokens.length > 1 && tokensInOrder(expectedTokens, spotifyTokens)) return true;
    if (spotifyTokens.length > 1 && tokensInOrder(spotifyTokens, expectedTokens)) return true;
    if (tokenSortRatio(expectedNormalized, normalized) > 80) return true;
  }
  return false;
}

function artistsMatch(expected, spotifyArtists) {
  if (expected.some((artist) => artistMatches(artist, spotifyArtists))) return true;
  const expectedCombined = expected.map(normalize).join(" ");
  const spotifyCombined = spotifyArtists.map(normalize).join(" ");
  return tokenSortRatio(expectedCombined, spotifyCombined) > 75;
}

export function isValidMatch(search, spotifyTrack) {
  const spotifyName = spotifyTrack.name;
  const spotifyArtists = spotifyTrack.artists.map((artist) => artist.name);

  if (trackMatches(search.track, spotifyName)) {
    if (search.artists.length && !artistsMatch(search.artists, spotifyArtists)) return false;
    return true;
  }

  if (search.artists.length) {
    for (const candidateTrack of search.artists) {
      if (trackMatches(candidateTrack, spotifyName)) {
        const otherArtists = [
          search.track,
          ...search.artists.filter((artist) => artist !== candidateTrack),
        ];
        if (artistsMatch(otherArtists, spotifyArtists)) return true;
      }
    }
  }

  return false;
}
