import React, { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Node,
  Edge,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CANONICAL_ORGAN_SYSTEMS, OrganSystem } from "../../types/study";
import { getNgrokGrader } from "../../services/ngrokGrader";

export interface ParsedTriple {
  id: string;
  organSystem: OrganSystem;
  sourceNode: string;
  linkingPhrase: string;
  targetNode: string;
  isCrossSystemBridge: boolean;
  targetOrganSystem?: OrganSystem;
}

/**
 * Deterministically parses `[Source Node] --(linking phrase <= 30 words)--> [Target Node]`
 * syntax from Markdown notes. Supports `System::Node` cross-system portal bridges.
 */
export function parseMarkdownMindMapTriples(
  organSystem: OrganSystem,
  markdownText: string
): ParsedTriple[] {
  const regex = /\[([^\]]+)\]\s*--\(([^)]+)\)-->\s*\[([^\]]+)\]/g;
  const triples: ParsedTriple[] = [];
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = regex.exec(markdownText)) !== null) {
    idx++;
    const rawSource = match[1].trim();
    const rawPhrase = match[2].trim().split(/\s+/).slice(0, 30).join(" ");
    const rawTarget = match[3].trim();

    let isBridge = false;
    let targetSys: OrganSystem | undefined = undefined;
    let cleanTarget = rawTarget;

    if (rawTarget.includes("::")) {
      const [sysPrefix, nodeRest] = rawTarget.split("::");
      const matchedSys = CANONICAL_ORGAN_SYSTEMS.find(
        (s) => s.toLowerCase() === sysPrefix.trim().toLowerCase()
      );
      if (matchedSys && matchedSys !== organSystem) {
        isBridge = true;
        targetSys = matchedSys;
        cleanTarget = nodeRest.trim();
      }
    }

    triples.push({
      id: `triple_${organSystem}_${idx}`,
      organSystem,
      sourceNode: rawSource,
      linkingPhrase: rawPhrase,
      targetNode: cleanTarget,
      isCrossSystemBridge: isBridge,
      targetOrganSystem: targetSys,
    });
  }
  return triples;
}

const INITIAL_MARKDOWN_SYNTAX = `[Macula Densa NaCl Delivery] --(triggers adenosine A1 receptor vasoconstriction of)--> [Afferent Arteriole]
[Afferent Arteriole] --(lowers hydrostatic pressure inside)--> [Glomerular Capillaries]
[Juxtaglomerular Granular Cells] --(secrete renin in response to beta-1 and low NaCl to generate)--> [Angiotensin II]
[Angiotensin II] --(preferentially constricts AT1 receptors on)--> [Efferent Arteriole]
[Angiotensin II] --(increases systemic arterial afterload and venous return in)--> [Cardiovascular::Left Ventricular Preload]`;

