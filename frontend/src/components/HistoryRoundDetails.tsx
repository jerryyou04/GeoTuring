import React from "react";
import type { GameHistoryEntry } from "../types";
import { GuessSummary } from "./HistoryDetail";
import { HistoryMap } from "./HistoryMap";
import { TranscriptView } from "./TranscriptView";

export function HistoryRoundDetails({ game }: { game: GameHistoryEntry }) {
  const messageCount = game.messageCount ?? game.transcript?.length ?? 0;
  return (
    <>
      <div className="historyRoundDetails">
        <GuessSummary game={game} />
        <HistoryMap game={game} />
      </div>
      <div className="historyConversation">
        <h2 className="historyChatMeta">Transcript{messageCount > 0 ? ` · ${messageCount} message${messageCount === 1 ? "" : "s"}` : ""}</h2>
        <TranscriptView transcript={game.transcript} partnerLabel={game.opponentType === "Human" ? "Opponent" : game.modelFamily || "AI"} />
      </div>
    </>
  );
}
