import React from "react";
import type { Phase } from "../types";

export function RoundProgress({ phase }: { phase: Phase }) {
  const current = phase === "reveal" ? 2 : ["identity", "humanGuess", "aiGuess", "waitingGuess"].includes(phase) ? 1 : 0;
  return (
    <ol className="roundProgress" aria-label="Round progress">
      {["Conversation", "Your guess", "Result"].map((label, index) => (
        <li key={label} className={index < current ? "complete" : ""} aria-current={index === current ? "step" : undefined}>
          <span aria-hidden="true">{index + 1}</span>{label}
        </li>
      ))}
    </ol>
  );
}
