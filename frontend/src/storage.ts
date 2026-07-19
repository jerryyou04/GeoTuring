import {
  ACTIVE_SESSION_STORAGE_KEY,
  EMPTY_PERSISTENT_SCORE,
  IP_LOCATION_STORAGE_KEY,
  LOCATION_CONSENT_STORAGE_KEY,
  NAME_STORAGE_KEY,
  PLAYER_ID_STORAGE_KEY,
  SCORE_STORAGE_KEY,
  SCORED_SESSION_IDS_STORAGE_KEY,
} from "./config";
import type { IpLocation, PersistentScore } from "./types";
import { hasValidIpLocation, toLocationNumber, toScoreNumber } from "./utils";

export function loadPersistentScore(): PersistentScore {
  if (typeof window === "undefined") {
    return EMPTY_PERSISTENT_SCORE;
  }

  try {
    const raw = window.localStorage.getItem(SCORE_STORAGE_KEY);

    if (!raw) {
      return EMPTY_PERSISTENT_SCORE;
    }

    const parsed = JSON.parse(raw) as Partial<PersistentScore>;

    return {
      readEarned: toScoreNumber(parsed.readEarned),
      readPossible: toScoreNumber(parsed.readPossible),
      humanEarned: toScoreNumber(parsed.humanEarned),
      humanPossible: toScoreNumber(parsed.humanPossible),
      aiEarned: toScoreNumber(parsed.aiEarned),
      aiPossible: toScoreNumber(parsed.aiPossible),
    };
  } catch {
    return EMPTY_PERSISTENT_SCORE;
  }
}

export function savePersistentScore(score: PersistentScore) {
  try {
    window.localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(score));
  } catch {
    // The in-memory scoreboard still updates if storage is unavailable.
  }
}

export function loadScoredSessionIds(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SCORED_SESSION_IDS_STORAGE_KEY) || "[]");

    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(-200)
      : [];
  } catch {
    return [];
  }
}

export function saveScoredSessionIds(sessionIds: Iterable<string>) {
  try {
    window.localStorage.setItem(
      SCORED_SESSION_IDS_STORAGE_KEY,
      JSON.stringify([...sessionIds].slice(-200)),
    );
  } catch {
    // The in-memory dedupe still works if storage is unavailable.
  }
}

export function loadLocationConsent() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(LOCATION_CONSENT_STORAGE_KEY) === "true";
}

export function saveLocationConsent(agreed: boolean) {
  try {
    window.localStorage.setItem(LOCATION_CONSENT_STORAGE_KEY, String(agreed));
  } catch {
    // The current checkbox state still works if storage is unavailable.
  }
}

export function loadName(): string {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    return (window.localStorage.getItem(NAME_STORAGE_KEY) || "").slice(0, 20);
  } catch {
    return "";
  }
}

export function saveName(name: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(NAME_STORAGE_KEY, name.slice(0, 20));
  } catch {
    // ignore storage failures
  }
}

export function loadOrCreatePlayerId() {
  if (typeof window === "undefined") {
    return createPlayerId();
  }

  try {
    const existing = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY);

    if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing)) {
      return existing;
    }

    const next = createPlayerId();
    window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return createPlayerId();
  }
}

export function loadActiveSessionId() {
  try {
    const value = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || "";

    return /^[a-z0-9]{4,40}$/i.test(value) ? value : "";
  } catch {
    return "";
  }
}

export function saveActiveSessionId(sessionId: string) {
  try {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // The active socket session still works if storage is unavailable.
  }
}

export function removeActiveSessionId() {
  try {
    window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

export function loadIpLocation(): IpLocation | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(IP_LOCATION_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<IpLocation>;
    const country = typeof parsed.country === "string" ? parsed.country : "";

    if (!country) {
      return null;
    }

    const location: IpLocation = {
      country,
      region: typeof parsed.region === "string" ? parsed.region : "",
      city: typeof parsed.city === "string" ? parsed.city : "",
      lat: toLocationNumber(parsed.lat, -90, 90),
      lng: toLocationNumber(parsed.lng, -180, 180),
      source: "ip",
      updatedAt: toScoreNumber(parsed.updatedAt),
    };

    return hasValidIpLocation(location) ? location : null;
  } catch {
    return null;
  }
}

export function saveIpLocation(location: IpLocation) {
  try {
    window.localStorage.setItem(IP_LOCATION_STORAGE_KEY, JSON.stringify(location));
  } catch {
    // The in-memory location still works if storage is unavailable.
  }
}

export function removeIpLocation() {
  try {
    window.localStorage.removeItem(IP_LOCATION_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

function createPlayerId() {
  const random = Math.random().toString(36).slice(2, 12);
  const timestamp = Date.now().toString(36);

  return `${timestamp}${random}`;
}
