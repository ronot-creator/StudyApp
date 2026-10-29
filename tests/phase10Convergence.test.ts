import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  APP_DATA_SUBDIRS,
  ensureAppDataDirectories,
  resolveAppDataSubPath,
  resolveAppLocalDataRoot,
  getDynamicSqliteDbUri,
} from "../src/lib/appPaths";
import {
  parseThoughtAnchors,
  preserveSpecialMarkdownBlocks,
  ReactEditor,
} from "../src/components/vault/VaultReader";
import {
  AiIntegrations,
  DEFAULT_MCP_CONNECTION_URL,
} from "../src/components/settings/AiIntegrations";

describe("Phase 10 Convergence Suite: Dynamic $APPLOCALDATA, Milkdown WYSIWYG, MCP Sidecar, & CSS Deduplication", () => {
  it("Step 1 (Dynamic Pathing): resolves $APPLOCALDATA paths and provisions vault, images, and srs_data without E:\\ drive", async () => {
    const root = await ensureAppDataDirectories();
    expect(root.length).toBeGreaterThan(0);
    expect(root.includes("E:\\StudyApp")).toBe(false);
    expect(APP_DATA_SUBDIRS).toContain("vault");
    expect(APP_DATA_SUBDIRS).toContain("images");
    expect(APP_DATA_SUBDIRS).toContain("srs_data");

    const vaultNote = await resolveAppDataSubPath("vault", "Renal.md");
    expect(vaultNote).toContain("vault");
    expect(vaultNote).toContain("Renal.md");

    const dbUri = await getDynamicSqliteDbUri();
    expect(dbUri.startsWith("sqlite:")).toBe(true);
    expect(dbUri.includes("E:/StudyApp")).toBe(false);
  });

  it("Step 1 (Capabilities & Rust Dynamic Sandbox): whitelists $APPLOCALDATA/** and eradicates hardcoded E:\\StudyApp\\MyFiles", () => {
    const capJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "src-tauri/capabilities/default.json"), "utf-8")
    );
    expect(capJson.permissions).toContain("fs:default");
    expect(capJson.permissions).toContain("path:default");
    const scopeObj = capJson.permissions.find(
      (p: any) => typeof p === "object" && p.identifier === "fs:scope"
    );
    expect(scopeObj.allow).toEqual([
      { path: "$APPLOCALDATA" },
      { path: "$APPLOCALDATA/**" },
    ]);

    const libRs = fs.readFileSync(path.resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf-8");
    expect(libRs).toContain("app.path().app_local_data_dir()");
    expect(libRs).toContain('Command::new_sidecar("mcp-sidecar")');
    expect(libRs.includes("E:\\StudyApp\\MyFiles")).toBe(false);
  });

  it("Step 2 (Milkdown WYSIWYG Integration): exports ReactEditor & MilkdownProvider and preserves thought-anchor & ```mindmap blocks", () => {
    expect(typeof ReactEditor).toBe("function");
    const vrSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/vault/VaultReader.tsx"),
      "utf-8"
    );
    expect(vrSource).toContain("MilkdownProvider");
    expect(vrSource).toContain("ReactEditor");
    expect(vrSource).toContain("@milkdown/preset-commonmark");
    expect(vrSource).toContain("@milkdown/preset-gfm");
    expect(vrSource).toContain("@milkdown/plugin-math");
    expect(vrSource.includes("<textarea")).toBe(false);

    const originalMd = [
      "# Renal Autoregulation",
      "```mindmap",
      "[Macula Densa] --(signals)--> [Afferent Arteriole]",
      "```",
      "<!-- thought-anchor:ta_renal_01 -->",
      "> **[AI Margin Note #ta_renal_01]:** ACE inhibitors dilate efferent arterioles.",
      "<!-- /thought-anchor:ta_renal_01 -->",
      "[? How does adenosine affect afferent tone? ?]",
    ].join("\n\n");

    const preserved = preserveSpecialMarkdownBlocks(
      originalMd,
      "# Renal Autoregulation\n\nUpdated paragraph in Milkdown.\n\n[? How does adenosine affect afferent tone? ?]"
    );
    expect(preserved).toContain("```mindmap");
    expect(preserved).toContain("[Macula Densa] --(signals)--> [Afferent Arteriole]");
    expect(preserved).toContain("<!-- thought-anchor:ta_renal_01 -->");

    const anchors = parseThoughtAnchors(preserved);
    expect(anchors.length).toBe(2);
  });

  it("Step 3 (Tauri Sidecar MCP Bundling & AiIntegrations UI): configures externalBin and exposes localhost:1420/mcp", () => {
    const tauriConf = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf-8")
    );
    expect(tauriConf.bundle.externalBin).toEqual(["bin/mcp-sidecar"]);

    expect(typeof AiIntegrations).toBe("function");
    expect(DEFAULT_MCP_CONNECTION_URL).toBe("http://localhost:1420/mcp");

    const aiIntSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/settings/AiIntegrations.tsx"),
      "utf-8"
    );
    expect(aiIntSource).toContain("localhost:1420/mcp");
  });

  it("Step 4 (CSS Deduplication): confirms src/styles/liquid-glass.css is deleted and src/index.css is the single source of truth", () => {
    const deletedPath = path.resolve(process.cwd(), "src/styles/liquid-glass.css");
    expect(fs.existsSync(deletedPath)).toBe(false);

    const indexCss = fs.readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf-8");
    expect(indexCss).toContain("--apple-liquid-refraction: url(#apple-liquid-glass)");

    const appTsx = fs.readFileSync(path.resolve(process.cwd(), "src/App.tsx"), "utf-8");
    expect(appTsx).toContain('import "./index.css"');
    expect(appTsx.includes("liquid-glass.css")).toBe(false);
  });
});
