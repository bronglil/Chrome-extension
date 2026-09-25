# ffmpeg.wasm (vendored)

- `@ffmpeg/ffmpeg` 0.12.15 — UMD (`ffmpeg.js`, `814.ffmpeg.js`)
- `@ffmpeg/core` 0.12.6 — single-thread (`ffmpeg-core.js`, `ffmpeg-core.wasm`)

Lazy-loaded only when the user chooses **Export as MP4**. Do not add
`worker-src blob:` to the extension CSP — the UMD worker resolves from this
folder via the script publicPath.

Upstream: https://github.com/ffmpegwasm/ffmpeg.wasm
