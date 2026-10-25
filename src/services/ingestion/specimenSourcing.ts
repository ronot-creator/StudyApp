import Database from "@tauri-apps/plugin-sql";
import { OrganSystem, OcclusionBox } from "../../types/study";
import { getNgrokGrader, SQLITE_DB_URI } from "../ngrokGrader";
import { readTextFile, writeFile, mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";

export type SpecimenModality =
  | "histology_slide"
  | "gross_specimen"
  | "radiology"
  | "diagram"
  | "pathway"
  | "model_3d";

export interface CuratedRepository {
  id: string;
  name: string;
  modality_focus: SpecimenModality[];
  api_endpoint: string;
  license_policy: string;
  enabled: boolean;
}

export interface SourcedMedicalAsset {
  id: string;
  descriptiveFilename: string;
  organSystem: OrganSystem;
  anatomicalStructure: string;
  modality: SpecimenModality;
  sourceCredit: string;
  sourceUrl: string;
  occlusionBoxes: OcclusionBox[];
}

// Use BaseDirectory.AppData as the base, with the sandbox path relative to it
// The capabilities file grants access to E:/StudyApp/MyFiles
const CURATED_SOURCES_REL_PATH = "vault/curated_medical_sources.json";
const IMAGES_REL_DIR = "images";

async function readJsonFile(relPath: string): Promise<string> {
  try {
    return await readTextFile(relPath, { baseDir: BaseDirectory.AppData });
  } catch {
    throw new Error(`Failed to read ${relPath}`);
  }
}

async function loadCuratedRepositories(): Promise<CuratedRepository[]> {
  try {
    const content = await readJsonFile(CURATED_SOURCES_REL_PATH);
    const data = JSON.parse(content);
    return data.repositories.filter((r: CuratedRepository) => r.enabled);
  } catch {
    return DEFAULT_CURATED_REPOSITORIES.filter((r) => r.enabled);
  }
}

export const DEFAULT_CURATED_REPOSITORIES: CuratedRepository[] = [
  { id: "nih_openi", name: "NIH Open-i Biomedical Image Search Engine", modality_focus: ["histology_slide", "radiology", "gross_specimen", "diagram"], api_endpoint: "https://openi.nlm.nih.gov/api/search", license_policy: "Open Access Biomedical Literature (CC-BY / Public Domain)", enabled: true },
  { id: "wikimedia_medical", name: "Wikimedia Commons Medical & Histopathology API", modality_focus: ["gross_specimen", "histology_slide", "diagram"], api_endpoint: "https://commons.wikimedia.org/w/api.php", license_policy: "CC-BY-SA / CC-BY / Public Domain", enabled: true },
  { id: "peir_digital_library", name: "University of Alabama PEIR Pathology Digital Library", modality_focus: ["histology_slide", "gross_specimen"], api_endpoint: "https://peir.path.uab.edu/library", license_policy: "Educational Open Access Attribution", enabled: true },
  { id: "anatomy_tool", name: "AnatomyTOOL Open Anatomical Illustrations and Specimens", modality_focus: ["gross_specimen", "diagram"], api_endpoint: "https://anatomytool.org/api/v1/search", license_policy: "CC-BY 4.0", enabled: true },
  { id: "wikipathways", name: "WikiPathways Open Biological and Physiological Pathways", modality_focus: ["pathway", "diagram"], api_endpoint: "https://webservice.wikipathways.org/findPathwaysByText", license_policy: "CC0 / Public Domain", enabled: true },
  { id: "sketchfab_3d_anatomy", name: "Sketchfab CC-BY Cultural and Medical 3D Anatomy (glTF/GLB)", modality_focus: ["model_3d"], api_endpoint: "https://api.sketchfab.com/v3/search", license_policy: "CC-BY Downloadable 3D glTF", enabled: true },
];

interface RepositorySearchResult { filename: string; sourceCredit: string; sourceUrl: string; localPath: string; }

async function downloadImage(url: string, destRelPath: string): Promise<boolean> {
  try {
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok || !resp.body) return false;
    const arrayBuffer = await resp.arrayBuffer();
    await writeFile(destRelPath, new Uint8Array(arrayBuffer), { baseDir: BaseDirectory.AppData });
    return true;
  } catch {
    return false;
  }
}

