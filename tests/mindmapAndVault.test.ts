import { describe, expect, it, beforeEach, vi } from "vitest";

const storageMap = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: vi.fn((k: string) => storageMap.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void storageMap.set(k, v)),
    removeItem: vi.fn((k: string) => void storageMap.delete(k)),
    clear: vi.fn(() => void storageMap.clear()),
  },
  writable: true,
});

import {
  extractMindMapCodeBlocks,
  parseMarkdownMindMapTriples,
  buildGraphFromTriples,
  appendTripleToVaultMarkdown,
  DEFAULT_SYSTEM_VAULT_MARKDOWN,
} from "../src/components/mindmap/MindMapCanvas";
import { parseThoughtAnchors } from "../src/components/vault/VaultReader";
import { CANONICAL_ORGAN_SYSTEMS } from "../src/types/study";

describe("Phase 7 & 8 MindMap Dual-Syntax & Portal Navigation", () => {
  beforeEach(() => {
    storageMap.clear();
  });

  it("ignores standard Markdown outside ```mindmap fenced blocks", () => {
    const md = `# Renal Physiology
[Outside Node A] --(should be ignored outside mindmap fence)--> [Outside Node B]

\`\`\`mindmap
[Macula Densa] --(releases adenosine to constrict)--> [Afferent Arteriole]
\`\`\`

Some trailing text with [Another Fake Node] --(ignored)--> [Target].`;

    const extracted = extractMindMapCodeBlocks(md);
    expect(extracted).toBe("[Macula Densa] --(releases adenosine to constrict)--> [Afferent Arteriole]");

    const triples = parseMarkdownMindMapTriples("Renal", md);
    expect(triples).toHaveLength(1);
    expect(triples[0].sourceNode).toBe("Macula Densa");
    expect(triples[0].targetNode).toBe("Afferent Arteriole");
    expect(triples[0].isCrossSystemBridge).toBe(false);
  });

  it("detects cross-system portal bridges (System::Node) and builds portal node metadata", () => {
    const md = `\`\`\`mindmap
[Angiotensin II] --(increases systemic arterial afterload and venous return in)--> [Cardiovascular::Left Ventricular Preload]
\`\`\``;

    const triples = parseMarkdownMindMapTriples("Renal", md);
    expect(triples).toHaveLength(1);
    expect(triples[0].isCrossSystemBridge).toBe(true);
    expect(triples[0].targetOrganSystem).toBe("Cardiovascular");
    expect(triples[0].targetNode).toBe("Left Ventricular Preload");

    const { nodes, edges } = buildGraphFromTriples(triples);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    const bridgeNode = nodes.find((n) => n.id === "Left Ventricular Preload");
    expect(bridgeNode).toBeDefined();
    expect(bridgeNode?.data.isBridge).toBe(true);
    expect(bridgeNode?.data.targetOrganSystem).toBe("Cardiovascular");
    expect(bridgeNode?.data.label).toContain("Cardiovascular::Left Ventricular Preload");
  });

  it("caps linking phrases at 30 words per Constitution Section 6.2", () => {
    const fortyWords = Array.from({ length: 40 }, (_, i) => `w${i + 1}`).join(" ");
    const md = `\`\`\`mindmap\n[Node 1] --(${fortyWords})--> [Node 2]\n\`\`\``;
    const triples = parseMarkdownMindMapTriples("Renal", md);
    expect(triples[0].linkingPhrase.split(/\s+/)).toHaveLength(30);
  });

  it("appends promoted triples inside existing ```mindmap block without corrupting prose", () => {
    const base = DEFAULT_SYSTEM_VAULT_MARKDOWN.Renal;
    const updated = appendTripleToVaultMarkdown(
      base,
      "[Podocyte Foot Processes] --(form slit diaphragms across)--> [Glomerular Basement Membrane]"
    );
    const triples = parseMarkdownMindMapTriples("Renal", updated);
    expect(triples.some((t) => t.sourceNode === "Podocyte Foot Processes")).toBe(true);
  });

  it("provides valid default dual-syntax markdown for all 12 canonical organ systems", () => {
    for (const sys of CANONICAL_ORGAN_SYSTEMS) {
      const md = DEFAULT_SYSTEM_VAULT_MARKDOWN[sys];
      expect(md).toBeTruthy();
      const triples = parseMarkdownMindMapTriples(sys, md);
      expect(triples.length).toBeGreaterThan(0);
    }
  });

  it("parses both single-line and multi-line thought anchors in VaultReader", () => {
    const md = DEFAULT_SYSTEM_VAULT_MARKDOWN.Renal;
    const anchors = parseThoughtAnchors(md);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].id).toBe("ta_renal_01");
    expect(anchors[0].text).toContain("bilateral renal artery stenosis");
  });
});
