import { useEffect, useState } from "react";
import { getNgrokGrader, type TunnelHealth } from "../services/ngrokGrader";

const HEALTH_POLL_MS = 15_000;

/** Tunnel URL / token inputs + live latency badge + offline-queue counter. */
export default function TunnelStatus() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [health, setHealth] = useState<TunnelHealth | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(0); // bump to restart the monitor after URL changes

  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    getNgrokGrader()
      .then((grader) => {
        if (cancelled) return;
        if (!url && grader.getTunnelUrl()) setUrl(grader.getTunnelUrl());
        stop = grader.startMonitor(HEALTH_POLL_MS, (h, p) => {
          setHealth(h);
          setPending(p);
        });
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);

  const apply = async () => {
    const grader = await getNgrokGrader();
    grader.setTunnel(url, token || undefined);
    setApplied((n) => n + 1);
  };

  const color = !health ? "#64748b" : health.online ? "#22c55e" : "#ef4444";
  const label = !health
    ? "checking..."
    : health.online
      ? `online · ${health.latencyMs} ms`
      : `offline${pending ? ` · ${pending} answer(s) queued` : ""}`;
  const input = { width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid #334155", background: "#1e293b", color: "#fff", marginBottom: "4px" } as const;

  return (
    <div>
      <label style={{ fontSize: "12px", display: "block", marginBottom: "4px" }}>Colab 3B Ngrok Tunnel URL</label>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.ngrok-free.app" style={input} />
      <input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="Fleet token (X-Fleet-Token)" style={input} />
      <button onClick={apply} style={{ padding: "4px 10px", marginBottom: "6px" }}>Connect</button>
      <div style={{ fontSize: "12px", color }}>● {label}</div>
      {error && <div style={{ fontSize: "11px", color: "#f87171" }}>{error}</div>}
    </div>
  );
}
