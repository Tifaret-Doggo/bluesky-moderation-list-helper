# Bluesky Modlist Local Tool

## Run

1. Install Node.js LTS (Node 20+ recommended).
2. In this folder, run `serve.cmd`.
3. On first run, dependencies install automatically.
4. Browser opens to `http://127.0.0.1:8787`.

## What v1 does

- Localhost-only Node web app
- OAuth sign-in flow via Bluesky
- Optionally gathers direct replies and quote posts from a Bluesky post URL
- Uses the signed-in Bluesky account's visibility for gathering, with public visibility when signed out
- Shows supported post media and lets the source-post author or likers be added to the batch
- Adds a reviewed post's author or all of its likers to the existing batch input
- Accepts list URI + one profile URL/handle/DID per line
- Normalizes/validates input
- Resolves handles to DIDs
- Fetches current list membership with pagination
- Holds followed accounts, followers, and mutual follows for explicit review before adding
- Skips existing members (default on)
- Creates missing `app.bsky.graph.listitem` records
- Returns per-line status and summary

## Data files

- `data/session.json` (OAuth session store)
- `data/state.json` (OAuth state store)
- `data/config.json` (last list URI)

These files are ignored by git in `.gitignore`.

## UI assets

- Background image: `assets/background.png`
- Favicon: `assets/favicon.png`

Replace those files with your own artwork using the same filenames to update the UI without code changes.

## Notes

- Tool is single-user and intended for personal local workflow only.
- If OAuth helper API changes in a future package version, pinning to the versions in `package.json` is recommended.

## Credits

Originally designed by [@tifaret.bsky.social](https://bsky.app/profile/tifaret.bsky.social), with development assistance from OpenAI Codex.

## License

Licensed under the [0BSD License](LICENSE).
