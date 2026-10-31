import { BaseDirectory, readFile, readTextFile } from "@tauri-apps/plugin-fs";

export interface PortableMarkdownRewriteResult {
  portableMarkdown: string;
  referencedImages: string[];
}

export interface ZipEntryInput {
  path: string;
  data: Uint8Array;
}

export interface PortableVaultExportBundle {
  noteFilename: string;
  portableMarkdown: string;
  referencedImages: string[];
  packagedFiles: string[];
  zipBytes: Uint8Array;
}

/**
 * Parses a Vault `.md` note and replaces all instances of `![alt](applocaldata://images/filename.jpg)`
 * (as well as `applocaldata://localhost/images/...` and `$APPLOCALDATA/images/...`) with standard
 * portable relative paths `![alt](./images/filename.jpg)`.
 */
export function rewriteAppLocalDataImagesToRelative(
  markdownContent: string
): PortableMarkdownRewriteResult {
  const referencedImages: string[] = [];
  const seen = new Set<string>();

  const pushImage = (rawName: string): string => {
    const cleanName = rawName
      .replace(/^[\\/]+/, "")
      .split(/[\\/]/)
      .pop() || rawName;
    if (cleanName && !seen.has(cleanName)) {
      seen.add(cleanName);
      referencedImages.push(cleanName);
    }
    return cleanName;
  };

  const portableMarkdown = (markdownContent || "").replace(
    /!\[([^\]]*)\]\((?:applocaldata:\/\/(?:localhost\/)?images\/|\$APPLOCALDATA[\\/]images[\\/])([^)\s]+)\)/gi,
    (_full, altText: string, imgName: string) => {
      const clean = pushImage(imgName);
      return `![${altText}](./images/${clean})`;
    }
  );

  return {
    portableMarkdown,
    referencedImages,
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
}

function writeUint32LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

/**
 * Builds a standards-compliant PKZIP (`.zip`) archive in memory from a list of `{ path, data }` entries.
 */
export function createPortableZipArchive(entries: ZipEntryInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const cleanPath = entry.path.replace(/^\.?[\\/]+/, "").replace(/\\/g, "/");
    const nameBytes = encoder.encode(cleanPath);
    const dataBytes = entry.data;
    const checksum = crc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    writeUint32LE(localHeader, 0, 0x04034b50); // PK\x03\x04
    writeUint16LE(localHeader, 4, 20);
    writeUint16LE(localHeader, 6, 0);
    writeUint16LE(localHeader, 8, 0); // Store (uncompressed)
    writeUint16LE(localHeader, 10, 0);
    writeUint16LE(localHeader, 12, 0);
    writeUint32LE(localHeader, 14, checksum);
    writeUint32LE(localHeader, 18, dataBytes.length);
    writeUint32LE(localHeader, 22, dataBytes.length);
    writeUint16LE(localHeader, 26, nameBytes.length);
    writeUint16LE(localHeader, 28, 0);
    localHeader.set(nameBytes, 30);
    localHeader.set(dataBytes, 30 + nameBytes.length);
    localParts.push(localHeader);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    writeUint32LE(centralHeader, 0, 0x02014b50); // PK\x01\x02
    writeUint16LE(centralHeader, 4, 20);
    writeUint16LE(centralHeader, 6, 20);
    writeUint16LE(centralHeader, 8, 0);
    writeUint16LE(centralHeader, 10, 0);
    writeUint16LE(centralHeader, 12, 0);
    writeUint16LE(centralHeader, 14, 0);
    writeUint32LE(centralHeader, 16, checksum);
    writeUint32LE(centralHeader, 20, dataBytes.length);
    writeUint32LE(centralHeader, 24, dataBytes.length);
    writeUint16LE(centralHeader, 28, nameBytes.length);
    writeUint16LE(centralHeader, 30, 0);
    writeUint16LE(centralHeader, 32, 0);
    writeUint16LE(centralHeader, 34, 0);
    writeUint16LE(centralHeader, 36, 0);
    writeUint32LE(centralHeader, 38, 0);
    writeUint32LE(centralHeader, 42, localOffset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = new Uint8Array(22);
  writeUint32LE(eocd, 0, 0x06054b50); // PK\x05\x06
  writeUint16LE(eocd, 4, 0);
  writeUint16LE(eocd, 6, 0);
  writeUint16LE(eocd, 8, entries.length);
  writeUint16LE(eocd, 10, entries.length);
  writeUint32LE(eocd, 12, centralSize);
  writeUint32LE(eocd, 16, localOffset);
  writeUint16LE(eocd, 20, 0);

  const totalLength = localOffset + centralSize + eocd.length;
  const out = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of localParts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  out.set(eocd, cursor);
  return out;
}

/**
 * Parses a Vault `.md` file, rewrites all `![alt](applocaldata://images/filename.jpg)` links
 * to `![alt](./images/filename.jpg)`, and packages the `.md` file alongside its associated images
 * into a portable `.zip` archive.
 */
export async function exportVaultNoteToPortableZip(
  noteFilename: string,
  options: {
    markdownContent?: string;
    readImageBytesFn?: (imageFilename: string) => Promise<Uint8Array>;
  } = {}
): Promise<PortableVaultExportBundle> {
  const cleanNoteFile = (noteFilename.split(/[\\/]/).pop() || "Note.md").endsWith(".md")
    ? noteFilename.split(/[\\/]/).pop()!
    : `${noteFilename.split(/[\\/]/).pop() || "Note"}.md`;

  let rawMd = options.markdownContent;
  if (typeof rawMd !== "string") {
    try {
      rawMd = await readTextFile(`vault/${cleanNoteFile}`, {
        baseDir: BaseDirectory.AppLocalData,
      });
    } catch {
      rawMd = "";
    }
  }

  const { portableMarkdown, referencedImages } = rewriteAppLocalDataImagePaths(rawMd);
  const entries: ZipEntryInput[] = [
    {
      path: cleanNoteFile,
      data: new TextEncoder().encode(portableMarkdown),
    },
  ];

  for (const imgName of referencedImages) {
    let imgBytes: Uint8Array;
    if (options.readImageBytesFn) {
      imgBytes = await options.readImageBytesFn(imgName);
    } else {
      try {
        imgBytes = await readFile(`images/${imgName}`, {
          baseDir: BaseDirectory.AppLocalData,
        });
      } catch {
        imgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      }
    }
    entries.push({
      path: `images/${imgName}`,
      data: imgBytes,
    });
  }

  const zipBytes = createPortableZipArchive(entries);
  return {
    noteFilename: cleanNoteFile,
    portableMarkdown,
    referencedImages,
    packagedFiles: entries.map((e) => e.path),
    zipBytes,
  };
}

export const rewriteAppLocalDataImagePaths = rewriteAppLocalDataImagesToRelative;
