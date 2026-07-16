import test from "node:test";
import assert from "node:assert/strict";

import {
  SongSearch,
  cleanChannelTitle,
  isValidMatch,
  normalize,
  parseSongTitle,
  tokensInOrder,
} from "../src/matcher.js";

const parseCases = [
  ["Chuck Berry - Johnny B. Goode", "Johnny B. Goode", ["Chuck Berry"]],
  ["The Beatles - Let It Be (Remastered 2009)", "Let It Be", ["The Beatles"]],
  ["Queen - Bohemian Rhapsody (Official Video)", "Bohemian Rhapsody", ["Queen"]],
  ["Nirvana - Smells Like Teen Spirit [HD]", "Smells Like Teen Spirit", ["Nirvana"]],
  ["AC/DC - Back In Black", "Back In Black", ["AC/DC"]],
  ["Tupac - California Love ft. Dr. Dre", "California Love", ["Tupac", "Dr. Dre"]],
  ["Eminem ft. Rihanna - Love The Way You Lie", "Love The Way You Lie", ["Eminem", "Rihanna"]],
  ["Kendrick Lamar - HUMBLE. (Music Video)", "HUMBLE.", ["Kendrick Lamar"]],
  ["Armin van Buuren - Blah Blah Blah (Extended Mix)", "Blah Blah Blah", ["Armin van Buuren"]],
  ["Bad Bunny x Jhayco - DÁKITI", "DÁKITI", ["Bad Bunny", "Jhayco"]],
  ["Rosalía - DESPECHÁ", "DESPECHÁ", ["Rosalía"]],
  ["Hip Hop - Dr. Dre - Still D.R.E. ft. Snoop Dogg", "Still D.R.E.", ["Dr. Dre", "Snoop Dogg"]],
  ["Lofi - Jinsang - affection", "affection", ["Jinsang"]],
  ["Lady Gaga & Ariana Grande - Rain On Me", "Rain On Me", ["Lady Gaga", "Ariana Grande"]],
  ["Linkin Park / Jay-Z - Numb / Encore (Live 8 2005)", "Numb / Encore", ["Linkin Park / Jay-Z"]],
  ["Lost [Official Music Video] - Linkin Park", "Linkin Park", ["Lost"]],
  ["David Guetta - Titanium ft. Sia (Official Video)", "Titanium", ["David Guetta", "Sia"]],
  ["Flight Facilities - Crave You (Adventure Club Dubstep Remix) (feat. Giselle)", "Crave You", ["Flight Facilities", "Giselle"]],
  ["Example - Stay Awake (Moam Remix) (Official Audio) | Ministry of Sound", "Stay Awake", ["Example"]],
  ["Linkin Park - Lost In The Echo (Killsonik Remix) [Recharged 2013] [HQ 1080p]", "Lost In The Echo", ["Linkin Park"]],
  ["NERO 'PROMISES' (SKRILLEX AND NERO REMIX)", "PROMISES", ["NERO"]],
  ['Skrillex & Damian "Jr. Gong" Marley - Make It Bun Dem [OFFICIAL VIDEO]', "Make It Bun Dem", ["Skrillex", "Damian Marley"]],
  ["[Hardcore] - Stonebank - Stronger (feat. EMEL) [Monstercat Release]", "Stronger", ["Stonebank", "EMEL"]],
  ["will.i.am - Scream & Shout ft. Britney Spears", "Scream & Shout", ["will.i.am", "Britney Spears"]],
  ["Swedish House Mafia ft. John Martin - Don't You Worry Child (Official Video)", "Don't You Worry Child", ["Swedish House Mafia", "John Martin"]],
  ["Ke$ha - Die Young (Official Video)", "Die Young", ["Ke$ha"]],
  ["The Script - Hall of Fame (Official Video) ft. will.i.am", "Hall of Fame", ["The Script", "will.i.am"]],
  ["Paul Potts First Audition", "Paul Potts First Audition", []],
  ["Nirvana - Girls (Dj Dima House &amp; Samsonoff Remix)", "Girls", ["Nirvana"]],
  ["Private video", null, null],
  ["Deleted video", null, null],
  ["PSY - GANGNAM STYLE(강남스타일) M/V", "GANGNAM STYLE", ["PSY"]],
  ["Mann - Buzzin (Remix) ft. 50 Cent", "Buzzin", ["Mann", "50 Cent"]],
  ["SKRILLEX - Bangarang feat. Sirah [Official Music Video]", "Bangarang", ["SKRILLEX", "Sirah"]],
  ["Loreen - Euphoria (LIVE) | Sweden 🇸🇪 | Grand Final | Winner of Eurovision 2012", "Euphoria", ["Loreen"]],
  ["Flo Rida - Club Can't Handle Me (feat David Guetta) [Official Video]", "Club Can't Handle Me", ["Flo Rida", "David Guetta"]],
  ["Gym Class Heroes: Stereo Hearts ft. Adam Levine [OFFICIAL VIDEO]", "Stereo Hearts", ["Gym Class Heroes", "Adam Levine"]],
  ["Fun.: We Are Young ft. Janelle Monáe [OFFICIAL VIDEO]", "We Are Young", ["Fun.", "Janelle Monáe"]],
  ["Nayer - Suave (Kiss Me) ft. Pitbull, Mohombi", "Suave", ["Nayer", "Pitbull", "Mohombi"]],
  ["will.i.am - T.H.E. (The Hardest Ever) ft. Mick Jagger, Jennifer Lopez", "T.H.E.", ["will.i.am", "Mick Jagger", "Jennifer Lopez"]],
  ["B.o.B - Airplanes (feat. Hayley Williams of Paramore) [Official Video]", "Airplanes", ["B.o.B", "Hayley Williams of Paramore"]],
  ["PLAYMEN &amp; ALEX LEON ft. T-PAIN - Out Of My Head | Official Video Clip", "Out Of My Head", ["PLAYMEN", "ALEX LEON", "T-PAIN"]],
  ["Tacabro - Tacatà - Tacata'", "Tacatà", ["Tacabro"]],
  ["Gotye - Somebody That I Used To Know (feat. Kimbra) [Official Music Video]", "Somebody That I Used To Know", ["Gotye", "Kimbra"]],
  ["Grits - My Life Be Like (Ooh-Aah) with lyrics", "My Life Be Like", ["Grits"]],
  ["Alesso &amp; Calvin Harris feat. Hurts - Under Control (Extended Mix)", "Under Control", ["Alesso", "Calvin Harris", "Hurts"]],
  ["[DnB] - Feint - Snake Eyes (feat. CoMa) [Monstercat Release]", "Snake Eyes", ["Feint", "CoMa"]],
  ["David Guetta &amp; Showtek - Bad ft.Vassy (Lyrics Video)", "Bad", ["David Guetta", "Showtek", "Vassy"]],
  ["New World Sound & Thomas Newson - Flute (Original Mix)", "Flute", ["New World Sound", "Thomas Newson"]],
  ["Showtek ft. We Are Loud & Sonny Wilson - Booyah (Official Music Video)", "Booyah", ["Showtek", "We Are Loud", "Sonny Wilson"]],
  ["Steve Aoki, Chris Lake & Tujamo - Boneless (Official Video)", "Boneless", ["Steve Aoki", "Chris Lake", "Tujamo"]],
  ["ENVY/Nico & Vinz - Am I Wrong (Felix Zaltaio & Lindh Van Berg Remix)", "Am I Wrong", ["ENVY/Nico", "Vinz"]],
  ['Hozier - Too Sweet (Lyrics) "i take my whiskey neat"', "Too Sweet", ["Hozier"]],
];

