import React from "react";
import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

export function CollectionPage({ active, title, description, count, children }: {
  active: "history" | "leaderboard";
  title: string;
  description: string;
  count?: string;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <Sidebar active={active} />
      <main className={`appMain collectionPage ${active}Page`}>
        <header className="collectionHeader">
          <div><h1>{title}</h1><p>{description}</p></div>
          {count && <span className="collectionCount">{count}</span>}
        </header>
        <section className="collectionBody" aria-label={title}>{children}</section>
      </main>
    </div>
  );
}

export function CollectionState({ children }: { children: ReactNode }) {
  return <div className="collectionState" role="status">{children}</div>;
}
