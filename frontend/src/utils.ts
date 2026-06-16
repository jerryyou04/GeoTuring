import type { AdminLocation, ChatMessage, IpLocation, MessageCounts } from "./types";

export function formatSeconds(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function getVisibleMessageCounts(messages: ChatMessage[]): MessageCounts {
  return {
    player: messages.filter((message) => message.author === "player").length,
    partner: messages.filter((message) => message.author === "partner").length,
  };
}

export function formatTimestamp(value: number) {
  if (!Number.isFinite(value)) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

export function shortSocketId(socketId: string) {
  return socketId.length <= 8 ? socketId : `${socketId.slice(0, 8)}...`;
}

export function locationText(location?: AdminLocation | null) {
  if (!location) {
    return "Unknown location";
  }

  const place = [location.city, location.region, location.country].filter(Boolean).join(", ");
  const coordinates =
    Number.isFinite(location.lat) && Number.isFinite(location.lng)
      ? `${Number(location.lat).toFixed(2)}, ${Number(location.lng).toFixed(2)}`
      : "";

  return [place, coordinates].filter(Boolean).join(" / ") || "Unknown location";
}

export function getIpLocationStatusText(status: string, agreed: boolean, location: IpLocation | null) {
  if (hasValidIpLocation(location)) {
    const place = [location.city, location.region].filter(Boolean).join(", ");

    return place ? `${place}. Estimated from your IP.` : "Estimated from your IP.";
  }

  if (!agreed) {
    return "Required so another player can guess your rough whereabouts.";
  }

  if (status === "checking") {
    return "Checking your rough IP location.";
  }

  if (status === "unavailable") {
    return "IP lookup failed. Refresh or try again before matchmaking.";
  }

  if (status === "invalid") {
    return "Your saved location had no usable coordinates, so it is being checked again.";
  }

  return "Location check will run from your network/IP.";
}

export function toScoreNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function toLocationNumber(value: unknown, min: number, max: number) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < min || number > max) {
    return null;
  }

  return number;
}

export function hasValidIpLocation(location: IpLocation | AdminLocation | null | undefined) {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng);
}

export function formatAiState(value: string) {
  const labels: Record<string, string> = {
    idle: "Idle",
    generating: "Generating",
    typing: "Typing",
    sent: "Sent",
    failed: "Failed",
  };

  return labels[value] || value;
}

export function formatAiSource(value: string | null) {
  if (!value) {
    return "Unknown";
  }

  const labels: Record<string, string> = {
    openrouter: "OpenRouter",
    local: "Local mock",
    local_fallback: "Local fallback",
  };

  return labels[value] || value;
}

export function formatMs(value: number) {
  if (!Number.isFinite(value)) {
    return "0.0s";
  }

  return `${(value / 1000).toFixed(1)}s`;
}
