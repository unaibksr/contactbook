# 📇 Contacts

A minimalist, mobile-first contact book that runs entirely in the browser
and installs as a native-feeling app on your phone. Add and edit contacts
with just a name and phone number, then export to a Google-compatible
vCard with one tap. Your data lives in `contacts.json` **in this very
folder** — so when you push this repo to GitHub, your contacts are
backed up alongside the code.

## Features

- **Installable PWA** — Add to your iOS or Android home screen, runs fullscreen
- **Mobile-first UI** — touch-friendly, single-screen flow, bottom-sheet forms
- **Minimal input** — name + phone number only
- **Quick actions** — call, message, copy from the contact detail screen
- **Persistent file storage** — data is auto-saved to `contacts.json`
  using the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
  (Chrome / Edge desktop). On unsupported browsers it falls back to
  localStorage.
- **vCard 3.0 export** — single contact or all contacts, Google Contacts
  compatible
- **vCard import** — drop a `.vcf` file or pick from the menu
- **JSON backup / restore** — for when you need a manual snapshot
- **Drag & drop** import on the page
- **Undo** deletes and bulk wipes via toast action
- **Dark mode** auto-detected from system
- **Offline-ready** — service worker caches all assets

## File layout

```
contactbook/
├── index.html              ← entry point (open this in a browser)
├── styles.css              ← all styles
├── app.js                  ← application logic
├── sw.js                   ← service worker (offline + install)
├── manifest.json           ← PWA manifest
├── contacts.json           ← ⭐ YOUR CONTACTS LIVE HERE
├── icon-192.png            ← PWA icon
├── icon-512.png            ← PWA icon
├── icon-maskable-512.png   ← PWA maskable icon (Android adaptive)
├── apple-touch-icon.png    ← iOS home screen icon
├── favicon-32.png          ← browser tab icon
├── icon.svg                ← source SVG for the icon
├── generate-icons.ps1      ← regenerate PNG icons from the SVG
├── push.ps1                ← one-command "push my contacts to GitHub"
├── setup.bat               ← one-command initial repo setup
├── .gitignore
└── README.md
```

## Install on your phone

**Android (Chrome / Edge / Samsung Internet):**
1. Open the app URL in Chrome on your phone
2. Tap the **⋮** menu → **Install app** (or **Add to Home screen**)
3. The app icon appears on your home screen
4. Opens fullscreen with no browser chrome

**iOS (Safari):**
1. Open the app URL in Safari
2. Tap the **Share** button (square with arrow)
3. Scroll down and tap **Add to Home Screen**
4. Confirm the name "Contacts" and tap **Add**

> **Tip:** for the best PWA experience on iOS, use Safari. iOS PWAs
> run in standalone mode without the browser bar.

## Quick start (desktop)

1. Open `index.html` in Chrome or Edge (File System Access API required
   for auto-save to `contacts.json`).
2. On first launch you'll be prompted to pick a save location. **Pick
   `contacts.json` inside this project folder** so the file stays
   in the repo.
3. Tap the `+` button to add a contact — only name and phone.
4. Your changes are auto-saved to `contacts.json`.

## Pushing to GitHub

Because `contacts.json` is **inside the project folder**, a normal
`git add . && git commit && git push` will commit your contact data
along with the code. No extra steps required.

### One-time setup

```bash
cd contactbook
git init
git add .
git commit -m "Initial commit with contacts"
git branch -M main
git remote add origin https://github.com/<you>/contactbook.git
git push -u origin main
```

Or on Windows, just run:

```bat
setup.bat https://github.com/<you>/contactbook.git
```

### Updating contacts later

After making changes in the app, run:

```bash
git add contacts.json
git commit -m "update contacts"
git push
```

Or on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\push.ps1
```

The `push.ps1` script stages only `contacts.json` plus the source
files (so random runtime files don't sneak into the repo), commits
with a timestamp, and pushes.

> **Tip:** if you don't want a specific contact in the public repo,
> use a private repository, or edit `contacts.json` before pushing.

## Keyboard shortcuts

| Key   | Action              |
| ----- | ------------------- |
| `N`   | New contact         |
| `E`   | Edit selected       |
| `Del` | Delete selected     |
| `/`   | Focus search        |
| `Esc` | Close sheet / modal |

## Browser support

| Feature            | Chrome | Edge | Firefox | Safari |
| ------------------ | :----: | :--: | :-----: | :----: |
| Add / edit / view  |   ✓    |  ✓   |    ✓    |   ✓    |
| vCard import / exp |   ✓    |  ✓   |    ✓    |   ✓    |
| Auto-save to file  |   ✓    |  ✓   |    ✗    |   ✗    |
| Install as PWA     |   ✓    |  ✓   |    ✓    |   ✓    |
| Offline (SW)       |   ✓    |  ✓   |    ✓    |   ✓    |
| localStorage cache |   ✓    |  ✓   |    ✓    |   ✓    |

When the File System Access API isn't available the app uses
localStorage as a cache. To save a permanent copy on those browsers,
use **Menu → Download backup** to save a `contacts-backup.json`.

## Regenerating the icons

If you tweak `icon.svg`, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\generate-icons.ps1
```

This generates `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
`apple-touch-icon.png`, and `favicon-32.png` from the SVG using
System.Drawing (built into Windows, no dependencies).

## License

MIT — do whatever you want.