async function searchWikimediaCommons(
  query: string,
  modality: SpecimenModality,
  organSystem: OrganSystem
): Promise<RepositorySearchResult[]> {
  const results: RepositorySearchResult[] = [];
  const searchUrl =
    `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
    `&gsrsearch=${encodeURIComponent(query + " " + modality.replace("_", " "))}` +
    `&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url|extmetadata&format=json&origin=*`;

  try {
    const resp = await fetch(searchUrl);
    if (!resp.ok) return results;
    const data = await resp.json();
    const pages = data?.query?.pages || {};

    for (const page of Object.values(pages) as Array<any>) {
      const info = page?.imageinfo?.[0];
      if (!info?.url) continue;
      const ext = info.url.split(".").pop()?.split("?")[0] || "jpg";
      const cleanSlug = query.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const filename = `${organSystem.toLowerCase()}_${cleanSlug}_${page.pageid}.${ext}`;
      const localPath = `${IMAGES_REL_DIR}/${filename}`;

      const downloaded = await downloadImage(info.url, localPath);
      if (downloaded) {
        results.push({
          filename,
          sourceCredit: `Wikimedia Commons Medical (${page.title})`,
          sourceUrl: info.url,
          localPath,
        });
      }
    }
  } catch {
    // Silent fail - will use fallback
  }
  return results;
}

async function searchNIHOpenI(
  query: string,
  _modality: SpecimenModality,
  organSystem: OrganSystem
): Promise<RepositorySearchResult[]> {
  const results: RepositorySearchResult[] = [];
  const searchUrl = `https://openi.nlm.nih.gov/api/search?query=${encodeURIComponent(query)}&coll=cxr&size=3&format=json`;

  try {
    const resp = await fetch(searchUrl);
    if (!resp.ok) return results;
    const data = await resp.json();

    for (const item of data?.list || []) {
      const imageUrl = item?.image_url;
      if (!imageUrl) continue;
      const ext = imageUrl.split(".").pop()?.split("?")[0] || "jpg";
      const cleanSlug = query.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const filename = `${organSystem.toLowerCase()}_${cleanSlug}_nih_${item.id}.${ext}`;
      const localPath = `${IMAGES_REL_DIR}/${filename}`;

      const downloaded = await downloadImage(imageUrl, localPath);
      if (downloaded) {
        results.push({
          filename,
          sourceCredit: `NIH Open-i (${item.citation || "Open Access"})`,
          sourceUrl: imageUrl,
          localPath,
        });
      }
    }
  } catch {
    // Silent fail
  }
  return results;
}

async function searchSketchfab3D(
  query: string,
  organSystem: OrganSystem
): Promise<RepositorySearchResult[]> {
  const results: RepositorySearchResult[] = [];
  const searchUrl = `https://api.sketchfab.com/v3/search?q=${encodeURIComponent(query + " anatomy medical")}&type=models&downloadable=true&count=3`;

  try {
    const resp = await fetch(searchUrl);
    if (!resp.ok) return results;
    const data = await resp.json();

    for (const model of data?.results || []) {
      if (!model.downloadable || !model.files?.some((f: any) => f.format === "gltf")) continue;
      const gltfFile = model.files.find((f: any) => f.format === "gltf");
      if (!gltfFile?.url) continue;

      const cleanSlug = query.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const filename = `${organSystem.toLowerCase()}_${cleanSlug}_${model.uid}.glb`;
      const localPath = `${IMAGES_REL_DIR}/${filename}`;

      const downloaded = await downloadImage(gltfFile.url, localPath);
      if (downloaded) {
        results.push({
          filename,
          sourceCredit: `Sketchfab CC-BY (${model.name} by ${model.user?.username || "unknown"})`,
          sourceUrl: model.viewerUrl,
          localPath,
        });
      }
    }
  } catch {
    // Silent fail
  }
  return results;
}
export class SpecimenSourcingService {
  public onPersistError?: (message: string) => void;

