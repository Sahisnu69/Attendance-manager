import React, { useState, useEffect, useMemo, useContext, createContext, useRef, useCallback, useId } from 'react';
import {
  LayoutDashboard, CheckCircle2, CalendarDays, Clock, MoreHorizontal, Trophy,
  BarChart3, History as HistoryIcon, Calculator as CalculatorIcon, SlidersHorizontal, Upload,
  StickyNote, BookOpen, User, Share2, DatabaseBackup, Bell, Flame, Lock, Award, ChevronRight,
  ChevronLeft, Plus, X, Check, Trash2, Pencil, Search, Settings as SettingsIcon,
  CircleCheck, CircleX, CalendarX2, Download, Save, AlertCircle, Info, Loader2,
  FileText, TableProperties, RotateCcw, ChevronDown, Printer, ClipboardCopy, ChevronUp,
  MoreVertical, PlusCircle, MapPin, GraduationCap, Repeat, CalendarPlus, Timer,
} from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import * as XLSX from 'xlsx';

/* ══════════════════════════════════════════════════════════════════════
   ATTENDANCE MANAGER — single-file React port of the Flutter app
   ══════════════════════════════════════════════════════════════════════
   Faithful port: same screens, same navigation, same attendance math,
   same gamification rules, same import/export behavior. Two structural
   swaps forced by the platform change (Flutter -> web React):
     - SQLite (Drift) -> localStorage, one JSON blob per table
     - Backup/restore of a .sqlite file -> export/import of one JSON file
   Native-only pieces (Android/iOS home-screen widget, OS-level background
   notifications) have no web equivalent and are called out inline where
   they're skipped, rather than silently dropped.
   ══════════════════════════════════════════════════════════════════════ */

/* ────────────────────────────────────────────────────────────────────
   STORAGE LAYER
   Real localStorage when available (any normal browser tab, or a
   Capacitor/WebView build). Falls back automatically to an in-memory
   store if localStorage throws (this happens inside Claude.ai's live
   artifact preview sandbox) so the app still renders and works for the
   session either way — it just won't persist across a full reload in
   that specific preview context.
   ──────────────────────────────────────────────────────────────────── */
const memoryStore = new Map();
let storageIsMemoryOnly = false;
(function probeStorage() {
  try {
    const k = '__am_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
  } catch (e) {
    storageIsMemoryOnly = true;
  }
})();

const storage = {
  get(key) {
    if (storageIsMemoryOnly) return memoryStore.has(key) ? memoryStore.get(key) : null;
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? null : v;
    } catch (e) {
      return memoryStore.has(key) ? memoryStore.get(key) : null;
    }
  },
  set(key, value) {
    if (storageIsMemoryOnly) { memoryStore.set(key, value); return; }
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      memoryStore.set(key, value);
    }
  },
};

function loadJSON(key, fallback) {
  const raw = storage.get(key);
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  storage.set(key, JSON.stringify(value));
}

const STORAGE_KEYS = {
  subjects: 'am_subjects',
  teachers: 'am_teachers',
  timetableEntries: 'am_timetable_entries',
  classSessions: 'am_class_sessions',
  attendanceRecords: 'am_attendance_records',
  holidays: 'am_holidays',
  lectureNotes: 'am_lecture_notes',
  settings: 'am_settings',
  reminderPrefs: 'am_reminder_prefs',
  schemaVersion: 'am_schema_version',
};

/* ────────────────────────────────────────────────────────────────────
   SMALL UTILITIES
   ──────────────────────────────────────────────────────────────────── */
