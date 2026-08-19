# Attendance Manager (React) — Build Guide

This turns `attendance-manager-app.jsx` into a running app: first in a
browser, then as an installable Android app via Capacitor — the same
pipeline you used for Forge.

Files in this folder:
- `attendance-manager-app.jsx` — the entire app (one component)
- `mount.jsx` — mounts it to the page
- `index.html`, `vite.config.js`, `package.json` — project scaffold
- `capacitor.config.json` — pre-filled Capacitor config

---

## 0. Prerequisites

- **Node.js 18+** — `node -v` to check. Get it from nodejs.org if missing.
- **Android Studio** (with its bundled JDK) — only needed once you get to
  the APK step. Skip it for now if you just want the browser version working.

---

## 1. Create the project folder

Make a new folder (e.g. `attendance-manager-app`, next to your `forge-app`
folder) and put all six files from this chat directly inside it — not in
a `src/` subfolder, at the top level, same layout as `forge-app`.

```
attendance-manager-app/
├── attendance-manager-app.jsx
├── mount.jsx
├── index.html
├── vite.config.js
├── package.json
└── capacitor.config.json
```

## 2. Install dependencies

Open a terminal in that folder:

```bash
npm install
```

This pulls in React, Vite, `lucide-react` (icons), `recharts` (the
Analytics charts), and `xlsx` (Excel export).

## 3. Run it in the browser first

```bash
npm run dev
```

Open the printed `http://localhost:5173` URL. This is the fastest loop
for checking everything — add a subject, build a timetable pattern,
generate sessions, mark attendance, look through Analytics — before ever
touching Android. Data is saved to the browser's local storage, so it
survives refreshes on this machine.

## 4. Verify the app locally

The current finalized build is fully local/offline for attendance data. It does not require an AI API key, cloud backend, or database. The "Import Routine" feature can accept JSON generated externally by any AI, but the app itself does not make AI/network calls for attendance calculations.

For normal development, run:

```bash
npm run dev
```

Then verify the core flows: add subjects, configure timetable entries, generate sessions, log attendance, review Analytics, export Excel, and use backup/restore.

## 5. Build the production bundle

```bash
npm run build
```

This produces a `www/` folder — same name Capacitor already expects to
find, matching your `forge-app` layout.

## 6. Add the Android project

First time only:

```bash
npx cap add android
```

This generates the `android/` folder (a real Android Studio project)
and points it at `capacitor.config.json`, which is already filled in
(app ID `com.zeus.attendancemanager`, app name "Attendance Manager",
web dir `www`). Change the `appId` first if you want a different package
name — it's the one thing that's awkward to change later.

## 7. Sync your build into the Android project

Every time you rebuild the web app (step 5), copy it into Android:

```bash
npx cap sync android
```

## 8. Open in Android Studio and run it

```bash
npx cap open android
```

Android Studio opens the `android/` project. Pick a device/emulator and
hit Run — same as any native Android project from here.

## 9. Build a real, shareable APK

In Android Studio: **Build → Generate Signed Bundle / APK**, choose APK,
either create a new keystore (first time) or reuse the one from Forge,
and build the release variant. The `.apk` lands under
`android/app/release/`, ready to install on any Android phone.

## 10. Day-to-day workflow after this

Whenever you change the JSX file:

```bash
npm run build
npx cap sync android
```

Then re-run from Android Studio (step 8). You don't need to repeat
`cap add android` — that's a one-time step.

## Known gotcha: `getDefaultProguardFile` build failure (AGP 9)

If `assembleDebug` fails with:

```
`getDefaultProguardFile('proguard-android.txt')` is no longer supported...
```

This is a real, currently-live breaking change: **Android Gradle Plugin 9
removed support for `proguard-android.txt` entirely.** It doesn't just hit
your own `android/app/build.gradle` — it hits Capacitor's own core package
and any plugin that ships its own `build.gradle`, since they all referenced
the old filename. You'll see the same error pointing at different files
one after another if you patch them by hand.

