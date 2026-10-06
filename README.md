# CaptionFlow 1.2

CaptionFlow is a Manifest V3 Chrome extension that:

- runs automatically on every page so it can place a button directly in a video's own player controls (YouTube's control bar and Crunchyroll's player bar specifically);
- shows a CaptionFlow icon inside the video player's control bar (next to the settings gear on YouTube; beside the player controls on Crunchyroll);
- opens an in-page **sidebar** (not a blocking overlay) when that button is clicked — this is CaptionFlow's main page, for picking a caption track or loading a local subtitle file;
- shows a separate **in-video toolbar** at the bottom of the player for quick subtitle appearance controls (visibility, font size, sync offset, position, style preset, background, colour) — this toolbar opens only when the player button is clicked, and closes when the sidebar is closed;
- discovers YouTube manual and auto-generated caption tracks;
- discovers Crunchyroll subtitle tracks (every language the player offers, served as ASS) via the vilos player configuration inside the player iframe;
- displays a selected track, or extracts it as an SRT/VTT file (Crunchyroll ASS converts on extract);
- loads local `.srt`, `.vtt`, `.ass`, and `.ssa` subtitle files on any HTML5 video.

Site-specific notes for Crunchyroll: the player lives in an iframe on `static.crunchyroll.com`, so CaptionFlow's overlay, toolbar, sidebar, and player button all mount inside that frame; `crunchyroll-main.js` is the page-world bridge that reads the player's subtitle list.

## Install

1. Extract this folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the `captionflow-extension` folder.
6. Open (or hard-refresh) a page with a video. A CaptionFlow icon appears in the video player's own controls — click it to open the sidebar. Clicking the toolbar icon in Chrome's toolbar does the same thing.

## Notes

- CaptionFlow's content script runs on every page automatically (it needs to, to place a button inside each page's video player), but it only acts once you open the sidebar.
- YouTube changes internal player APIs occasionally. CaptionFlow uses several discovery paths and keeps all YouTube-specific logic isolated in `youtube-main.js`.
- Local files are processed inside the browser and are not uploaded.
- Protected browser pages such as `chrome://` pages cannot be scripted by extensions.

## Run tests

```bash
node tests/subtitles.test.js
```

