import type { FormEvent } from "react";
import React, { useEffect, useRef, useState } from "react";
import { MIN_MESSAGES_PER_SIDE } from "../config";
import type { ChatMessage, MessageCounts, TurnStatePayload } from "../types";
import { formatSeconds } from "../utils";

export function ChatRoom({
  canGuess,
  counts,
  messages,
  draft,
  endMessage,
  finalGuessSecondsLeft,
  isEnded,
  isLocked,
  isPlayerTurn,
  lockedMessage = "Chat locked. Use the final guess beside the chat.",
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
  canGuess: boolean;
  counts: MessageCounts;
  messages: ChatMessage[];
  draft: string;
  endMessage: string;
  finalGuessSecondsLeft: number;
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
  const roundExpired = !isEnded && !isLocked && secondsLeft <= 0;
  const turnExpired = !isEnded && !isLocked && turnState.currentTurn !== "paused" && turnSecondsLeft <= 0;
  const timerExpired = roundExpired || turnExpired;
  const canSend = draft.trim().length > 0 && isPlayerTurn && !isEnded && !isLocked && !timerExpired;
  const guessLabel = canGuess
    ? "Guess"
    : `Guess ${Math.min(counts.player, MIN_MESSAGES_PER_SIDE)}/${MIN_MESSAGES_PER_SIDE} ${Math.min(
      counts.partner,
      MIN_MESSAGES_PER_SIDE,
    )}/${MIN_MESSAGES_PER_SIDE}`;
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
    : isLocked
      ? `${finalGuessSecondsLeft}s`
      : timerExpired
        ? "0s"
        : turnState.currentTurn === "paused"
          ? "--"
          : `${turnSecondsLeft}s`;
  const showPartnerTyping = !isEnded && !isLocked && turnState.currentTurn === "partner";
  const roundClockValue = isLocked ? "Locked" : formatSeconds(secondsLeft);
  const inputPlaceholder = roundExpired
    ? "Round time expired..."
    : turnExpired
      ? "Turn time expired..."
      : isPlayerTurn
        ? "Ask something revealing..."
        : "Waiting for their message...";
  const expiredMessage = roundExpired
    ? "Round time expired. Waiting for the final state."
    : "Turn time expired. Waiting for the final state.";

  useEffect(() => {
    const newestMessage = messages[messages.length - 1];

    if (followLatestRef.current || newestMessage?.author === "player" || isLocked || isEnded) {
      scrollMessagesToBottom("smooth");
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
        behavior,
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
    <section className="gamePanel chatLayout">
      <div className="chatHeader">
        <div>
          <p className="roundLabel">Anonymous chat</p>
          <h2>Find the tell.</h2>
        </div>
        <div className="timerStack">
          <div>
            <span>{isLocked ? "Chat" : "Round"}</span>
            <strong>{roundClockValue}</strong>
          </div>
          <div className={isPlayerTurn ? "activeTurn" : ""}>
            <span>{isEnded ? "Ended" : isLocked ? "Guess" : turnLabel}</span>
            <strong>{turnClockLabel}</strong>
          </div>
        </div>
      </div>

      {isEnded && <div className="chatEndedBanner">{endMessage || "This round ended."}</div>}
      {!isEnded && !isLocked && timerExpired && <div className="chatEndedBanner">{expiredMessage}</div>}

      <div className="messagesShell">
        <div className="messages" aria-live="polite" ref={messagesRef} onScroll={handleMessagesScroll}>
          {messages.map((message) => (
            <div className={`message ${message.author}`} key={message.id}>
              {message.text}
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
          <button className="primaryButton" type="button" onClick={onRestart}>
            Play again
          </button>
        </div>
      ) : isLocked ? (
        <div className="chatEndedBanner">{lockedMessage}</div>
      ) : (
        <div className="chatControls">
          {pendingGuessConfirm && (
            <div className="guessConfirm">
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
              disabled={!isPlayerTurn || timerExpired}
              maxLength={400}
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              placeholder={inputPlaceholder}
            />
            <button disabled={!canSend} type="submit">
              Send
            </button>
            <button className="secondaryButton" disabled={!canGuess || timerExpired} type="button" onClick={onGuess}>
              {guessLabel}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
