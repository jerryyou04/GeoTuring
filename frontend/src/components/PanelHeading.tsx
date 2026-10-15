import React from "react";
import type { ReactNode } from "react";

export function PanelHeading({ title, label, description, actions }: {
  title: string;
  label?: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="panelHeading">
      <div className="panelHeadingCopy">
        {label && <p className="roundLabel">{label}</p>}
        <h2 tabIndex={-1}>{title}</h2>
        {description && <p className="panelDescription">{description}</p>}
      </div>
      {actions && <div className="panelHeadingActions">{actions}</div>}
    </header>
  );
}

export function RoundTimer({ label, value, active = false, urgent = false }: {
  label: string;
  value: string;
  active?: boolean;
  urgent?: boolean;
}) {
  return (
    <div className={`roundTimer ${active ? "active" : ""} ${urgent ? "urgent" : ""}`} role="timer" aria-label={`${label}: ${value}`}>
      <span>{label}</span><strong>{value}</strong>
    </div>
  );
}