export const MindMapCanvas: React.FC = () => {
  const [selectedSystem, setSelectedSystem] = useState<OrganSystem>("Renal");
  const [syntaxInput, setSyntaxInput] = useState<string>(INITIAL_MARKDOWN_SYNTAX);
  const [extractingColab, setExtractingColab] = useState<boolean>(false);

  const triples = useMemo(
    () => parseMarkdownMindMapTriples(selectedSystem, syntaxInput),
    [selectedSystem, syntaxInput]
  );

  const { nodes, edges } = useMemo(() => {
    const nodeMap = new Map<
      string,
      { id: string; label: string; isBridge: boolean; bridgeSys?: OrganSystem }
    >();

    for (const t of triples) {
      if (!nodeMap.has(t.sourceNode)) {
        nodeMap.set(t.sourceNode, { id: t.sourceNode, label: t.sourceNode, isBridge: false });
      }
      if (!nodeMap.has(t.targetNode)) {
        nodeMap.set(t.targetNode, {
          id: t.targetNode,
          label: t.targetNode,
          isBridge: t.isCrossSystemBridge,
          bridgeSys: t.targetOrganSystem,
        });
      }
    }

    const rfNodes: Node[] = Array.from(nodeMap.values()).map((item, idx) => ({
      id: item.id,
      position: {
        x: (idx % 2) * 380 + 60,
        y: Math.floor(idx / 2) * 145 + 40,
      },
      data: {
        label: item.isBridge
          ? `🌐 [${item.bridgeSys} Bridge] ${item.label}`
          : item.label,
      },
      style: {
        background: item.isBridge
          ? "rgba(99, 102, 241, 0.28)"
          : "rgba(15, 23, 42, 0.85)",
        color: "#f8fafc",
        border: item.isBridge
          ? "1.5px solid #818cf8"
          : "1px solid rgba(56, 189, 248, 0.55)",
        borderRadius: "12px",
        padding: "10px 14px",
        fontSize: "12.5px",
        fontWeight: 600,
        width: 240,
      },
    }));

    const rfEdges: Edge[] = triples.map((t) => ({
      id: t.id,
      source: t.sourceNode,
      target: t.targetNode,
      label: t.linkingPhrase,
      animated: t.isCrossSystemBridge,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#38bdf8" },
      style: {
        stroke: t.isCrossSystemBridge ? "#818cf8" : "#38bdf8",
        strokeWidth: 1.8,
      },
      labelStyle: {
        fill: "#e2e8f0",
        fontSize: 11,
        fontWeight: 500,
      },
      labelBgStyle: {
        fill: "rgba(15, 23, 42, 0.88)",
        fillOpacity: 0.9,
      },
    }));

    return { nodes: rfNodes, edges: rfEdges };
  }, [triples]);

  const handleExtractViaColab = async () => {
    const tunnelUrl = getNgrokGrader().getTunnelUrl();
    if (!tunnelUrl) return;
    setExtractingColab(true);
    try {
      const resp = await fetch(`${tunnelUrl}/extract-mindmap-triples`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organ_system: selectedSystem,
          markdown_text: syntaxInput,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.triples) && data.triples.length > 0) {
          const formatted = data.triples
            .map(
              (t: any) =>
                `[${t.source_node}] --(${t.linking_phrase})--> [${
                  t.is_cross_system_bridge && t.target_organ_system
                    ? `${t.target_organ_system}::${t.target_node}`
                    : t.target_node
                }]`
            )
            .join("
");
          setSyntaxInput(formatted);
        }
      }
    } finally {
      setExtractingColab(false);
    }
  };

  const crossSystemBridges = triples.filter((t) => t.isCrossSystemBridge);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px", height: "100%" }}>
      <div
        className="liquid-card"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <label style={{ fontSize: "12.5px", color: "#94a3b8" }}>Organ System:</label>
          <select
            className="liquid-select"
            style={{ width: "220px" }}
            value={selectedSystem}
            onChange={(e) => setSelectedSystem(e.target.value as OrganSystem)}
          >
            {CANONICAL_ORGAN_SYSTEMS.map((sys) => (
              <option key={sys} value={sys}>
                {sys}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {crossSystemBridges.map((b) => (
            <button
              key={b.id}
              className="liquid-btn"
              style={{
                background: "rgba(99, 102, 241, 0.22)",
                borderColor: "rgba(129, 140, 248, 0.55)",
                fontSize: "11.5px",
              }}
              onClick={() => b.targetOrganSystem && setSelectedSystem(b.targetOrganSystem)}
            >
              🌐 Jump to {b.targetOrganSystem} Portal ({b.targetNode})
            </button>
          ))}
          <button
            className="liquid-btn liquid-btn-secondary"
            onClick={handleExtractViaColab}
            disabled={extractingColab}
          >
            {extractingColab ? "Extracting..." : "Colab 3B Auto-Extract Triples"}
          </button>
        </div>
      </div>

      <div style={{ height: "380px", borderRadius: "14px", overflow: "hidden" }} className="liquid-card">
        <ReactFlow nodes={nodes} edges={edges} fitView>
          <Background color="rgba(148, 163, 184, 0.18)" gap={20} />
          <Controls />
        </ReactFlow>
      </div>

      <div className="liquid-card">
        <label style={{ display: "block", fontSize: "12px", color: "#94a3b8", marginBottom: "6px" }}>
          Markdown Flowchart Syntax (<code>[Node A] --(linking phrase &lt;= 30 words)--&gt; [Node B]</code>)
        </label>
        <textarea
          className="liquid-textarea"
          rows={4}
          value={syntaxInput}
          onChange={(e) => setSyntaxInput(e.target.value)}
        />
      </div>
    </div>
  );
};