function simplified(search) {
  return search ? { track: search.track, artists: search.artists } : null;
}

for (const [title, track, artists] of parseCases) {
  test(`parses ${title}`, () => {
    assert.deepEqual(simplified(parseSongTitle(title)), track === null ? null : { track, artists });
  });
}

test("parser handles empty and bracket-only titles", () => {
  assert.equal(parseSongTitle(""), null);
  assert.equal(parseSongTitle("  \r\n  "), null);
  assert.equal(parseSongTitle("[Official Music Video]"), null);
});

test("parser decodes HTML entities", () => {
  assert.deepEqual(
    simplified(parseSongTitle("Adventure Club &amp; Krewella - Rise &amp; Fall")),
    { track: "Rise & Fall", artists: ["Adventure Club", "Krewella"] },
  );
});

test("parser strips genre and label segments", () => {
  assert.deepEqual(simplified(parseSongTitle("Country - Johnny Cash - Ring of Fire")), {
    track: "Ring of Fire",
    artists: ["Johnny Cash"],
  });
  assert.deepEqual(simplified(parseSongTitle("NENA | 99 Luftballons [1983] [Offizielles HD Musikvideo]")), {
    track: "99 Luftballons",
    artists: ["NENA"],
  });
});

test("parser preserves the legacy reversed title behavior", () => {
  assert.deepEqual(simplified(parseSongTitle("Bohemian Rhapsody - Queen - Topic")), {
    track: "Queen",
    artists: ["Bohemian Rhapsody"],
  });
});

test("channel title cleanup supplies useful artists", () => {
  assert.equal(cleanChannelTitle("Rosalía - Topic"), "Rosalía");
  assert.equal(cleanChannelTitle("Queen VEVO"), "Queen");
  assert.equal(cleanChannelTitle(null), "");
});

test("SongSearch emits broad and field-filtered queries", () => {
  assert.deepEqual(new SongSearch("One", ["Metallica"]).queries(), [
    "One Metallica",
    "Metallica One",
    'artist:"Metallica" track:"One"',
  ]);
  assert.deepEqual(new SongSearch("Imagine").queries(), ["Imagine"]);
});

