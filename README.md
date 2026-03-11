# ⚡ Wardyati Auto-Book

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-green)
![Browser](https://img.shields.io/badge/Browser-Chrome-yellow)
![Status](https://img.shields.io/badge/Status-Active-brightgreen)

Never lose a shift booking to slow reflexes again. This Chrome extension detects all shifts on your Wardyati room page, lets you pick your target, and fires the booking click at 16ms — before any human can react.

![Demo](https://raw.githubusercontent.com/Omar4242/wardyati-autobook/main/demo.gif)

> 📌 *Replace `demo.gif` with your own screen recording. Use [ScreenToGif](https://www.screentogif.com/) to record it for free.*

---

## What it does

- Scans all shifts on the page and shows you their status: OPEN, CLOSED, FULL, or already booked (MINE)
- Shows remaining spots and current holder count for each shift
- You pick the shift you want, click Arm, and forget about it
- The moment coordination opens and the button unlocks, it clicks automatically
- Polls every 16ms — that's one screen frame, faster than any human

---

## Installation

> Not on the Chrome Web Store yet — install manually in 30 seconds:

1. Download or clone this repo
2. Unzip if needed
3. Open Chrome and go to `chrome://extensions/`
4. Turn on **Developer Mode** (toggle in the top-right corner)
5. Click **Load unpacked** and select the `wardyati-extension` folder
6. Done — the ⚡ icon will appear in your toolbar

---

## How to use it

1. Go to your room page on `wardyati.com/rooms/`
2. The floating panel appears in the bottom-left corner
3. All shifts are listed with their status and available spots
4. Click the shift you want to book
5. Click **⚡ Arm Auto-Book** before the countdown hits zero
6. It fires automatically the instant the hold button becomes clickable

You can drag the panel anywhere on the screen if it's in the way.

---

## Why it's faster than doing it manually

| Method | Typical Speed |
|---|---|
| Human click | 200–300ms after noticing |
| Bookmarklet | 50–100ms (you still trigger it) |
| This extension | ~16ms after unlock |

The problem with manual booking isn't your internet — it's reaction time. This removes that bottleneck entirely.

---

## Project structure

```
wardyati-extension/
├── manifest.json      # Chrome extension config (Manifest V3)
├── content.js         # Core logic injected into the room page
├── popup.html         # Toolbar popup
└── icon.png           # Extension icon
```

---

## Technical notes

- Built with **Manifest V3** — the current Chrome standard
- No external libraries — pure vanilla JavaScript
- Uses `MutationObserver` to detect when htmx updates the page DOM
- Content script only runs on `https://wardyati.com/rooms/*` — nowhere else
- Polling at 16ms (~60fps) is the sweet spot between speed and CPU usage

---

## Limitations

- Works on wardyati.com only
- If the server enforces its own rate limiting, client-side speed won't help
- If multiple people are running this extension, it comes down to whose HTTP request the server processes first — that's outside anyone's control

---

## Contributing

Pull requests are welcome. If you want to improve something:

1. Fork the repo
2. Create a branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m "Add your feature"`
4. Push: `git push origin feature/your-feature`
5. Open a Pull Request

If you find a bug or have a feature idea, open an [issue](https://github.com/Omar4242/wardyati-autobook/issues).

---

## License

MIT — free to use, modify, and distribute.

---

Made by [Omar4242](https://github.com/Omar4242)
