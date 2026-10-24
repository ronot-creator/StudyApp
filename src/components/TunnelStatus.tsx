import React, { useEffect, useState } from "react";
import { getNgrokGrader } from "../services/ngrokGrader";

export const TunnelStatus: React.FC = () => {
  const grader = getNgrokGrader();
  const [url, setUrl] = useState<string>(grader.getTunnelUrl());
  const [online, setOnline] = useState<boolean>(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [editing, setEditing] = useState<boolean>(false);

  const pollHealth = async () => {
    const status = await grader.checkHealth();
    setOnline(status.online);
    setLatencyMs(status.latencyMs);
  };

  useEffect(() => {
    void pollHealth();
    const timer = setInterval(() => {
      void pollHealth();
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  const saveUrl = () => {
    grader.setTunnelConfig(url);
    setEditing(false);
    void pollHealth();
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <span
        className="liquid-badge"
        style={{
          background: online ? "rgba(52, 211, 153, 0.16)" : "rgba(251, 191, 36, 0.16)",
          color: online ? "#34d399" : "#fbbf24",
          border: online
            ? "1px solid rgba(52, 211, 153, 0.4)"
            : "1px solid rgba(251, 191, 36, 0.4)",
          cursor: "pointer",
        }}
        onClick={() => setEditing(!editing)}
        title="Click to configure Colab 3B Ngrok Tunnel URL"
      >
        <span
          style={{
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            background: online ? "#34d399" : "#fbbf24",
          }}
        />
        {online
          ? `Colab 3B Online (${latencyMs ?? "--"} ms)`
          : "Colab 3B Offline (SQLite Queue Active)"}
      </span>

      {editing && (
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <input
            className="liquid-input"
            style={{ width: "240px", padding: "5px 9px", fontSize: "12px" }}
            placeholder="https://xxxx.ngrok-free.app"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="liquid-btn" style={{ padding: "5px 10px" }} onClick={saveUrl}>
            Save
          </button>
        </div>
      )}
    </div>
  );
};