test("normalization handles accents, dotted names, dollar signs, and emoji", () => {
  assert.equal(normalize("Rosalía 🇪🇸"), "rosalia");
  assert.equal(normalize("will.i.am & Ke$ha"), "will i am kesha");
});

test("tokensInOrder filters one-character tokens", () => {
  assert.equal(tokensInOrder(["a"], ["a", "song"]), false);
  assert.equal(tokensInOrder(["a", "song"], ["song"]), true);
  assert.equal(tokensInOrder(["take", "me"], ["take", "on", "me"]), true);
  assert.equal(tokensInOrder(["me", "take"], ["take", "on", "me"]), false);
  assert.equal(tokensInOrder([], ["anything"]), false);
});

const spotifyTrack = (name, ...artists) => ({
  name,
  artists: artists.map((artist) => ({ name: artist })),
});

const positiveMatches = [
  [new SongSearch("Not Afraid", ["Eminem"]), spotifyTrack("Not Afraid", "Eminem")],
  [new SongSearch("Bad Guy", ["Billie Eilish"]), spotifyTrack("bad guy", "Billie Eilish")],
  [new SongSearch("Bohemian Rhapsody", ["Queen"]), spotifyTrack("Bohemian Rhapsody - Remastered 2011", "Queen")],
  [new SongSearch("Hotel California", ["Eagles"]), spotifyTrack("Hotel California - Remastered", "Eagles")],
  [new SongSearch("One More Time", ["Daft Punk"]), spotifyTrack("One More Time - Radio Edit", "Daft Punk")],
  [new SongSearch("Heroes", ["David Bowie"]), spotifyTrack("Heroes - Single Version", "David Bowie")],
  [new SongSearch("One More Time"), spotifyTrack("One More Time (Radio Edit)", "Daft Punk")],
  [new SongSearch("DESPECHÁ", ["Rosalía"]), spotifyTrack("DESPECHÁ", "Rosalia")],
  [new SongSearch("Wake Me Up", ["Avicii", "Aloe Blacc"]), spotifyTrack("Wake Me Up", "Avicii", "Aloe Blacc")],
  [new SongSearch("Wake Me Up", ["Avicii", "Aloe Blacc"]), spotifyTrack("Wake Me Up (feat. Aloe Blacc)", "Avicii")],
  [new SongSearch("Airplanes", ["B.o.B", "Hayley Williams of Paramore"]), spotifyTrack("Airplanes", "B.o.B", "Hayley Williams")],
  [new SongSearch("Somebody That I Used To Know", ["Gotye"]), spotifyTrack("Somebody That I Used To Know (feat. Kimbra)", "Gotye")],
  [new SongSearch("Let It Be", ["The Beatles"]), spotifyTrack("Let It Be Me", "The Beatles")],
  [new SongSearch("T.H.E.", ["will.i.am", "Mick Jagger", "Jennifer Lopez"]), spotifyTrack("T.H.E. (The Hardest Ever)", "will.i.am", "Mick Jagger", "Jennifer Lopez")],
];

for (const [search, track] of positiveMatches) {
  test(`accepts ${search.track} by ${search.artists.join(", ") || "unknown artist"}`, () => {
    assert.equal(isValidMatch(search, track), true);
  });
}

const negativeMatches = [
  [new SongSearch("Numb", ["Linkin Park"]), spotifyTrack("Numb", "Jay-Z")],
  [new SongSearch("One More Time"), spotifyTrack("Harder Better Faster Stronger", "Daft Punk")],
  [new SongSearch("Take On Me", ["a-ha"]), spotifyTrack("Take", "a-ha")],
  [new SongSearch("Take On Me", ["a-ha"]), spotifyTrack("On Me", "a-ha")],
  [new SongSearch("One", ["Metallica"]), spotifyTrack("One More Time", "Daft Punk")],
  [new SongSearch("Go", ["Common"]), spotifyTrack("Go", "Grimes")],
  [new SongSearch("In The End", ["Linkin Park"]), spotifyTrack("In The End", "Dark")],
  [new SongSearch("Hello", ["Adele"]), spotifyTrack("Hello", "Lionel Richie")],
  [new SongSearch("Me Take On", ["a-ha"]), spotifyTrack("Take On Me", "a-ha")],
  [new SongSearch("Lose Yourself", ["Eminem"]), spotifyTrack("Rap God - Remastered", "Eminem")],
  [new SongSearch("Sandstorm"), spotifyTrack("Blue (Da Ba Dee)", "Eiffel 65")],
  [new SongSearch("More", ["Usher"]), spotifyTrack("Want Some More", "Usher")],
];

for (const [search, track] of negativeMatches) {
  test(`rejects ${track.name} as ${search.track}`, () => {
    assert.equal(isValidMatch(search, track), false);
  });
}
