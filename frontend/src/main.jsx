import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

function App() {
  const [apiStatus, setApiStatus] = useState("checking");
  const [socketStatus, setSocketStatus] = useState("connecting");
  const [socketId, setSocketId] = useState("");

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Health check failed");
        }

        return response.json();
      })
      .then((data) => setApiStatus(data.status || "ok"))
      .catch(() => setApiStatus("offline"));

    const socket = io(API_URL);

    socket.on("connect", () => {
      setSocketStatus("connected");
      setSocketId(socket.id);
    });

    socket.on("disconnect", () => {
      setSocketStatus("disconnected");
      setSocketId("");
    });

    return () => socket.disconnect();
  }, []);

  return (
    <main className="app">
      <section className="panel" aria-labelledby="title">
        <p className="eyebrow">GeoTuring</p>
        <h1 id="title">Frontend is live.</h1>
        <p className="summary">
          This lightweight client is ready for Railway and connected to the
          GeoTuring backend.
        </p>

        <div className="statusGrid">
          <Status label="API" value={apiStatus} />
          <Status label="Socket" value={socketStatus} />
        </div>

        <dl className="details">
          <div>
            <dt>Backend URL</dt>
            <dd>{API_URL}</dd>
          </div>
          <div>
            <dt>Socket ID</dt>
            <dd>{socketId || "Waiting for connection"}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

function Status({ label, value }) {
  const isGood = value === "healthy" || value === "connected";

  return (
    <div className="status">
      <span className={isGood ? "dot good" : "dot"} />
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
