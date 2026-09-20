# Permissions

Why SnapShot Studio requests each permission, and the plan to keep the set
minimal. Everything runs locally; no data is collected (see `PRIVACY.md`).

## Current permissions

| Permission | Why it's needed |
|---|---|
| `activeTab` | Capture the visible page and inject the selection/stitch scripts on the tab the user acts on. |
| `tabCapture` | Tab-level media capture. |
| `desktopCapture` | Screen/window capture and recording (via Chrome's share picker). |
| `offscreen` | Run media APIs (frame grabs, `MediaRecorder`) that MV3 service workers can't. |
| `scripting` | Inject the in-page area-selection overlay and full-page scroll-and-stitch. |
| `storage` | Briefly hand a capture from the popup to the editor; store preferences locally. |
| `downloads` | Save exported images, PDFs, and recordings. |
| `clipboardWrite` | Copy an image, extracted text, or a link on "Copy". |
| `commands` | Keyboard shortcuts. |
| `host_permissions: <all_urls>` | Capture and inject scripts on any site the user chooses, and read the current tab's URL/title (for the page-QR). |

## Removed

- **`tabs`** — redundant. With `<all_urls>` host access, `chrome.tabs.query`
  already returns tab `url`/`title`, so the separate `tabs` permission added no
  capability. Removed with no functional change.

## Planned further reduction (follow-up)

Dropping `<all_urls>` in favour of `activeTab` + `optional_host_permissions` is
feasible but changes behaviour (capture would require a fresh user gesture per
tab, and the optional S3 upload would rely on the target bucket's CORS config).
It needs real-browser validation across all capture flows, so it is tracked
separately rather than bundled here. See issue #20 discussion.
