import React, { useCallback, useEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";
import {
  ReactFlow,
  Background,
  Controls,
  Node,
  Edge,
  MarkerType,
  NodeMouseHandler,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
  Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { readTextFile, writeTextFile, writeFile, mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { ensureAppDataDirectories, resolveAppDataSubPath } from "../../lib/appPaths";
import Database from "@tauri-apps/plugin-sql";
import { CANONICAL_ORGAN_SYSTEMS, OrganSystem } from "../../types/study";
import { getNgrokGrader, SQLITE_DB_URI } from "../../services/ngrokGrader";
import {
  extractMindMapTriplesWithGemma,
  GEMMA_31B_MODEL_ID,
  getDualTunnelConfig,
  hasAiStudioApiKey,
} from "../../services/aiStudio";

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

export const VAULT_STORAGE_PREFIX = "studyapp_vault_md_";
export const NODE_POS_STORAGE_PREFIX = "studyapp_mindmap_pos_";

export const DEFAULT_SYSTEM_VAULT_MARKDOWN: Record<OrganSystem, string> = {
  Renal: `# Glomerular Filtration & Tubuloglomerular Feedback (TGF)

The renal corpuscle autoregulates GFR across systemic pressures (80–180 mmHg) via myogenic stretch and macula densa paracrine signaling.

\`\`\`mindmap
[Macula Densa NaCl Delivery] --(triggers adenosine A1 receptor vasoconstriction of)--> [Afferent Arteriole]
[Afferent Arteriole] --(lowers hydrostatic pressure inside)--> [Glomerular Capillaries]
[Juxtaglomerular Granular Cells] --(secrete renin in response to beta-1 and low NaCl to generate)--> [Angiotensin II]
[Angiotensin II] --(preferentially constricts AT1 receptors on)--> [Efferent Arteriole]
[Angiotensin II] --(increases systemic arterial afterload and venous return in)--> [Cardiovascular::Left Ventricular Preload]
\`\`\`

<!-- thought-anchor:ta_renal_01 -->
> **[AI Margin Note #ta_renal_01]:** In bilateral renal artery stenosis, glomerular hydrostatic pressure is critically dependent on Angiotensin II-mediated efferent arteriolar tone. Starting an ACE inhibitor removes this constriction and causes an acute rise in serum creatinine.
<!-- /thought-anchor:ta_renal_01 -->`,
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

export interface MindMapHistorySnapshot {
  markdown: string;
  nodes: Node<MindMapNodeData>[];
  edges: Edge[];
}

/**
 * Pure Undo/Redo state history controller for ReactFlow MindMap state transitions.
 */
export function createMindMapHistoryManager(initialMarkdown: string = "") {
  let past: string[] = [];
  let present: string = initialMarkdown;
  let future: string[] = [];

  return {
    getPresent: () => present,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    pushState: (nextMarkdown: string) => {
      if (nextMarkdown === present) return present;
      past = [...past, present];
      present = nextMarkdown;
      future = [];
      return present;
    },
    undo: (): string | null => {
      if (past.length === 0) return null;
      const previous = past[past.length - 1];
      past = past.slice(0, -1);
      future = [present, ...future];
      present = previous;
      return present;
    },
    redo: (): string | null => {
      if (future.length === 0) return null;
      const next = future[0];
      future = future.slice(1);
      past = [...past, present];
      present = next;
      return present;
    },
  };
}

export function dataUrlToPngBytes(dataUrl: string): Uint8Array {
  const base64Part = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  const binary = atob(base64Part);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Rasterizes the ReactFlow MindMap canvas to a PNG via `html-to-image` (`toPng`)
 * and saves it natively to `$APPLOCALDATA/images/<filename>.png`.
 */
export async function exportMindMapCanvasToPng(
  canvasElement: HTMLElement | null,
  organSystem: OrganSystem,
  options: {
    timestampSecs?: number;
    toPngImpl?: typeof toPng;
    writeBinaryFn?: (path: string, bytes: Uint8Array) => Promise<void>;
  } = {}
): Promise<{ savedImagePath: string; filename: string; pngBytes: Uint8Array }> {
  const ts = options.timestampSecs ?? Math.floor(Date.now() / 1000);
  const safeSys = getSafeVaultFilename(organSystem);
  const filename = `mindmap_${safeSys}_${ts}.png`;
  const savedImagePath = await resolveAppDataSubPath("images", filename);

  let dataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const rasterizeFn = options.toPngImpl ?? toPng;
  if (canvasElement) {
    try {
      dataUrl = await rasterizeFn(canvasElement, {
        cacheBust: true,
        backgroundColor: "#090f1d",
      });
    } catch {
      // Fallback in headless environment
    }
  }

  const pngBytes = dataUrlToPngBytes(dataUrl);
  if (options.writeBinaryFn) {
    await options.writeBinaryFn(savedImagePath, pngBytes);
  } else {
    try {
      await mkdir("images", { baseDir: BaseDirectory.AppLocalData, recursive: true });
      await writeFile(`images/${filename}`, pngBytes, {
        baseDir: BaseDirectory.AppLocalData,
      });
    } catch {
      // Safe fallback in headless environment
    }
  }

  return {
    savedImagePath,
    filename,
    pngBytes,
  };
}

export function getSafeVaultFilename(organSystem: OrganSystem): string {
  return organSystem.replace(/[^A-Za-z0-9_-]+/g, "_");
}

export async function resolveDynamicVaultNotePath(organSystem: OrganSystem): Promise<string> {
  const safeName = getSafeVaultFilename(organSystem);
  try {
    const base = await appLocalDataDir();
    return await join(base, "vault", `${safeName}.md`);
  } catch {
    return resolveAppDataSubPath("vault", `${safeName}.md`);
  }
}

export async function readOrganSystemVaultMarkdown(organSystem: OrganSystem): Promise<string> {
  const safeName = getSafeVaultFilename(organSystem);
  const relVaultPath = `vault/${safeName}.md`;
  try {
    await ensureAppDataDirectories();
    const diskText = await readTextFile(relVaultPath, { baseDir: BaseDirectory.AppLocalData });
    if (diskText && diskText.trim().length > 0) {
      try {
        localStorage.setItem(`${VAULT_STORAGE_PREFIX}${organSystem}`, diskText);
      } catch {
        // ignore storage error
      }
      return diskText;
    }
  } catch {
    try {
      const fullPath = await resolveDynamicVaultNotePath(organSystem);
      const diskText = await readTextFile(fullPath);
      if (diskText && diskText.trim().length > 0) {
        return diskText;
      }
    } catch {
      // Fallback to localStorage or built-in system markdown
    }
  }

  try {
    const cached = localStorage.getItem(`${VAULT_STORAGE_PREFIX}${organSystem}`);
    if (cached && cached.trim().length > 0) {
      return cached;
    }
  } catch {
    // ignore storage error
  }

  return DEFAULT_SYSTEM_VAULT_MARKDOWN[organSystem];
}

export async function writeOrganSystemVaultMarkdown(
  organSystem: OrganSystem,
  markdownContent: string
): Promise<void> {
  try {
    localStorage.setItem(`${VAULT_STORAGE_PREFIX}${organSystem}`, markdownContent);
  } catch {
    // ignore storage error
  }

  const safeName = getSafeVaultFilename(organSystem);
  const relVaultPath = `vault/${safeName}.md`;
  try {
    await mkdir("vault", { baseDir: BaseDirectory.AppLocalData, recursive: true });
    await writeTextFile(relVaultPath, markdownContent, { baseDir: BaseDirectory.AppLocalData });
  } catch {
    try {
      const fullPath = await resolveDynamicVaultNotePath(organSystem);
      await writeTextFile(fullPath, markdownContent);
    } catch {
      // Safe fallback in browser preview
    }
  }
}

export function appendTripleToVaultMarkdown(
  markdownContent: string,
  tripleLine: string
): string {
  const blockRegex = /(```mindmap\s*[\s\S]*?)(```)/i;
  if (blockRegex.test(markdownContent)) {
    return markdownContent.replace(blockRegex, (_full, body: string, close: string) => {
      const trimmed = body.replace(/\s+$/, "");
      return `${trimmed}\n${tripleLine}\n${close}`;
    });
  }
  return `${markdownContent.trim()}\n\n\`\`\`mindmap\n${tripleLine}\n\`\`\`\n`;
}

export function replaceMindMapBlockWithTriples(
  markdownContent: string,
  triples: Array<{
    sourceNode: string;
    linkingPhrase: string;
    targetNode: string;
    isCrossSystemBridge?: boolean;
    targetOrganSystem?: OrganSystem;
  }>
): string {
  const lines = triples.map((t) => {
    const phrase = t.linkingPhrase.trim().split(/\s+/).slice(0, 30).join(" ");
    const tgt =
      t.isCrossSystemBridge && t.targetOrganSystem
        ? `${t.targetOrganSystem}::${t.targetNode.trim()}`
        : t.targetNode.trim();
    return `[${t.sourceNode.trim()}] --(${phrase})--> [${tgt}]`;
  });
  const newBlock = `\`\`\`mindmap\n${lines.join("\n")}\n\`\`\``;
  const blockRegex = /```mindmap\s*[\s\S]*?```/i;
  if (blockRegex.test(markdownContent)) {
    return markdownContent.replace(blockRegex, newBlock);
  }
  return `${markdownContent.trim()}\n\n${newBlock}\n`;
}

export function renameNodeInMarkdown(
  organSystem: OrganSystem,
  markdownContent: string,
  oldLabel: string,
  newLabel: string
): string {
  const cleanNew = newLabel.replace(/[\[\]\r\n]+/g, " ").trim();
  if (!cleanNew || cleanNew === oldLabel) return markdownContent;
  const parsed = parseMarkdownMindMapTriples(organSystem, markdownContent);
  const updated = parsed.map((t) => ({
    ...t,
    sourceNode: t.sourceNode === oldLabel ? cleanNew : t.sourceNode,
    targetNode: t.targetNode === oldLabel ? cleanNew : t.targetNode,
  }));
  return replaceMindMapBlockWithTriples(markdownContent, updated);
}

export function deleteNodeFromMarkdown(
  organSystem: OrganSystem,
  markdownContent: string,
  nodeLabel: string
): string {
  const parsed = parseMarkdownMindMapTriples(organSystem, markdownContent);
  const remaining = parsed.filter(
    (t) => t.sourceNode !== nodeLabel && t.targetNode !== nodeLabel
  );
  return replaceMindMapBlockWithTriples(markdownContent, remaining);
}

export function deleteEdgeFromMarkdown(
  organSystem: OrganSystem,
  markdownContent: string,
  edgeIdOrPair: { id?: string; source?: string; target?: string }
): string {
  const parsed = parseMarkdownMindMapTriples(organSystem, markdownContent);
  const remaining = parsed.filter((t) => {
    if (edgeIdOrPair.id && t.id === edgeIdOrPair.id) return false;
    if (
      edgeIdOrPair.source &&
      edgeIdOrPair.target &&
      t.sourceNode === edgeIdOrPair.source &&
      t.targetNode === edgeIdOrPair.target
    ) {
      return false;
    }
    return true;
  });
  return replaceMindMapBlockWithTriples(markdownContent, remaining);
}

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

export function loadSavedNodePositions(
  organSystem: OrganSystem
): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(`${NODE_POS_STORAGE_PREFIX}${organSystem}`);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return {};
}

export function saveNodePosition(
  organSystem: OrganSystem,
  nodeId: string,
  pos: { x: number; y: number }
): void {
  try {
    const map = loadSavedNodePositions(organSystem);
    map[nodeId] = { x: Math.round(pos.x), y: Math.round(pos.y) };
    localStorage.setItem(`${NODE_POS_STORAGE_PREFIX}${organSystem}`, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export function buildGraphFromTriples(
  triples: ParsedTriple[],
  savedPositions: Record<string, { x: number; y: number }> = {}
): {
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
    position: savedPositions[item.id] ?? {
      x: (idx % 2) * 380 + 60,
      y: Math.floor(idx / 2) * 145 + 40,
    },
    draggable: true,
    selectable: true,
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
        ? "rgba(99, 102, 241, 0.30)"
        : "rgba(15, 23, 42, 0.86)",
      color: "#f8fafc",
      border: item.isBridge
        ? "1.5px solid #818cf8"
        : "1px solid rgba(56, 189, 248, 0.55)",
      borderRadius: "12px",
      padding: "10px 14px",
      fontSize: "12.5px",
      fontWeight: 600,
      width: 250,
      cursor: item.isBridge ? "pointer" : "grab",
      boxShadow: item.isBridge
        ? "0 8px 24px -4px rgba(99, 102, 241, 0.35), inset 0 1px 0 0 rgba(255,255,255,0.22)"
        : "0 8px 20px -4px rgba(2, 6, 23, 0.65), inset 0 1px 0 0 rgba(255,255,255,0.16)",
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeRenameText, setSelectedNodeRenameText] = useState<string>("");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedPortalNode, setSelectedPortalNode] = useState<{
    nodeId: string;
    label: string;
    targetOrganSystem: OrganSystem;
  } | null>(null);
  const [extractingColab, setExtractingColab] = useState<boolean>(false);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null);

  const [newSourceNode, setNewSourceNode] = useState<string>("");
  const [newLinkingPhrase, setNewLinkingPhrase] = useState<string>("");
  const [newTargetNode, setNewTargetNode] = useState<string>("");
  const [newBridgeSystem, setNewBridgeSystem] = useState<string>("");
  const [saveToast, setSaveToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setSaveToast(msg);
    window.setTimeout(() => setSaveToast(null), 4000);
  };

  const handleSelectSystem = useCallback(
    (nextSystem: OrganSystem) => {
      setInternalSystem(nextSystem);
      setSelectedPortalNode(null);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      onOrganSystemChange?.(nextSystem);
    },
    [onOrganSystemChange]
  );

  useEffect(() => {
    let cancelled = false;
    setSelectedPortalNode(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);

    const loadVaultMarkdownForSystem = async () => {
      const markdownContent = await readOrganSystemVaultMarkdown(activeSystem);
      if (cancelled) return;
      setSyntaxInput(markdownContent);
      const parsed = parseMarkdownMindMapTriples(activeSystem, markdownContent);
      const savedPos = loadSavedNodePositions(activeSystem);
      const nextGraph = buildGraphFromTriples(parsed, savedPos);
      setNodes(nextGraph.nodes);
      setEdges(nextGraph.edges);
    };

    void loadVaultMarkdownForSystem();
    return () => {
      cancelled = true;
    };
  }, [activeSystem, propOrganSystem]);

  const persistGraphToSqlite = async (system: OrganSystem, parsedTriples: ParsedTriple[]) => {
    try {
      const db = await Database.load(SQLITE_DB_URI);
      const posMap = loadSavedNodePositions(system);
      for (const idx of parsedTriples.keys()) {
        const t = parsedTriples[idx];
        const srcId = `node_${system}_${t.sourceNode.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
        const tgtId = `node_${system}_${t.targetNode.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
        const srcPos = posMap[t.sourceNode] ?? { x: (idx % 2) * 380 + 60, y: Math.floor(idx / 2) * 145 + 40 };
        const tgtPos = posMap[t.targetNode] ?? { x: 440, y: Math.floor(idx / 2) * 145 + 100 };
        await db.execute(
          `INSERT OR REPLACE INTO mindmap_nodes (id, organ_system, label, position_x, position_y)
           VALUES ($1, $2, $3, $4, $5)`,
          [srcId, system, t.sourceNode, srcPos.x, srcPos.y]
        );
        await db.execute(
          `INSERT OR REPLACE INTO mindmap_nodes (id, organ_system, label, position_x, position_y)
           VALUES ($1, $2, $3, $4, $5)`,
          [tgtId, t.targetOrganSystem ?? system, t.targetNode, tgtPos.x, tgtPos.y]
        );
        await db.execute(
          `INSERT OR REPLACE INTO mindmap_edges (id, source_node_id, target_node_id, linking_phrase, is_cross_system_bridge, target_organ_system)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            t.id,
            srcId,
            tgtId,
            t.linkingPhrase.slice(0, 240),
            t.isCrossSystemBridge ? 1 : 0,
            t.targetOrganSystem ?? null,
          ]
        );
      }
    } catch {
      // Safe fallback in browser preview
    }
  };

  const handleSyntaxChange = useCallback(
    (nextMarkdown: string) => {
      setUndoStack((prev) => [...prev, syntaxInput]);
      setRedoStack([]);
      setSyntaxInput(nextMarkdown);
      const parsed = parseMarkdownMindMapTriples(activeSystem, nextMarkdown);
      const savedPos = loadSavedNodePositions(activeSystem);
      const nextGraph = buildGraphFromTriples(parsed, savedPos);
      setNodes(nextGraph.nodes);
      setEdges(nextGraph.edges);
      void writeOrganSystemVaultMarkdown(activeSystem, nextMarkdown);
      void persistGraphToSqlite(activeSystem, parsed);
    },
    [activeSystem]
  );

  const onNodesChange: OnNodesChange<Node<MindMapNodeData>> = useCallback(
    (changes) => {
      setNodes((nds) => {
        const updated = applyNodeChanges(changes, nds);
        for (const ch of changes) {
          if (ch.type === "position" && ch.position && ch.id) {
            saveNodePosition(activeSystem, ch.id, ch.position);
          }
        }
        return updated;
      });
    },
    [activeSystem]
  );

  const onEdgesChange: OnEdgesChange<Edge> = useCallback(
    (changes) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
      for (const ch of changes) {
        if (ch.type === "remove" && ch.id) {
          const updatedMd = deleteEdgeFromMarkdown(activeSystem, syntaxInput, { id: ch.id });
          handleSyntaxChange(updatedMd);
        }
      }
    },
    [activeSystem, syntaxInput, handleSyntaxChange]
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      const defaultPhrase = "physiologically regulates";
      const tripleLine = `[${connection.source}] --(${defaultPhrase})--> [${connection.target}]`;
      const updatedMd = appendTripleToVaultMarkdown(syntaxInput, tripleLine);
      handleSyntaxChange(updatedMd);
      showToast(`Connected [${connection.source}] → [${connection.target}]`);
    },
    [syntaxInput, handleSyntaxChange]
  );

  const handleUndoMindMap = () => {
    if (undoStack.length === 0) return;
    const prevMd = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [syntaxInput, ...prev]);
    setSyntaxInput(prevMd);
    const parsed = parseMarkdownMindMapTriples(activeSystem, prevMd);
    const nextGraph = buildGraphFromTriples(parsed, loadSavedNodePositions(activeSystem));
    setNodes(nextGraph.nodes);
    setEdges(nextGraph.edges);
    void writeOrganSystemVaultMarkdown(activeSystem, prevMd);
  };

  const handleRedoMindMap = () => {
    if (redoStack.length === 0) return;
    const nextMd = redoStack[0];
    setRedoStack((prev) => prev.slice(1));
    setUndoStack((prev) => [...prev, syntaxInput]);
    setSyntaxInput(nextMd);
    const parsed = parseMarkdownMindMapTriples(activeSystem, nextMd);
    const nextGraph = buildGraphFromTriples(parsed, loadSavedNodePositions(activeSystem));
    setNodes(nextGraph.nodes);
    setEdges(nextGraph.edges);
    void writeOrganSystemVaultMarkdown(activeSystem, nextMd);
  };

  const handleExportPng = async () => {
    const res = await exportMindMapCanvasToPng(canvasWrapperRef.current, activeSystem);
    showToast(`Exported MindMap PNG to ${res.savedImagePath}`);
  };

  const handleAddTriple = async () => {
    if (!newSourceNode.trim() || !newLinkingPhrase.trim() || !newTargetNode.trim()) return;
    const cappedPhrase = newLinkingPhrase.trim().split(/\s+/).slice(0, 30).join(" ");
    const targetExpr =
      newBridgeSystem && newBridgeSystem !== activeSystem
        ? `${newBridgeSystem}::${newTargetNode.trim()}`
        : newTargetNode.trim();
    const tripleLine = `[${newSourceNode.trim()}] --(${cappedPhrase})--> [${targetExpr}]`;
    const updatedMd = appendTripleToVaultMarkdown(syntaxInput, tripleLine);
    handleSyntaxChange(updatedMd);
    setNewSourceNode("");
    setNewLinkingPhrase("");
    setNewTargetNode("");
    setNewBridgeSystem("");
    showToast(`Added triple to ${activeSystem}.md & SQLite mindmap_edges`);
  };

  const handleRenameSelectedNode = () => {
    if (!selectedNodeId || !selectedNodeRenameText.trim()) return;
    const updatedMd = renameNodeInMarkdown(
      activeSystem,
      syntaxInput,
      selectedNodeId,
      selectedNodeRenameText.trim()
    );
    handleSyntaxChange(updatedMd);
    setSelectedNodeId(selectedNodeRenameText.trim());
    showToast(`Renamed node "${selectedNodeId}" → "${selectedNodeRenameText.trim()}"`);
  };

  const handleDeleteSelectedNode = () => {
    if (!selectedNodeId) return;
    const updatedMd = deleteNodeFromMarkdown(activeSystem, syntaxInput, selectedNodeId);
    handleSyntaxChange(updatedMd);
    setSelectedNodeId(null);
    setSelectedPortalNode(null);
    showToast(`Deleted node "${selectedNodeId}" and its incident edges`);
  };

  const handleDeleteSelectedEdge = () => {
    if (!selectedEdgeId) return;
    const updatedMd = deleteEdgeFromMarkdown(activeSystem, syntaxInput, { id: selectedEdgeId });
    handleSyntaxChange(updatedMd);
    setSelectedEdgeId(null);
    showToast(`Removed causal edge ${selectedEdgeId}`);
  };

  const handleNodeClick: NodeMouseHandler<Node<MindMapNodeData>> = useCallback((_event, node) => {
    const data = node.data;
    const rawName = data?.rawLabel || node.id;
    setSelectedNodeId(rawName);
    setSelectedNodeRenameText(rawName);
    setSelectedEdgeId(null);

    if (data?.isBridge && data.targetOrganSystem) {
      setSelectedPortalNode({
        nodeId: node.id,
        label: rawName,
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

  const handleNodeDoubleClick: NodeMouseHandler<Node<MindMapNodeData>> = useCallback(
    (_event, node) => {
      const data = node.data;
      if (data?.isBridge && data.targetOrganSystem) {
        handleSelectSystem(data.targetOrganSystem);
      }
    },
    [handleSelectSystem]
  );

  useEffect(() => {
    const onOmnibarMutation = (event: Event) => {
      const custom = event as CustomEvent<{
        organSystem?: OrganSystem;
        updatedMarkdown?: string;
        mutation?: { summary?: string };
      }>;
      const detail = custom.detail;
      if (!detail || !detail.updatedMarkdown) return;
      if (detail.organSystem && detail.organSystem !== activeSystem) {
        setInternalSystem(detail.organSystem);
      }
      setSyntaxInput(detail.updatedMarkdown);
      const parsed = parseMarkdownMindMapTriples(
        detail.organSystem || activeSystem,
        detail.updatedMarkdown
      );
      const savedPos = loadSavedNodePositions(detail.organSystem || activeSystem);
      const nextGraph = buildGraphFromTriples(parsed, savedPos);
      setNodes(nextGraph.nodes);
      setEdges(nextGraph.edges);
      void persistGraphToSqlite(detail.organSystem || activeSystem, parsed);
      if (detail.mutation?.summary) {
        showToast(detail.mutation.summary);
      }
    };
    window.addEventListener("convergence:omnibar-mindmap-update", onOmnibarMutation);
    return () =>
      window.removeEventListener("convergence:omnibar-mindmap-update", onOmnibarMutation);
  }, [activeSystem]);

  const handleExtractViaColab = async () => {
    const dualCfg = getDualTunnelConfig();
    if (hasAiStudioApiKey() && dualCfg.preferGemmaWhenKeyPresent) {
      setExtractingColab(true);
      try {
        const gemmaTriples = await extractMindMapTriplesWithGemma(syntaxInput, activeSystem);
        if (gemmaTriples.length > 0) {
          let nextMd = syntaxInput;
          for (const t of gemmaTriples) {
            const targetExpr =
              t.is_cross_system_bridge && t.target_organ_system
                ? `${t.target_organ_system}::${t.target_node}`
                : t.target_node;
            nextMd = appendTripleToVaultMarkdown(
              nextMd,
              `[${t.source_node}] --(${t.linking_phrase})--> [${targetExpr}]`
            );
          }
          handleSyntaxChange(nextMd);
          showToast(`Extracted ${gemmaTriples.length} triples via ${GEMMA_31B_MODEL_ID}`);
          setExtractingColab(false);
          return;
        }
      } catch {
        // Fall through to secondary Colab Fleet tunnel
      } finally {
        setExtractingColab(false);
      }
    }
    const grader = getNgrokGrader();
    const tunnelUrl = grader.getTunnelUrl();
    if (!tunnelUrl) {
      showToast("Configure Colab 3B Ngrok Tunnel URL in the topbar first.");
      return;
    }
    setExtractingColab(true);
    try {
      const fleetToken = localStorage.getItem("studyapp_fleet_token") || "studyapp-local-secret";
      const resp = await fetch(`${tunnelUrl}/extract-mindmap-triples`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fleet-Token": fleetToken,
          "ngrok-skip-browser-warning": "true",
        },
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
                `[${t.source_node || t.source}] --(${t.linking_phrase})--> [${
                  t.is_cross_system_bridge && t.target_organ_system
                    ? `${t.target_organ_system}::${t.target_node || t.target}`
                    : t.target_node || t.target
                }]`
            )
            .join("\n");
          const wrapped = `\`\`\`mindmap\n${formattedLines}\n\`\`\``;
          handleSyntaxChange(wrapped);
          showToast(`Extracted ${data.triples.length} triples via Colab 3B`);
        }
      }
    } catch {
      showToast("Colab 3B tunnel unreachable — using local deterministic parser.");
    } finally {
      setExtractingColab(false);
    }
  };

  const triples = parseMarkdownMindMapTriples(activeSystem, syntaxInput);
  const crossSystemBridges = triples.filter((t) => t.isCrossSystemBridge);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px", height: "100%" }}>
      {saveToast && (
        <div
          className="liquid-card"
          style={{
            padding: "9px 14px",
            fontSize: "12.5px",
            borderColor: "rgba(52, 211, 153, 0.5)",
            background: "rgba(6, 78, 59, 0.35)",
          }}
        >
          {saveToast}
        </div>
      )}

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
            onClick={() => void handleExtractViaColab()}
            disabled={extractingColab}
          >
            {extractingColab ? "Extracting..." : "Colab 3B Auto-Extract Triples"}
          </button>
          <button
            className="liquid-btn liquid-btn-secondary"
            data-testid="mindmap-undo-btn"
            disabled={undoStack.length === 0}
            onClick={handleUndoMindMap}
          >
            ↶ Undo
          </button>
          <button
            className="liquid-btn liquid-btn-secondary"
            data-testid="mindmap-redo-btn"
            disabled={redoStack.length === 0}
            onClick={handleRedoMindMap}
          >
            ↷ Redo
          </button>
          <button
            className="liquid-btn liquid-btn-secondary"
            data-testid="mindmap-export-png-btn"
            onClick={() => void handleExportPng()}
          >
            🖼 Export PNG
          </button>
        </div>
      </div>

      <div className="liquid-card" style={{ padding: "12px 16px" }}>
        <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "8px" }}>
          Add Physiological Causal Link (auto-appends to <code>```mindmap</code> block in{" "}
          <code>$APPLOCALDATA/vault/{getSafeVaultFilename(activeSystem)}.md</code>)
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.6fr 1.2fr 1fr auto", gap: "8px" }}>
          <input
            className="liquid-input"
            placeholder="Source Node (e.g. Macula Densa)"
            value={newSourceNode}
            onChange={(e) => setNewSourceNode(e.target.value)}
          />
          <input
            className="liquid-input"
            placeholder="Linking phrase <= 30 words (e.g. releases adenosine to constrict)"
            value={newLinkingPhrase}
            onChange={(e) => setNewLinkingPhrase(e.target.value)}
          />
          <input
            className="liquid-input"
            placeholder="Target Node (e.g. Afferent Arteriole)"
            value={newTargetNode}
            onChange={(e) => setNewTargetNode(e.target.value)}
          />
          <select
            className="liquid-select"
            value={newBridgeSystem}
            onChange={(e) => setNewBridgeSystem(e.target.value)}
          >
            <option value="">Same System ({activeSystem})</option>
            {CANONICAL_ORGAN_SYSTEMS.filter((s) => s !== activeSystem).map((s) => (
              <option key={s} value={s}>
                Bridge &rarr; {s}
              </option>
            ))}
          </select>
          <button
            className="liquid-btn"
            onClick={() => void handleAddTriple()}
            disabled={!newSourceNode.trim() || !newLinkingPhrase.trim() || !newTargetNode.trim()}
          >
            + Add Link
          </button>
        </div>
      </div>

      {(selectedNodeId || selectedEdgeId) && (
        <div
          className="liquid-card"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "10px 14px",
            flexWrap: "wrap",
          }}
        >
          {selectedNodeId && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1 }}>
                <span style={{ fontSize: "12px", color: "#94a3b8" }}>Edit Node:</span>
                <input
                  className="liquid-input"
                  style={{ maxWidth: "260px" }}
                  value={selectedNodeRenameText}
                  onChange={(e) => setSelectedNodeRenameText(e.target.value)}
                />
                <button className="liquid-btn" onClick={handleRenameSelectedNode}>
                  Rename Node
                </button>
                <button
                  className="liquid-btn liquid-btn-secondary"
                  style={{ borderColor: "rgba(251, 113, 133, 0.45)", color: "#fb7185" }}
                  onClick={handleDeleteSelectedNode}
                >
                  Delete Node
                </button>
              </div>
              {selectedPortalNode && (
                <button
                  className="liquid-btn"
                  onClick={() => handleSelectSystem(selectedPortalNode.targetOrganSystem)}
                >
                  🌐 Jump to {selectedPortalNode.targetOrganSystem} Portal &rarr;
                </button>
              )}
            </>
          )}

          {selectedEdgeId && (
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "12px", color: "#cbd5e1" }}>
                Selected Causal Edge: <code>{selectedEdgeId}</code>
              </span>
              <button
                className="liquid-btn liquid-btn-secondary"
                style={{ borderColor: "rgba(251, 113, 133, 0.45)", color: "#fb7185" }}
                onClick={handleDeleteSelectedEdge}
              >
                Delete Edge
              </button>
            </div>
          )}
        </div>
      )}

      <div
        ref={canvasWrapperRef}
        data-testid="mindmap-canvas-export-surface"
        style={{ position: "relative", height: "360px", borderRadius: "14px", overflow: "hidden" }}
        className="liquid-card"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onEdgeClick={(_e, edge) => {
            setSelectedEdgeId(edge.id);
            setSelectedNodeId(null);
          }}
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
          Dual-Syntax Vault Note (<code>$APPLOCALDATA/vault/{getSafeVaultFilename(activeSystem)}.md</code> — only{" "}
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