function uid() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dateKey(d) {
  const x = startOfDay(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function isSameDate(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
// ISO weekday: 1 = Monday ... 7 = Sunday (matches Dart's DateTime.weekday)
function isoWeekday(d) { const js = d.getDay(); return js === 0 ? 7 : js; }
function mondayOf(d) { return addDays(startOfDay(d), -(isoWeekday(d) - 1)); }
function combineDateAndMinutes(date, minutes) {
  const x = startOfDay(date);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate(), Math.floor(minutes / 60), minutes % 60);
}
function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ────────────────────────────────────────────────────────────────────
   HAPTICS — navigator.vibrate is well-supported in Android WebViews
   (which is what this becomes under Capacitor) and Chrome; it's a
   silent no-op on iOS Safari and desktop, so this is safe everywhere.
   Kept short and infrequent by design — never on passive navigation,
   only on a deliberate action (marking attendance, saving, deleting).
   ──────────────────────────────────────────────────────────────────── */
function haptic(pattern) {
  try {
    if (navigator && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch (e) { /* silently ignore — never let feedback failure break an action */ }
}
const HAPTIC = { tap: 10, select: 14, success: [12, 28, 12], warn: [16, 40, 16] };

/* ────────────────────────────────────────────────────────────────────
   ANDROID BACK BUTTON — Capacitor's default bridge maps the hardware
   back button to "go back in the WebView's history if any exists,
   otherwise minimize/exit." This app never pushed any history entries,
   so back always fell straight through to exiting, regardless of
   whether a sheet, dialog, or pushed screen was open. Fix: push a real
   history entry whenever something opens, and let popstate close the
   top-most thing first — so back always does the contextually correct
   thing, and only exits once there's genuinely nothing left open.
   ──────────────────────────────────────────────────────────────────── */
let backCloseStack = []; // array of { id, onClose }, index 0 = outermost

function pushBackLayer(onClose) {
  const id = uid();
  const depth = backCloseStack.length + 1;
  try { window.history.pushState({ amDepth: depth }, ''); } catch (e) { /* no-op outside a real browser history */ }
  backCloseStack.push({ id, onClose });
  return id;
}
function closeBackLayer(id) {
  const idx = backCloseStack.findIndex((e) => e.id === id);
  if (idx === -1) return; // already removed by the back button itself
  backCloseStack.splice(idx, 1);
  // Update our own bookkeeping immediately rather than waiting on the
  // resulting popstate — consecutive history.back() calls can be
  // coalesced by the browser into fewer popstate events than calls, so
  // counting events is unreliable. Comparing state depth (below) is not.
  try { window.history.back(); } catch (e) { /* no-op outside a real browser history */ }
}
function initBackButtonHandling() {
  function handler(event) {
    const targetDepth = (event.state && typeof event.state.amDepth === 'number') ? event.state.amDepth : 0;
    while (backCloseStack.length > targetDepth) {
      const top = backCloseStack.pop();
      if (top) top.onClose();
    }
    // Stack now matches history depth exactly; if it's at 0, there was
    // nothing left to intercept and Capacitor's own Android bridge takes
    // over from here (minimizes/exits), same as native.
  }
  window.addEventListener('popstate', handler);
  return () => window.removeEventListener('popstate', handler);
}

// Drop-in for any sheet/dialog/screen: pass whether it's currently open
// and what "closing" means for it. Handles registering and cleaning up
// its own back-button layer automatically.
function useBackButtonLayer(isOpen, onClose) {
  const idRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return undefined;
    idRef.current = pushBackLayer(() => onCloseRef.current());
    return () => {
      if (idRef.current) { closeBackLayer(idRef.current); idRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
}

const _timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const _dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const _weekdayDateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// minutes-from-midnight -> "5:00 PM"
function formatMinutes(minutes) {
  const anchor = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return _timeFmt.format(anchor);
}
// Date -> "20 Jul 2026"
function formatDate(d) { return _dateFmt.format(d); }
// Date -> "Mon, 20 Jul"
function formatWeekdayDate(d) { return _weekdayDateFmt.format(d); }

/* ────────────────────────────────────────────────────────────────────
   CONSTANTS
   ──────────────────────────────────────────────────────────────────── */
const WEEKDAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_SHORT = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const SUBJECT_PALETTE = [
  '#FF4D6D', '#B444FF', '#3D8BFF', '#22D3EE',
  '#39E88A', '#B6F23D', '#FFB020', '#FF3D9E',
];

const AttendanceStatus = { PRESENT: 'present', ABSENT: 'absent', EXCUSED: 'excused', NOT_MARKED: 'notMarked' };
const SessionStatus = {
  SCHEDULED: 'scheduled',
  CANCELLED_HOLIDAY: 'cancelledHoliday',
  CANCELLED_OTHER: 'cancelledOther',
  RESCHEDULED: 'rescheduled',
};

const DEFAULT_SETTINGS = {
  targetThreshold: 0.60,
  excusedIsExcludedFromTotals: true,
  enforcePerSubjectFloor: false,
};

const DEFAULT_REMINDER_PREFS = {
  enabled: false,
  hour: 20,
  minute: 0,
};

/* ────────────────────────────────────────────────────────────────────
   ATTENDANCE ENGINE (pure functions — direct port of AttendanceEngine)
   Aggregate (class-based) attendance is the number that gates exam
   eligibility: total attended ÷ total held, across every subject
   combined. Per-subject numbers are informational only.
   ──────────────────────────────────────────────────────────────────── */
function countsTowardTotals(s) {
  return s.status !== SessionStatus.CANCELLED_HOLIDAY && s.status !== SessionStatus.CANCELLED_OTHER;
}
function sessionStartDateTime(s) { return combineDateAndMinutes(s.date, s.startMinutes); }
function sessionEndDateTime(s) { return combineDateAndMinutes(s.date, s.endMinutes); }
function isPastSession(s, asOf) { return !(sessionStartDateTime(s) > asOf); }

function computeAggregate(sessions, recordsBySessionId, settings, asOf) {
  const now = asOf || new Date();
  let held = 0, present = 0, absent = 0, excused = 0, remaining = 0;

  for (const s of sessions) {
    if (!countsTowardTotals(s)) continue;
    const isPast = isPastSession(s, now);
    const record = recordsBySessionId[s.id];
    const status = record ? record.status : AttendanceStatus.NOT_MARKED;

    if (!isPast) { remaining++; continue; }

    switch (status) {
      case AttendanceStatus.PRESENT: held++; present++; break;
      case AttendanceStatus.ABSENT: held++; absent++; break;
      case AttendanceStatus.EXCUSED:
        excused++;
        if (!settings.excusedIsExcludedFromTotals) held++;
        break;
      case AttendanceStatus.NOT_MARKED:
      default:
        held++;
        break;
    }
  }

  const currentPercentage = held === 0 ? null : present / held;
  return {
    totalHeld: held, totalPresent: present, totalAbsent: absent, totalExcused: excused,
    totalRemaining: remaining, totalTermSessions: held + remaining, targetThreshold: settings.targetThreshold,
    currentPercentage,
    isAboveTarget: currentPercentage === null ? true : currentPercentage >= settings.targetThreshold,
    marginPercentagePoints: currentPercentage === null ? null : (currentPercentage - settings.targetThreshold) * 100,
  };
}

function computeSubjectBreakdown(sessions, recordsBySessionId, settings, asOf) {
  const now = asOf || new Date();
  const held = {}, present = {};
  for (const s of sessions) {
    if (!countsTowardTotals(s) || !isPastSession(s, now)) continue;
    const record = recordsBySessionId[s.id];
    const status = record ? record.status : AttendanceStatus.NOT_MARKED;
    if (status === AttendanceStatus.EXCUSED && settings.excusedIsExcludedFromTotals) continue;
    held[s.subjectId] = (held[s.subjectId] || 0) + 1;
    if (status === AttendanceStatus.PRESENT) present[s.subjectId] = (present[s.subjectId] || 0) + 1;
  }
  const list = Object.keys(held).map((id) => {
    const h = held[id], p = present[id] || 0;
    return { subjectId: id, totalHeld: h, totalPresent: p, percentage: h === 0 ? null : p / h };
  });
  list.sort((a, b) => (a.percentage ?? 0) - (b.percentage ?? 0));
  return list;
}

function computeSafeSkips(stats) {
  const finalTotal = stats.totalHeld + stats.totalRemaining;
  const target = stats.targetThreshold;
  if (finalTotal === 0) {
    return { remainingSessions: 0, maxSafeSkips: 0, mustAttend: 0, projectedPercentageIfMaxSkipsUsed: 0, alreadyBelowTarget: false };
  }
  const rawNeeded = target * finalTotal - stats.totalPresent;
  const mustAttend = clampInt(Math.ceil(rawNeeded), 0, stats.totalRemaining);
  const maxSafeSkips = stats.totalRemaining - mustAttend;
  const projectedPresent = stats.totalPresent + mustAttend;
  const projectedPct = finalTotal === 0 ? 0 : projectedPresent / finalTotal;
  return {
    remainingSessions: stats.totalRemaining,
    maxSafeSkips, mustAttend,
    projectedPercentageIfMaxSkipsUsed: projectedPct,
    alreadyBelowTarget: (stats.currentPercentage ?? 1.0) < target && stats.totalHeld > 0,
  };
}

function simulateFinalPercentage(stats, futureAttendCount) {
  const clamped = clampInt(futureAttendCount, 0, stats.totalRemaining);
  const finalTotal = stats.totalHeld + stats.totalRemaining;
  if (finalTotal === 0) return 0;
  return (stats.totalPresent + clamped) / finalTotal;
}

function computeRecoveryPlan(stats) {
  const target = stats.targetThreshold;
  const currentPct = stats.currentPercentage;
  if (currentPct === null || currentPct >= target) {
    return { alreadyOnTarget: true, recoveryPossibleThisTerm: true, consecutiveClassesToAttend: 0, bestPossiblePercentageIfAllRemainingAttended: currentPct ?? 1.0 };
  }
  const h = stats.totalHeld, p = stats.totalPresent;
  const numerator = target * h - p;
  const denominator = 1 - target;
  const xNeeded = denominator <= 0 ? Infinity : numerator / denominator;
  const xNeededInt = Number.isFinite(xNeeded) ? Math.ceil(xNeeded) : (1 << 30);
  const bestCasePresent = stats.totalPresent + stats.totalRemaining;
  const bestCaseTotal = stats.totalHeld + stats.totalRemaining;
  const bestCasePct = bestCaseTotal === 0 ? 0 : bestCasePresent / bestCaseTotal;
  const possible = xNeededInt <= stats.totalRemaining;
  return {
    alreadyOnTarget: false,
    recoveryPossibleThisTerm: possible,
    consecutiveClassesToAttend: possible ? xNeededInt : stats.totalRemaining,
    bestPossiblePercentageIfAllRemainingAttended: bestCasePct,
  };
}

/* ────────────────────────────────────────────────────────────────────
   GAMIFICATION ENGINE — deterministic, zero AI/network involvement.
   ──────────────────────────────────────────────────────────────────── */
function xpToReachLevel(level) { return 25 * level * (level - 1); }

function computeGamification(sessions, recordsBySessionId, targetThreshold, asOf) {
  const now = asOf || new Date();
  const past = sessions
    .filter((s) => countsTowardTotals(s) && !(sessionStartDateTime(s) > now))
    .slice()
    .sort((a, b) => sessionStartDateTime(a) - sessionStartDateTime(b));

  let totalPresent = 0, totalExcused = 0;
  let currentStreak = 0, longestStreak = 0;
  let everRecovered = false, wasEverBelowTarget = false;
  let runningHeld = 0, runningPresent = 0;

  for (const s of past) {
    const record = recordsBySessionId[s.id];
    const status = record ? record.status : AttendanceStatus.NOT_MARKED;
    switch (status) {
      case AttendanceStatus.PRESENT:
        totalPresent++; currentStreak++;
        if (currentStreak > longestStreak) longestStreak = currentStreak;
        runningHeld++; runningPresent++;
        break;
      case AttendanceStatus.ABSENT:
        currentStreak = 0; runningHeld++;
        break;
      case AttendanceStatus.EXCUSED:
        totalExcused++; runningHeld++;
        break;
      case AttendanceStatus.NOT_MARKED:
      default:
        currentStreak = 0; runningHeld++;
        break;
    }
    if (runningHeld > 0) {
      const pct = runningPresent / runningHeld;
      if (pct < targetThreshold) wasEverBelowTarget = true;
      else if (wasEverBelowTarget && pct >= targetThreshold) everRecovered = true;
    }
  }

  const totalXp = totalPresent * 10 + totalExcused * 3 + longestStreak * 2;
  let level = 1;
  while (xpToReachLevel(level + 1) <= totalXp) level++;
  const xpAtCurrentLevel = xpToReachLevel(level);
  const xpAtNextLevel = xpToReachLevel(level + 1);
  const currentPct = runningHeld === 0 ? null : runningPresent / runningHeld;
  const xpNeededForNextLevel = xpAtNextLevel - xpAtCurrentLevel;
  const xpIntoCurrentLevel = totalXp - xpAtCurrentLevel;

  return {
    currentStreak, longestStreak, totalPresent, totalExcused, totalXp, level,
    xpIntoCurrentLevel, xpNeededForNextLevel,
    everRecoveredFromBelowTarget: everRecovered,
    currentMarginPercentagePoints: currentPct === null ? null : (currentPct - targetThreshold) * 100,
    levelProgress: xpNeededForNextLevel === 0 ? 1 : clampInt(xpIntoCurrentLevel / xpNeededForNextLevel, 0, 1),
  };
}

const ACHIEVEMENTS = [
  { id: 'first_step', title: 'First Step', description: 'Log your first attended class.', isUnlocked: (s) => s.totalPresent >= 1 },
  { id: 'getting_started', title: 'Getting Started', description: 'Attend 10 classes.', isUnlocked: (s) => s.totalPresent >= 10 },
  { id: 'half_century', title: 'Half Century', description: 'Attend 50 classes.', isUnlocked: (s) => s.totalPresent >= 50 },
  { id: 'century_club', title: 'Century Club', description: 'Attend 100 classes.', isUnlocked: (s) => s.totalPresent >= 100 },
  { id: 'week_warrior', title: 'Week Warrior', description: 'Reach a 7-class attendance streak.', isUnlocked: (s) => s.longestStreak >= 7 },
  { id: 'fortnight_fighter', title: 'Fortnight Fighter', description: 'Reach a 14-class attendance streak.', isUnlocked: (s) => s.longestStreak >= 14 },
  { id: 'unstoppable', title: 'Unstoppable', description: 'Reach a 30-class attendance streak.', isUnlocked: (s) => s.longestStreak >= 30 },
  { id: 'comeback_kid', title: 'Comeback Kid', description: 'Recover from below target back to at/above it.', isUnlocked: (s) => s.everRecoveredFromBelowTarget },
  { id: 'safety_margin', title: 'Safety Margin', description: 'Hold 15+ percentage points above target.', isUnlocked: (s) => s.currentMarginPercentagePoints != null && s.currentMarginPercentagePoints >= 15 },
  { id: 'level_5', title: 'Leveled Up', description: 'Reach level 5.', isUnlocked: (s) => s.level >= 5 },
  { id: 'level_10', title: 'Veteran', description: 'Reach level 10.', isUnlocked: (s) => s.level >= 10 },
];

/* ────────────────────────────────────────────────────────────────────
   TIMETABLE SESSION GENERATOR — template (TimetableEntry) -> dated rows
   (ClassSession). Idempotent: safe to re-run without duplicating.
   ──────────────────────────────────────────────────────────────────── */
function mod(n, m) { return ((n % m) + m) % m; }

function firstOccurrenceOnOrAfter(anchor, weekday, intervalWeeks, notBefore) {
  const anchorDateOnly = startOfDay(anchor);
  let firstOccurrence = addDays(anchorDateOnly, mod(weekday - isoWeekday(anchorDateOnly), 7));
  if (firstOccurrence < anchorDateOnly) firstOccurrence = addDays(firstOccurrence, 7);
  if (!(firstOccurrence < notBefore)) return firstOccurrence;
  const stepDays = 7 * intervalWeeks;
  const daysShort = Math.round((notBefore - firstOccurrence) / 86400000);
  const stepsNeeded = Math.ceil(daysShort / stepDays);
  return addDays(firstOccurrence, stepsNeeded * stepDays);
}

function holidayContains(h, date) {
  const d = startOfDay(date);
  return d >= startOfDay(h.start) && d <= startOfDay(h.end);
}

function generateSessionsFor(entries, holidays, existingSessions, horizon) {
  const today = startOfDay(new Date());
  const newSessions = [];
  const existingByEntry = {};
  for (const s of existingSessions) {
    (existingByEntry[s.timetableEntryId] || (existingByEntry[s.timetableEntryId] = [])).push(s.date);
  }

  for (const entry of entries) {
    if (!entry.active) continue;
    const effectiveHorizon = (entry.effectiveUntil && entry.effectiveUntil < horizon) ? entry.effectiveUntil : horizon;
    let cursor = firstOccurrenceOnOrAfter(entry.anchorDate, entry.weekday, entry.intervalWeeks, today);
    const existingDates = existingByEntry[entry.id] || [];

    while (!(cursor > effectiveHorizon)) {
      const alreadyExists = existingDates.some((d) => isSameDate(d, cursor));
      if (!alreadyExists) {
        const onHoliday = holidays.some((h) => holidayContains(h, cursor));
        newSessions.push({
          id: uid(),
          timetableEntryId: entry.id,
          subjectId: entry.subjectId,
          teacherId: entry.teacherId || null,
          date: cursor,
          startMinutes: entry.startMinutes,
          endMinutes: entry.endMinutes,
          room: entry.room || '',
          status: onHoliday ? SessionStatus.CANCELLED_HOLIDAY : SessionStatus.SCHEDULED,
        });
      }
      cursor = addDays(cursor, 7 * entry.intervalWeeks);
    }
  }
  return newSessions;
}

function reapplyHolidays(sessions, holidays) {
  const today = startOfDay(new Date());
  let changed = false;
  const next = sessions.map((s) => {
    if (s.date < today) return s;
    const shouldBeHoliday = holidays.some((h) => holidayContains(h, s.date));
    const isHoliday = s.status === SessionStatus.CANCELLED_HOLIDAY;
    if (shouldBeHoliday && !isHoliday) { changed = true; return { ...s, status: SessionStatus.CANCELLED_HOLIDAY }; }
    if (!shouldBeHoliday && isHoliday) { changed = true; return { ...s, status: SessionStatus.SCHEDULED }; }
    return s;
  });
  return changed ? next : sessions;
}

/* ────────────────────────────────────────────────────────────────────
   ROUTINE IMPORT — paste-from-any-AI parser. Forgiving about text
   around the JSON, strict about the JSON's content once found.
   ──────────────────────────────────────────────────────────────────── */
const ROUTINE_IMPORT_PROMPT = `You will be given an image or written description of a college/school
class timetable. Convert it into STRICT JSON matching the exact schema
below. Output ONLY the JSON object — no explanation, no markdown code
fences, no text before or after it.

Schema:
{
  "subjects": [ { "code": string, "name": string } ],
  "teachers": [ { "code": string, "name": string } ],
  "timetable": [
    {
      "subject_code": string,
      "teacher_code": string or null,
      "weekday": string,
      "start_time": string,
      "end_time": string,
      "room": string or null,
      "repeats_every_weeks": number
    }
  ]
}

Rules:
- "weekday" must be exactly one of: Monday, Tuesday, Wednesday, Thursday,
  Friday, Saturday, Sunday.
- "start_time" and "end_time" must be 24-hour HH:MM, e.g. "17:00".
- "subject_code" in every timetable entry must match a "code" in
  "subjects". Same for "teacher_code" and "teachers".
- Every distinct subject abbreviation shown becomes one entry in
  "subjects". If only a full name is visible, invent a short 2-5 letter
  code from it.
- Every distinct teacher's initials/code shown becomes one entry in
  "teachers". If no teacher is shown for a slot, use null.
- Create ONE timetable entry per individual class slot. The same subject
  appearing on different days, or twice on the same day, is separate
  entries — do not merge or deduplicate them.
- "repeats_every_weeks" is 1 for a normal weekly class, 2 for something
  that only happens every other week, etc. Default to 1 if unclear.
- If a specific detail truly isn't legible, use null rather than
  guessing — do not invent data that isn't visibly there.
- Output ONLY the JSON object. Nothing else, in any form.
`;

const WEEKDAY_NAME_TO_NUM = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

function extractJsonObject(input) {
  const start = input.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < input.length; i++) {
    if (input[i] === '{') depth++;
    if (input[i] === '}') {
      depth--;
      if (depth === 0) return input.substring(start, i + 1);
    }
  }
  return null;
}

function parseTimeHHMM(raw) {
  if (raw == null) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function parseRoutineImport(rawInput) {
  const jsonText = extractJsonObject(rawInput);
  if (jsonText == null) {
    return { routine: null, errors: ["Couldn't find a JSON object in what was pasted. Make sure you copied the AI's full response, including the { and } braces."] };
  }
  let decoded;
  try {
    decoded = JSON.parse(jsonText);
  } catch (e) {
    return { routine: null, errors: [`That text isn't valid JSON (${e.message}). If the AI added any commentary around the JSON, try asking it to output ONLY the JSON object.`] };
  }

  const errors = [];
  const subjects = [];
  const subjectCodes = new Set();
  for (const raw of (decoded.subjects || [])) {
    const code = raw.code == null ? null : String(raw.code).trim();
    const name = raw.name == null ? null : String(raw.name).trim();
    if (!code || !name) { errors.push(`A subject is missing a code or name: ${JSON.stringify(raw)}`); continue; }
    subjects.push({ code, name });
    subjectCodes.add(code);
  }

  const teachers = [];
  const teacherCodes = new Set();
  for (const raw of (decoded.teachers || [])) {
    const code = raw.code == null ? null : String(raw.code).trim();
    const name = raw.name == null ? null : String(raw.name).trim();
    if (!code || !name) { errors.push(`A teacher is missing a code or name: ${JSON.stringify(raw)}`); continue; }
    teachers.push({ code, name });
    teacherCodes.add(code);
  }

  const timetable = [];
  const rawSlots = decoded.timetable || [];
  for (let i = 0; i < rawSlots.length; i++) {
    const map = rawSlots[i];
    const rowLabel = `Timetable entry ${i + 1}`;
    const subjectCode = map.subject_code == null ? null : String(map.subject_code).trim();
    if (!subjectCode) { errors.push(`${rowLabel}: missing subject_code.`); continue; }
    if (!subjectCodes.has(subjectCode)) { errors.push(`${rowLabel}: subject_code "${subjectCode}" isn't in the subjects list.`); continue; }

    let teacherCode = map.teacher_code == null ? null : String(map.teacher_code).trim();
    if (teacherCode && !teacherCodes.has(teacherCode)) {
      errors.push(`${rowLabel}: teacher_code "${teacherCode}" isn't in the teachers list.`); continue;
    }

    const weekdayRaw = map.weekday == null ? null : String(map.weekday).trim().toLowerCase();
    const weekday = weekdayRaw == null ? null : WEEKDAY_NAME_TO_NUM[weekdayRaw];
    if (!weekday) { errors.push(`${rowLabel}: weekday "${map.weekday}" isn't a recognized day name.`); continue; }

    const start = parseTimeHHMM(map.start_time);
    const end = parseTimeHHMM(map.end_time);
    if (start == null) { errors.push(`${rowLabel}: start_time "${map.start_time}" isn't HH:MM.`); continue; }
    if (end == null) { errors.push(`${rowLabel}: end_time "${map.end_time}" isn't HH:MM.`); continue; }
    if (end <= start) { errors.push(`${rowLabel}: end_time must be after start_time.`); continue; }

    const repeatsRaw = Number(map.repeats_every_weeks);
    const repeats = Number.isFinite(repeatsRaw) ? repeatsRaw : 1;

    timetable.push({
      subjectCode,
      teacherCode: teacherCode || null,
      weekday, startMinutes: start, endMinutes: end,
      room: map.room == null ? null : String(map.room).trim(),
      repeatsEveryWeeks: repeats < 1 ? 1 : repeats,
    });
  }

  if (subjects.length === 0 && timetable.length === 0) {
    errors.push('No usable subjects or timetable entries found. Check that the pasted JSON matches the expected schema.');
    return { routine: null, errors };
  }

  return { routine: { subjects, teachers, timetable }, errors };
}

/* ────────────────────────────────────────────────────────────────────
   THEME — Material 3 tonal palette seeded from 0xFF3D5AFE (indigo blue),
   same seed the Flutter app uses for ColorScheme.fromSeed. Light/dark
   switch off prefers-color-scheme, mirroring ThemeMode.system. Devices
   that support Material You get a wallpaper-derived scheme in the
   original app; this seed is exactly what that app falls back to
   everywhere else, so it's the correct 1:1 anchor here.
   ──────────────────────────────────────────────────────────────────── */
const THEME_CSS = `
.am-root, .am-root * { box-sizing: border-box; }
.am-root {
  --radius-card: 20px;
  --radius-md: 14px;
  --radius-sm: 10px;
  --radius-pill: 999px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  height: 100%;
  width: 100%;
  position: relative;
  overflow: hidden;
  isolation: isolate;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
.am-root input, .am-root textarea,
.am-root [data-selectable="true"], .am-root [data-selectable="true"] * {
  -webkit-user-select: text;
  user-select: text;
  -webkit-touch-callout: default;
}

/* ---- Neon (fixed dark theme — glow doesn't translate to a light
   background, so this app now runs one deliberate look rather than
   following system light/dark, same call Forge made) ---- */
.am-root {
  --md-primary: #3D8BFF;
  --md-on-primary: #04122E;
  --md-primary-container: #163A7C;
  --md-on-primary-container: #CFE1FF;
  --md-secondary: #FF3D9E;
  --md-on-secondary: #300019;
  --md-secondary-container: #6E1349;
  --md-on-secondary-container: #FFD3EC;
  --md-tertiary: #A85CFF;
  --md-on-tertiary: #23003F;
  --md-tertiary-container: #48227E;
  --md-on-tertiary-container: #E8D4FF;
  --md-error: #FF4D6D;
  --md-on-error: #2C0009;
  --md-error-container: #6B0F22;
  --md-on-error-container: #FFD7DE;
  --md-background: #07070F;
  --md-on-background: #EEEEFA;
  --md-surface: #07070F;
  --md-on-surface: #EEEEFA;
  --md-on-surface-soft: #9797C2;
  --md-outline: #46466E;
  --md-outline-variant: #23233C;
  --md-surface-lowest: #030308;
  --md-surface-low: #0C0C18;
  --md-surface-c: #12121F;
  --md-surface-high: #191930;
  --md-surface-highest: #232341;
  --status-green: #39E88A;
  --status-green-soft: #0E3626;
  --status-orange: #FFB020;
  --status-orange-soft: #3D2A09;
  --heat-zero: rgba(255,77,109,0.65);
  --accent-gradient: linear-gradient(135deg, #3D8BFF 0%, #B444FF 55%, #FF3D9E 100%);
  --glow-primary: 0 0 1px rgba(61,139,255,0.8), 0 4px 22px rgba(61,139,255,0.45);
  --glow-secondary: 0 0 1px rgba(255,61,158,0.8), 0 4px 22px rgba(255,61,158,0.4);
  --neu-light: rgba(255,255,255,0.035);
  --neu-dark: rgba(0,0,0,0.55);
  --neu-raised: 7px 7px 15px var(--neu-dark), -6px -6px 13px var(--neu-light);
  --neu-raised-sm: 4px 4px 9px var(--neu-dark), -3px -3px 8px var(--neu-light);
  --neu-inset: inset 5px 5px 10px var(--neu-dark), inset -4px -4px 9px var(--neu-light);
  --neu-inset-sm: inset 3px 3px 7px var(--neu-dark), inset -2px -2px 6px var(--neu-light);
  --shadow-1: 0 1px 3px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.5);
  --shadow-2: 0 8px 30px rgba(94,45,199,0.28), 0 2px 10px rgba(0,0,0,0.55);
  background: radial-gradient(120% 90% at 15% -10%, #14163a 0%, rgba(20,22,58,0) 55%), var(--md-background);
  color: var(--md-on-background);
}

.am-root {
  position: absolute; inset: 0;
  min-height: 100dvh; min-height: 100vh;
  overflow: hidden;
}
.am-shell {
  position:absolute;
  inset: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  display:flex; flex-direction:column;
  box-sizing:border-box;
}

.am-tab-content { flex:1; min-height:0; position:relative; overflow:hidden; }
.am-scroll-area { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; }
.am-screen { height:100%; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; padding-bottom: 96px; box-sizing:border-box; }
.am-screen.no-bottom-pad { padding-bottom: 24px; }

/* App bar */
.am-appbar {
  display:flex; align-items:center; gap:4px;
  padding: 14px 8px 14px 8px;
  background: var(--md-surface); position:sticky; top:0; z-index:5;
  border-bottom: 1px solid var(--md-outline-variant);
}
.am-appbar::after {
  content:''; position:absolute; left:0; right:0; bottom:-1px; height:1px;
  background: linear-gradient(90deg, rgba(61,139,255,0.55), rgba(180,68,255,0.4), rgba(255,61,158,0.55));
}
.am-appbar.elevated { box-shadow: var(--shadow-1); }
.am-appbar-title { font-size:20px; font-weight:600; letter-spacing:-0.2px; padding: 0 4px; flex:1; }
.am-appbar-actions { display:flex; align-items:center; gap:2px; }

/* Bottom nav */
.am-bottom-nav {
  display:flex; align-items:stretch; background: var(--md-surface-c);
  box-shadow: 0 -1px 0 var(--md-outline-variant);
  padding-bottom: 0;
  flex-shrink:0;
}
.am-nav-item {
  flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
  padding: 10px 4px 8px; background:none; border:none; cursor:pointer; color: var(--md-on-surface-soft);
  font-family: inherit; font-size: 12px; font-weight: 500; transition: color .15s ease;
}
.am-nav-item .nav-icon-wrap { padding: 2px 16px; border-radius: var(--radius-pill); transition: background .2s ease, transform .15s ease, box-shadow .2s ease; display:flex; }
.am-nav-item:active .nav-icon-wrap { transform: scale(0.88); }
.am-nav-item.active { color: var(--md-on-surface); }
.am-nav-item.active .nav-icon-wrap { background: var(--accent-gradient); color: #FFFFFF; box-shadow: var(--glow-primary); }

/* FAB */
.am-fab {
  will-change: transform;
  position:absolute; right:20px; bottom:20px; z-index:8;
  width:56px; height:56px; border-radius:16px; border:none; cursor:pointer;
  background: var(--accent-gradient); color: #FFFFFF;
  display:flex; align-items:center; justify-content:center; box-shadow: var(--shadow-2), var(--glow-primary);
  transition: transform .15s cubic-bezier(.3,.8,.4,1), box-shadow .15s ease;
}
.am-fab:active { transform: scale(0.92); box-shadow: var(--shadow-1); }
.am-fab-extended { width:auto; height:auto; border-radius:16px; padding:15px 22px; gap:10px; font-family:inherit; font-size:14.5px; font-weight:700; }

/* Cards & surfaces */
.am-card {
  will-change: transform;
  background: var(--md-surface-c); border-radius: var(--radius-card); padding:16px;
  box-shadow: var(--neu-raised);
  transition: transform .12s cubic-bezier(.3,.8,.4,1), box-shadow .12s ease;
}
.am-card.elevated { box-shadow: var(--neu-raised), var(--shadow-1); }
.am-card.outlined { background:transparent; box-shadow:none; border:1px solid var(--md-outline-variant); }
.am-card.clickable { cursor:pointer; }
.am-card.clickable:active { transform: scale(0.985); box-shadow: var(--neu-inset); }
.am-surface-high { background: var(--md-surface-high); }
.am-section-title { font-size:16.5px; font-weight:600; letter-spacing:0.15px; color: var(--md-on-surface); margin: 4px 4px 10px; }
.am-divider { height:1px; background: var(--md-outline-variant); border:none; margin: 8px 0; }

/* List tile */
.am-tile {
  will-change: transform;
  display:flex; align-items:center; gap:14px; padding:14px 16px; border-radius:18px; cursor:pointer;
  background: var(--md-surface-c); border:none; width:100%; text-align:left; font-family:inherit; color:inherit;
  box-shadow: var(--neu-raised-sm); margin-bottom:10px;
  transition: box-shadow .15s ease, transform .1s ease;
}
.am-tile:hover { transform: translateY(-1px); }
.am-tile:active { transform: scale(0.985); box-shadow: var(--neu-inset-sm); }
.am-tile-icon { width:40px; height:40px; border-radius:12px; display:flex; align-items:center; justify-content:center; flex-shrink:0; background: var(--md-secondary-container); color: var(--md-on-secondary-container); box-shadow: var(--neu-inset-sm); }
.am-tile-title { font-size:15px; font-weight:600; }
.am-tile-sub { font-size:12.5px; color: var(--md-on-surface-soft); margin-top:2px; }

/* Buttons */
.am-btn { font-family:inherit; font-size:14px; font-weight:600; border-radius: var(--radius-pill); padding:11px 22px; border:none; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:8px; white-space:nowrap; transition: filter .15s ease, transform .1s ease; }
.am-btn:active { filter:brightness(0.94); transform: scale(0.97); }
.am-btn:disabled { opacity:0.4; cursor:not-allowed; }
.am-btn-filled { background: var(--accent-gradient); color: #FFFFFF; box-shadow: var(--glow-primary); }
.am-btn-tonal { background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
.am-btn-outlined { background:transparent; color: var(--md-primary); border:1px solid var(--md-outline); }
.am-btn-text { background:transparent; color: var(--md-primary); padding:11px 14px; }
.am-btn-danger { background: var(--md-error-container); color: var(--md-on-error-container); }
.am-btn-block { width:100%; }
.am-btn-sm { padding:7px 14px; font-size:13px; }
.am-icon-btn { width:40px; height:40px; border-radius:50%; border:none; background:transparent; color: var(--md-on-surface); display:flex; align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; transition: background-color .15s ease, transform .1s ease; }
.am-icon-btn:hover { background: var(--md-surface-high); }
.am-icon-btn:active { transform: scale(0.9); background: var(--md-surface-high); }
.am-icon-btn.filled { background: var(--md-primary); color: var(--md-on-primary); }
.am-icon-btn.tonal { background: var(--md-secondary-container); color: var(--md-on-secondary-container); }

/* Chips */
.am-chip { display:inline-flex; align-items:center; gap:6px; padding:8px 16px; border-radius: var(--radius-pill); border:none; background: var(--md-surface-c); color: var(--md-on-surface); font-family:inherit; font-size:13.5px; font-weight:600; cursor:pointer; box-shadow: var(--neu-raised-sm); transition: background-color .15s ease, box-shadow .15s ease, transform .1s ease; }
.am-chip.selected { background: var(--accent-gradient); color: #FFFFFF; box-shadow: var(--glow-primary); }
.am-chip:active { transform: scale(0.95); box-shadow: var(--neu-inset-sm); }
.am-chip.sm { padding:5px 12px; font-size:12px; }
.status-chip { display:inline-flex; align-items:center; gap:6px; padding:9px 14px; border-radius:14px; border:none; background: var(--md-surface-c); font-family:inherit; font-size:13px; font-weight:700; cursor:pointer; flex:1; justify-content:center; color: var(--md-on-surface-soft); box-shadow: var(--neu-inset-sm); transition: background-color .15s ease, box-shadow .15s ease, transform .1s cubic-bezier(.3,.8,.4,1); }
.status-chip:active { transform: scale(0.93); }
.status-chip.present.active { background: var(--status-green-soft); color: var(--status-green); box-shadow: var(--neu-raised-sm); }
.status-chip.absent.active { background: var(--md-error-container); color: var(--md-error); box-shadow: var(--neu-raised-sm); }
.status-chip.excused.active { background: var(--status-orange-soft); color: var(--status-orange); box-shadow: var(--neu-raised-sm); }

/* Accessibility: visible focus ring for keyboard use, without adding one on mouse/touch taps */
.am-root button:focus-visible, .am-root [role="button"]:focus-visible, .am-root input:focus-visible, .am-root select:focus-visible, .am-root textarea:focus-visible {
  outline: 2.5px solid var(--md-primary); outline-offset: 2px;
}

/* Inputs */
.am-field { display:flex; flex-direction:column; gap:6px; margin-bottom:16px; }
.am-field-label { font-size:12.5px; font-weight:700; color: var(--md-on-surface-soft); padding-left:2px; }
.am-input, .am-textarea, .am-select {
  font-family:inherit; font-size:15px; padding:13px 14px; border-radius:14px;
  border:none; background: var(--md-surface-c); color: var(--md-on-surface); width:100%;
  box-shadow: var(--neu-inset-sm);
  transition: box-shadow .15s ease;
}
.am-input:focus, .am-textarea:focus, .am-select:focus { outline:none; box-shadow: var(--neu-inset-sm), 0 0 0 2px var(--md-primary); }
.am-textarea { resize:vertical; min-height:90px; line-height:1.5; }
.am-field-hint { font-size:12px; color: var(--md-on-surface-soft); padding-left:2px; }
.am-field-error { font-size:12px; color: var(--md-error); padding-left:2px; }

/* Switch */
.am-switch { position:relative; width:46px; height:26px; flex-shrink:0; }
.am-switch input { opacity:0; width:0; height:0; position:absolute; }
.am-switch-track { position:absolute; inset:0; background: var(--md-surface-c); box-shadow: var(--neu-inset-sm); border-radius:999px; cursor:pointer; transition: background-color .2s ease, box-shadow .2s ease; }
.am-switch input:checked + .am-switch-track { background: var(--md-primary); }
.am-switch-thumb { position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; transition: transform .2s ease; box-shadow: 0 1px 2px rgba(0,0,0,0.3); }
.am-switch input:checked ~ .am-switch-thumb { transform: translateX(20px); }

/* Slider */
.am-slider { width:100%; height:26px; -webkit-appearance:none; appearance:none; background:transparent; cursor:pointer; }
.am-slider::-webkit-slider-runnable-track { height:6px; border-radius:4px; background: var(--md-surface-c); box-shadow: var(--neu-inset-sm); }
.am-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; margin-top:-9px; width:23px; height:23px; border-radius:50%; background: var(--md-primary); border:3px solid var(--md-surface); box-shadow:0 1px 3px rgba(0,0,0,0.3); }
.am-slider::-moz-range-track { height:5px; border-radius:4px; background: var(--md-outline-variant); }
.am-slider::-moz-range-thumb { width:17px; height:17px; border:3px solid var(--md-surface); border-radius:50%; background: var(--md-primary); }

/* Sheets & dialogs */
.am-overlay { position:absolute; inset:0; background:rgba(0,0,0,0.45); z-index:20; animation: amFadeIn .18s ease; }
.am-sheet { position:absolute; left:0; right:0; bottom:0; max-height:88%; background: var(--md-surface-low); border-radius:24px 24px 0 0; z-index:21; display:flex; flex-direction:column; animation: amSheetUp .22s cubic-bezier(.2,.9,.3,1); box-shadow: 0 -4px 24px rgba(0,0,0,0.25); }
.am-sheet-handle { width:36px; height:4px; border-radius:4px; background: var(--md-outline-variant); margin:10px auto 4px; flex-shrink:0; }
.am-sheet-body { overflow-y:auto; padding: 8px 20px calc(24px + env(safe-area-inset-bottom,0px)); }
.am-dialog-wrap { position:absolute; inset:0; z-index:22; display:flex; align-items:center; justify-content:center; padding:24px; }
.am-dialog { background: var(--md-surface-high); border-radius:28px; padding:24px; max-width:400px; width:100%; box-shadow: var(--shadow-2); animation: amPopIn .18s ease; }
.am-dialog-title { font-size:18px; font-weight:700; margin-bottom:10px; }
.am-dialog-body { font-size:14px; color: var(--md-on-surface-soft); line-height:1.5; margin-bottom:20px; }
.am-dialog-actions { display:flex; justify-content:flex-end; gap:8px; }

/* Snackbar */
.am-snackbar-wrap { position:absolute; left:16px; right:16px; bottom:96px; z-index:30; display:flex; flex-direction:column; gap:8px; pointer-events:none; align-items:center; }
.am-snackbar { pointer-events:auto; background: var(--md-on-surface); color: var(--md-surface); padding:14px 18px; border-radius:14px; font-size:13.5px; font-weight:600; box-shadow: var(--shadow-2); max-width:480px; width:100%; animation: amToastIn .2s ease; }

/* Tabs */
.am-tabs { display:flex; gap:4px; padding:4px; background: var(--md-surface-high); border-radius:16px; margin-bottom:16px; }
.am-tab { flex:1; text-align:center; padding:9px 8px; border-radius:12px; font-size:13px; font-weight:700; border:none; cursor:pointer; background:transparent; color: var(--md-on-surface-soft); font-family:inherit; }
.am-tab.active { background: var(--md-surface-lowest); color: var(--md-primary); box-shadow: var(--shadow-1); }

/* Progress */
.am-progress-track { height:8px; border-radius:999px; background: var(--md-surface-c); box-shadow: var(--neu-inset-sm); overflow:hidden; }
.am-progress-fill { height:100%; border-radius:999px; background: var(--accent-gradient); transition: width .4s ease; }

/* Badge */
.am-badge { display:inline-flex; align-items:center; justify-content:center; min-width:20px; height:20px; padding:0 6px; border-radius:999px; background: var(--md-error); color: var(--md-on-error); font-size:11px; font-weight:700; }

/* Empty state */
.am-empty { display:flex; flex-direction:column; align-items:center; text-align:center; padding: 56px 32px; color: var(--md-on-surface-soft); gap:12px; }
.am-empty-icon { color: var(--md-outline); }

/* Utility */
.am-row { display:flex; align-items:center; }
.am-row-between { display:flex; align-items:center; justify-content:space-between; }
.am-col { display:flex; flex-direction:column; }
.am-grow { flex:1; }
.am-muted { color: var(--md-on-surface-soft); }
.am-center-text { text-align:center; }
.am-mono { font-variant-numeric: tabular-nums; }

@keyframes amFadeIn { from{opacity:0} to{opacity:1} }
@keyframes amSheetUp { from{ transform:translateY(24px); opacity:0.6 } to{ transform:translateY(0); opacity:1 } }
@keyframes amPopIn { from{ transform:scale(0.92); opacity:0 } to{ transform:scale(1); opacity:1 } }
@keyframes amToastIn { from{ transform:translateY(10px); opacity:0 } to{ transform:translateY(0); opacity:1 } }
@keyframes amFadeSlideUp { from{ opacity:0; transform:translateY(10px) } to{ opacity:1; transform:translateY(0) } }
@keyframes amIndeterminate { 0%{ transform:translateX(-100%) } 100%{ transform:translateX(350%) } }
@keyframes amScreenIn { from{ opacity:0; transform:translateX(18px) } to{ opacity:1; transform:translateX(0) } }
.am-screen-transition { animation: amScreenIn 220ms cubic-bezier(.25,.85,.35,1) backwards; height:100%; will-change: transform, opacity; }
.am-tab-pane { position:absolute; inset:0; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; transition: opacity 180ms cubic-bezier(.2,.7,.3,1); will-change: opacity; }
@keyframes amSpin { to { transform: rotate(360deg); } }
.am-spin { animation: amSpin 1s linear infinite; }

@media print {
  body * { visibility:hidden; }
  .am-print-area, .am-print-area * { visibility:visible; }
  .am-print-area { position:absolute; left:0; top:0; width:100%; }
}

@media (prefers-reduced-motion: reduce) {
  .am-root *, .am-root *::before, .am-root *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
`;

/* ────────────────────────────────────────────────────────────────────
   PERSISTENCE — one JSON blob per table, mirroring the Drift tables.
   Dates round-trip through JSON as ISO strings, so every load path
   revives them back into Date objects.
   ──────────────────────────────────────────────────────────────────── */
function reviveDates(obj, dateFields) {
  const copy = { ...obj };
  for (const f of dateFields) {
    if (copy[f]) copy[f] = new Date(copy[f]);
  }
  return copy;
}

function hydrate(raw) {
  return {
    subjects: raw.subjects || [],
    teachers: raw.teachers || [],
    timetableEntries: (raw.timetableEntries || []).map((e) => reviveDates(e, ['anchorDate', 'effectiveUntil'])),
    classSessions: (raw.classSessions || []).map((s) => reviveDates(s, ['date'])),
    attendanceRecords: (() => {
      const out = {};
      const src = raw.attendanceRecords || {};
      for (const k of Object.keys(src)) out[k] = reviveDates(src[k], ['markedAt']);
      return out;
    })(),
    holidays: (raw.holidays || []).map((h) => reviveDates(h, ['start', 'end'])),
    lectureNotes: (raw.lectureNotes || []).map((n) => reviveDates(n, ['createdAt', 'updatedAt'])),
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    reminderPrefs: { ...DEFAULT_REMINDER_PREFS, ...(raw.reminderPrefs || {}) },
  };
}

function loadAllFromStorage() {
  return hydrate({
    subjects: loadJSON(STORAGE_KEYS.subjects, []),
    teachers: loadJSON(STORAGE_KEYS.teachers, []),
    timetableEntries: loadJSON(STORAGE_KEYS.timetableEntries, []),
    classSessions: loadJSON(STORAGE_KEYS.classSessions, []),
    attendanceRecords: loadJSON(STORAGE_KEYS.attendanceRecords, {}),
    holidays: loadJSON(STORAGE_KEYS.holidays, []),
    lectureNotes: loadJSON(STORAGE_KEYS.lectureNotes, []),
    settings: loadJSON(STORAGE_KEYS.settings, {}),
    reminderPrefs: loadJSON(STORAGE_KEYS.reminderPrefs, {}),
  });
}

function colorForIndex(i) { return SUBJECT_PALETTE[i % SUBJECT_PALETTE.length]; }

/* ────────────────────────────────────────────────────────────────────
   DATA CONTEXT — global app state + actions, standing in for the
   Riverpod repositories/providers. One provider at the root; every
   screen reads via useAttendanceData().
   ──────────────────────────────────────────────────────────────────── */
const DataContext = createContext(null);
function useAttendanceData() {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useAttendanceData must be used inside DataProvider');
  return ctx;
}

function DataProvider({ children }) {
  const initial = useMemo(() => loadAllFromStorage(), []);
  const [subjects, setSubjects] = useState(initial.subjects);
  const [teachers, setTeachers] = useState(initial.teachers);
  const [timetableEntries, setTimetableEntries] = useState(initial.timetableEntries);
  const [classSessions, setClassSessions] = useState(initial.classSessions);
  const [attendanceRecords, setAttendanceRecords] = useState(initial.attendanceRecords);
  const [holidays, setHolidays] = useState(initial.holidays);
  const [lectureNotes, setLectureNotes] = useState(initial.lectureNotes);
  const [settings, setSettings] = useState(initial.settings);
  const [reminderPrefs, setReminderPrefs] = useState(initial.reminderPrefs);
  const [toasts, setToasts] = useState([]);

  useEffect(() => { saveJSON(STORAGE_KEYS.subjects, subjects); }, [subjects]);
  useEffect(() => { saveJSON(STORAGE_KEYS.teachers, teachers); }, [teachers]);
  useEffect(() => { saveJSON(STORAGE_KEYS.timetableEntries, timetableEntries); }, [timetableEntries]);
  useEffect(() => { saveJSON(STORAGE_KEYS.classSessions, classSessions); }, [classSessions]);
  useEffect(() => { saveJSON(STORAGE_KEYS.attendanceRecords, attendanceRecords); }, [attendanceRecords]);
  useEffect(() => { saveJSON(STORAGE_KEYS.holidays, holidays); }, [holidays]);
  useEffect(() => { saveJSON(STORAGE_KEYS.lectureNotes, lectureNotes); }, [lectureNotes]);
  useEffect(() => { saveJSON(STORAGE_KEYS.settings, settings); }, [settings]);
  useEffect(() => { saveJSON(STORAGE_KEYS.reminderPrefs, reminderPrefs); }, [reminderPrefs]);
  useEffect(() => {
    if (initial.reminderPrefs.enabled) syncReminderSchedule(initial.reminderPrefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = useCallback((message) => {
    const id = uid();
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2600);
  }, []);

  /* ---- Subjects ---- */
  const upsertSubject = useCallback((subject) => {
    setSubjects((prev) => {
      const idx = prev.findIndex((s) => s.id === subject.id);
      if (idx === -1) {
        const withId = { id: subject.id || uid(), colorValue: SUBJECT_PALETTE[prev.length % SUBJECT_PALETTE.length], customThreshold: null, isElective: false, archived: false, ...subject };
        return [...prev, withId];
      }
      const next = prev.slice();
      next[idx] = { ...next[idx], ...subject };
      return next;
    });
  }, []);
  const setSubjectArchived = useCallback((id, archived) => {
    setSubjects((prev) => prev.map((s) => (s.id === id ? { ...s, archived } : s)));
  }, []);

  /* ---- Teachers ---- */
  const upsertTeacher = useCallback((teacher) => {
    setTeachers((prev) => {
      const idx = prev.findIndex((t) => t.id === teacher.id);
      if (idx === -1) return [...prev, { id: teacher.id || uid(), notes: '', ...teacher }];
      const next = prev.slice();
      next[idx] = { ...next[idx], ...teacher };
      return next;
    });
  }, []);
  const deleteTeacher = useCallback((id) => {
    setTeachers((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /* ---- Timetable entries ---- */
  const upsertTimetableEntry = useCallback((entry) => {
    setTimetableEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id);
      if (idx === -1) {
        return [...prev, {
          id: entry.id || uid(), intervalWeeks: 1, anchorDate: startOfDay(new Date()),
          effectiveUntil: null, active: true, room: '', teacherId: null, ...entry,
        }];
      }
      const next = prev.slice();
      next[idx] = { ...next[idx], ...entry };
      return next;
    });
  }, []);
  const deleteTimetableEntry = useCallback((id) => {
    setTimetableEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  /* ---- Sessions & attendance ---- */
  const generateSessions = useCallback((horizonDays = 120) => {
    const horizon = addDays(startOfDay(new Date()), horizonDays);
    const created = generateSessionsFor(timetableEntries, holidays, classSessions, horizon);
    if (created.length) setClassSessions((prev) => [...prev, ...created]);
    return created.length;
  }, [timetableEntries, holidays, classSessions]);

  const reapplyHolidaysAction = useCallback(() => {
    const next = reapplyHolidays(classSessions, holidays);
    if (next !== classSessions) setClassSessions(next);
  }, [classSessions, holidays]);

  const markAttendance = useCallback((sessionId, status, note) => {
    setAttendanceRecords((prev) => {
      const next = { ...prev };
      if (status === AttendanceStatus.NOT_MARKED) {
        delete next[sessionId];
        return next;
      }
      const existing = prev[sessionId];
      next[sessionId] = {
        id: existing ? existing.id : uid(),
        sessionId, status, markedAt: new Date(),
        note: note !== undefined ? note : (existing ? existing.note : null),
      };
      return next;
    });
  }, []);

  const setSessionNote = useCallback((sessionId, note) => {
    setAttendanceRecords((prev) => {
      const existing = prev[sessionId];
      if (!existing) return prev;
      return { ...prev, [sessionId]: { ...existing, note } };
    });
  }, []);

  const rescheduleSession = useCallback((sessionId, newDate, newStartMinutes, newEndMinutes) => {
    setClassSessions((prev) => prev.map((s) => (s.id === sessionId
      ? { ...s, date: newDate, startMinutes: newStartMinutes, endMinutes: newEndMinutes, status: SessionStatus.RESCHEDULED }
      : s)));
  }, []);

  const cancelSession = useCallback((sessionId) => {
    setClassSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, status: SessionStatus.CANCELLED_OTHER } : s)));
  }, []);

  const restoreSession = useCallback((sessionId) => {
    setClassSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, status: SessionStatus.SCHEDULED } : s)));
  }, []);

  const deleteSession = useCallback((sessionId) => {
    setClassSessions((prev) => prev.filter((s) => s.id !== sessionId));
    setAttendanceRecords((prev) => { const next = { ...prev }; delete next[sessionId]; return next; });
  }, []);

  /* ---- Holidays ---- */
  const upsertHoliday = useCallback((holiday) => {
    setHolidays((prev) => {
      const idx = prev.findIndex((h) => h.id === holiday.id);
      if (idx === -1) return [...prev, { id: holiday.id || uid(), ...holiday }];
      const next = prev.slice();
      next[idx] = { ...next[idx], ...holiday };
      return next;
    });
  }, []);
  const deleteHoliday = useCallback((id) => setHolidays((prev) => prev.filter((h) => h.id !== id)), []);

  /* ---- Lecture notes ---- */
  const upsertNote = useCallback((note) => {
    setLectureNotes((prev) => {
      const idx = prev.findIndex((n) => n.id === note.id);
      const now = new Date();
      if (idx === -1) return [...prev, { id: note.id || uid(), sessionId: null, createdAt: now, updatedAt: now, ...note }];
      const next = prev.slice();
      next[idx] = { ...next[idx], ...note, updatedAt: now };
      return next;
    });
  }, []);
  const deleteNote = useCallback((id) => setLectureNotes((prev) => prev.filter((n) => n.id !== id)), []);

  /* ---- Settings ---- */
  const updateSettings = useCallback((patch) => setSettings((prev) => ({ ...prev, ...patch })), []);
  const updateReminderPrefs = useCallback((patch) => setReminderPrefs((prev) => ({ ...prev, ...patch })), []);

  /* ---- Routine import ---- */
  const importRoutine = useCallback((routine, clearExistingTimetable) => {
    let subjectsCreated = 0, subjectsReused = 0, teachersCreated = 0, teachersReused = 0, entriesCreated = 0;

    const nextSubjects = subjects.map((s) => ({ ...s }));
    const subjectIdByCode = {};
    for (const s of routine.subjects) {
      const existing = nextSubjects.find((x) => x.code === s.code);
      if (existing) {
        subjectIdByCode[s.code] = existing.id; subjectsReused++;
        if (existing.name !== s.name) existing.name = s.name;
      } else {
        const id = uid();
        nextSubjects.push({ id, name: s.name, code: s.code, colorValue: colorForIndex(nextSubjects.length), customThreshold: null, isElective: false, archived: false });
        subjectIdByCode[s.code] = id; subjectsCreated++;
      }
    }

    const nextTeachers = teachers.map((t) => ({ ...t }));
    const teacherIdByCode = {};
    for (const t of routine.teachers) {
      const existing = nextTeachers.find((x) => x.shortCode === t.code);
      if (existing) {
        teacherIdByCode[t.code] = existing.id; teachersReused++;
        if (existing.name !== t.name) existing.name = t.name;
      } else {
        const id = uid();
        nextTeachers.push({ id, name: t.name, shortCode: t.code, notes: '' });
        teacherIdByCode[t.code] = id; teachersCreated++;
      }
    }

    let nextEntries = clearExistingTimetable ? [] : timetableEntries.map((e) => ({ ...e }));
    const today = startOfDay(new Date());
    for (const slot of routine.timetable) {
      const subjectId = subjectIdByCode[slot.subjectCode];
      if (!subjectId) continue;
      const teacherId = slot.teacherCode ? teacherIdByCode[slot.teacherCode] : null;
      nextEntries.push({
        id: uid(), subjectId, teacherId: teacherId || null, weekday: slot.weekday,
        startMinutes: slot.startMinutes, endMinutes: slot.endMinutes, room: slot.room || '',
        intervalWeeks: slot.repeatsEveryWeeks, anchorDate: today, effectiveUntil: null, active: true,
      });
      entriesCreated++;
    }

    setSubjects(nextSubjects);
    setTeachers(nextTeachers);
    setTimetableEntries(nextEntries);

    return { subjectsCreated, subjectsReused, teachersCreated, teachersReused, timetableEntriesCreated: entriesCreated };
  }, [subjects, teachers, timetableEntries]);

  /* ---- Backup / restore ---- */
  const exportBackupJSON = useCallback(() => JSON.stringify({
    schemaVersion: 1, exportedAt: new Date().toISOString(),
    subjects, teachers, timetableEntries, classSessions, attendanceRecords, holidays, lectureNotes, settings, reminderPrefs,
  }, null, 2), [subjects, teachers, timetableEntries, classSessions, attendanceRecords, holidays, lectureNotes, settings, reminderPrefs]);

  const restoreFromBackupJSON = useCallback((text) => {
    const parsed = JSON.parse(text);
    const next = hydrate(parsed);
    setSubjects(next.subjects);
    setTeachers(next.teachers);
    setTimetableEntries(next.timetableEntries);
    setClassSessions(next.classSessions);
    setAttendanceRecords(next.attendanceRecords);
    setHolidays(next.holidays);
    setLectureNotes(next.lectureNotes);
    setSettings(next.settings);
    setReminderPrefs(next.reminderPrefs);
  }, []);

  const eraseAllData = useCallback(() => {
    setSubjects([]); setTeachers([]); setTimetableEntries([]); setClassSessions([]);
    setAttendanceRecords({}); setHolidays([]); setLectureNotes([]);
    setSettings(DEFAULT_SETTINGS); setReminderPrefs(DEFAULT_REMINDER_PREFS);
  }, []);

  /* ---- Derived lookups (cheap at this data scale — recompute per render) ---- */
  const subjectById = useMemo(() => Object.fromEntries(subjects.map((s) => [s.id, s])), [subjects]);
  const teacherById = useMemo(() => Object.fromEntries(teachers.map((t) => [t.id, t])), [teachers]);
  const activeSubjects = useMemo(() => subjects.filter((s) => !s.archived).sort((a, b) => a.name.localeCompare(b.name)), [subjects]);
  const activeTimetableEntries = useMemo(
    () => timetableEntries.filter((e) => e.active).sort((a, b) => (a.weekday - b.weekday) || (a.startMinutes - b.startMinutes)),
    [timetableEntries]
  );

  const value = {
    subjects, teachers, timetableEntries, classSessions, attendanceRecords, holidays, lectureNotes, settings, reminderPrefs,
    subjectById, teacherById, activeSubjects, activeTimetableEntries,
    upsertSubject, setSubjectArchived,
    upsertTeacher, deleteTeacher,
    upsertTimetableEntry, deleteTimetableEntry,
    generateSessions, reapplyHolidaysAction,
    markAttendance, setSessionNote, rescheduleSession, cancelSession, restoreSession, deleteSession,
    upsertHoliday, deleteHoliday,
    upsertNote, deleteNote,
    updateSettings, updateReminderPrefs,
    importRoutine,
    exportBackupJSON, restoreFromBackupJSON, eraseAllData,
    showToast,
  };

  return (
    <DataContext.Provider value={value}>
      {children}
      <div className="am-snackbar-wrap">
        {toasts.map((t) => <div className="am-snackbar" key={t.id}>{t.message}</div>)}
      </div>
    </DataContext.Provider>
  );
}

/* ────────────────────────────────────────────────────────────────────
   UI PRIMITIVES
   ──────────────────────────────────────────────────────────────────── */
function AppBar({ title, onBack, actions, elevated }) {
  return (
    <div className={`am-appbar${elevated ? ' elevated' : ''}`}>
      {onBack && (
        <button className="am-icon-btn" onClick={onBack} aria-label="Back"><ChevronLeft size={22} /></button>
      )}
      <div className="am-appbar-title" style={onBack ? undefined : { paddingLeft: 12 }}>{title}</div>
      <div className="am-appbar-actions">{actions}</div>
    </div>
  );
}

function Btn({ variant = 'filled', size, block, icon, onClick, disabled, children, type = 'button' }) {
  const cls = ['am-btn', `am-btn-${variant}`, size === 'sm' ? 'am-btn-sm' : '', block ? 'am-btn-block' : ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled}>
      {icon}{children}
    </button>
  );
}

function IconBtn({ onClick, children, variant, label, disabled }) {
  return (
    <button className={`am-icon-btn${variant ? ` ${variant}` : ''}`} onClick={onClick} aria-label={label} disabled={disabled}>
      {children}
    </button>
  );
}

function Card({ children, elevated, outlined, style, onClick }) {
  const cls = ['am-card', elevated ? 'elevated' : '', outlined ? 'outlined' : '', onClick ? 'clickable' : ''].filter(Boolean).join(' ');
  const interactiveProps = onClick ? {
    role: 'button', tabIndex: 0,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } },
  } : {};
  return <div className={cls} style={style} onClick={onClick} {...interactiveProps}>{children}</div>;
}

