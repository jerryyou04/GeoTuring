import React from "react";
import type { ReactNode } from "react";
import { HistoryIcon, LeaderboardIcon } from "./NavIcons";

type SidebarProps = {
  active: "game" | "history" | "leaderboard";
  newGameAction?: { disabled: boolean; title?: string; onClick: () => void };
  footer?: ReactNode;
};

export function Sidebar({ active, newGameAction, footer }: SidebarProps) {
  const newGameContent = <><span className="navIcon" aria-hidden="true">+</span>New game</>;

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brandMark" src="/geoturing-logo.png" alt="" />
        <strong>GeoTuring</strong>
      </div>
      <nav className="sidebarNav" aria-label="Main navigation">
        {newGameAction ? (
          <button className="navItem primary" type="button" {...newGameAction}>
            {newGameContent}
          </button>
        ) : (
          <a className="navItem" href="/">{newGameContent}</a>
        )}
        <a className={`navItem ${active === "history" ? "active" : ""}`} href="/history" aria-current={active === "history" ? "page" : undefined}>
          <span className="navIcon"><HistoryIcon /></span>History
        </a>
        <a className={`navItem ${active === "leaderboard" ? "active" : ""}`} href="/leaderboard" aria-current={active === "leaderboard" ? "page" : undefined}>
          <span className="navIcon"><LeaderboardIcon /></span>Leaderboard
        </a>
      </nav>
      {footer && <div className="sidebarFooter">{footer}</div>}
    </aside>
  );
}
