/**
 * Convergence Phase 11 — Tauri WebView Preload Command Bridge (`preload.js`)
 * 1. Attaches event listeners to standard chat input areas (`textarea`, `[contenteditable="true"]`, `[role="textbox"]`)
 *    to intercept shorthand commands (e.g. `/q anatomy`, `/q renal autoregulation`, `/vault cardiovascular`).
 * 2. Invokes `window.__TAURI__.core.invoke("resolve_shorthand_query", ...)` to fetch local `$APPLOCALDATA/vault`
 *    text from the Rust backend.
 * 3. Replaces the input field with a token-optimized system prompt containing the requested local context.
 */
(function () {
  if (window.__CONVERGENCE_PRELOAD_BRIDGE_INSTALLED__) return;
  window.__CONVERGENCE_PRELOAD_BRIDGE_INSTALLED__ = true;

  const SHORTHAND_REGEX = /^\/(q|vault|context)\s+([^\r\n]+)$/i;

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
      formatted_prompt: `[CONVERGENCE LOCAL VAULT CONTEXT — query: "${query.trim()}"]\nSource: $APPLOCALDATA/vault\nFocus on high-yield physiological mechanisms, causal triples, and 2nd-order clinical reasoning for "${query.trim()}".\n[/CONVERGENCE LOCAL VAULT CONTEXT]\n\nQuestion: Explain ${query.trim()} using my local vault notes.`,
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
    const match = SHORTHAND_REGEX.exec(currentText);
    if (!match) return false;

    const topicQuery = match[2].trim();
    if (!topicQuery) return false;

    try {
      const response = await invokeTauriShorthand(topicQuery, currentText);
      const formattedPrompt =
        typeof response === "string"
          ? response
          : response?.formatted_prompt ||
            response?.prompt ||
            `[CONVERGENCE LOCAL VAULT CONTEXT: ${topicQuery}]\n${response?.context_excerpt || ""}`;
      writeInputText(targetEl, formattedPrompt);
      return true;
    } catch (err) {
      console.warn("[Convergence Preload Bridge] Shorthand fallback:", err);
      return false;
    }
  };

  document.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (!isChatInputElement(target)) return;
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        const text = readInputText(target).trim();
        if (SHORTHAND_REGEX.test(text)) {
          event.preventDefault();
          event.stopPropagation();
          void handleShorthandInterception(target);
        }
      }
    },
    true
  );

  window.__CONVERGENCE_PRELOAD_BRIDGE__ = {
    SHORTHAND_REGEX,
    invokeTauriShorthand,
    handleShorthandInterception,
    readInputText,
    writeInputText,
  };
})();