function SectionTitle({ children }) { return <div className="am-section-title">{children}</div>; }
function Divider() { return <hr className="am-divider" />; }

function Field({ label, hint, error, children }) {
  return (
    <div className="am-field">
      {label && <div className="am-field-label">{label}</div>}
      {children}
      {hint && !error && <div className="am-field-hint">{hint}</div>}
      {error && <div className="am-field-error">{error}</div>}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, type = 'text', autoFocus }) {
  return <input className="am-input" type={type} value={value} placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} />;
}

function TextArea({ value, onChange, placeholder, rows = 4 }) {
  return <textarea className="am-textarea" rows={rows} value={value} placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)} />;
}

function Select({ value, onChange, options, placeholder }) {
  return (
    <select className="am-select" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {placeholder && <option value="" disabled>{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function SwitchToggle({ checked, onChange }) {
  return (
    <label className="am-switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="am-switch-track" />
      <span className="am-switch-thumb" />
    </label>
  );
}

function SliderInput({ value, min, max, step = 1, onChange }) {
  return <input className="am-slider" type="range" min={min} max={max} step={step} value={value}
    onChange={(e) => onChange(Number(e.target.value))} />;
}

function Chip({ selected, onClick, children, sm }) {
  return <button type="button" className={`am-chip${selected ? ' selected' : ''}${sm ? ' sm' : ''}`} onClick={onClick}>{children}</button>;
}

function Row({ children, between, style, gap }) {
  return <div className={between ? 'am-row-between' : 'am-row'} style={{ gap: gap ?? 10, ...style }}>{children}</div>;
}
function Col({ children, style, gap }) {
  return <div className="am-col" style={{ gap: gap ?? 0, ...style }}>{children}</div>;
}

function EmptyState({ icon, title, subtitle }) {
  return (
    <div className="am-empty">
      <div className="am-empty-icon">{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--md-on-surface)' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 13 }}>{subtitle}</div>}
    </div>
  );
}

function ProgressBar({ value }) {
  return <div className="am-progress-track"><div className="am-progress-fill" style={{ width: `${clampInt(value * 100, 0, 100)}%` }} /></div>;
}

function Sheet({ open, onClose, title, children }) {
  useBackButtonLayer(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="am-overlay" onClick={onClose} />
      <div className="am-sheet" role="dialog">
        <div className="am-sheet-handle" />
        {title && (
          <div className="am-row-between" style={{ padding: '4px 20px 8px' }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
            <IconBtn onClick={onClose} label="Close"><X size={20} /></IconBtn>
          </div>
        )}
        <div className="am-sheet-body">{children}</div>
      </div>
    </>
  );
}

function AlertDialog({ open, title, body, okLabel = 'OK', onOk }) {
  useBackButtonLayer(open, onOk);
  if (!open) return null;
  return (
    <div className="am-dialog-wrap">
      <div className="am-overlay" onClick={onOk} />
      <div className="am-dialog">
        <div className="am-dialog-title">{title}</div>
        <div className="am-dialog-body">{body}</div>
        <div className="am-dialog-actions">
          <Btn variant="text" onClick={onOk}>{okLabel}</Btn>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', danger, onConfirm, onCancel }) {
  useBackButtonLayer(open, onCancel);
  if (!open) return null;
  return (
    <div className="am-dialog-wrap">
      <div className="am-overlay" onClick={onCancel} />
      <div className="am-dialog">
        <div className="am-dialog-title">{title}</div>
        <div className="am-dialog-body">{body}</div>
        <div className="am-dialog-actions">
          <Btn variant="text" onClick={onCancel}>Cancel</Btn>
          <Btn variant={danger ? 'danger' : 'filled'} onClick={onConfirm}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}

function Tabs({ tabs, active, onChange }) {
  return (
    <div className="am-tabs">
      {tabs.map((t) => (
        <button key={t.value} className={`am-tab${active === t.value ? ' active' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Loader({ size = 20 }) { return <Loader2 size={size} className="am-spin" />; }

/* ────────────────────────────────────────────────────────────────────
   SHARED FEATURE WIDGETS
   ──────────────────────────────────────────────────────────────────── */
function AttendanceRing({ percentage, target, size = 180, strokeWidth = 14 }) {
  const gradientId = useId();
  const [animated, setAnimated] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setAnimated(percentage ?? 0), 40);
    return () => clearTimeout(t);
  }, [percentage]);

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const cappedPct = clampInt(animated, 0, 1);
  const dash = circumference * cappedPct;
  const onTarget = percentage != null && percentage >= target;
  const strokeColor = percentage == null ? 'var(--md-outline-variant)' : (onTarget ? `url(#${gradientId})` : 'var(--md-error)');
  const glow = percentage == null ? 'none'
    : onTarget ? 'drop-shadow(0 0 7px rgba(61,139,255,0.55)) drop-shadow(0 0 11px rgba(255,61,158,0.35))'
    : 'drop-shadow(0 0 8px rgba(255,77,109,0.5))';

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', filter: glow, transition: 'filter 0.4s ease' }}>
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#3D8BFF" />
            <stop offset="55%" stopColor="#B444FF" />
            <stop offset="100%" stopColor="#FF3D9E" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--md-surface-highest)" strokeWidth={strokeWidth} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={strokeColor} strokeWidth={strokeWidth}
          strokeDasharray={`${dash} ${circumference}`} strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.9s cubic-bezier(.25,.85,.35,1), stroke 0.4s ease' }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: size * 0.19, fontWeight: 800, letterSpacing: -0.5 }}>{percentage == null ? '—' : `${Math.round(percentage * 100)}%`}</div>
        <div className="am-muted" style={{ fontSize: 12.5, fontWeight: 700, marginTop: 2 }}>Target {Math.round(target * 100)}%</div>
      </div>
    </div>
  );
}

function StaggeredFadeIn({ index = 0, children }) {
  const cappedIndex = Math.min(index, 12);
  const delay = cappedIndex * 30;
  const duration = 260 + delay;
  return <div style={{ animation: `amFadeSlideUp ${duration}ms ease backwards`, animationDelay: `${delay}ms` }}>{children}</div>;
}

function StatusChips({ status, onChange }) {
  const items = [
    { key: AttendanceStatus.PRESENT, label: 'Present', icon: CheckCircle2, cls: 'present' },
    { key: AttendanceStatus.ABSENT, label: 'Absent', icon: CircleX, cls: 'absent' },
    { key: AttendanceStatus.EXCUSED, label: 'Excused', icon: CalendarX2, cls: 'excused' },
  ];
  function handleClick(key) { haptic(HAPTIC.select); onChange(key); }
  return (
    <Row gap={8}>
      {items.map(({ key, label, icon: Icon, cls }) => (
        <button key={key} className={`status-chip ${cls}${status === key ? ' active' : ''}`} style={{ flexDirection: 'column', gap: 3, padding: '9px 4px' }} onClick={() => handleClick(key)}>
          <Icon size={17} />
          <span style={{ fontSize: 11.5 }}>{label}</span>
        </button>
      ))}
    </Row>
  );
}

// Direct port of shared/widgets/session_attendance_card.dart — used by both
// the Attendance Logging screen and the Calendar day sheet.
// Subject name paired with the teacher when one's set, instead of code
// paired with name (which often echoed the same text back, e.g. "PPM —
// PPM", when a subject's name and code happened to be identical).
function subjectTeacherLabel(subject, teacher, fallbackId) {
  if (!subject) return fallbackId;
  const teacherPart = teacher ? (teacher.shortCode || teacher.name) : null;
  return teacherPart ? `${subject.name} — ${teacherPart}` : subject.name;
}

function SessionCard({ session, subjectLabel, status, onMark, showDate }) {
  const dateLabel = showDate ? `${formatDate(session.date)} · ` : '';
  return (
    <Card style={{ margin: '6px 0' }}>
      <div style={{ fontWeight: 700, fontSize: 14.5 }}>{subjectLabel}</div>
      <div className="am-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
        {dateLabel}{formatMinutes(session.startMinutes)} – {formatMinutes(session.endMinutes)}
        {session.room ? ` · Room ${session.room}` : ''}
      </div>
      <div style={{ marginTop: 12 }}><StatusChips status={status} onChange={onMark} /></div>
    </Card>
  );
}

function heatColorForBucket(bucket) {
  if (!bucket || bucket.held === 0) return 'var(--md-surface-highest)';
  const pct = bucket.percentage;
  if (pct >= 1.0) return '#39E88A';
  if (pct >= 0.6) return '#1F8F5C';
  if (pct > 0) return '#FFB020';
  return 'var(--heat-zero)';
}

// Direct port of shared/widgets/attendance_heatmap.dart — grid spans from
// the Monday of the first logged day through the last logged day (not a
// fixed rolling window), one column per week.
function AttendanceHeatmapChart({ dailyBuckets, cellSize = 14 }) {
  if (dailyBuckets.length === 0) {
    return <div style={{ padding: 16, fontSize: 14 }} className="am-muted">No logged classes yet — nothing to show on the heatmap.</div>;
  }
  const byDay = {};
  for (const d of dailyBuckets) byDay[dateKey(d.day)] = d;
  const first = dailyBuckets[0].day;
  const start = mondayOf(first);
  const last = dailyBuckets[dailyBuckets.length - 1].day;
  const totalDays = Math.round((last - start) / 86400000) + 1;
  const totalWeeks = Math.ceil(totalDays / 7);

  return (
    <div style={{ overflowX: 'auto', padding: 4 }}>
      <div style={{ display: 'flex', width: 'max-content' }}>
        {Array.from({ length: totalWeeks }).map((_, week) => (
          <div key={week} style={{ display: 'flex', flexDirection: 'column', marginRight: 3 }}>
            {Array.from({ length: 7 }).map((_, weekday) => {
              const date = addDays(start, week * 7 + weekday);
              const bucket = byDay[dateKey(date)];
              const title = bucket ? `${date.getDate()}/${date.getMonth() + 1}: ${bucket.attended}/${bucket.held}` : `${date.getDate()}/${date.getMonth() + 1}: no class`;
              return (
                <div key={weekday} title={title} style={{
                  width: cellSize, height: cellSize, marginBottom: 3, borderRadius: 3,
                  background: heatColorForBucket(bucket),
                }} />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ color, label }) {
  return <Row gap={6}><div style={{ width: 12, height: 12, background: color, borderRadius: 2 }} /><span className="am-muted" style={{ fontSize: 12.5 }}>{label}</span></Row>;
}

/* ════════════════════════════════════════════════════════════════════
   SCREENS
   ════════════════════════════════════════════════════════════════════ */

/* ---- Dashboard ---- */
function DashboardScreen({ onOpenGamification }) {
  const { classSessions, attendanceRecords, settings } = useAttendanceData();
  const stats = useMemo(() => computeAggregate(classSessions, attendanceRecords, settings), [classSessions, attendanceRecords, settings]);
  const skip = useMemo(() => computeSafeSkips(stats), [stats]);
  const recovery = useMemo(() => computeRecoveryPlan(stats), [stats]);
  const gam = useMemo(() => computeGamification(classSessions, attendanceRecords, settings.targetThreshold), [classSessions, attendanceRecords, settings.targetThreshold]);

  const showRecovery = !stats.isAboveTarget && stats.totalHeld > 0;

  return (
    <div className="am-screen">
      <AppBar title="Attendance" />
      <div style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
          <AttendanceRing percentage={stats.currentPercentage} target={stats.targetThreshold} />
        </div>

        <Card onClick={onOpenGamification} style={{ marginBottom: 20 }}>
          <Row between>
            <Row gap={10}>
              <Flame size={20} color={gam.currentStreak > 0 ? '#FF7043' : 'var(--md-outline)'} />
              <span style={{ fontWeight: 700 }}>{gam.currentStreak} streak</span>
              <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--md-primary-container)', color: 'var(--md-on-primary-container)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, marginLeft: 10 }}>
                {gam.level}
              </div>
              <span style={{ fontWeight: 700 }}>Level {gam.level}</span>
            </Row>
            <ChevronRight size={18} />
          </Row>
        </Card>

        <Row gap={12} style={{ marginBottom: 20 }}>
          <Card style={{ flex: 1, textAlign: 'center', padding: '18px 8px' }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{stats.totalHeld}</div>
            <div className="am-muted" style={{ fontSize: 12.5 }}>Held</div>
          </Card>
          <Card style={{ flex: 1, textAlign: 'center', padding: '18px 8px' }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{stats.totalPresent}</div>
            <div className="am-muted" style={{ fontSize: 12.5 }}>Attended</div>
          </Card>
          <Card style={{ flex: 1, textAlign: 'center', padding: '18px 8px' }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{stats.totalRemaining}</div>
            <div className="am-muted" style={{ fontSize: 12.5 }}>Remaining</div>
          </Card>
        </Row>

        {showRecovery ? (
          <Card style={{ background: 'var(--md-error-container)', color: 'var(--md-on-error-container)', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Recovery Plan</div>
            <div style={{ lineHeight: 1.5, fontSize: 14 }}>
              {recovery.recoveryPossibleThisTerm
                ? `Attend your next ${recovery.consecutiveClassesToAttend} classes in a row (no more skips) to climb back to target.`
                : `Even attending every remaining class this term caps out at ${Math.round(recovery.bestPossiblePercentageIfAllRemainingAttended * 100)}% — full recovery isn't mathematically possible this term. Talk to your department about condonation/makeup options.`}
            </div>
          </Card>
        ) : (
          <Card style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Safe Skip Calculator</div>
            <div className="am-muted" style={{ lineHeight: 1.5, fontSize: 14 }}>
              {skip.remainingSessions === 0
                ? 'No classes remaining this term.'
                : `You can safely miss ${skip.maxSafeSkips} of your remaining ${skip.remainingSessions} classes and still finish at ${Math.round(skip.projectedPercentageIfMaxSkipsUsed * 100)}%.`}
            </div>
          </Card>
        )}

        <Card>
          <div style={{ fontStyle: 'italic', fontSize: 13.5, lineHeight: 1.5 }} className="am-muted">
            This is calculated in aggregate across every subject combined, matching how your college actually grades attendance — not as separate per-subject minimums.
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---- Attendance Logging ---- */
function AttendanceLoggingScreen() {
  const { classSessions, attendanceRecords, subjectById, teacherById, markAttendance } = useAttendanceData();

  const todaysSessions = useMemo(() => {
    const today = startOfDay(new Date());
    return classSessions
      .filter((s) => countsTowardTotals(s) && isSameDate(s.date, today))
      .slice()
      .sort((a, b) => a.startMinutes - b.startMinutes);
  }, [classSessions]);

  const needsMarking = useMemo(() => {
    const now = new Date();
    const past = classSessions
      .filter((s) => countsTowardTotals(s) && sessionStartDateTime(s) < now)
      .slice()
      .sort((a, b) => sessionStartDateTime(b) - sessionStartDateTime(a));
    const unmarked = past.filter((s) => {
      const r = attendanceRecords[s.id];
      return !r || r.status === AttendanceStatus.NOT_MARKED;
    });
    return unmarked.slice(0, 30);
  }, [classSessions, attendanceRecords]);

  function labelFor(item) {
    return subjectTeacherLabel(subjectById[item.subjectId], item.teacherId ? teacherById[item.teacherId] : null, item.subjectId);
  }

  return (
    <div className="am-screen">
      <AppBar title="Mark attendance" />
      <div style={{ padding: '8px 16px' }}>
        <SectionTitle>Today</SectionTitle>
        {todaysSessions.length === 0 ? (
          <div className="am-muted" style={{ padding: '4px 4px 20px', fontSize: 14 }}>No classes scheduled today.</div>
        ) : todaysSessions.map((item) => (
          <SessionCard key={item.id} session={item} subjectLabel={labelFor(item)}
            status={attendanceRecords[item.id] ? attendanceRecords[item.id].status : AttendanceStatus.NOT_MARKED}
            onMark={(status) => markAttendance(item.id, status)} />
        ))}

        <div style={{ height: 20 }} /><Divider /><div style={{ height: 8 }} />

        <SectionTitle>Needs marking (past, unlogged)</SectionTitle>
        {needsMarking.length === 0 ? (
          <div className="am-muted" style={{ padding: '4px 4px 20px', fontSize: 14 }}>Nothing outstanding — every past class is logged.</div>
        ) : needsMarking.map((item) => (
          <SessionCard key={item.id} session={item} subjectLabel={labelFor(item)}
            status={attendanceRecords[item.id] ? attendanceRecords[item.id].status : AttendanceStatus.NOT_MARKED}
            showDate onMark={(status) => markAttendance(item.id, status)} />
        ))}
      </div>
    </div>
  );
}

/* ---- Small popover menu (stand-in for PopupMenuButton) ---- */
function PopupMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <IconBtn onClick={() => setOpen((o) => !o)} label="More options"><MoreVertical size={20} /></IconBtn>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 42, zIndex: 15, background: 'var(--md-surface-high)',
          borderRadius: 14, boxShadow: 'var(--shadow-2)', minWidth: 150, padding: 6, animation: 'amPopIn .12s ease',
        }}>
          {items.map((it) => (
            <button key={it.label} onClick={() => { setOpen(false); it.onSelect(); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', borderRadius: 10,
                border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                color: it.danger ? 'var(--md-error)' : 'var(--md-on-surface)', cursor: 'pointer',
              }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Subjects ---- */
function SubjectsScreen({ onBack }) {
  const { activeSubjects, upsertSubject, setSubjectArchived } = useAttendanceData();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  function openEditor(subject) { setEditing(subject); setEditorOpen(true); }

  return (
    <div className="am-screen">
      <AppBar title="Subjects" onBack={onBack} />
      <div style={{ padding: '8px 8px' }}>
        {activeSubjects.length === 0 ? (
          <EmptyState icon={<BookOpen size={40} />} title="No subjects yet. Add your first one with the + button." />
        ) : activeSubjects.map((s, i) => (
          <StaggeredFadeIn index={i} key={s.id}>
            <div className="am-tile" role="button" tabIndex={0} onClick={() => openEditor(s)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(s); } }}>
              <div className="am-tile-icon" style={{ background: s.colorValue, color: '#fff' }}>
                {(s.code || '?').charAt(0)}
              </div>
              <div className="am-grow">
                <div className="am-tile-title">{s.name}</div>
                <div className="am-tile-sub">
                  {s.code}{s.customThreshold != null ? ` • custom target ${Math.round(s.customThreshold * 100)}%` : ''}
                </div>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <PopupMenu items={[
                  { label: 'Edit', onSelect: () => openEditor(s) },
                  { label: 'Archive', onSelect: () => { haptic(HAPTIC.warn); setSubjectArchived(s.id, true); } },
                ]} />
              </div>
            </div>
          </StaggeredFadeIn>
        ))}
      </div>
      <button className="am-fab" onClick={() => { haptic(HAPTIC.tap); openEditor(null); }} aria-label="Add subject"><Plus size={24} /></button>
      <SubjectEditorSheet open={editorOpen} onClose={() => setEditorOpen(false)} existing={editing} onSave={upsertSubject} />
    </div>
  );
}

function SubjectEditorSheet({ open, onClose, existing, onSave }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [color, setColor] = useState(SUBJECT_PALETTE[0]);

  useEffect(() => {
    if (open) {
      setName(existing ? existing.name : '');
      setCode(existing ? existing.code : '');
      setColor(existing ? existing.colorValue : SUBJECT_PALETTE[0]);
    }
  }, [open, existing]);

  const canSave = name.trim().length > 0 && code.trim().length > 0;
  function save() {
    haptic(HAPTIC.success);
    onSave({
      id: existing ? existing.id : uid(),
      name: name.trim(), code: code.trim().toUpperCase(), colorValue: color,
      customThreshold: existing ? existing.customThreshold : null,
      isElective: existing ? existing.isElective : false,
      archived: existing ? existing.archived : false,
    });
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={existing ? 'Edit subject' : 'Add subject'}>
      <Field label="Name"><TextInput value={name} onChange={setName} placeholder="e.g. Economics" /></Field>
      <Field label="Code"><TextInput value={code} onChange={(v) => setCode(v.toUpperCase())} placeholder="e.g. ECO" /></Field>
      <div className="am-field-label" style={{ marginBottom: 10 }}>Colour</div>
      <Row gap={12} style={{ marginBottom: 20, flexWrap: 'wrap' }}>
        {SUBJECT_PALETTE.map((c) => (
          <button key={c} onClick={() => setColor(c)} aria-label={c}
            style={{
              width: color === c ? 36 : 28, height: color === c ? 36 : 28, borderRadius: '50%', background: c,
              border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'transform .15s ease, width .15s ease, height .15s ease',
            }}>
            {color === c && <Check size={16} color="#fff" />}
          </button>
        ))}
      </Row>
      <Btn variant="filled" block disabled={!canSave} onClick={save}>Save</Btn>
    </Sheet>
  );
}

/* ---- Teachers ---- */
function TeachersScreen({ onBack }) {
  const { teachers, upsertTeacher, deleteTeacher } = useAttendanceData();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  function openEditor(t) { setEditing(t); setEditorOpen(true); }

  return (
    <div className="am-screen">
      <AppBar title="Teachers" onBack={onBack} />
      <div style={{ padding: '8px 8px' }}>
        {teachers.length === 0 ? (
          <EmptyState icon={<User size={40} />} title="No teachers yet. Tap + to add one." />
        ) : teachers.map((t, i) => (
          <StaggeredFadeIn index={i} key={t.id}>
          <div className="am-tile" role="button" tabIndex={0} onClick={() => openEditor(t)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(t); } }}>
            <div className="am-tile-icon">{t.shortCode}</div>
            <div className="am-grow">
              <div className="am-tile-title">{t.name}</div>
              {t.notes ? <div className="am-tile-sub">{t.notes}</div> : null}
            </div>
            <IconBtn label="Delete" onClick={(e) => { e.stopPropagation(); haptic(HAPTIC.warn); deleteTeacher(t.id); }}>
              <Trash2 size={18} />
            </IconBtn>
          </div>
          </StaggeredFadeIn>
        ))}
      </div>
      <button className="am-fab" onClick={() => { haptic(HAPTIC.tap); openEditor(null); }} aria-label="Add teacher"><Plus size={24} /></button>
      <TeacherEditorSheet open={editorOpen} onClose={() => setEditorOpen(false)} existing={editing} onSave={upsertTeacher} />
    </div>
  );
}

function TeacherEditorSheet({ open, onClose, existing, onSave }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (open) {
      setName(existing ? existing.name : '');
      setCode(existing ? existing.shortCode : '');
      setNotes(existing && existing.notes ? existing.notes : '');
    }
  }, [open, existing]);

  const canSave = name.trim().length > 0 && code.trim().length > 0;
  function save() {
    haptic(HAPTIC.success);
    onSave({
      id: existing ? existing.id : uid(),
      name: name.trim(), shortCode: code.trim().toUpperCase(),
      notes: notes.trim() === '' ? null : notes.trim(),
    });
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={existing ? 'Edit teacher' : 'Add teacher'}>
      <Field label="Full name"><TextInput value={name} onChange={setName} /></Field>
      <Field label="Timetable code (e.g. KC)"><TextInput value={code} onChange={(v) => setCode(v.toUpperCase())} /></Field>
      <Field label="Notes (optional)"><TextInput value={notes} onChange={setNotes} /></Field>
      <Btn variant="filled" block disabled={!canSave} onClick={save}>Save</Btn>
    </Sheet>
  );
}

/* ---- Timetable ---- */
function minutesToTimeValue(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
function timeValueToMinutes(v) { const [h, m] = v.split(':').map(Number); return h * 60 + m; }

function TimetableScreen() {
  const { activeTimetableEntries, subjectById, generateSessions } = useAttendanceData();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [genOpen, setGenOpen] = useState(false);

  const grouped = useMemo(() => {
    const g = {};
    for (const e of activeTimetableEntries) (g[e.weekday] || (g[e.weekday] = [])).push(e);
    return g;
  }, [activeTimetableEntries]);
  const days = Object.keys(grouped).map(Number).sort((a, b) => a - b);

  return (
    <div className="am-screen">
      <AppBar title="Timetable" actions={
        <IconBtn label="Generate sessions from these patterns" onClick={() => setGenOpen(true)}><Repeat size={20} /></IconBtn>
      } />
      <div style={{ padding: '0 8px' }}>
        {activeTimetableEntries.length === 0 ? (
          <EmptyState icon={<CalendarDays size={40} />} title="No recurring classes yet. Add your weekly pattern (subject, day, time) with the + button, then generate sessions from it." />
        ) : (
          <>
            {days.map((day) => (
              <div key={day}>
                <div style={{ padding: '16px 12px 4px' }}><SectionTitle>{WEEKDAY_NAMES[day]}</SectionTitle></div>
                {grouped[day].map((entry, i) => (
                  <StaggeredFadeIn index={i} key={entry.id}>
                    <TimetableTile entry={entry} subjectById={subjectById} onOpen={() => { setEditing(entry); setEditorOpen(true); }} />
                  </StaggeredFadeIn>
                ))}
              </div>
            ))}
            <div style={{ padding: 24, fontStyle: 'italic', textAlign: 'center', fontSize: 13.5 }} className="am-muted">
              After adding or editing patterns, tap the repeat icon above to generate actual dated classes from them — patterns alone don't create anything to log attendance against until you do.
            </div>
          </>
        )}
      </div>
      <button className="am-fab" onClick={() => { haptic(HAPTIC.tap); setEditing(null); setEditorOpen(true); }} aria-label="Add pattern"><Plus size={24} /></button>
      <TimetableEditorSheet open={editorOpen} onClose={() => setEditorOpen(false)} existing={editing} />
      <GenerateSessionsSheet open={genOpen} onClose={() => setGenOpen(false)} generateSessions={generateSessions} />
    </div>
  );
}

function TimetableTile({ entry, subjectById, onOpen }) {
  const { deleteTimetableEntry, teacherById } = useAttendanceData();
  const s = subjectById[entry.subjectId];
  const teacher = entry.teacherId ? teacherById[entry.teacherId] : null;
  const title = subjectTeacherLabel(s, teacher, entry.subjectId);
  return (
    <div className="am-tile" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
      <div className="am-tile-icon"><Clock size={19} /></div>
      <div className="am-grow">
        <div className="am-tile-title">{title}</div>
        <div className="am-tile-sub">
          {s ? `${s.code} • ` : ''}{formatMinutes(entry.startMinutes)} – {formatMinutes(entry.endMinutes)}
          {entry.room ? ` • Room ${entry.room}` : ''}
          {entry.intervalWeeks > 1 ? ` • every ${entry.intervalWeeks} weeks` : ''}
        </div>
      </div>
      <IconBtn label="Delete" onClick={(e) => { e.stopPropagation(); haptic(HAPTIC.warn); deleteTimetableEntry(entry.id); }}><Trash2 size={18} /></IconBtn>
    </div>
  );
}

function GenerateSessionsSheet({ open, onClose, generateSessions }) {
  const today = startOfDay(new Date());
  const defaultHorizon = addDays(today, 90);
  const [dateStr, setDateStr] = useState(dateKey(defaultHorizon));
  const { showToast } = useAttendanceData();

  useEffect(() => { if (open) setDateStr(dateKey(defaultHorizon)); }, [open]); // eslint-disable-line

  function confirm() {
    const horizon = parseDateKey(dateStr);
    const horizonDays = Math.round((horizon - today) / 86400000);
    const created = generateSessions(Math.max(horizonDays, 0));
    haptic(HAPTIC.success);
    showToast(`Generated ${created} new class session(s).`);
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title="Generate classes through which date?">
      <Field label="Horizon date">
        <input className="am-input" type="date" value={dateStr} min={dateKey(today)} max={dateKey(addDays(today, 365))}
          onChange={(e) => setDateStr(e.target.value)} />
      </Field>
      <Btn variant="filled" block onClick={confirm}>Generate</Btn>
    </Sheet>
  );
}

function TimetableEditorSheet({ open, onClose, existing }) {
  const { activeSubjects, teachers, upsertTimetableEntry } = useAttendanceData();
  const [subjectId, setSubjectId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [weekday, setWeekday] = useState(1);
  const [start, setStart] = useState('17:00');
  const [end, setEnd] = useState('18:00');
  const [room, setRoom] = useState('');
  const [intervalWeeks, setIntervalWeeks] = useState(1);

  useEffect(() => {
    if (!open) return;
    const e = existing;
    setSubjectId(e ? e.subjectId : (activeSubjects[0] ? activeSubjects[0].id : ''));
    setTeacherId(e && e.teacherId ? e.teacherId : '');
    setWeekday(e ? e.weekday : 1);
    setStart(e ? minutesToTimeValue(e.startMinutes) : '17:00');
    setEnd(e ? minutesToTimeValue(e.endMinutes) : '18:00');
    setRoom(e ? (e.room || '') : '');
    setIntervalWeeks(e ? e.intervalWeeks : 1);
  }, [open, existing]); // eslint-disable-line

  function save() {
    if (!subjectId) return;
    haptic(HAPTIC.success);
    upsertTimetableEntry({
      id: existing ? existing.id : uid(),
      subjectId, teacherId: teacherId || null, weekday,
      startMinutes: timeValueToMinutes(start), endMinutes: timeValueToMinutes(end),
      room: room.trim(), intervalWeeks,
      anchorDate: existing ? existing.anchorDate : startOfDay(new Date()),
      effectiveUntil: existing ? existing.effectiveUntil : null,
      active: true,
    });
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={existing ? 'Edit pattern' : 'Add class pattern'}>
      {activeSubjects.length === 0 ? (
        <div style={{ marginBottom: 16, fontSize: 14 }}>Add a subject first (Subjects tab) before building the timetable.</div>
      ) : (
        <Field label="Subject">
          <Select value={subjectId} onChange={setSubjectId} options={activeSubjects.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))} />
        </Field>
      )}
      <Field label="Teacher (optional)">
        <Select value={teacherId} onChange={setTeacherId} options={[{ value: '', label: '—' }, ...teachers.map((t) => ({ value: t.id, label: `${t.shortCode} — ${t.name}` }))]} />
      </Field>
      <Field label="Day of week">
        <Select value={weekday} onChange={(v) => setWeekday(Number(v))} options={[1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: d, label: WEEKDAY_NAMES[d] }))} />
      </Field>
      <Row gap={12}>
        <div style={{ flex: 1 }}><Field label="Start"><input className="am-input" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field></div>
        <div style={{ flex: 1 }}><Field label="End"><input className="am-input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field></div>
      </Row>
      <Field label="Room (optional)"><TextInput value={room} onChange={setRoom} /></Field>
      <Field label="Repeats every">
        <Select value={intervalWeeks} onChange={(v) => setIntervalWeeks(Number(v))} options={[
          { value: 1, label: 'Every week' }, { value: 2, label: 'Every 2 weeks (alternate)' },
          { value: 3, label: 'Every 3 weeks' }, { value: 4, label: 'Every 4 weeks' },
        ]} />
      </Field>
      <Btn variant="filled" block disabled={!subjectId} onClick={save}>Save</Btn>
    </Sheet>
  );
}

/* ---- Calendar ---- */
function statusDotColor(status) {
  if (status === AttendanceStatus.PRESENT) return 'var(--status-green)';
  if (status === AttendanceStatus.ABSENT) return 'var(--md-error)';
  if (status === AttendanceStatus.EXCUSED) return 'var(--status-orange)';
  return 'var(--md-outline)';
}

function CalendarScreen() {
  const { classSessions, attendanceRecords, subjectById, teacherById } = useAttendanceData();
  const today = startOfDay(new Date());
  const [focusedMonth, setFocusedMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(today);

  const byDay = useMemo(() => {
    const map = {};
    for (const s of classSessions) {
      const key = dateKey(s.date);
      const record = attendanceRecords[s.id];
      const status = record ? record.status : AttendanceStatus.NOT_MARKED;
      (map[key] || (map[key] = [])).push({ session: s, status });
    }
    for (const key of Object.keys(map)) map[key].sort((a, b) => a.session.startMinutes - b.session.startMinutes);
    return map;
  }, [classSessions, attendanceRecords]);

  const weeks = useMemo(() => {
    const firstOfMonth = focusedMonth;
    const gridStart = mondayOf(firstOfMonth);
    const lastOfMonth = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() + 1, 0);
    const gridEnd = addDays(mondayOf(lastOfMonth), 6);
    const rows = [];
    let cursor = gridStart;
    while (cursor <= gridEnd) {
      const row = [];
      for (let i = 0; i < 7; i++) { row.push(cursor); cursor = addDays(cursor, 1); }
      rows.push(row);
    }
    return rows;
  }, [focusedMonth]);

  function labelFor(session) {
    return subjectTeacherLabel(subjectById[session.subjectId], session.teacherId ? teacherById[session.teacherId] : null, session.subjectId);
  }
  const selectedItems = byDay[dateKey(selectedDay)] || [];
  const monthLabel = focusedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="am-screen no-bottom-pad" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar title="Calendar" />
      <div style={{ padding: '4px 16px 8px' }}>
        <Row between style={{ marginBottom: 8 }}>
          <IconBtn label="Previous month" onClick={() => setFocusedMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}><ChevronLeft size={20} /></IconBtn>
          <div style={{ fontWeight: 700, fontSize: 15.5 }}>{monthLabel}</div>
          <IconBtn label="Next month" onClick={() => setFocusedMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}><ChevronRight size={20} /></IconBtn>
        </Row>
        <Row style={{ marginBottom: 4 }}>
          {WEEKDAY_SHORT.map((d, i) => <div key={i} className="am-muted" style={{ flex: 1, textAlign: 'center', fontSize: 11.5, fontWeight: 700 }}>{d}</div>)}
        </Row>
        {weeks.map((row, ri) => (
          <Row key={ri} style={{ marginBottom: 2 }}>
            {row.map((day, di) => {
              const inMonth = day.getMonth() === focusedMonth.getMonth();
              const isToday = isSameDate(day, today);
              const isSelected = isSameDate(day, selectedDay);
              const events = byDay[dateKey(day)] || [];
              return (
                <div key={di} style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
                  <button onClick={() => setSelectedDay(day)} style={{
                    width: 38, height: 46, border: 'none', background: 'none', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '4px 0',
                  }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: isToday || isSelected ? 800 : 500,
                      color: !inMonth ? 'var(--md-outline)' : (isSelected ? 'var(--md-on-primary)' : 'var(--md-on-surface)'),
                      background: isSelected ? 'var(--md-primary)' : 'transparent',
                      border: isToday && !isSelected ? '1.5px solid var(--md-primary)' : 'none',
                    }}>
                      {day.getDate()}
                    </div>
                    <div style={{ display: 'flex', gap: 2, height: 5 }}>
                      {events.slice(0, 4).map((e, ei) => (
                        <div key={ei} style={{ width: 5, height: 5, borderRadius: '50%', background: statusDotColor(e.status) }} />
                      ))}
                    </div>
                  </button>
                </div>
              );
            })}
          </Row>
        ))}
      </div>
      <Divider />
      <div className="am-scroll-area" style={{ padding: '8px 16px' }}>
        {selectedItems.length === 0 ? (
          <div className="am-muted" style={{ textAlign: 'center', padding: 32 }}>No classes on this day.</div>
        ) : selectedItems.map((item) => (
          <SessionCardConnected key={item.session.id} session={item.session} subjectLabel={labelFor(item.session)} />
        ))}
      </div>
    </div>
  );
}

function SessionCardConnected({ session, subjectLabel, showDate }) {
  const { attendanceRecords, markAttendance } = useAttendanceData();
  const status = attendanceRecords[session.id] ? attendanceRecords[session.id].status : AttendanceStatus.NOT_MARKED;
  return <SessionCard session={session} subjectLabel={subjectLabel} status={status} showDate={showDate} onMark={(s) => markAttendance(session.id, s)} />;
}

/* ---- Lecture Notes ---- */
function NotesScreen({ onBack }) {
  const { lectureNotes, activeSubjects, subjectById, deleteNote, upsertNote } = useAttendanceData();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const sortedNotes = useMemo(() => lectureNotes.slice().sort((a, b) => b.updatedAt - a.updatedAt), [lectureNotes]);

  return (
    <div className="am-screen">
      <AppBar title="Lecture Notes" onBack={onBack} />
      <div style={{ padding: '8px 8px' }}>
        {activeSubjects.length === 0 ? (
          <EmptyState icon={<BookOpen size={40} />} title="Add a subject first (Subjects tab) before writing notes." />
        ) : sortedNotes.length === 0 ? (
          <EmptyState icon={<StickyNote size={40} />} title="No notes yet. Tap + to add one." />
        ) : sortedNotes.map((n) => {
          const s = subjectById[n.subjectId];
          return (
            <div className="am-tile" role="button" tabIndex={0} key={n.id} onClick={() => { setEditing(n); setEditorOpen(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(n); setEditorOpen(true); } }}>
              <div className="am-tile-icon" style={{ background: s ? s.colorValue : undefined, color: s ? '#fff' : undefined }}>
                {s && s.code ? s.code.charAt(0) : '?'}
              </div>
              <div className="am-grow">
                <div className="am-tile-title">{n.title}</div>
                <div className="am-tile-sub">{(s ? s.code : n.subjectId)} · {formatDate(n.updatedAt)}</div>
              </div>
              <IconBtn label="Delete" onClick={(e) => { e.stopPropagation(); haptic(HAPTIC.warn); deleteNote(n.id); }}><Trash2 size={18} /></IconBtn>
            </div>
          );
        })}
      </div>
      {activeSubjects.length > 0 && (
        <button className="am-fab" onClick={() => { haptic(HAPTIC.tap); setEditing(null); setEditorOpen(true); }} aria-label="Add note"><Plus size={24} /></button>
      )}
      <NoteEditorSheet open={editorOpen} onClose={() => setEditorOpen(false)} existing={editing} subjects={activeSubjects} onSave={upsertNote} />
    </div>
  );
}

function NoteEditorSheet({ open, onClose, existing, subjects, onSave }) {
  const [subjectId, setSubjectId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    if (!open) return;
    setSubjectId(existing ? existing.subjectId : (subjects[0] ? subjects[0].id : ''));
    setTitle(existing ? existing.title : '');
    setBody(existing ? existing.body : '');
  }, [open, existing]); // eslint-disable-line

  const canSave = title.trim().length > 0 && subjectId;
  function save() {
    haptic(HAPTIC.success);
    onSave({ id: existing ? existing.id : uid(), subjectId, title: title.trim(), body: body.trim() });
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={existing ? 'Edit note' : 'New note'}>
      <Field label="Subject"><Select value={subjectId} onChange={setSubjectId} options={subjects.map((s) => ({ value: s.id, label: s.code }))} /></Field>
      <Field label="Title"><TextInput value={title} onChange={setTitle} /></Field>
      <Field label="Notes"><TextArea value={body} onChange={setBody} rows={8} /></Field>
      <Btn variant="filled" block disabled={!canSave} onClick={save}>Save</Btn>
    </Sheet>
  );
}

/* ---- History ---- */
function HistoryScreen({ onBack }) {
  const { classSessions, attendanceRecords, subjects, subjectById, teacherById, activeSubjects, markAttendance } = useAttendanceData();
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);
  const [subjectIdFilter, setSubjectIdFilter] = useState('');

  const allHistory = useMemo(() => {
    const now = new Date();
    return classSessions
      .filter((s) => countsTowardTotals(s) && sessionStartDateTime(s) < now)
      .slice()
      .sort((a, b) => sessionStartDateTime(b) - sessionStartDateTime(a))
      .map((s) => {
        const r = attendanceRecords[s.id];
        return { session: s, status: r ? r.status : AttendanceStatus.NOT_MARKED };
      });
  }, [classSessions, attendanceRecords]);

  const filtered = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return allHistory.filter((item) => {
      if (statusFilter && item.status !== statusFilter) return false;
      if (subjectIdFilter && item.session.subjectId !== subjectIdFilter) return false;
      if (needle) {
        const subj = subjectById[item.session.subjectId];
        const haystack = `${subj ? subj.name : ''} ${subj ? subj.code : ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [allHistory, statusFilter, subjectIdFilter, searchText, subjectById]);

  return (
    <div className="am-screen">
      <AppBar title="History" onBack={onBack} />
      <div style={{ padding: '10px 16px 6px' }}>
        <div style={{ position: 'relative' }}>
          <Search size={17} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--md-on-surface-soft)' }} />
          <input className="am-input" style={{ paddingLeft: 40, borderRadius: 24 }} placeholder="Search by subject"
            value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', overflowX: 'auto' }}>
        <Chip sm selected={!statusFilter} onClick={() => setStatusFilter(null)}>All</Chip>
        <Chip sm selected={statusFilter === AttendanceStatus.PRESENT} onClick={() => setStatusFilter(AttendanceStatus.PRESENT)}>Present</Chip>
        <Chip sm selected={statusFilter === AttendanceStatus.ABSENT} onClick={() => setStatusFilter(AttendanceStatus.ABSENT)}>Absent</Chip>
        <Chip sm selected={statusFilter === AttendanceStatus.EXCUSED} onClick={() => setStatusFilter(AttendanceStatus.EXCUSED)}>Excused</Chip>
        {activeSubjects.length > 0 && (
          <select className="am-select" style={{ width: 'auto', padding: '5px 10px', fontSize: 12.5 }} value={subjectIdFilter} onChange={(e) => setSubjectIdFilter(e.target.value)}>
            <option value="">All subjects</option>
            {activeSubjects.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
          </select>
        )}
      </div>
      <div style={{ padding: '8px 16px 4px' }}><Divider /></div>
      <div style={{ padding: '4px 16px 20px' }}>
        {filtered.length === 0 ? (
          <div className="am-muted" style={{ textAlign: 'center', padding: 32 }}>No matching classes.</div>
        ) : filtered.map((item, i) => {
          const subject = subjectById[item.session.subjectId];
          const teacher = item.session.teacherId ? teacherById[item.session.teacherId] : null;
          const label = subjectTeacherLabel(subject, teacher, item.session.subjectId);
          return (
            <StaggeredFadeIn index={i} key={item.session.id}>
              <SessionCard session={item.session} subjectLabel={label} status={item.status} showDate
                onMark={(status) => markAttendance(item.session.id, status)} />
            </StaggeredFadeIn>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Attendance Calculator (scratch-pad, independent of real data) ---- */
function AttendanceCalculatorScreen({ onBack }) {
  const { settings } = useAttendanceData();
  const [heldStr, setHeldStr] = useState('0');
  const [attendedStr, setAttendedStr] = useState('0');
  const [remainingStr, setRemainingStr] = useState('0');
  const [target, setTarget] = useState(settings.targetThreshold);

  const held = Math.max(0, parseInt(heldStr, 10) || 0);
  const attendedRaw = Math.max(0, parseInt(attendedStr, 10) || 0);
  const attended = clampInt(attendedRaw, 0, held === 0 ? Number.MAX_SAFE_INTEGER : held);
  const remaining = Math.max(0, parseInt(remainingStr, 10) || 0);

  const stats = useMemo(() => {
    const currentPercentage = held === 0 ? null : attended / held;
    return {
      totalHeld: held, totalPresent: attended, totalAbsent: held - attended, totalExcused: 0,
      totalRemaining: remaining, targetThreshold: target, currentPercentage,
      isAboveTarget: currentPercentage === null ? true : currentPercentage >= target,
    };
  }, [held, attended, remaining, target]);
  const skip = useMemo(() => computeSafeSkips(stats), [stats]);
  const recovery = useMemo(() => computeRecoveryPlan(stats), [stats]);

  return (
    <div className="am-screen">
      <AppBar title="Attendance Calculator" onBack={onBack} />
      <div style={{ padding: 20 }}>
        <Row gap={12}>
          <div style={{ flex: 1 }}><Field label="Classes held"><input className="am-input" type="number" inputMode="numeric" value={heldStr} onChange={(e) => setHeldStr(e.target.value)} /></Field></div>
          <div style={{ flex: 1 }}><Field label="Classes attended"><input className="am-input" type="number" inputMode="numeric" value={attendedStr} onChange={(e) => setAttendedStr(e.target.value)} /></Field></div>
        </Row>
        <Field label="Classes remaining this term (for skip/recovery math)">
          <input className="am-input" type="number" inputMode="numeric" value={remainingStr} onChange={(e) => setRemainingStr(e.target.value)} />
        </Field>

        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Target: {Math.round(target * 100)}%</div>
        <SliderInput value={target} min={0.4} max={0.9} step={0.01} onChange={setTarget} />

        <Card style={{ marginTop: 16 }}>
          <div style={{ fontSize: 30, fontWeight: 800 }}>
            {stats.currentPercentage == null ? 'Enter classes held to see a percentage.' : `${(stats.currentPercentage * 100).toFixed(1)}%`}
          </div>
          <div style={{ fontWeight: 700, marginTop: 4, color: stats.isAboveTarget ? 'var(--status-green)' : 'var(--md-error)' }}>
            {stats.isAboveTarget ? 'At or above target' : 'Below target'}
          </div>
        </Card>

        {remaining > 0 && (
          <>
            <Card style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Safe Skip</div>
              <div className="am-muted" style={{ fontSize: 14 }}>
                You can miss {skip.maxSafeSkips} of the next {remaining} and still finish at {Math.round(skip.projectedPercentageIfMaxSkipsUsed * 100)}%.
              </div>
            </Card>
            {!recovery.alreadyOnTarget && (
              <Card style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Recovery</div>
                <div className="am-muted" style={{ fontSize: 14 }}>
                  {recovery.recoveryPossibleThisTerm
                    ? `Attend the next ${recovery.consecutiveClassesToAttend} in a row to reach target.`
                    : `Not recoverable this term — best case is ${Math.round(recovery.bestPossiblePercentageIfAllRemainingAttended * 100)}% even attending everything left.`}
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---- Simulator / Predictor (uses REAL current stats) ---- */
function AttendanceSimulatorScreen({ onBack }) {
  const { classSessions, attendanceRecords, settings } = useAttendanceData();
  const stats = useMemo(() => computeAggregate(classSessions, attendanceRecords, settings), [classSessions, attendanceRecords, settings]);
  const [futureAttend, setFutureAttend] = useState(null);

  useEffect(() => { if (futureAttend === null && stats.totalRemaining >= 0) setFutureAttend(stats.totalRemaining); }, [stats.totalRemaining]); // eslint-disable-line

  if (stats.totalRemaining === 0) {
    return (
      <div className="am-screen">
        <AppBar title="Simulator" onBack={onBack} />
        <div style={{ padding: 32, textAlign: 'center' }} className="am-muted">
          No remaining classes this term — nothing left to simulate. Generate more sessions from the Timetable tab if your term isn't actually over.
        </div>
      </div>
    );
  }

  const attend = futureAttend === null ? stats.totalRemaining : futureAttend;
  const projected = simulateFinalPercentage(stats, attend);
  const skipped = stats.totalRemaining - attend;
  const meetsTarget = projected >= stats.targetThreshold;
  const skip = computeSafeSkips(stats);

  return (
    <div className="am-screen">
      <AppBar title="Simulator" onBack={onBack} />
      <div style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}><AttendanceRing percentage={projected} target={stats.targetThreshold} size={200} /></div>
        <div style={{ textAlign: 'center', fontWeight: 700, marginTop: 8, color: meetsTarget ? 'var(--status-green)' : 'var(--md-error)' }}>
          {meetsTarget ? 'Meets target' : 'Below target'}
        </div>

        <div style={{ marginTop: 24, fontSize: 14 }}>
          If you attend {attend} of your remaining {stats.totalRemaining} classes (skipping {skipped}):
        </div>
        <SliderInput value={attend} min={0} max={stats.totalRemaining} step={1} onChange={setFutureAttend} />
        <Row between style={{ fontSize: 12 }} className="am-muted">
          <span>Skip all ({skipped} skips)</span>
          <span>Attend all</span>
        </Row>

        <Row gap={8} style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <Chip onClick={() => setFutureAttend(stats.totalRemaining)}>Attend all remaining</Chip>
          <Chip onClick={() => setFutureAttend(skip.mustAttend)}>Minimum to hit target</Chip>
          <Chip onClick={() => setFutureAttend(0)}>Skip all remaining</Chip>
        </Row>

        <Card style={{ marginTop: 20 }}>
          <div style={{ fontStyle: 'italic', fontSize: 13.5, lineHeight: 1.5 }} className="am-muted">
            Right now: {stats.totalPresent}/{stats.totalHeld} held ({stats.currentPercentage == null ? '—' : `${(stats.currentPercentage * 100).toFixed(1)}%`}). This slider only projects the remaining {stats.totalRemaining} — it never changes anything you've already logged.
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---- Analytics (Weekly / Monthly / Semester / Heatmap) ---- */
function computeAnalyticsData(sessions, recordsBySessionId, asOf) {
  const now = asOf || new Date();
  const past = sessions
    .filter((s) => countsTowardTotals(s) && !(sessionStartDateTime(s) > now))
    .slice()
    .sort((a, b) => sessionStartDateTime(a) - sessionStartDateTime(b));

  const dayMap = new Map(), weekMap = new Map();
  for (const s of past) {
    const dk = dateKey(s.date);
    if (!dayMap.has(dk)) dayMap.set(dk, []);
    dayMap.get(dk).push(s);
    const wk = dateKey(mondayOf(s.date));
    if (!weekMap.has(wk)) weekMap.set(wk, []);
    weekMap.get(wk).push(s);
  }
  function attendedCount(arr) {
    return arr.filter((s) => { const r = recordsBySessionId[s.id]; return r && r.status === AttendanceStatus.PRESENT; }).length;
  }

  const dailyBuckets = Array.from(dayMap.entries())
    .map(([dk, arr]) => { const held = arr.length, attended = attendedCount(arr); return { day: parseDateKey(dk), held, attended, percentage: held === 0 ? null : attended / held }; })
    .sort((a, b) => a.day - b.day);

  const weeklyBuckets = Array.from(weekMap.entries())
    .map(([wk, arr]) => { const held = arr.length, attended = attendedCount(arr); return { weekStart: parseDateKey(wk), held, attended, percentage: held === 0 ? null : attended / held }; })
    .sort((a, b) => a.weekStart - b.weekStart);

  const semesterTrend = [];
  let runningHeld = 0, runningPresent = 0;
  for (const s of past) {
    runningHeld++;
    const r = recordsBySessionId[s.id];
    if (r && r.status === AttendanceStatus.PRESENT) runningPresent++;
    semesterTrend.push({ date: sessionStartDateTime(s), cumulativePercentage: runningPresent / runningHeld });
  }

  return { dailyBuckets, weeklyBuckets, semesterTrend };
}
function daysInMonthOf(dailyBuckets, year, month) { return dailyBuckets.filter((d) => d.day.getFullYear() === year && d.day.getMonth() === month); }
function daysInWeekOf(dailyBuckets, weekStart) { const end = addDays(weekStart, 6); return dailyBuckets.filter((d) => d.day >= weekStart && d.day <= end); }

function AnalyticsScreen({ onBack }) {
  const { classSessions, attendanceRecords, settings } = useAttendanceData();
  const data = useMemo(() => computeAnalyticsData(classSessions, attendanceRecords), [classSessions, attendanceRecords]);
  const [tab, setTab] = useState('weekly');

  return (
    <div className="am-screen">
      <AppBar title="Analytics" onBack={onBack} />
      <div style={{ padding: '10px 16px 0' }}>
        <Tabs tabs={[{ value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'semester', label: 'Semester' }, { value: 'heatmap', label: 'Heatmap' }]} active={tab} onChange={setTab} />
      </div>
      <div style={{ padding: '0 16px 20px' }}>
        {tab === 'weekly' && <WeeklyTab data={data} />}
        {tab === 'monthly' && <MonthlyTab data={data} />}
        {tab === 'semester' && <SemesterTab data={data} target={settings.targetThreshold} />}
        {tab === 'heatmap' && <HeatmapTab data={data} />}
      </div>
    </div>
  );
}

function WeeklyTab({ data }) {
  const today = startOfDay(new Date());
  const currentWeekStart = mondayOf(today);
  const days = daysInWeekOf(data.dailyBuckets, currentWeekStart);
  if (data.dailyBuckets.length === 0) return <div className="am-muted" style={{ textAlign: 'center', padding: 40 }}>No logged classes yet.</div>;

  const held = days.reduce((a, d) => a + d.held, 0);
  const attended = days.reduce((a, d) => a + d.attended, 0);
  const chartData = days.map((d) => ({ label: WEEKDAY_SHORT[isoWeekday(d.day) - 1], held: d.held, attended: d.attended }));

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 16, marginTop: 16 }}>This week ({formatDate(currentWeekStart)} onward)</div>
      <div className="am-muted" style={{ fontSize: 14, marginTop: 4, marginBottom: 16 }}>
        {held === 0 ? 'No classes logged yet this week.' : `${attended} / ${held} held (${Math.round((attended / held) * 100)}%)`}
      </div>
      {days.length > 0 && (
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'var(--md-on-surface-soft)' }} />
              <YAxis axisLine={false} tickLine={false} width={26} tick={{ fontSize: 11, fill: 'var(--md-on-surface-soft)' }} allowDecimals={false} />
              <Bar dataKey="held" fill="#3A3A5E" radius={[3, 3, 0, 0]} maxBarSize={16} />
              <Bar dataKey="attended" fill="var(--md-primary)" radius={[3, 3, 0, 0]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <Row gap={16} style={{ justifyContent: 'center', marginTop: 12 }}>
        <Legend color="var(--md-primary)" label="Attended" />
        <Legend color="#3A3A5E" label="Held" />
      </Row>
    </div>
  );
}

function MonthlyTab({ data }) {
  const now = new Date();
  const monthDays = daysInMonthOf(data.dailyBuckets, now.getFullYear(), now.getMonth());
  if (monthDays.length === 0) return <div className="am-muted" style={{ textAlign: 'center', padding: 40 }}>No logged classes this month.</div>;

  const byWeek = new Map();
  for (const d of monthDays) {
    const wk = dateKey(mondayOf(d.day));
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(d);
  }
  const weekKeys = Array.from(byWeek.keys()).sort();
  const held = monthDays.reduce((a, d) => a + d.held, 0);
  const attended = monthDays.reduce((a, d) => a + d.attended, 0);
  const chartData = weekKeys.map((wk, i) => {
    const bucket = byWeek.get(wk);
    const h = bucket.reduce((a, d) => a + d.held, 0);
    const a = bucket.reduce((acc, d) => acc + d.attended, 0);
    return { label: `W${i + 1}`, pct: h === 0 ? 0 : (a / h) * 100 };
  });

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 16, marginTop: 16 }}>This month</div>
      <div className="am-muted" style={{ fontSize: 14, marginTop: 4, marginBottom: 16 }}>
        {attended} / {held} held ({held === 0 ? '—' : `${Math.round((attended / held) * 100)}%`})
      </div>
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'var(--md-on-surface-soft)' }} />
            <YAxis domain={[0, 100]} axisLine={false} tickLine={false} width={32} tick={{ fontSize: 11, fill: 'var(--md-on-surface-soft)' }} />
            <Bar dataKey="pct" fill="var(--md-primary)" radius={[4, 4, 0, 0]} maxBarSize={26} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="am-muted" style={{ fontStyle: 'italic', fontSize: 12.5, marginTop: 8 }}>Bars show % attended per week of the month.</div>
    </div>
  );
}

function SemesterTab({ data, target }) {
  if (data.semesterTrend.length === 0) return <div className="am-muted" style={{ textAlign: 'center', padding: 40 }}>No logged classes yet.</div>;
  const chartData = data.semesterTrend.map((t, i) => ({ x: i, pct: t.cumulativePercentage * 100 }));
  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 16, marginTop: 16 }}>Running attendance % across the whole term</div>
      <div className="am-muted" style={{ fontSize: 13, marginTop: 4, marginBottom: 16, lineHeight: 1.45 }}>
        Each point is your cumulative % right after that class — this is exactly the number that determines exam eligibility at any given moment, not just today.
      </div>
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <YAxis domain={[0, 100]} axisLine={false} tickLine={false} width={32} tick={{ fontSize: 11, fill: 'var(--md-on-surface-soft)' }} />
            <XAxis dataKey="x" hide />
            <Area type="linear" dataKey="pct" stroke="var(--md-primary)" strokeWidth={2} fill="var(--md-primary)" fillOpacity={0.15} dot={false} />
            <ReferenceLine y={target * 100} stroke="var(--md-error)" strokeDasharray="6 4" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="am-muted" style={{ fontStyle: 'italic', fontSize: 12.5, marginTop: 8 }}>Dashed line marks your target threshold.</div>
    </div>
  );
}

function HeatmapTab({ data }) {
  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 16, marginTop: 16, marginBottom: 14 }}>Every logged day, term to date</div>
      <AttendanceHeatmapChart dailyBuckets={data.dailyBuckets} />
      <Row gap={14} style={{ marginTop: 16, flexWrap: 'wrap' }}>
        <Legend color="#39E88A" label="100%" />
        <Legend color="#1F8F5C" label="≥60%" />
        <Legend color="#FFB020" label="<60%" />
        <Legend color="var(--heat-zero)" label="0%" />
      </Row>
    </div>
  );
}

/* ---- Gamification / Progress ---- */
function GamificationScreen({ onBack }) {
  const { classSessions, attendanceRecords, settings } = useAttendanceData();
  const stats = useMemo(() => computeGamification(classSessions, attendanceRecords, settings.targetThreshold), [classSessions, attendanceRecords, settings.targetThreshold]);
  const unlocked = useMemo(() => new Set(ACHIEVEMENTS.filter((a) => a.isUnlocked(stats)).map((a) => a.id)), [stats]);
  const [progressWidth, setProgressWidth] = useState(0);
  useEffect(() => { const t = setTimeout(() => setProgressWidth(stats.levelProgress), 40); return () => clearTimeout(t); }, [stats.levelProgress]);

  return (
    <div className="am-screen">
      <AppBar title="Progress" onBack={onBack} />
      <div style={{ padding: 20 }}>
        <Card>
          <Row gap={16}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--md-primary-container)', color: 'var(--md-on-primary-container)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 800, flexShrink: 0 }}>
              {stats.level}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Level {stats.level}</div>
              <div className="am-muted" style={{ fontSize: 13 }}>{stats.totalXp} XP total</div>
            </div>
          </Row>
          <div style={{ marginTop: 16 }}>
            <div className="am-progress-track"><div className="am-progress-fill" style={{ width: `${clampInt(progressWidth, 0, 1) * 100}%`, transition: 'width 0.6s cubic-bezier(.2,.7,.3,1)' }} /></div>
          </div>
          <div className="am-muted" style={{ fontSize: 12.5, marginTop: 6 }}>{stats.xpIntoCurrentLevel} / {stats.xpNeededForNextLevel} XP to level {stats.level + 1}</div>
        </Card>

        <Row gap={12} style={{ marginTop: 16 }}>
          <Card style={{ flex: 1, textAlign: 'center', padding: '18px 8px' }}>
            <Flame size={26} color={stats.currentStreak > 0 ? '#FF5722' : 'var(--md-outline)'} style={{ margin: '0 auto' }} />
            <div style={{ fontSize: 21, fontWeight: 800, marginTop: 8 }}>{stats.currentStreak}</div>
            <div className="am-muted" style={{ fontSize: 12.5 }}>Current streak</div>
          </Card>
          <Card style={{ flex: 1, textAlign: 'center', padding: '18px 8px' }}>
            <Trophy size={26} color="var(--md-outline)" style={{ margin: '0 auto' }} />
            <div style={{ fontSize: 21, fontWeight: 800, marginTop: 8 }}>{stats.longestStreak}</div>
            <div className="am-muted" style={{ fontSize: 12.5 }}>Best streak</div>
          </Card>
        </Row>

        <div style={{ marginTop: 24, marginBottom: 12 }}><SectionTitle>Achievements ({unlocked.size}/{ACHIEVEMENTS.length})</SectionTitle></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {ACHIEVEMENTS.map((a) => {
            const isUnlocked = unlocked.has(a.id);
            return (
              <div key={a.id} style={{
                background: isUnlocked ? 'var(--md-tertiary-container)' : 'var(--md-surface-highest)',
                color: isUnlocked ? 'var(--md-on-tertiary-container)' : 'var(--md-outline)',
                borderRadius: 18, padding: 14, minHeight: 108, display: 'flex', flexDirection: 'column', justifyContent: 'center',
              }}>
                {isUnlocked ? <Trophy size={20} /> : <Lock size={20} />}
                <div style={{ fontWeight: 700, fontSize: 13, marginTop: 8 }}>{a.title}</div>
                <div style={{ fontSize: 11.5, marginTop: 2, opacity: isUnlocked ? 0.85 : 1, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {a.description}
                </div>
              </div>
            );
          })}
        </div>

        <Card style={{ marginTop: 20 }}>
          <div style={{ fontStyle: 'italic', fontSize: 12.5, lineHeight: 1.5 }} className="am-muted">
            All of this is computed locally from what you've actually logged — no AI call involved, same numbers every time for the same attendance history.
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---- Import Routine (paste-only; never calls an AI itself) ---- */
function ImportRoutineScreen({ onBack }) {
  const { importRoutine, showToast } = useAttendanceData();
  const [pasteText, setPasteText] = useState('');
  const [result, setResult] = useState(null);
  const [clearExisting, setClearExisting] = useState(false);
  const [completeSummary, setCompleteSummary] = useState(null);

  function copyPrompt() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ROUTINE_IMPORT_PROMPT).then(() => showToast('Prompt copied.')).catch(() => showToast('Could not copy — select and copy manually.'));
    } else {
      showToast('Could not copy — select and copy manually.');
    }
  }

  function parse() { setResult(parseRoutineImport(pasteText)); }

  function confirmImport() {
    if (!result || !result.routine) return;
    const summary = importRoutine(result.routine, clearExisting);
    setCompleteSummary(summary);
  }

  function closeComplete() {
    setCompleteSummary(null);
    setResult(null);
    setPasteText('');
  }

  const hasUsableData = !!(result && result.routine);
  const isCleanSuccess = hasUsableData && result.errors.length === 0;

  return (
    <div className="am-screen">
      <AppBar title="Import Routine" onBack={onBack} />
      <div style={{ padding: 20 }}>
        <Card>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Step 1 — Copy this prompt</div>
          <div className="am-muted" style={{ fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
            Paste it into any AI chat app you already have (ChatGPT, Gemini, Claude, whatever) along with a photo or description of your timetable. This app doesn't call an AI for this — that step happens over there.
          </div>
          <div style={{ marginTop: 12 }}>
            <Btn variant="outlined" icon={<ClipboardCopy size={16} />} onClick={copyPrompt}>Copy prompt to clipboard</Btn>
          </div>
        </Card>

        <Card style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Step 2 — Paste what the AI gave back</div>
          <div style={{ marginTop: 10 }}>
            <TextArea value={pasteText} onChange={setPasteText} rows={9} placeholder={'{ "subjects": [...], "teachers": [...], "timetable": [...] }'} />
          </div>
          <div style={{ marginTop: 12 }}>
            <Btn variant="filled" icon={<Search size={16} />} disabled={pasteText.trim().length === 0} onClick={parse}>Parse</Btn>
          </div>
        </Card>

        {result && (
          <Card style={{
            marginTop: 16,
            background: isCleanSuccess ? undefined : (!result.routine ? 'var(--md-error-container)' : 'var(--md-tertiary-container)'),
            color: isCleanSuccess ? undefined : (!result.routine ? 'var(--md-on-error-container)' : 'var(--md-on-tertiary-container)'),
          }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              {!result.routine ? "Couldn't parse this" : (isCleanSuccess ? 'Ready to import' : 'Partially parsed — some rows skipped')}
            </div>
            {result.routine && (
              <>
                <div style={{ marginTop: 8, fontSize: 14 }}>
                  {result.routine.subjects.length} subject(s), {result.routine.teachers.length} teacher(s), {result.routine.timetable.length} timetable pattern(s) found.
                </div>
                {result.routine.subjects.length > 0 && (
                  <Row gap={6} style={{ marginTop: 8, flexWrap: 'wrap' }}>
                    {result.routine.subjects.map((s) => <span key={s.code} className="am-chip sm" style={{ cursor: 'default' }}>{s.code} — {s.name}</span>)}
                  </Row>
                )}
              </>
            )}
            {result.errors.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{result.errors.length} issue(s):</div>
                {result.errors.map((e, i) => <div key={i} style={{ fontSize: 12.5, marginTop: 4 }}>• {e}</div>)}
              </div>
            )}
          </Card>
        )}

        {hasUsableData && (
          <>
            <div style={{ marginTop: 16 }}>
              <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="checkbox" checked={clearExisting} onChange={(e) => setClearExisting(e.target.checked)} style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Also clear my existing timetable first</div>
                  <div className="am-muted" style={{ fontSize: 12.5, marginTop: 2 }}>Leave unchecked to add these patterns alongside what's already there instead of replacing it.</div>
                </div>
              </label>
            </div>
            <div style={{ marginTop: 12 }}>
              <Btn variant="filled" icon={<Check size={16} />} onClick={confirmImport}>Confirm import</Btn>
            </div>
          </>
        )}
      </div>

      <AlertDialog
        open={!!completeSummary}
        title="Import complete"
        body={completeSummary && (
          <>
            {completeSummary.subjectsCreated} subject(s) created{completeSummary.subjectsReused > 0 ? `, ${completeSummary.subjectsReused} matched existing` : ''}.<br />
            {completeSummary.teachersCreated} teacher(s) created{completeSummary.teachersReused > 0 ? `, ${completeSummary.teachersReused} matched existing` : ''}.<br />
            {completeSummary.timetableEntriesCreated} timetable pattern(s) added.<br /><br />
            Head to the Timetable tab and tap the repeat icon to generate actual dated classes from these patterns — they won't show up anywhere to log attendance against until you do that.
          </>
        )}
        onOk={closeComplete}
      />
    </div>
  );
}

/* ---- Backup & Restore ----
   Platform swap: the Flutter app copies/restores a SQLite file via the OS
   share sheet and file picker, then force-closes because the DB
   connection has to be rebuilt from scratch. Here persistence is React
   state + localStorage, so a restore takes effect immediately — no
   relaunch needed. That's a genuine behavior improvement forced by the
   storage swap, not a UI choice, and the copy below reflects it. */
/* ────────────────────────────────────────────────────────────────────
   FILE SAVE / SHARE — a plain browser download does not reliably work
   inside a bare Android WebView. Native builds use Capacitor Filesystem
   + Share; browser/dev builds fall back to the normal anchor download.
   ──────────────────────────────────────────────────────────────────── */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function downloadViaBrowser(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function saveOrShareBlob(filename, blob) {
  try {
    const core = await import('@capacitor/core');
    const Capacitor = core.Capacitor;
    if (Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const base64Data = await blobToBase64(blob);
      const written = await Filesystem.writeFile({ path: filename, data: base64Data, directory: Directory.Cache });
      await Share.share({ title: filename, url: written.uri, dialogTitle: `Save or share ${filename}` });
      return;
    }
  } catch (e) {
    // Fall through to the browser technique.
  }
  downloadViaBrowser(filename, blob);
}

async function downloadTextFile(filename, content, mime) {
  return saveOrShareBlob(filename, new Blob([content], { type: mime || 'application/json' }));
}

function BackupScreen({ onBack }) {
  const { exportBackupJSON, restoreFromBackupJSON, showToast } = useAttendanceData();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const fileInputRef = useRef(null);

  async function backupNow() {
    try {
      const json = exportBackupJSON();
      await downloadTextFile(`attendance-manager-backup-${dateKey(new Date())}.json`, json);
    } catch (e) {
      showToast(`Backup failed: ${e.message}`);
    }
  }

  function pickFile() { fileInputRef.current && fileInputRef.current.click(); }

  function onFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setConfirmOpen(true);
    setPendingFile(file);
  }
  const [pendingFile, setPendingFile] = useState(null);

  function doRestore() {
    setConfirmOpen(false);
    if (!pendingFile) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        restoreFromBackupJSON(String(reader.result));
        haptic(HAPTIC.success);
        setDoneOpen(true);
      } catch (e) {
        haptic(HAPTIC.warn);
        showToast(`Restore failed: ${e.message}`);
      }
    };
    reader.readAsText(pendingFile);
  }

  return (
    <div className="am-screen">
      <AppBar title="Backup & Restore" onBack={onBack} />
      <div style={{ padding: 20 }}>
        <Card>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Backup</div>
          <div className="am-muted" style={{ fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
            Everything — subjects, teachers, timetable, every attendance mark, notes — lives in one file. This downloads it as a file; save it to Drive, email it to yourself, whatever you trust.
          </div>
          <div style={{ marginTop: 16 }}>
            <Btn variant="filled" icon={<Upload size={16} />} onClick={backupNow}>Back up now</Btn>
          </div>
        </Card>

        <Card style={{ marginTop: 16, background: 'var(--md-error-container)', color: 'var(--md-on-error-container)' }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Restore</div>
          <div style={{ fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
            This REPLACES everything currently in this app with the backup file you pick. There's no undo — what's here now is gone once you confirm.
          </div>
          <div style={{ marginTop: 16 }}>
            <Btn variant="danger" icon={<Download size={16} />} onClick={pickFile}>Choose backup file to restore</Btn>
          </div>
        </Card>
        <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={onFileChosen} />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Replace all current data?"
        body="This cannot be undone. Everything in this app will be overwritten by the file you picked."
        confirmLabel="Continue" danger
        onConfirm={doRestore}
        onCancel={() => setConfirmOpen(false)}
      />
      <AlertDialog
        open={doneOpen}
        title="Restore complete"
        body="Your data has been replaced with the backup and is active now — no restart needed."
        onOk={() => setDoneOpen(false)}
      />
    </div>
  );
}

/* ---- Export (PDF via print, Excel via SheetJS) ---- */
function statusLabel(status) {
  if (status === AttendanceStatus.PRESENT) return 'Present';
  if (status === AttendanceStatus.ABSENT) return 'Absent';
  if (status === AttendanceStatus.EXCUSED) return 'Excused';
  return 'Not marked';
}

function ExportScreen({ onBack }) {
  const { classSessions, attendanceRecords, subjects, settings, showToast } = useAttendanceData();
  const [reportOpen, setReportOpen] = useState(false);
  const subjectById = useMemo(() => Object.fromEntries(subjects.map((s) => [s.id, s])), [subjects]);

  async function exportExcel() {
    try {
      const sorted = classSessions.slice().sort((a, b) => sessionStartDateTime(a) - sessionStartDateTime(b));
      const rows = [['Date', 'Subject Code', 'Subject Name', 'Start Time', 'End Time', 'Room', 'Status']];
      for (const s of sorted) {
        const subj = subjectById[s.subjectId];
        const r = attendanceRecords[s.id];
        rows.push([
          formatDate(s.date), subj ? subj.code : s.subjectId, subj ? subj.name : '',
          formatMinutes(s.startMinutes), formatMinutes(s.endMinutes), s.room || '',
          statusLabel(r ? r.status : null),
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
      const arrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      await saveOrShareBlob('attendance_report.xlsx', blob);
    } catch (e) {
      showToast(`Export failed: ${e.message || e}`);
    }
  }

  return (
    <div className="am-screen">
      <AppBar title="Export" onBack={onBack} />
      <div style={{ padding: 20 }}>
        <Card onClick={() => setReportOpen(true)} style={{ marginBottom: 12, cursor: 'pointer' }}>
          <Row between>
            <Row gap={14}>
              <div className="am-tile-icon"><FileText size={19} /></div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>PDF report</div>
                <div className="am-muted" style={{ fontSize: 12.5, marginTop: 2 }}>Overall stats, per-subject breakdown, full session log</div>
              </div>
            </Row>
            <ChevronRight size={18} />
          </Row>
        </Card>
        <Card onClick={exportExcel} style={{ cursor: 'pointer' }}>
          <Row between>
            <Row gap={14}>
              <div className="am-tile-icon"><TableProperties size={19} /></div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Excel spreadsheet</div>
                <div className="am-muted" style={{ fontSize: 12.5, marginTop: 2 }}>Every session as a row — date, subject, time, status</div>
              </div>
            </Row>
            <ChevronRight size={18} />
          </Row>
        </Card>
      </div>
      {reportOpen && (
        <PdfReportOverlay onClose={() => setReportOpen(false)} classSessions={classSessions}
          attendanceRecords={attendanceRecords} subjectById={subjectById} settings={settings} />
      )}
    </div>
  );
}

function PdfReportOverlay({ onClose, classSessions, attendanceRecords, subjectById, settings }) {
  useBackButtonLayer(true, onClose);
  const aggregate = useMemo(() => computeAggregate(classSessions, attendanceRecords, settings), [classSessions, attendanceRecords, settings]);
  const subjectStats = useMemo(() => computeSubjectBreakdown(classSessions, attendanceRecords, settings), [classSessions, attendanceRecords, settings]);
  const sortedSessions = useMemo(() => classSessions.slice().sort((a, b) => sessionStartDateTime(a) - sessionStartDateTime(b)), [classSessions]);
  const th = { textAlign: 'left', borderBottom: '1px solid #ccc', padding: '5px 7px', fontSize: 12 };
  const td = { padding: '4px 7px', borderBottom: '1px solid #eee', fontSize: 11.5 };

  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--md-surface)', zIndex: 40, overflowY: 'auto' }}>
      <div style={{ position: 'sticky', top: 0, background: 'var(--md-surface)', padding: 12, display: 'flex', justifyContent: 'flex-end', gap: 8, boxShadow: 'var(--shadow-1)' }}>
        <Btn variant="text" onClick={onClose}>Close</Btn>
        <Btn variant="filled" icon={<Printer size={16} />} onClick={() => window.print()}>Print / Save as PDF</Btn>
      </div>
      <div className="am-print-area" style={{ padding: '20px 28px 60px', color: '#111', background: '#fff', maxWidth: 800, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Attendance Report</h1>
        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>Generated {formatDate(new Date())}</div>

        <h2 style={{ fontSize: 15, marginTop: 22 }}>Overall (aggregate, all subjects combined)</h2>
        <p style={{ fontSize: 13 }}>
          Held: {aggregate.totalHeld}&nbsp;&nbsp;&nbsp;Attended: {aggregate.totalPresent}&nbsp;&nbsp;&nbsp;
          Current: {aggregate.currentPercentage == null ? '—' : `${(aggregate.currentPercentage * 100).toFixed(1)}%`}&nbsp;&nbsp;&nbsp;
          Target: {Math.round(aggregate.targetThreshold * 100)}%
        </p>

        <h2 style={{ fontSize: 15, marginTop: 20 }}>By subject (informational — not independently graded)</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
          <thead><tr>{['Subject', 'Held', 'Attended', '%'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {subjectStats.map((s) => {
              const subj = subjectById[s.subjectId];
              return (
                <tr key={s.subjectId}>
                  <td style={td}>{subj ? subj.name : s.subjectId}</td>
                  <td style={td}>{s.totalHeld}</td>
                  <td style={td}>{s.totalPresent}</td>
                  <td style={td}>{s.percentage == null ? '—' : `${(s.percentage * 100).toFixed(1)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h2 style={{ fontSize: 15, marginTop: 20 }}>Full session log</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
          <thead><tr>{['Date', 'Subject', 'Time', 'Status'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {sortedSessions.map((s) => {
              const subj = subjectById[s.subjectId];
              const r = attendanceRecords[s.id];
              return (
                <tr key={s.id}>
                  <td style={td}>{formatDate(s.date)}</td>
                  <td style={td}>{subj ? subj.code : s.subjectId}</td>
                  <td style={td}>{formatMinutes(s.startMinutes)}</td>
                  <td style={td}>{statusLabel(r ? r.status : null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---- Notifications ----
   Real background OS-level scheduling (firing while the app/tab isn't
   open) has no plain-web equivalent — that needs native platform
   integration once this is wrapped in Capacitor. What's implemented here
   is the real, honest web equivalent: browser Notification permission +
   a foreground timer that fires while the app is open, which is exactly
   as far as a webpage can go on its own. */
/* ────────────────────────────────────────────────────────────────────
   LOCAL NOTIFICATIONS — native scheduling on Capacitor, with browser
   Notification API as a best-effort foreground-only fallback.
   ──────────────────────────────────────────────────────────────────── */
const REMINDER_NOTIFICATION_ID = 19171;

async function tryGetLocalNotifications() {
  try {
    const mod = await import('@capacitor/local-notifications');
    return mod.LocalNotifications;
  } catch (e) {
    return null;
  }
}

async function syncReminderSchedule(prefs) {
  const LocalNotifications = await tryGetLocalNotifications();
  if (LocalNotifications) {
    try {
      await LocalNotifications.cancel({ notifications: [{ id: REMINDER_NOTIFICATION_ID }] });
      if (!prefs.enabled) return { ok: true };
      const perm = await LocalNotifications.requestPermissions();
      if (perm.display !== 'granted') return { ok: false, reason: 'denied' };
      await LocalNotifications.schedule({
        notifications: [{
          id: REMINDER_NOTIFICATION_ID,
          title: 'Mark your attendance',
          body: "Don't forget to log today's classes.",
          schedule: { on: { hour: prefs.hour, minute: prefs.minute }, repeats: true, allowWhileIdle: true },
        }],
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'error' };
    }
  }
  if (prefs.enabled && typeof Notification !== 'undefined') {
    try {
      const perm = await Notification.requestPermission();
      return { ok: perm === 'granted', reason: perm === 'granted' ? null : 'denied' };
    } catch (e) {
      return { ok: false, reason: 'error' };
    }
  }
  return { ok: true };
}

function NotificationsScreen({ onBack }) {
  const { reminderPrefs, updateReminderPrefs, showToast } = useAttendanceData();

  async function setEnabled(v) {
    const result = await syncReminderSchedule({ ...reminderPrefs, enabled: v });
    if (v && !result.ok) {
      showToast(result.reason === 'denied' ? 'Notification permission was denied by the OS.' : 'Could not schedule the reminder.');
      updateReminderPrefs({ enabled: false });
      return;
    }
    updateReminderPrefs({ enabled: v });
  }

  async function setTime(v) {
    const [h, m] = v.split(':').map(Number);
    updateReminderPrefs({ hour: h, minute: m });
    if (reminderPrefs.enabled) await syncReminderSchedule({ ...reminderPrefs, hour: h, minute: m });
  }

  return (
    <div className="am-screen">
      <AppBar title="Notifications" onBack={onBack} />
      <div style={{ padding: 20 }}>
        <Card>
          <Row between gap={16}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Daily reminder to mark attendance</div>
              <div className="am-muted" style={{ fontSize: 12.5, marginTop: 3 }}>A single local notification, fully offline — nothing is sent anywhere.</div>
            </div>
            <SwitchToggle checked={reminderPrefs.enabled} onChange={setEnabled} />
          </Row>
        </Card>

        {reminderPrefs.enabled && (
          <Card style={{ marginTop: 12 }}>
            <Field label="Reminder time">
              <input className="am-input" type="time" value={minutesToTimeValue(reminderPrefs.hour * 60 + reminderPrefs.minute)} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </Card>
        )}

        <div style={{ height: 24 }} /><Divider /><div style={{ height: 16 }} />
        <div style={{ fontStyle: 'italic', fontSize: 13, lineHeight: 1.5 }} className="am-muted">
          Per-class "starting soon" reminders are scheduled automatically for the rest of today whenever you open the Log tab — no setup needed here.
        </div>
      </div>
    </div>
  );
}

/* ---- Settings ---- */
function SettingsScreen({ onBack }) {
  const { settings, updateSettings } = useAttendanceData();

  return (
    <div className="am-screen">
      <AppBar title="Settings" onBack={onBack} />
      <div style={{ padding: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>Target attendance</div>
        <div className="am-muted" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>
          Your institution's minimum — check the actual rulebook, this defaults to 60% but isn't guaranteed to match yours.
        </div>
        <SliderInput value={settings.targetThreshold} min={0.4} max={0.9} step={0.01} onChange={(v) => updateSettings({ targetThreshold: v })} />
        <div style={{ textAlign: 'right', fontSize: 22, fontWeight: 800 }}>{Math.round(settings.targetThreshold * 100)}%</div>

        <div style={{ height: 24 }} /><Divider /><div style={{ height: 16 }} />

        <Row between gap={16} style={{ marginBottom: 24 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Aggregate across all subjects</div>
            <div className="am-muted" style={{ fontSize: 12.5, marginTop: 3, lineHeight: 1.45 }}>
              Matches most colleges: total attended ÷ total held, not per-subject. Turn off only if yours genuinely enforces a separate floor per subject too.
            </div>
          </div>
          <SwitchToggle checked={!settings.enforcePerSubjectFloor} onChange={(v) => updateSettings({ enforcePerSubjectFloor: !v })} />
        </Row>

        <Row between gap={16}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Exclude excused absences from totals</div>
            <div className="am-muted" style={{ fontSize: 12.5, marginTop: 3, lineHeight: 1.45 }}>
              On: an excused class doesn't count against you at all. Off: it counts as held-but-absent, same as a normal skip.
            </div>
          </div>
          <SwitchToggle checked={settings.excusedIsExcludedFromTotals} onChange={(v) => updateSettings({ excusedIsExcludedFromTotals: v })} />
        </Row>
      </div>
    </div>
  );
}

/* ---- More menu ---- */
const MORE_ITEMS = [
  { key: 'gamification', label: 'Progress & Achievements', icon: Trophy },
  { key: 'analytics', label: 'Analytics', icon: BarChart3 },
  { key: 'history', label: 'History', icon: HistoryIcon },
  { key: 'calculator', label: 'Calculator', icon: CalculatorIcon },
  { key: 'simulator', label: 'Simulator / Predictor', icon: SlidersHorizontal },
  { key: 'import', label: 'Import Routine', icon: Upload },
  { key: 'notes', label: 'Lecture Notes', icon: StickyNote },
  { key: 'subjects', label: 'Subjects', icon: BookOpen },
  { key: 'teachers', label: 'Teachers', icon: User },
  { key: 'export', label: 'Export (PDF / Excel)', icon: Share2 },
  { key: 'backup', label: 'Backup & Restore', icon: DatabaseBackup },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
];

function MoreScreen({ onNavigate }) {
  return (
    <div className="am-screen">
      <AppBar title="More" />
      <div>
        {MORE_ITEMS.map((item, i) => (
          <React.Fragment key={item.key}>
            <button onClick={() => onNavigate(item.key)} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 16, padding: '14px 20px',
              background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', textAlign: 'left', fontFamily: 'inherit',
            }}>
              <item.icon size={21} color="var(--md-on-surface-soft)" />
              <div style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>{item.label}</div>
              <ChevronRight size={18} color="var(--md-on-surface-soft)" />
            </button>
            {i < MORE_ITEMS.length - 1 && <div style={{ height: 1, background: 'var(--md-outline-variant)' }} />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

const PUSHED_SCREEN_COMPONENTS = {
  gamification: GamificationScreen,
  analytics: AnalyticsScreen,
  history: HistoryScreen,
  calculator: AttendanceCalculatorScreen,
  simulator: AttendanceSimulatorScreen,
  import: ImportRoutineScreen,
  notes: NotesScreen,
  subjects: SubjectsScreen,
  teachers: TeachersScreen,
  export: ExportScreen,
  backup: BackupScreen,
  notifications: NotificationsScreen,
  settings: SettingsScreen,
};

/* ---- Bottom navigation ---- */
const NAV_TABS = [
  { icon: LayoutDashboard, activeIcon: LayoutDashboard, label: 'Dashboard' },
  { icon: CheckCircle2, activeIcon: CheckCircle2, label: 'Log' },
  { icon: CalendarDays, activeIcon: CalendarDays, label: 'Calendar' },
  { icon: Clock, activeIcon: Clock, label: 'Timetable' },
  { icon: MoreHorizontal, activeIcon: MoreHorizontal, label: 'More' },
];

function BottomNav({ index, onSelect }) {
  return (
    <div className="am-bottom-nav">
      {NAV_TABS.map((tab, i) => {
        const Icon = tab.icon;
        return (
          <button key={tab.label} className={`am-nav-item${index === i ? ' active' : ''}`} onClick={() => onSelect(i)}>
            <span className="nav-icon-wrap"><Icon size={22} strokeWidth={index === i ? 2.4 : 2} /></span>
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---- Main shell: bottom-nav tabs (always mounted, IndexedStack-style)
   plus a one-level push stack for everything reachable from More or the
   Dashboard FAB, mirroring Navigator.push covering the whole Scaffold. ---- */
function MainShell() {
  const [tabIndex, setTabIndex] = useState(0);
  const [pushedKey, setPushedKey] = useState(null);
  const [pushNonce, setPushNonce] = useState(0);

  function push(key) { setPushedKey(key); setPushNonce((n) => n + 1); }
  function pop() { setPushedKey(null); }
  useBackButtonLayer(pushedKey !== null, pop);

  if (pushedKey) {
    const Comp = PUSHED_SCREEN_COMPONENTS[pushedKey];
    return (
      <div className="am-shell">
        <div className="am-screen-transition" key={pushNonce} style={{ position: 'absolute', inset: 0 }}>
          <Comp onBack={pop} />
        </div>
      </div>
    );
  }

  return (
    <div className="am-shell">
      <div className="am-tab-content">
        <div className="am-tab-pane" style={{ opacity: tabIndex === 0 ? 1 : 0, pointerEvents: tabIndex === 0 ? 'auto' : 'none', visibility: tabIndex === 0 ? 'visible' : 'hidden' }}>
          <DashboardScreen onOpenGamification={() => push('gamification')} />
        </div>
        <div className="am-tab-pane" style={{ opacity: tabIndex === 1 ? 1 : 0, pointerEvents: tabIndex === 1 ? 'auto' : 'none', visibility: tabIndex === 1 ? 'visible' : 'hidden' }}><AttendanceLoggingScreen /></div>
        <div className="am-tab-pane" style={{ opacity: tabIndex === 2 ? 1 : 0, pointerEvents: tabIndex === 2 ? 'auto' : 'none', visibility: tabIndex === 2 ? 'visible' : 'hidden' }}><CalendarScreen /></div>
        <div className="am-tab-pane" style={{ opacity: tabIndex === 3 ? 1 : 0, pointerEvents: tabIndex === 3 ? 'auto' : 'none', visibility: tabIndex === 3 ? 'visible' : 'hidden' }}><TimetableScreen /></div>
        <div className="am-tab-pane" style={{ opacity: tabIndex === 4 ? 1 : 0, pointerEvents: tabIndex === 4 ? 'auto' : 'none', visibility: tabIndex === 4 ? 'visible' : 'hidden' }}><MoreScreen onNavigate={push} /></div>
      </div>
      <BottomNav index={tabIndex} onSelect={setTabIndex} />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   ROOT APP
   ──────────────────────────────────────────────────────────────────── */
export default function AttendanceManagerApp() {
  useEffect(() => initBackButtonHandling(), []);
  return (
    <DataProvider>
      <style>{THEME_CSS}</style>
      <div className="am-root">
        <MainShell />
      </div>
    </DataProvider>
  );
}
