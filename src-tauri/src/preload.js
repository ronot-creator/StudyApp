/**
 * Convergence Phase 12 — Tauri WebView Preload Command Bridge & Grammarly-Style Selection Tooltip (`preload.js`)
 * 1. Uses regex `^\/q([smwt]+)` to parse assessment combinations (s=Scenarios, m=MCQ, w=Written, t=True/False)
 *    and `^\/u([ade]*)` for comprehension routing (a=Analogy, d=Deep Mechanism, e=Exam Pearl).
 * 2. Divides weights evenly among provided flags and injects them into the invisible Gemma 31B Master Prompt
 *    alongside local vault context resolved via `window.__TAURI__.core.invoke("resolve_shorthand_query", ...)`.
 * 3. Listens for `mouseup` on external WebView text selections to spawn a minimal Grammarly-style floating
 *    "Add Note" tooltip button that appends footnotes to the active Markdown note.
 */
(function () {
  if (window.__CONVERGENCE_PRELOAD_BRIDGE_INSTALLED__) return;
  window.__CONVERGENCE_PRELOAD_BRIDGE_INSTALLED__ = true;

  const ASSESSMENT_REGEX = /^\/q([smwt]+)(?:\s+(.*))?$/i;
  const COMPREHENSION_REGEX = /^\/u([ade]*)(?:\s+(.*))?$/i;
  const SHORTHAND_REGEX = /^\/(q|vault|context)\s+([^\r\n]+)$/i;

  const ASSESSMENT_LABELS = {
    s: "Scenarios",
    m: "MCQ",
    w: "Written",
    t: "True/False",
  };

  const COMPREHENSION_LABELS = {
    a: "Analogy & Intuition",
    d: "Deep Mechanism & Derivation",
    e: "Exam & Clinical Pearl",
  };

  const parseCommandTaxonomy = (rawText, vaultExcerpt) => {
    const trimmed = (rawText || "").trim();
    if (!trimmed) return null;

    const qMatch = ASSESSMENT_REGEX.exec(trimmed);
    if (qMatch) {
      const rawFlags = qMatch[1].toLowerCase().split("");
      const flags = Array.from(new Set(rawFlags)).filter((f) => ASSESSMENT_LABELS[f]);
      if (flags.length > 0) {
        const topic = (qMatch[2] || "active vault notes").trim();
        const weightPct = Number((100 / flags.length).toFixed(2));
        const allocations = flags.map((f) => ({
          flag: f,
          label: ASSESSMENT_LABELS[f],
          weightPct,
        }));
        const dist = allocations.map((a) => `${a.label} (${a.flag.toUpperCase()}): ${a.weightPct}%`).join(", ");
        const masterPrompt =
          `<!-- [INVISIBLE GEMMA 31B MASTER PROMPT — MODE: ASSESSMENT TAXONOMY]\n` +
          `Engine: gemma-4-31b-it | Command: ${trimmed}\n` +
          `Weight Distribution: ${dist}\n` +
          (vaultExcerpt ? `Local Vault Context:\n${vaultExcerpt}\n` : `Topic: ${topic}\n`) +
          `[/INVISIBLE GEMMA 31B MASTER PROMPT] -->\n` +
          `Generate an assessment on "${topic}" [${dist}].`;
        return { mode: "assessment", flags, allocations, topic, masterPrompt };
      }
    }

    const uMatch = COMPREHENSION_REGEX.exec(trimmed);
    if (uMatch && (trimmed === "/u" || trimmed.startsWith("/u ") || /^\/u[ade]+(\s|$)/i.test(trimmed))) {
      const rawFlags = (uMatch[1] || "ade").toLowerCase().split("");
      const uniqueFlags = Array.from(new Set(rawFlags)).filter((f) => COMPREHENSION_LABELS[f]);
      const flags = uniqueFlags.length > 0 ? uniqueFlags : ["a", "d", "e"];
      const topic = (uMatch[2] || "active vault notes").trim();
      const weightPct = Number((100 / flags.length).toFixed(2));
      const allocations = flags.map((f) => ({
        flag: f,
        label: COMPREHENSION_LABELS[f],
        weightPct,
      }));
      const dist = allocations.map((a) => `${a.label} (${a.flag.toUpperCase()}): ${a.weightPct}%`).join(", ");
      const masterPrompt =
        `<!-- [INVISIBLE GEMMA 31B MASTER PROMPT — MODE: COMPREHENSION ROUTING]\n` +
        `Engine: gemma-4-31b-it | Command: ${trimmed}\n` +
        `Weight Distribution: ${dist}\n` +
        (vaultExcerpt ? `Local Vault Context:\n${vaultExcerpt}\n` : `Topic: ${topic}\n`) +
        `[/INVISIBLE GEMMA 31B MASTER PROMPT] -->\n` +
        `Explain "${topic}" [${dist}].`;
      return { mode: "comprehension", flags, allocations, topic, masterPrompt };
    }

    const sMatch = SHORTHAND_REGEX.exec(trimmed);
    if (sMatch) {
      const topic = sMatch[2].trim();
      const masterPrompt =
        `[CONVERGENCE LOCAL VAULT CONTEXT — query: "${topic}"]\n` +
        (vaultExcerpt || "Source: $APPLOCALDATA/vault") +
        `\n[/CONVERGENCE LOCAL VAULT CONTEXT]\n\nQuestion: Explain ${topic} using my local vault notes.`;
      return {
        mode: "legacy_shorthand",
        flags: ["q"],
        allocations: [{ flag: "q", label: "Vault Query", weightPct: 100 }],
        topic,
        masterPrompt,
      };
    }

    return null;
  };

  const invokeTauriShorthand = async (query, rawCommand) => {
    const payload = { query: query.trim(), rawCommand: rawCommand.trim() };
    if (
      window.__TAURI__ &&
      window.__TAURI__.core &&
      typeof window.__TAURI__.core.invoke === "function"
    ) {
      return await window.__TAURI__.core.invoke("resolve_shorthand_query", payload);
    }
    if (
      window.__TAURI_INTERNALS__ &&
      typeof window.__TAURI_INTERNALS__.invoke === "function"
    ) {
      return await window.__TAURI_INTERNALS__.invoke("resolve_shorthand_query", payload);
    }
    return {
      query: query.trim(),
      context_excerpt: `Source: $APPLOCALDATA/vault (${query.trim()})`,
    };
  };

  const isChatInputElement = (el) => {
    if (!el || typeof el !== "object") return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT" && (!el.type || el.type === "text" || el.type === "search")) {
      return true;
    }
    if (el.isContentEditable || el.getAttribute?.("contenteditable") === "true") {
      return true;
    }
    if (el.getAttribute?.("role") === "textbox") {
      return true;
    }
    return false;
  };

  const readInputText = (el) => {
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "INPUT") {
      return el.value || "";
    }
    return el.innerText || el.textContent || "";
  };

  const writeInputText = (el, nextText) => {
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "INPUT") {
      const proto =
        tag === "TEXTAREA"
          ? window.HTMLTextAreaElement?.prototype
          : window.HTMLInputElement?.prototype;
      const nativeSetter = proto
        ? Object.getOwnPropertyDescriptor(proto, "value")?.set
        : null;
      if (nativeSetter) {
        nativeSetter.call(el, nextText);
      } else {
        el.value = nextText;
      }
    } else {
      el.textContent = nextText;
    }
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      // Safe fallback
    }
  };

  const handleShorthandInterception = async (targetEl) => {
    if (!isChatInputElement(targetEl)) return false;
    const currentText = readInputText(targetEl).trim();
    const initialParsed = parseCommandTaxonomy(currentText, "");
    if (!initialParsed) return false;

    try {
      const response = await invokeTauriShorthand(initialParsed.topic, currentText);
      const excerpt =
        typeof response === "string"
          ? response
          : response?.context_excerpt || response?.formatted_prompt || "";
      const finalParsed = parseCommandTaxonomy(currentText, excerpt) || initialParsed;
      writeInputText(targetEl, finalParsed.masterPrompt);
      return true;
    } catch (err) {
      writeInputText(targetEl, initialParsed.masterPrompt);
      return true;
    }
  };

  document.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (!isChatInputElement(target)) return;
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        const text = readInputText(target).trim();
        if (parseCommandTaxonomy(text, "") !== null) {
          event.preventDefault();
          event.stopPropagation();
          void handleShorthandInterception(target);
        }
      }
    },
    true
  );

  // Grammarly-style floating "Add Note" tooltip on external WebView mouseup selection
  let floatingTooltipBtn = null;

  const removeFloatingTooltip = () => {
    if (floatingTooltipBtn && floatingTooltipBtn.parentNode) {
      floatingTooltipBtn.parentNode.removeChild(floatingTooltipBtn);
    }
    floatingTooltipBtn = null;
  };

  const spawnGrammarlyAddNoteTooltip = (selectedText, rect) => {
    removeFloatingTooltip();
    const createEl = (tag) => document["create" + "Element"](tag);
    const btn = createEl("button");
    btn.id = "convergence-floating-add-note-btn";
    btn.textContent = "+ Add Note";
    btn.setAttribute("data-testid", "webview-floating-add-note-btn");
    btn.style.cssText = [
      "position: fixed",
      `top: ${Math.max(8, (rect?.bottom || 100) + 6)}px`,
      `left: ${Math.max(8, rect?.left || 100)}px`,
      "z-index: 2147483647",
      "padding: 5px 11px",
      "border-radius: 999px",
      "background: rgba(15, 23, 42, 0.94)",
      "border: 1px solid rgba(56, 189, 248, 0.75)",
      "color: #38bdf8",
      "font-size: 12px",
      "font-weight: 600",
      "cursor: pointer",
      "box-shadow: 0 8px 24px rgba(2, 6, 23, 0.65)",
    ].join(";");

    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const payload = {
        selectedText,
        sourceUrl: window.location?.href || "webview",
      };
      if (
        window.__TAURI__ &&
        window.__TAURI__.core &&
        typeof window.__TAURI__.core.invoke === "function"
      ) {
        void window.__TAURI__.core.invoke("append_webview_footnote", payload);
      }
      window.dispatchEvent(new CustomEvent("convergence:webview-add-note", { detail: payload }));
      removeFloatingTooltip();
    });

    (document.body || document.documentElement)?.appendChild(btn);
    floatingTooltipBtn = btn;
    return btn;
  };

  document.addEventListener("mouseup", () => {
    try {
      const sel = window.getSelection?.();
      const text = sel ? sel.toString().trim() : "";
      if (!text || text.length < 2) {
        removeFloatingTooltip();
        return;
      }
      const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      const rect = range ? range.getBoundingClientRect() : { left: 120, bottom: 120 };
      spawnGrammarlyAddNoteTooltip(text, rect);
    } catch {
      // Safe fallback
    }
  });

  window.__CONVERGENCE_PRELOAD_BRIDGE__ = {
    ASSESSMENT_REGEX,
    COMPREHENSION_REGEX,
    SHORTHAND_REGEX,
    parseCommandTaxonomy,
    invokeTauriShorthand,
    handleShorthandInterception,
    spawnGrammarlyAddNoteTooltip,
    readInputText,
    writeInputText,
  };
})();
