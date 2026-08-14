# Audio Viewer

A fast, mobile-first, **single-file** audio player. Drag & drop an `.mp3`,
`.wav`, `.flac`, `.m4a`, `.ogg`, or `.opus` and play it right in your browser —
with **ID3 tags, cover art, and a waveform**. It's a **viewer** — no accounts,
no uploads. Everything runs locally in your browser.

🔗 **Live:** <https://audio-viewer.us/>

![Single file](https://img.shields.io/badge/build-single%20HTML%20file-success) ![No build step](https://img.shields.io/badge/build%20step-none-success) ![License](https://img.shields.io/badge/license-MIT-blue)

> Part of the **[File Viewer](https://file-viewer.us/) family** — Audio, HTML,
> Markdown, ePUB, PDF, Data, DOCX, Sheets, EML, PPTX, Log, Cert, PUB, Image,
> and Video each have their own dedicated viewer. Use the **☰ menu** in the
> header to jump between them.

## Features

- 🎵 **Native playback** — the file mounts on an `<audio controls>` element via
  an object URL; the browser streams it straight from disk (no copy in JS).
- 🏷️ **ID3v2 tags (v2.3 + v2.4)** — a hand-rolled, dependency-free reader shows
  **title, artist, album, year, and embedded cover art** from the tag at the
  head of the file. No tag? The file name steps in.
- 🌊 **Waveform** — peaks are decoded with the Web Audio API and drawn to a
  canvas above the controls; **click the waveform to seek**. (Skipped silently
  for files over ~50 MB or when the browser can't decode the codec.)
- 📇 **Details line** — duration, format, and file size at a glance; the Copy
  button puts the track details on your clipboard.
- 🚦 **Honest failures** — `.wma`/`.mid`/`.midi` have no in-browser decoder, so
  they get a conversion notice instead of a broken player; a codec your browser
  build can't decode gets a clear hint card, never a silent failure.
- 🧭 **Wrong file? Right viewer.** Drop a PDF, image, or spreadsheet and the
  family router offers to open its sibling viewer and hands the file across
  in-browser (`postMessage` — it never touches the network).
- ☰ **Family menu** · 🫥 **auto-hiding header** · 🎨 **pick any background color**.
- 🪶 **One file, no build, no dependencies** — works offline, even from `file://`.
- 📊 **Privacy-friendly analytics** — self-hosted, cookieless
  [Plausible](https://plausible.io/); your audio never leaves your device.

## Supported file types

`.mp3` `.wav` `.flac` `.m4a` `.aac` `.ogg` `.oga` `.opus` `.weba` `.mka` `.aif` `.aiff`

Exactly which of these play depends on the codecs in your browser build —
MP3/WAV/FLAC/OGG are near-universal; the viewer says so honestly when a decoder
is missing rather than failing silently.

`.wma`, `.mid`, and `.midi` are accepted **with a notice**: browsers ship no
WMA decoder and no MIDI synthesizer, so the viewer explains how to convert
instead of pretending to play.

## Quick start

**Just open it.** Download [`index.html`](index.html), double-click it — no
server, no build, no internet needed.

```sh
python3 -m http.server 8080   # then open http://localhost:8080
```

## Deploy to Cloudflare Pages

Deploys ride the [`deploy.yml`](.github/workflows/deploy.yml) workflow
(direct-upload via wrangler, project `audio-viewer-us`); pushes to `main` go to
production, PRs get preview deployments. The [`_headers`](_headers) file
applies a strict CSP automatically. Add the custom domain **audio-viewer.us**
under the project's Custom domains tab.

## How it works

Everything is in [`index.html`](index.html) — **no third-party libraries.**
Playback is the browser's own `<audio>` element pointed at an object URL for
the dropped `File` (revoked on replace and on Clear). A compact **ID3v2
reader** (written for this project) parses the tag bytes at the head of the
file — syncsafe sizes, text frames (TIT2/TPE1/TALB/TYER/TDRC in ISO-8859-1,
UTF-8, or UTF-16), and APIC cover art rendered as a `data:` URI. The waveform
decodes a copy of the bytes with `decodeAudioData` and draws min/max peaks to a
canvas. The viewer's CSP stays strict (`default-src 'none'`; `media-src 'self'
blob:` for the object URL, `img-src 'self' data:` for cover art).

**Note:** this is a player, **not an editor** — it reads what's in the file and
never modifies or uploads it.

## Privacy

Your files stay on your device. There is no upload endpoint — the page can't
send your audio anywhere (the CSP's `connect-src` allows only the analytics
beacon). Analytics are cookieless, self-hosted Plausible page counts.

## Credits

No bundled libraries — the ID3v2 reader and waveform renderer are original to
this project; playback and decoding use the browser's built-in `<audio>` and
Web Audio APIs. The audio-file icon is
[`file_type_audio.svg`](https://github.com/vscode-icons/vscode-icons) from
vscode-icons (MIT). Headings use the
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) typeface
(SIL OFL-1.1). Analytics by [Plausible](https://plausible.io/).

## License

[MIT](LICENSE) © 2026 Michal Ferber, aka **TechGuyWithABeard**.
