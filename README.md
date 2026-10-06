# Tab Thumbnails Switcher

A Chrome / Chromium extension that shows the tabs of the current window as a grid of thumbnails, so you can find, switch to, and close tabs at a glance.

Inspired by [Tab Thumbnails](https://chromewebstore.google.com/detail/tab-thumbnails/adcmjkdmkpfdlhinedckkklaklijifpo). On top of its features, this extension adds window position presets, automatic scaling to the number of tabs, and split view support.

## Features

### Thumbnail grid
- Every tab in the current window is shown as a card with a thumbnail, favicon, and title. Long titles wrap onto two lines.
- The active tab has a blue outline and a **Current tab** label.
- Choose 2–6 thumbnails per row.
- Light, dark, or system theme.
- If a page can't be captured (e.g. `chrome://` pages), its card shows the favicon instead.

### Thumbnails
- Saved thumbnails show up as soon as the switcher opens.
- The active tab's thumbnail is captured again in the background when you switch tabs, when a page finishes loading, and when a window gains focus.
- **Refresh** captures every tab in the window, then returns to the tab you were on.

### Tab management
- Click a card to switch to that tab.
- Close a tab with the × button in the top-left corner, or by middle-clicking the card.
- The **+** button opens a new tab.

### Keyboard

| Key | Action |
|---|---|
| `←` `→` | Move the selection; wraps across rows |
| `↑` `↓` | Move the selection; keeps the column |
| `Enter` | Switch to the selected tab |
| `Delete` / `Backspace` | Close the selected tab |
| `Esc` | Close settings, or close the switcher |
| `1`–`9`, `0`, `a`–`z` | Jump to a tab (turn on **Show shortcut keys on thumbnails**) |

The default shortcut to open the switcher is `Ctrl+Shift+E` (`⌘+Shift+E` on macOS). Change it with the **Change** button in settings, which opens `chrome://extensions/shortcuts`.

### Window position presets
By default the switcher opens as a floating window. You can place it in one of five positions:

| Preset | Shape |
|---|---|
| Center | Grid in the middle of the screen |
| Top center | Horizontal strip along the top |
| Bottom center | Horizontal strip along the bottom |
| Left center | Vertical strip along the left edge |
| Right center | Vertical strip along the right edge |

To use the original toolbar popup instead, set **Open as** to **Toolbar popup**.

### Automatic scaling
The window size, number of rows and columns, and card size (120–340 px) are chosen to fit the number of tabs, and recalculated when tabs open or close.
- Top and bottom presets stay a single row as long as cards are at least 160 px wide.
- Left and right presets use as few columns as possible.
- If the tabs don't fit even at the minimum card size, the grid scrolls.

### Split view
Two tabs shown side by side in a split view appear as **one card**, with each pane's thumbnail on its own half.
- Click a half to switch to that pane.
- Middle-click a half to close only that pane.
- The × button closes both tabs.

Split views are detected in two ways:
1. `tab.splitViewId` from the Split View API (Chrome 155+).
2. Browsers with their own split view that don't report `splitViewId` (for example [Dia](https://www.diabrowser.com/)): two adjacent tabs whose widths add up to one full tab width, minus the divider, are treated as a split.

### Languages
English, Korean, Simplified Chinese, Traditional Chinese, Japanese, Spanish, German, Polish, French, Portuguese (Brazil), Russian.

## Installation

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

Requires Chrome / Chromium 140 or later.

## Permissions

| Permission | Used for |
|---|---|
| `tabs` | Reading tab titles, URLs, and sizes |
| `<all_urls>` (host) | Capturing thumbnails of tabs with `captureVisibleTab` |
| `storage`, `unlimitedStorage` | Saving thumbnails and settings locally |
| `favicon` | Showing favicons |
| `system.display` | Finding the screen area to place the switcher window |

All data stays in local extension storage. Nothing is sent anywhere.

## Known limitations

- Detecting split views by width relies on a tab's last known size. If you unsplit and never view either tab again, the two may still show as one card.
- Some browsers send no tab event when a split view is created or removed, so an open switcher won't update until you open it again.
- `captureVisibleTab` is limited to about two calls per second, so **Refresh** takes a moment in windows with many tabs.

## Project structure

```
manifest.json         Extension manifest (MV3)
background.js         Service worker: thumbnail capture, shortcut, switcher window
switcher.html/css/js  Switcher UI, keyboard handling, settings panel
shared/layout.js      Window size, position, and card size for each preset
shared/split.js       Groups tabs into cards, including split view detection
shared/settings.js    Settings defaults and storage helpers
_locales/             Translations
icons/                Extension icons
```
