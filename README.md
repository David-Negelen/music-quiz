# Musik Quiz

A browser-based music learning app. Listen to 30-second iTunes previews and type the title, artist, and release year from memory. A spaced repetition algorithm schedules when each song comes back so you study what you need most.

## Running

```sh
npm start
```

Opens at [http://localhost:3000](http://localhost:3000). The server handles both the API and static file serving — no separate build step or dev server needed.

## Tabs

**Library** — search for songs via the iTunes Search API and add them. Import a whole playlist at once by pasting `Artist - Title` lines or uploading an Apple Music `.txt` export (Music.app → File → Export Playlist… → save as `.txt`). Each song shows three coloured dots for Title / Artist / Year knowledge.

**Stats** — an overview of your library and study history: knowledge bars per field, hardest songs by accuracy, best consecutive-day streak, a bar chart of recent sessions, and a scrollable session history you can expand song-by-song.

**Quiz** — start a study session. Songs are served in spaced repetition order: overdue first, then new, then not yet due. Uncheck "All songs" to cap the batch size.

## Answering

A 30-second preview plays automatically. Type in all three fields and click Check (or press Enter). Year answers must be exact; title and artist answers are case-insensitive, ignore punctuation, and treat a leading "The" as optional. After checking, the correct answers appear inline and the Next button advances to the next song.

After the last song a **Review** screen shows per-field totals, a grouped list of everything you played, and the Back to Quiz button.

## Spaced repetition (SM-2)

After each song the app computes a quality score based on how many fields you got right, then applies the SM-2 algorithm:

| Correct fields | Quality |
|---|---|
| 3 / 3 | 5 |
| 2 / 3 | 3 |
| 1 / 3 | 2 |
| 0 / 3 | 1 |

- Quality ≥ 3: interval grows (1 day → 6 days → interval × ease factor), ease factor adjusts upward.
- Quality < 3: interval resets to 1 day, review count resets to 0.

The due date is stored per song and survives restarts. The Quiz Setup screen shows how many songs are due today, how many are new (never reviewed), and how many aren't due yet.

## Data

All data is stored in `db.sqlite` in the project root (gitignored). Nothing is sent to any server except iTunes search queries.
