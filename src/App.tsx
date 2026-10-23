import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TunnelStatus from "./components/TunnelStatus";

export default function App() {
  const [activeTab, setActiveTab] = useState<"vault" | "srs" | "mindmap">("vault");
  const [statusMsg, setStatusMsg] = useState<string>("Ready (Sandbox: E:\\StudyApp\\MyFiles\\)");

  const mountGeminiPanel = async () => {
    try {
      await invoke("mount_persistent_ai_panel", {
        panelLabel: "gemini_study_panel",
        targetUrl: "https://gemini.google.com/app",
        partitionId: "persist:study_session",
      });
      setStatusMsg("Mounted persistent Gemini panel (persist:study_session)");
    } catch (err) {
      setStatusMsg(`Panel error: ${String(err)}`);
    }
  };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif", background: "#0f172a", color: "#f8fafc" }}>
      <aside style={{ width: "260px", borderRight: "1px solid #1e293b", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <h2 style={{ margin: 0, fontSize: "18px", color: "#38bdf8" }}>StudyApp Pipeline</h2>
        <div style={{ fontSize: "12px", color: "#94a3b8" }}>{statusMsg}</div>
        <button onClick={() => setActiveTab("vault")} style={{ padding: "8px 12px", textAlign: "left" }}>1. Markdown Vault & Thought Anchors</button>
        <button onClick={() => setActiveTab("srs")} style={{ padding: "8px 12px", textAlign: "left" }}>2. Tolerant FSRS Review</button>
        <button onClick={() => setActiveTab("mindmap")} style={{ padding: "8px 12px", textAlign: "left" }}>3. Organ-System Mind Maps</button>
        <hr style={{ borderColor: "#1e293b", width: "100%" }} />
        <button onClick={mountGeminiPanel} style={{ padding: "8px 12px", background: "#0284c7", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}>
          Launch Gemini WebView (persist:study_session)
        </button>
        <div style={{ marginTop: "auto" }}>
          <TunnelStatus />
        </div>
      </aside>
      <main style={{ flex: 1, padding: "24px", overflowY: "auto" }}>
        {activeTab === "vault" && <div><h3>Local Vault Reader (E:\StudyApp\MyFiles\vault)</h3><p>Select text to send via get_active_highlight() to the local MCP server.</p></div>}
        {activeTab === "srs" && <div><h3>Contextually Tolerant FSRS Deck</h3><p>MCQs evaluate locally; written physiological explanations route to the Colab 3B fleet via Ngrok.</p></div>}
        {activeTab === "mindmap" && <div><h3>Modular Cross-System Flowchart</h3><p>Edges support linking phrases up to 30 words (e.g. [Male Urethra] --(passes through)--&gt; [Prostate Gland]).</p></div>}
      </main>
    </div>
  );
}
