# Musik Quiz

A browser-based music learning app. Listen to 30-second previews from iTunes and type the title, artist, and release year. Your performance is tracked per song so the weakest ones always come up first.

## Running

No build step needed. Serve the folder over HTTP — the Web Audio API and iTunes search both require `http://`, not `file://`.

**With auto-reload on file save (recommended for development):**
```sh
npm run dev
```
Opens http://localhost:8080 and reloads automatically whenever you save a file.

**Plain Python server (no auto-reload):**
```sh
python3 -m http.server 8080
```
Then open [http://localhost:8080](http://localhost:8080).

## How it works

1. **Library tab** — search for songs via the iTunes Search API and add them. Import a whole playlist at once via paste or an Apple Music `.txt` export (File → Export Playlist… → save as `.txt`).

2. **Quiz tab** — start a study session. By default it goes through *all* songs, weakest first. Uncheck "All songs" to limit the batch size.

3. **Answering** — a 30-second preview plays automatically. Type your answer and press Enter or click Check. Year answers must be exact; title/artist answers are case-insensitive and ignore punctuation and a leading "The".

## Mastery levels

Each song is rated based on your correct/attempt ratio across all three question types:

| Dot | Level    | Condition                       |
|-----|----------|---------------------------------|
| ○   | New      | Never attempted                 |
| ◔   | Learning | < 55% correct                   |
| ◑   | Familiar | 55 – 84% correct                |
| ✓   | Mastered | ≥ 85% correct with ≥ 4 attempts |

Mastery dots are visible in the Library. The study session always surfaces New and Learning songs before Familiar and Mastered ones.

## Data

Everything (library and stats) is stored in `localStorage` — nothing is sent anywhere except the iTunes search queries.
