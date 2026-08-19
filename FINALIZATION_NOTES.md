# Attendance Manager — Finalization Notes

Applied the previously requested finalization fixes to the supplied React/Capacitor source.

## Completed in source

1. Popup menu stacking fix:
   - `StaggeredFadeIn` now uses `animation-fill-mode: backwards`.
   - pushed screen transition also uses `backwards` rather than `both`.
2. Subject/faculty display:
   - shared `subjectTeacherLabel()` helper.
   - attendance logging, calendar, history, and timetable tile now show subject name paired with assigned faculty code/name.
3. Native export/share:
   - Excel export generates an XLSX Blob and routes through Capacitor Filesystem + Share on native builds.
   - JSON backup uses the same native path.
   - browser download remains as fallback.
4. Native notifications:
   - daily reminder uses Capacitor Local Notifications on native builds.
   - permission request and recurring schedule are synchronized when enabled/time changes.
   - previously enabled reminders are re-registered at app startup.
5. Android edge-to-edge/safe areas:
   - top, bottom, and horizontal safe-area insets applied to the app shell.
6. Motion polish:
   - transition/animation properties kept on opacity/transform where applicable.
   - `will-change` added to major animated surfaces.
   - reduced-motion media rule remains in place.
7. Theme chrome:
   - `theme-color` changed from legacy indigo to `#07070F`.
8. Dependencies:
   - added Filesystem, Share, and Local Notifications Capacitor plugins at `^6.1.2` to match the existing Capacitor 6 line.

## Verification status

The source-level changes were audited after patching. A complete npm install/build could not be completed in this environment because dependency installation timed out, so an actual Vite production bundle and real Android native-plugin behavior remain unverified here.
