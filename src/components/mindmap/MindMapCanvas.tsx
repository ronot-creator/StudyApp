import React, { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Node,
  Edge,
  MarkerType,
  NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { readTextFile } from "@tauri-apps/plugin-fs";
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

export interface MindMapNodeData extends Record<string, unknown> {
  label: string;
  rawLabel: string;
  isBridge: boolean;
  targetOrganSystem?: OrganSystem;
}

export interface MindMapCanvasProps {
  organSystem?: OrganSystem;
  onOrganSystemChange?: (system: OrganSystem) => void;
}

const DEFAULT_SYSTEM_VAULT_MARKDOWN: Record<OrganSystem, string> = {
  Renal: `# Glomerular Filtration & Tubuloglomerular Feedback (TGF)

The renal corpuscle autoregulates GFR across systemic pressures (80–180 mmHg) via myogenic stretch and macula densa paracrine signaling.

\`\`\`mindmap
[Macula Densa NaCl Delivery] --(triggers adenosine A1 receptor vasoconstriction of)--> [Afferent Arteriole]
[Afferent Arteriole] --(lowers hydrostatic pressure inside)--> [Glomerular Capillaries]
[Juxtaglomerular Granular Cells] --(secrete renin in response to beta-1 and low NaCl to generate)--> [Angiotensin II]
[Angiotensin II] --(preferentially constricts AT1 receptors on)--> [Efferent Arteriole]
[Angiotensin II] --(increases systemic arterial afterload and venous return in)--> [Cardiovascular::Left Ventricular Preload]
\`\`\``,
  Cardiovascular: `# Ventricular-Vascular Coupling & Frank-Starling Law

Sarcomere length-tension dependence increases stroke volume in response to elevated end-diastolic volume via heightened troponin C calcium sensitivity.

\`\`\`mindmap
[Left Ventricular End-Diastolic Volume] --(stretches sarcomeres to increase Ca2+ sensitivity and)--> [Stroke Volume]
[Sympathetic Beta-1 Stimulation] --(accelerates SERCA2a phospholamban phosphorylation in)--> [Lusitropic Relaxation]
[Stroke Volume] --(augments mean arterial perfusion pressure delivered to)--> [Renal::Renal Artery Perfusion]
\`\`\``,
  Respiratory: `# Alveolar-Capillary Gas Exchange & Hypoxic Pulmonary Vasoconstriction

\`\`\`mindmap
[Alveolar Hypoxia (PAO2 < 60 mmHg)] --(inhibits voltage-gated K+ channels in vascular smooth muscle to constrict)--> [Pulmonary Arterioles]
[Pulmonary Arterioles] --(shunts capillary blood flow toward well-ventilated alveoli to optimize)--> [V/Q Matching]
[Chronic Hypoxic Vasoconstriction] --(elevates right ventricular afterload in)--> [Cardiovascular::Right Ventricular Hypertrophy]
\`\`\``,
  Neurology: `# Cerebral Autoregulation & Monro-Kellie Doctrine

\`\`\`mindmap
[Arterial PaCO2 Elevation] --(lowers perivascular pH via nitric oxide to dilate)--> [Cerebral Pial Arterioles]
[Cerebral Pial Arterioles] --(increases intracranial blood volume and elevates)--> [Intracranial Pressure (ICP)]
[Cushing Reflex Triad] --(triggers baroreceptor-mediated reflex bradycardia in)--> [Cardiovascular::SA Node Vagal Tone]
\`\`\``,
  Gastrointestinal: `# Enterohepatic Circulation & Portal Hemodynamics

\`\`\`mindmap
[Ileal Apical ASBT Transporter] --(reabsorbs conjugated bile salts into)--> [Portal Venous Circulation]
[Portal Venous Circulation] --(activates hepatic FXR nuclear receptors to suppress)--> [CYP7A1 Cholesterol 7-Alpha-Hydroxylase]
\`\`\``,
  Endocrine: `# Hypothalamic-Pituitary-Adrenal & RAAS Integration

\`\`\`mindmap
[Zona Glomerulosa Angiotensin II Stimulation] --(upregulates aldosterone synthase CYP11B2 to secrete)--> [Aldosterone]
[Aldosterone] --(induces ENaC and Na+/K+ ATPase expression in)--> [Renal::Principal Cells of Collecting Duct]
\`\`\``,
  "Hematology/Oncology": `# Coagulation Cascade & Platelet Activation

\`\`\`mindmap
[Subendothelial von Willebrand Factor] --(binds platelet glycoprotein Ib-IX-V receptor to mediate)--> [Platelet Tethering & Adhesion]
[Activated GPIIb/IIIa Integrin] --(cross-links fibrinogen dimers to stabilize)--> [Primary Hemostatic Plug]
\`\`\``,
  Immunology: `# Complement Activation & Adaptive Co-Stimulation

\`\`\`mindmap
[C3b Opsonization] --(assembles C5 convertase complex to cleave)--> [C5a Anaphylatoxin & MAC C5b-9]
[CD28 Co-Stimulatory Receptor] --(binds APC B7-1/B7-2 to induce IL-2 transcription in)--> [Naive CD4+ T Lymphocytes]
\`\`\``,
  Musculoskeletal: `# Excitation-Contraction Coupling & Cross-Bridge Cycling

\`\`\`mindmap
[T-Tubule Dihydropyridine Receptor] --(mechanically gates sarcoplasmic reticulum ryanodine RYR1 channels to release)--> [Cytosolic Ca2+ Surge]
[Cytosolic Ca2+ Surge] --(binds Troponin C to shift Tropomyosin and expose)--> [Actin Myosin-Binding Sites]
\`\`\``,
  Reproductive: `# Hypothalamic-Pituitary-Gonadal Axis Pulsatility

\`\`\`mindmap
[Arcuate Nucleus Kisspeptin Neurons] --(drive pulsatile release of)--> [Gonadotropin-Releasing Hormone (GnRH)]
[High-Frequency GnRH Pulses] --(preferentially stimulate gonadotroph secretion of)--> [Luteinizing Hormone (LH)]
\`\`\``,
  Integumentary: `# Epidermal Barrier & Melanogenesis

\`\`\`mindmap
[Keratinocyte UV-B DNA Photodamage] --(stabilizes p53 to upregulate POMC cleavage into)--> [Alpha-MSH]
[Alpha-MSH] --(activates melanocortin-1 receptor MC1R to stimulate)--> [Tyrosinase Eumelanin Synthesis]
\`\`\``,
  "Multisystem/General": `# Systemic Shock & End-Organ Perfusion Compensation

\`\`\`mindmap
[Carotid Sinus Baroreceptor Unloading] --(augments rostral ventrolateral medulla sympathetic outflow to)--> [Cardiovascular::Systemic Vascular Resistance]
[Systemic Sympathetic Outflow] --(activates juxtaglomerular beta-1 receptors in)--> [Renal::Renin-Angiotensin-Aldosterone Axis]
\`\`\``,
};

/**
 * Extracts only the text enclosed inside ` \`\`\`mindmap ... \`\`\` ` fenced code blocks.
 * Standard Markdown prose outside these blocks is ignored by the graph parser.
 */
export function extractMindMapCodeBlocks(markdownText: string): string {
  const blockRegex = /```mindmap\s*([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(markdownText)) !== null) {
    if (match[1] && match[1].trim()) {
      blocks.push(match[1].trim());
    }
  }
  return blocks.join("\n");
}

/**
 * Deterministically parses `[Source Node] --(linking phrase <= 30 words)--> [Target Node]`
 * syntax exclusively from inside ` \`\`\`mindmap ` code blocks in Markdown notes.
 * Supports `System::Node` cross-system portal bridges.
 */
export function parseMarkdownMindMapTriples(
  organSystem: OrganSystem,
  markdownText: string
): ParsedTriple[] {
  const extractedCodeBlockText = extractMindMapCodeBlocks(markdownText);
  if (!extractedCodeBlockText) {
    return [];
  }

  const regex = /\[([^\]]+)\]\s*--\(([^)]+)\)-->\s*\[([^\]]+)\]/g;
  const triples: ParsedTriple[] = [];
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = regex.exec(extractedCodeBlockText)) !== null) {
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

export function buildGraphFromTriples(triples: ParsedTriple[]): {
  nodes: Node<MindMapNodeData>[];
  edges: Edge[];
} {
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
    } else if (t.isCrossSystemBridge && t.targetOrganSystem) {
      const existing = nodeMap.get(t.targetNode)!;
      existing.isBridge = true;
      existing.bridgeSys = t.targetOrganSystem;
    }
  }

  const rfNodes: Node<MindMapNodeData>[] = Array.from(nodeMap.values()).map((item, idx) => ({
    id: item.id,
    position: {
      x: (idx % 2) * 380 + 60,
      y: Math.floor(idx / 2) * 145 + 40,
    },
    data: {
      label: item.isBridge
        ? `🌐 [${item.bridgeSys}::${item.label}]`
        : item.label,
      rawLabel: item.label,
      isBridge: item.isBridge,
      targetOrganSystem: item.bridgeSys,
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
      width: 250,
      cursor: item.isBridge ? "pointer" : "default",
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
}

export const MindMapCanvas: React.FC<MindMapCanvasProps> = ({
  organSystem: propOrganSystem,
  onOrganSystemChange,
}) => {
  const [internalSystem, setInternalSystem] = useState<OrganSystem>(propOrganSystem ?? "Renal");
  const activeSystem: OrganSystem = propOrganSystem ?? internalSystem;

  const [syntaxInput, setSyntaxInput] = useState<string>(
    DEFAULT_SYSTEM_VAULT_MARKDOWN[activeSystem]
  );
  const [nodes, setNodes] = useState<Node<MindMapNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedPortalNode, setSelectedPortalNode] = useState<{
    nodeId: string;
    label: string;
    targetOrganSystem: OrganSystem;
  } | null>(null);
  const [extractingColab, setExtractingColab] = useState<boolean>(false);

  const handleSelectSystem = useCallback(
    (nextSystem: OrganSystem) => {
      setInternalSystem(nextSystem);
      setSelectedPortalNode(null);
      onOrganSystemChange?.(nextSystem);
    },
    [onOrganSystemChange]
  );

  // Dynamically read E:\StudyApp\MyFiles\vault\{organSystem}.md on OrganSystem tab switch
  useEffect(() => {
    let cancelled = false;
    setSelectedPortalNode(null);

    const loadVaultMarkdownForSystem = async () => {
      const vaultFilePath = `E:\\StudyApp\\MyFiles\\vault\\${activeSystem}.md`;
      let markdownContent = DEFAULT_SYSTEM_VAULT_MARKDOWN[activeSystem];

      try {
        const diskText = await readTextFile(vaultFilePath);
        if (diskText && diskText.trim().length > 0) {
          markdownContent = diskText;
        }
      } catch {
        // Fallback to strict system-scoped local default when running in browser preview or before file creation
      }

      if (cancelled) return;
      setSyntaxInput(markdownContent);
      const parsed = parseMarkdownMindMapTriples(activeSystem, markdownContent);
      const nextGraph = buildGraphFromTriples(parsed);
      setNodes(nextGraph.nodes);
      setEdges(nextGraph.edges);
    };

    void loadVaultMarkdownForSystem();
    return () => {
      cancelled = true;
    };
  }, [activeSystem, propOrganSystem]);

  const handleSyntaxChange = (nextMarkdown: string) => {
    setSyntaxInput(nextMarkdown);
    const parsed = parseMarkdownMindMapTriples(activeSystem, nextMarkdown);
    const nextGraph = buildGraphFromTriples(parsed);
    setNodes(nextGraph.nodes);
    setEdges(nextGraph.edges);
  };

  const handleNodeClick: NodeMouseHandler<Node<MindMapNodeData>> = useCallback((_event, node) => {
    const data = node.data;
    if (data?.isBridge && data.targetOrganSystem) {
      setSelectedPortalNode({
        nodeId: node.id,
        label: data.rawLabel || String(data.label),
        targetOrganSystem: data.targetOrganSystem,
      });
      return;
    }

    const rawText = String(data?.label ?? node.id);
    if (rawText.includes("::")) {
      const [prefix, rest] = rawText.replace(/^🌐\s*\[|\]$/g, "").split("::");
      const matched = CANONICAL_ORGAN_SYSTEMS.find(
        (s) => s.toLowerCase() === prefix.trim().toLowerCase()
      );
      if (matched) {
        setSelectedPortalNode({
          nodeId: node.id,
          label: (rest || node.id).trim(),
          targetOrganSystem: matched,
        });
        return;
      }
    }

    setSelectedPortalNode(null);
  }, []);

  const handleExtractViaColab = async () => {
    const tunnelUrl = getNgrokGrader().getTunnelUrl();
    if (!tunnelUrl) return;
    setExtractingColab(true);
    try {
      const resp = await fetch(`${tunnelUrl}/extract-mindmap-triples`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organ_system: activeSystem,
          markdown_text: syntaxInput,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.triples) && data.triples.length > 0) {
          const formattedLines = data.triples
            .map(
              (t: any) =>
                `[${t.source_node}] --(${t.linking_phrase})--> [${
                  t.is_cross_system_bridge && t.target_organ_system
                    ? `${t.target_organ_system}::${t.target_node}`
                    : t.target_node
                }]`
            )
            .join("\n");
          const wrapped = `\`\`\`mindmap\n${formattedLines}\n\`\`\``;
          handleSyntaxChange(wrapped);
        }
      }
    } finally {
      setExtractingColab(false);
    }
  };

  const triples = parseMarkdownMindMapTriples(activeSystem, syntaxInput);
  const crossSystemBridges = triples.filter((t) => t.isCrossSystemBridge);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px", height: "100%" }}>
      <div
        className="liquid-card"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <label style={{ fontSize: "12.5px", color: "#94a3b8" }}>Organ System:</label>
          <select
            className="liquid-select"
            style={{ width: "220px" }}
            value={activeSystem}
            onChange={(e) => handleSelectSystem(e.target.value as OrganSystem)}
          >
            {CANONICAL_ORGAN_SYSTEMS.map((sys) => (
              <option key={sys} value={sys}>
                {sys}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          {selectedPortalNode && (
            <button
              className="liquid-btn"
              style={{
                background: "linear-gradient(135deg, rgba(16, 185, 129, 0.32), rgba(56, 189, 248, 0.28))",
                borderColor: "rgba(52, 211, 153, 0.75)",
                fontSize: "12px",
              }}
              onClick={() => handleSelectSystem(selectedPortalNode.targetOrganSystem)}
            >
              🚀 Jump to {selectedPortalNode.targetOrganSystem} ({selectedPortalNode.label})
            </button>
          )}
          {crossSystemBridges.map((b) => (
            <button
              key={b.id}
              className="liquid-btn"
              style={{
                background: "rgba(99, 102, 241, 0.22)",
                borderColor: "rgba(129, 140, 248, 0.55)",
                fontSize: "11.5px",
              }}
              onClick={() => b.targetOrganSystem && handleSelectSystem(b.targetOrganSystem)}
            >
              🌐 Jump to {b.targetOrganSystem} ({b.targetNode})
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

      <div
        style={{ position: "relative", height: "380px", borderRadius: "14px", overflow: "hidden" }}
        className="liquid-card"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={handleNodeClick}
          fitView
        >
          <Background color="rgba(148, 163, 184, 0.18)" gap={20} />
          <Controls />
        </ReactFlow>

        {selectedPortalNode && (
          <div
            style={{
              position: "absolute",
              bottom: 16,
              right: 16,
              zIndex: 25,
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "10px 14px",
              borderRadius: "12px",
              background: "rgba(15, 23, 42, 0.92)",
              border: "1px solid rgba(129, 140, 248, 0.65)",
              boxShadow: "0 12px 28px rgba(2, 6, 23, 0.75)",
            }}
          >
            <span style={{ fontSize: "12px", color: "#e2e8f0" }}>
              Portal Selected: <strong>{selectedPortalNode.targetOrganSystem}::{selectedPortalNode.label}</strong>
            </span>
            <button
              className="liquid-btn"
              style={{ padding: "5px 11px", fontSize: "11.5px" }}
              onClick={() => handleSelectSystem(selectedPortalNode.targetOrganSystem)}
            >
              Jump to {selectedPortalNode.targetOrganSystem} &rarr;
            </button>
          </div>
        )}
      </div>

      <div className="liquid-card">
        <label style={{ display: "block", fontSize: "12px", color: "#94a3b8", marginBottom: "6px" }}>
          Dual-Syntax Vault Note (<code>E:\StudyApp\MyFiles\vault\{activeSystem}.md</code> — only{" "}
          <code>```mindmap</code> blocks are parsed into graph nodes)
        </label>
        <textarea
          className="liquid-textarea"
          rows={6}
          value={syntaxInput}
          onChange={(e) => handleSyntaxChange(e.target.value)}
        />
      </div>
    </div>
  );
};
