import React from "react";

export function StatusPill({ value }: { value: string }) {
  const statusClass = value.toLowerCase();

  return (
    <div className={`statusPill ${statusClass === "connected" || statusClass === "live" ? "online" : ""}`} role="status" aria-label={`Connection: ${value}`}>
      <span aria-hidden="true" />
      {value}
    </div>
  );
}
