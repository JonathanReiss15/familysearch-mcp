import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ImageRights, ResolvedImage } from './session-client.js';

/** FAMILYSEARCH_DOWNLOAD_DIR, else ~/Downloads/familysearch; one subfolder per film. */
export function resolveDownloadDir(outputDir: string | undefined, dgsNum: string | undefined): string {
  if (outputDir?.trim()) {
    return path.resolve(expandHome(outputDir.trim()));
  }
  const root = process.env.FAMILYSEARCH_DOWNLOAD_DIR
    ? expandHome(process.env.FAMILYSEARCH_DOWNLOAD_DIR)
    : path.join(os.homedir(), 'Downloads', 'familysearch');
  return path.resolve(root, dgsNum || 'images');
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
}

/** <DGS>_<image number>.jpg, so files sort in viewer order; the ARK when the position is unknown. */
export function imageFileName(image: ResolvedImage): string {
  if (image.dgsNum && image.index) {
    return `${image.dgsNum}_${String(image.index).padStart(5, '0')}.jpg`;
  }
  return `${image.arkId.replace(/:/g, '_')}.jpg`;
}

export function isSavedJpeg(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(2);
      return fs.readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0xff && head[1] === 0xd8;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Writes through a temporary file so an interrupted download never looks complete. */
export function saveJpeg(filePath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const partial = `${filePath}.part`;
  fs.writeFileSync(partial, data);
  fs.renameSync(partial, filePath);
}

/** Pixel size from the JPEG start-of-frame marker. */
export function jpegSize(data: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return undefined;
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

export function describeRights(rights?: ImageRights): string {
  if (!rights) return 'unknown (FamilySearch returned no access rights)';
  if (!rights.authorized) return 'not viewable with this account';
  return rights.allowDownload ? 'view and download' : 'view only (FamilySearch disables Download)';
}

export function describeImage(image: ResolvedImage): string {
  const position = image.index ? `image ${image.index}${image.total ? ` of ${image.total}` : ''}` : 'position unknown';
  const film = image.dgsNum ? `film (DGS) ${image.dgsNum}, ${position}` : 'film unknown';
  return `${image.arkId} (${film})\nViewer: https://www.familysearch.org/ark:/61903/${image.arkId}\nAccess: ${describeRights(image.rights)}`;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
