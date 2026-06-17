import React from "react";
import type { StoredTranscriptMessage } from "../types";

// Renders a stored chat transcript as bubbles. Messages are stored from the
// owning player's perspective, so "player" is always that person and "partner"
// is whoever (or whatever) they were talking to.
export function TranscriptView({
  transcript,
  partnerLabel = "Partner",
}: {
  transcript: StoredTranscriptMessage[] | undefined;
  partnerLabel?: string;
}) {
  if (!transcript || transcript.length === 0) {
    return <p className="emptyTranscript">No chat was recorded for this game.</p>;
  }

  return (
    <div className="chatTranscript">
      {transcript.map((message, index) => (
        <div
          className={`chatBubbleRow ${message.author === "player" ? "self" : "other"}`}
          key={message.id || `${index}`}
        >
          <div className="chatBubble">
            <span className="chatBubbleAuthor">
              {message.author === "player" ? "You" : partnerLabel}
            </span>
            <p>{message.text}</p>
            <time>{formatTime(message.sentAt)}</time>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatTime(value: number) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