**Don't hand-edit files under `node_modules`** — they get overwritten on
the next `npm install`. Instead, update Capacitor itself; the team has
already merged the fix upstream:

```bash
npm install @capacitor/core@latest @capacitor/android@latest @capacitor/cli@latest
npx cap sync android
```

Rebuild after that. If your own `android/app/build.gradle` still has the
old filename (Capacitor's update won't touch that one, since it's inside
your project, not a dependency), fix that one line by hand as before:
`getDefaultProguardFile('proguard-android.txt')` → `getDefaultProguardFile('proguard-android-optimize.txt')`.

If errors persist after updating, the underlying cause is likely that your
local Android Studio installed an Android Gradle Plugin version newer than
what's been tested — pinning AGP down to a known-good 8.x release in
`android/build.gradle` is the fallback, but that has to stay paired with a
compatible Gradle wrapper version, so treat it as a last resort rather than
a first move.

## Optional polish

- **App icon / splash screen**: `npx @capacitor/assets generate` (feed it
  a source icon PNG), or drop images directly into
  `android/app/src/main/res/` the way you did for Forge.
- **Package name**: edit `appId` in `capacitor.config.json` before step 6
  — awkward to change once the Android project exists.

---

## What's different from the Flutter app, and why

Everything else in the app — every screen, every calculation (attendance
%, safe-skip math, recovery plan, XP/streaks/achievements, session
generation from timetable patterns) — is a direct, faithful port. Four
things changed because the platform did, not by choice:

1. **Storage**: SQLite → the browser's local storage. Same data, same
   shape, just a different file format under the hood. Backup/restore is
   now a JSON file you download/pick, instead of copying a `.sqlite` file
   — and restoring takes effect immediately, no app restart needed.
2. **AI keys**: `.env` at build time → the `AI_API_KEYS` constant
   described in step 4 above.
3. **PDF export**: the original used native PDF/print packages; no
   equivalent library is bundled here, so "PDF report" opens a formatted
   page and uses your browser's own Print → Save as PDF — same end
   result, standard web mechanism.
4. **Home-screen widget & true background notifications**: these are
   OS-level features with no plain-web equivalent. The daily-reminder
   toggle and its browser notification permission are wired up and will
   fire while the app is open; a real always-on background version would
   need a native Capacitor plugin (e.g. `@capacitor/local-notifications`)
   added to the Android project directly — a good next step once this is
   running, but outside what a web page can do on its own.

## Finalization patch (latest)

The finalized source now includes:

- Subject/faculty display uses `Subject Name — Faculty Short Code` when a teacher is assigned, instead of `Subject Code — Subject Name` on attendance, calendar, history, and timetable displays.
- Popup menus use stagger animations with `backwards` fill mode so transformed tiles do not trap their dropdown stacking context.
- Excel and JSON backup exports use Capacitor Filesystem + Share on native Android, with a browser-download fallback for web/dev builds.
- Daily attendance reminders use `@capacitor/local-notifications` for native Android scheduling, with permission handling and startup re-registration. Browser notification permission remains a fallback outside native builds.
- Edge-to-edge safe-area handling was added using `env(safe-area-inset-*)`, including top/notch, left/right, and bottom insets.
- Screen transitions were audited toward transform/opacity-based animation and GPU-friendly `will-change` hints; reduced-motion support remains active.
- `index.html` uses `#07070F` for the Android/browser theme color to match the dark neon background.

### Added native Capacitor packages

The `package.json` includes these packages at the same Capacitor 6.x line as the existing project:

- `@capacitor/filesystem`
- `@capacitor/share`
- `@capacitor/local-notifications`

After copying the project to a machine with network access:

```bash
npm install
npx cap sync android
npm run build
```

Then open/build the Android project as usual. Native notification, file-sharing, and actual notch behavior still require a real Android build/device to verify.
