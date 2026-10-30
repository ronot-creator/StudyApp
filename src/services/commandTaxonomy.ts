export const ASSESSMENT_TAXONOMY_REGEX = /^\/q([smwt]+)(?:\s+(.*))?$/i;
export const COMPREHENSION_TAXONOMY_REGEX = /^\/u([ade]*)(?:\s+(.*))?$/i;
export const LEGACY_SHORTHAND_REGEX = /^\/(q|vault|context)\s+([^\r\n]+)$/i;

export type AssessmentFlag = "s" | "m" | "w" | "t";
export type ComprehensionFlag = "a" | "d" | "e";

export const ASSESSMENT_FLAG_LABELS: Record<AssessmentFlag, string> = {
  s: "Scenarios",
  m: "MCQ",
  w: "Written",
  t: "True/False",
};

export const COMPREHENSION_FLAG_LABELS: Record<ComprehensionFlag, string> = {
  a: "Analogy & Intuition",
  d: "Deep Mechanism & Derivation",
  e: "Exam & Clinical Pearl",
};

export interface TaxonomyWeightAllocation {
  flag: string;
  label: string;
  weightPct: number;
}

export interface ParsedCommandTaxonomy {
  mode: "assessment" | "comprehension" | "legacy_shorthand";
  rawCommand: string;
  flags: string[];
  allocations: TaxonomyWeightAllocation[];
  topic: string;
  masterPrompt: string;
}

/**
 * Parses `/q([smwt]+)` assessment permutations and `/u([ade]*)` comprehension permutations,
 * divides weights evenly across all provided flags, and constructs the invisible Gemma 31B Master Prompt.
 */
export function parseCommandTaxonomy(
  rawInput: string,
  vaultContextExcerpt: string = ""
): ParsedCommandTaxonomy | null {
  const trimmed = (rawInput || "").trim();
  if (!trimmed) return null;

  // 1. Check `/q([smwt]+)` assessment taxonomy
  const qMatch = ASSESSMENT_TAXONOMY_REGEX.exec(trimmed);
  if (qMatch) {
    const rawFlags = qMatch[1].toLowerCase().split("");
    const uniqueFlags = Array.from(new Set(rawFlags)).filter(
      (f): f is AssessmentFlag => f in ASSESSMENT_FLAG_LABELS
    );
    if (uniqueFlags.length === 0) return null;

    const topic = (qMatch[2] || "active vault notes").trim();
    const evenWeight = Number((100 / uniqueFlags.length).toFixed(2));
    const allocations: TaxonomyWeightAllocation[] = uniqueFlags.map((flag) => ({
      flag,
      label: ASSESSMENT_FLAG_LABELS[flag],
      weightPct: evenWeight,
    }));

    const weightSummary = allocations
      .map((a) => `${a.label} (${a.flag.toUpperCase()}): ${a.weightPct}%`)
      .join(", ");

    const masterPrompt = [
      `<!-- [INVISIBLE GEMMA 31B MASTER PROMPT — MODE: ASSESSMENT TAXONOMY]`,
      `Engine: gemma-4-31b-it | Command: ${trimmed}`,
      `Weight Distribution: ${weightSummary}`,
      vaultContextExcerpt ? `Local Vault Context:\n${vaultContextExcerpt}` : `Topic: ${topic}`,
      `Instruction: Generate a rigorous medical assessment on "${topic}" adhering strictly to the exact weight distribution (${weightSummary}).`,
      `[/INVISIBLE GEMMA 31B MASTER PROMPT] -->`,
      `Generate an assessment on "${topic}" [${weightSummary}].`,
    ].join("\n");

    return {
      mode: "assessment",
      rawCommand: trimmed,
      flags: uniqueFlags,
      allocations,
      topic,
      masterPrompt,
    };
  }

  // 2. Check `/u([ade]*)` comprehension routing taxonomy
  const uMatch = COMPREHENSION_TAXONOMY_REGEX.exec(trimmed);
  if (uMatch && (trimmed === "/u" || trimmed.startsWith("/u ") || /^\/u[ade]+(\s|$)/i.test(trimmed))) {
    const rawFlags = (uMatch[1] || "ade").toLowerCase().split("");
    const uniqueFlags = Array.from(new Set(rawFlags)).filter(
      (f): f is ComprehensionFlag => f in COMPREHENSION_FLAG_LABELS
    );
    const activeFlags: ComprehensionFlag[] =
      uniqueFlags.length > 0 ? uniqueFlags : ["a", "d", "e"];

    const topic = (uMatch[2] || "active vault notes").trim();
    const evenWeight = Number((100 / activeFlags.length).toFixed(2));
    const allocations: TaxonomyWeightAllocation[] = activeFlags.map((flag) => ({
      flag,
      label: COMPREHENSION_FLAG_LABELS[flag],
      weightPct: evenWeight,
    }));

    const weightSummary = allocations
      .map((a) => `${a.label} (${a.flag.toUpperCase()}): ${a.weightPct}%`)
      .join(", ");

    const masterPrompt = [
      `<!-- [INVISIBLE GEMMA 31B MASTER PROMPT — MODE: COMPREHENSION ROUTING]`,
      `Engine: gemma-4-31b-it | Command: ${trimmed}`,
      `Weight Distribution: ${weightSummary}`,
      vaultContextExcerpt ? `Local Vault Context:\n${vaultContextExcerpt}` : `Topic: ${topic}`,
      `Instruction: Explain "${topic}" synthesized across the requested comprehension dimensions (${weightSummary}).`,
      `[/INVISIBLE GEMMA 31B MASTER PROMPT] -->`,
      `Explain "${topic}" [${weightSummary}].`,
    ].join("\n");

    return {
      mode: "comprehension",
      rawCommand: trimmed,
      flags: activeFlags,
      allocations,
      topic,
      masterPrompt,
    };
  }

  // 3. Legacy `/q <topic>` or `/vault <topic>` shorthand fallback
  const legacyMatch = LEGACY_SHORTHAND_REGEX.exec(trimmed);
  if (legacyMatch) {
    const topic = legacyMatch[2].trim();
    const masterPrompt = [
      `[CONVERGENCE LOCAL VAULT CONTEXT — query: "${topic}"]`,
      vaultContextExcerpt || `Source: $APPLOCALDATA/vault`,
      `[/CONVERGENCE LOCAL VAULT CONTEXT]`,
      `Instruction: Using the local vault context above, explain ${topic}.`,
    ].join("\n");

    return {
      mode: "legacy_shorthand",
      rawCommand: trimmed,
      flags: ["q"],
      allocations: [{ flag: "q", label: "Vault Query", weightPct: 100 }],
      topic,
      masterPrompt,
    };
  }

  return null;
}
