import type { FormEvent } from "react";
import React, { useEffect, useId, useRef, useState } from "react";
import { MIN_MESSAGES_PER_SIDE } from "../config";
import type { ChatMessage, MessageCounts, TurnStatePayload } from "../types";
import { formatSeconds } from "../utils";
import { PanelHeading, RoundTimer } from "./PanelHeading";

export function ChatRoom({
  canRestart,
  canGuess,
  counts,
  messages,
  draft,
  endMessage,
  isEnded,
  isLocked,
  isPlayerTurn,
  lockedMessage = "Chat locked. Make your final guess.",
  pendingGuessConfirm,
  secondsLeft,
  turnSecondsLeft,
  turnState,
  onCancelGuess,
  onConfirmGuess,
  onDraft,
  onSend,
  onGuess,
  onRestart,
}: {
  canRestart: boolean;
  canGuess: boolean;
  counts: MessageCounts;
  messages: ChatMessage[];
  draft: string;
  endMessage: string;
  isEnded: boolean;
  isLocked: boolean;
  isPlayerTurn: boolean;
  lockedMessage?: string;
  pendingGuessConfirm: boolean;
  secondsLeft: number;
  turnSecondsLeft: number;
  turnState: TurnStatePayload;
  onCancelGuess: () => void;
  onConfirmGuess: () => void;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onGuess: () => void;
  onRestart: () => void;
}) {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const followLatestRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const guessHintId = useId();
  const roundExpired = !isEnded && !isLocked && secondsLeft <= 0;
  const turnExpired = !isEnded && !isLocked && turnState.currentTurn !== "paused" && turnSecondsLeft <= 0;
  const timerExpired = roundExpired || turnExpired;
  const canSend = draft.trim().length > 0 && isPlayerTurn && !isEnded && !isLocked && !timerExpired;
  const turnLabel = roundExpired
    ? "Time up"
    : turnExpired
      ? "Turn ended"
      : turnState.currentTurn === "player"
        ? "Your turn"
        : turnState.currentTurn === "partner"
          ? "Their turn"
          : turnState.canAbort
            ? "Ready"
            : "Waiting";
  const turnClockLabel = isEnded
    ? "--"
    : timerExpired
        ? "0s"
        : turnState.currentTurn === "paused"
          ? "--"
          : `${turnSecondsLeft}s`;
  const showPartnerTyping = !isEnded && !isLocked && turnState.currentTurn === "partner";
  const roundClockValue = formatSeconds(secondsLeft);
  const inputPlaceholder = roundExpired
    ? "Round time expired..."
    : turnExpired
      ? "Turn time expired..."
      : isPlayerTurn
        ? "Ask something revealing..."
        : "Type while you wait...";
  const expiredMessage = roundExpired
    ? "Round time expired."
    : "Turn time expired.";

  useEffect(() => {
    const newestMessage = messages[messages.length - 1];

    if (followLatestRef.current || newestMessage?.author === "player" || isLocked || isEnded) {
      scrollMessagesToBottom();
    }
  }, [isEnded, isLocked, messages, showPartnerTyping]);

  // When the turn flips back to the player, put the cursor straight in the
  // composer so they can type without clicking to refocus.
  useEffect(() => {
    if (isPlayerTurn && !isEnded && !isLocked) {
      inputRef.current?.focus();
    }
  }, [isPlayerTurn, isEnded, isLocked]);

  function scrollMessagesToBottom(behavior: ScrollBehavior = "auto") {
    window.requestAnimationFrame(() => {
      const element = messagesRef.current;

      if (!element) {
        return;
      }

      element.scrollTo({
        top: element.scrollHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : behavior,
      });
      followLatestRef.current = true;
      setShowJumpToLatest(false);
    });
  }

  function handleMessagesScroll() {
    const element = messagesRef.current;

    if (!element) {
      return;
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const isNearLatest = distanceFromBottom < 96;

    followLatestRef.current = isNearLatest;
    setShowJumpToLatest(!isNearLatest);
  }

  return (
    <section className={`gamePanel chatLayout ${isLocked ? "chatLocked" : ""} ${isEnded ? "chatEnded" : ""}`} aria-label="Conversation">
      <PanelHeading title="Conversation" actions={
        isLocked ? <span className="chatReadOnly">Read only</span> : <div className="timerStack">
          <RoundTimer label="Round" value={isEnded ? "Ended" : roundClockValue} />
          {!isEnded && <RoundTimer label={turnLabel} value={turnClockLabel} active={isPlayerTurn} urgent={turnSecondsLeft <= 10 && turnState.currentTurn !== "paused"} />}
        </div>
      } />

      {isEnded && <div className="chatEndedBanner" role="status">{endMessage || "This round ended."}</div>}
      {!isEnded && !isLocked && timerExpired && <div className="chatEndedBanner" role="status">{expiredMessage}</div>}

      <div className="messagesShell">
        <div className="messages" role="log" aria-label="Conversation messages" aria-live="polite" ref={messagesRef} onScroll={handleMessagesScroll} tabIndex={0}>
          {messages.map((message) => (
            <div className={`message ${message.author} ${message.delivery || ""}`} key={message.id}>
              <span className="srOnly">{message.author === "player" ? "You: " : message.author === "partner" ? "Opponent: " : "Round update: "}</span>
              {message.text}
              {message.delivery === "pending" && <small className="messageDelivery">Sending...</small>}
            </div>
          ))}
          {showPartnerTyping && (
            <div className="message partner typingBubble" aria-label="Their turn, typing">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
        {showJumpToLatest && (
          <button className="jumpToLatest" type="button" onClick={() => scrollMessagesToBottom("smooth")}>
            Latest
          </button>
        )}
      </div>

      {isEnded ? (
        <div className="composer endedComposer">
          <button className="primaryButton" disabled={!canRestart} type="button" onClick={onRestart}>
            {canRestart ? "Play again" : "Finalizing round..."}
          </button>
        </div>
      ) : isLocked ? (
        <div className="chatEndedBanner" role="status">{lockedMessage}</div>
      ) : (
        <div className="chatControls">
          {!canGuess && !timerExpired && <p className="chatGuessHint" id={guessHintId}>Exchange {MIN_MESSAGES_PER_SIDE} messages each to unlock guessing. <span>You {Math.min(counts.player, MIN_MESSAGES_PER_SIDE)}/{MIN_MESSAGES_PER_SIDE} · Opponent {Math.min(counts.partner, MIN_MESSAGES_PER_SIDE)}/{MIN_MESSAGES_PER_SIDE}</span></p>}
          {pendingGuessConfirm && (
            <div className="guessConfirm" role="group" aria-label="Confirm final guesses">
              <span>Lock chat and make final guesses?</span>
              <div>
                <button className="secondaryButton" type="button" onClick={onCancelGuess}>
                  Cancel
                </button>
                <button className="primaryButton" type="button" onClick={onConfirmGuess}>
                  Lock round
                </button>
              </div>
            </div>
          )}
          <form className="composer" onSubmit={onSend}>
            <input
              ref={inputRef}
              aria-label="Chat message"
              disabled={timerExpired}
              maxLength={400}
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              placeholder={inputPlaceholder}
            />
            <button disabled={!canSend} type="submit">
              Send
            </button>
            <button className="secondaryButton" disabled={!canGuess || timerExpired} aria-describedby={!canGuess && !timerExpired ? guessHintId : undefined} type="button" onClick={onGuess}>
              Make a guess
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