  public async searchAndRegisterSpecimens(
    organSystem: OrganSystem,
    anatomicalQuery: string,
    modality: SpecimenModality
  ): Promise<SourcedMedicalAsset[]> {
    const repositories = await loadCuratedRepositories();
    const relevantRepos = repositories.filter((r) => r.modality_focus.includes(modality));
    const results: SourcedMedicalAsset[] = [];

    for (const repo of relevantRepos) {
      let searchResults: RepositorySearchResult[] = [];

      try {
        switch (repo.id) {
          case "wikimedia_medical":
            searchResults = await searchWikimediaCommons(anatomicalQuery, modality, organSystem);
            break;
          case "nih_openi":
            if (modality === "radiology" || modality === "histology_slide") {
              searchResults = await searchNIHOpenI(anatomicalQuery, modality, organSystem);
            }
            break;
          case "sketchfab_3d_anatomy":
            if (modality === "model_3d") {
              searchResults = await searchSketchfab3D(anatomicalQuery, organSystem);
            }
            break;
        }
      } catch {
        // Continue to next repository
      }

      for (const sr of searchResults) {
        const boxes = await getNgrokGrader().requestImageOcclusionBoxes(
          sr.filename,
          organSystem,
          anatomicalQuery
        );
        const asset: SourcedMedicalAsset = {
          id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          descriptiveFilename: sr.filename,
          organSystem,
          anatomicalStructure: anatomicalQuery,
          modality,
          sourceCredit: sr.sourceCredit,
          sourceUrl: sr.sourceUrl,
          occlusionBoxes: boxes,
        };
        results.push(asset);
        await this.persistAssetToSqlite(asset);
      }

      if (results.length > 0) break;
    }

    if (results.length === 0) {
      const ext = modality === "model_3d" ? "glb" : "png";
      const cleanSlug = anatomicalQuery.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const filename = `${organSystem.toLowerCase()}_${cleanSlug}_${modality}.${ext}`;
      const localPath = `${IMAGES_REL_DIR}/${filename}`;

      try {
        await mkdir(IMAGES_REL_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
        if (ext === "png") {
          const pngBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
          await writeFile(localPath, pngBytes, { baseDir: BaseDirectory.AppData });
        }
      } catch {
        // Ignore placeholder creation failure
      }

      const boxes = await getNgrokGrader().requestImageOcclusionBoxes(
        filename,
        organSystem,
        anatomicalQuery
      );
      const fallbackAsset: SourcedMedicalAsset = {
        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        descriptiveFilename: filename,
        organSystem,
        anatomicalStructure: anatomicalQuery,
        modality,
        sourceCredit:
          modality === "model_3d"
            ? "Sketchfab CC-BY 3D Medical Anatomy Repository (placeholder)"
            : "NIH Open-i / PEIR Pathology Open Access Archive (placeholder)",
        sourceUrl: `file://${localPath}`,
        occlusionBoxes: boxes,
      };
      results.push(fallbackAsset);
      await this.persistAssetToSqlite(fallbackAsset);
    }

    return results;
  }

  private async persistAssetToSqlite(asset: SourcedMedicalAsset): Promise<void> {
    try {
      const db = await Database.load(SQLITE_DB_URI);
      await db.execute(
        `INSERT OR REPLACE INTO medical_images
           (id, descriptive_filename, organ_system, anatomical_structure, modality, source_credit, source_url, occlusion_boxes_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          asset.id,
          asset.descriptiveFilename,
          asset.organSystem,
          asset.anatomicalStructure,
          asset.modality,
          asset.sourceCredit,
          asset.sourceUrl,
          JSON.stringify(asset.occlusionBoxes),
        ]
      );
    } catch (err) {
      console.error("[SpecimenSourcing] persistAssetToSqlite failed:", err);
      this.onPersistError?.(`Specimen metadata NOT saved to SQLite: ${String(err)}`);
    }
  }
}

export const specimenSourcingService = new SpecimenSourcingService();