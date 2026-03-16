# Wardyati Auto-Book

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-green)
![Browser](https://img.shields.io/badge/Browser-Chrome-yellow)

A Chrome extension that automates shift booking on wardyati.com. Instead of watching the countdown and clicking manually, you pick your shifts in advance and the extension clicks the moment the booking button becomes available.

---

## What it does

- Lists all shifts on the room page with their remaining spots
- Lets you select the shifts you want and order them by priority
- Persists your priority list across sessions via `chrome.storage.local`

## Installation

Not yet on the Chrome Web Store — install manually:

1. Download or clone this repo
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer Mode** (top-right toggle)
4. Click **Load unpacked** and select the repo folder
5. The extension icon will appear in your toolbar

---

## How to use it

1. Go to your room page on `wardyati.com/rooms/`
2. Click the extension icon in the toolbar
3. All shifts with available spots are listed — click any to add it to your priority queue
4. Use the ↑ ↓ arrows to reorder by preference
5. Click **Arm** before the coordination window opens
6. The extension will book your highest-priority available shift the moment the button unlocks, then move to the next after a short cooldown

---

## Project structure

```
wardyati-autobook/
├── manifest.json   — Chrome extension config (Manifest V3)
├── content.js      — Core polling and booking logic, injected into the room page
├── popup.html      — Extension popup UI
├── popup.js        — Popup logic, communicates with content script via chrome.storage.local
└── README.md
```

---

## Technical notes

- Communication between popup and content script goes through `chrome.storage.local` — this avoids Chrome's structured-clone restriction on `executeScript` args
- Polling interval is 50
- The 1.5s cooldown between bookings reflects the site's own rate limiting behavior
- Content script only runs on `https://wardyati.com/rooms/*`

---

## Limitations

- **Network latency is the real bottleneck.** The extension eliminates your reaction time (~200–300ms) but cannot reduce the round-trip time between your machine and the server, which varies significantly by ISP and region
- If the site updates its DOM structure or class names, the extension will need to be updated to match
- If the server enforces rate limiting server-side, client-side speed provides no advantage
- Chrome only — no Firefox support

---

## Contributing

Pull requests are welcome.

1. Fork the repo
2. Create a branch: `git checkout -b feature/your-feature`
3. Commit: `git commit -m "describe your change"`
4. Push: `git push origin feature/your-feature`
5. Open a Pull Request

For bugs or feature requests, open an [issue](https://github.com/Omar4242/wardyati-autobook/issues).

---

## License

MIT — free to use, modify, and distribute.

---

Made by [Omar4242](https://github.com/Omar4242)
