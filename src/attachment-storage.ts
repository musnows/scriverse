import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import sharp, { type Metadata } from "sharp";
import { AppError } from "./errors.js";
import { DEFAULT_ATTACHMENT_IMAGE_MAX_BYTES, formatUploadLimit } from "./upload-limits.js";

if (process.platform === "win32") {
  sharp.cache({ files: 0 });
}

const maximumPixels = 25_000_000;
const maximumAnimationFrames = 100;
const maximumAnimationPixels = 50_000_000;
const maximumGifFrames = 10_000;
const allowedFormats = new Set(["png", "jpeg", "webp", "gif"]);

type AttachmentIngestOptions = {
  allowedFormats?: ReadonlySet<string>;
  preserveFormat?: boolean;
  maximumUploadBytes?: number;
  unsupportedMessage?: string;
};

type StoredImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type StoredAttachmentFile = {
  originalMimeType: StoredImageMimeType;
  storedMimeType: StoredImageMimeType;
  originalByteLength: number;
  storedByteLength: number;
  originalSha256: string;
  storedSha256: string;
  storageKey: string;
  width: number;
  height: number;
  pageCount: number;
  animated: boolean;
};

function mimeType(format: string): StoredImageMimeType {
  if (format === "png") return "image/png";
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  if (format === "gif") return "image/gif";
  throw new AppError(415, "UNSUPPORTED_ATTACHMENT", "附件仅支持 PNG、JPEG、WebP 和 GIF 图片");
}

function extensionForMime(value: StoredImageMimeType): string {
  if (value === "image/jpeg") return "jpg";
  return value.slice("image/".length);
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function hasGifSignature(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  const header = Buffer.alloc(6);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) return false;
    const signature = header.toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  } finally {
    await handle.close();
  }
}

export class AttachmentStorage {
  readonly temporaryDirectory: string;

  constructor(
    readonly rootDirectory: string,
    readonly maximumUploadBytes = DEFAULT_ATTACHMENT_IMAGE_MAX_BYTES
  ) {
    this.temporaryDirectory = join(rootDirectory, ".tmp");
  }

  async prepare(): Promise<void> {
    await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
  }

  private resolvedStoragePath(storageKey: string): string {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png|jpe?g|gif)$/u.test(storageKey)) {
      throw new AppError(500, "ATTACHMENT_PATH_INVALID", "附件存储路径无效");
    }
    const path = resolve(this.rootDirectory, storageKey);
    const root = resolve(this.rootDirectory);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new AppError(500, "ATTACHMENT_PATH_INVALID", "附件存储路径无效");
    }
    return path;
  }

  path(storageKey: string): string {
    return this.resolvedStoragePath(storageKey);
  }

  async read(storageKey: string): Promise<Buffer> {
    try {
      return await readFile(this.resolvedStoragePath(storageKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(404, "ATTACHMENT_FILE_NOT_FOUND", "附件文件不存在");
      }
      throw error;
    }
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.resolvedStoragePath(storageKey), { force: true });
  }

  async ingest(sourcePath: string, options: AttachmentIngestOptions = {}): Promise<StoredAttachmentFile> {
    await this.prepare();
    const originalStats = await stat(sourcePath);
    const maximumUploadBytes = options.maximumUploadBytes ?? this.maximumUploadBytes;
    if (originalStats.size > maximumUploadBytes) {
      throw new AppError(413, "ATTACHMENT_TOO_LARGE", `图片附件不能超过 ${formatUploadLimit(maximumUploadBytes)}`);
    }
    const originalSha256 = await sha256File(sourcePath);
    const isGif = await hasGifSignature(sourcePath);
    let metadata: Metadata;
    try {
      metadata = await sharp(sourcePath, { animated: true, limitInputPixels: isGif ? false : maximumPixels, sequentialRead: true }).metadata();
    } catch {
      throw new AppError(415, "INVALID_ATTACHMENT_IMAGE", "附件不是有效的图片文件");
    }
    const format = String(metadata.format ?? "");
    if (!(options.allowedFormats ?? allowedFormats).has(format)) {
      throw new AppError(415, "UNSUPPORTED_ATTACHMENT", options.unsupportedMessage ?? "附件仅支持 PNG、JPEG、WebP 和 GIF 图片");
    }
    const width = Number(metadata.width ?? 0);
    const pageHeight = Number(metadata.pageHeight ?? metadata.height ?? 0);
    const pageCount = Math.max(1, Number(metadata.pages ?? 1));
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(pageHeight) || pageHeight <= 0) {
      throw new AppError(415, "INVALID_ATTACHMENT_IMAGE", "无法读取附件图片尺寸");
    }
    if (isGif && pageCount > maximumGifFrames) {
      throw new AppError(413, "ATTACHMENT_GIF_TOO_MANY_FRAMES", "GIF 动画不能超过 10,000 帧");
    }
    if (!isGif && width * pageHeight > maximumPixels) throw new AppError(413, "ATTACHMENT_IMAGE_TOO_LARGE", "附件图片像素尺寸过大");
    if (!isGif && (!Number.isInteger(pageCount) || pageCount > maximumAnimationFrames)) {
      throw new AppError(413, "ATTACHMENT_ANIMATION_TOO_LARGE", "附件动画帧数过多");
    }
    if (!isGif && width * pageHeight * pageCount > maximumAnimationPixels) {
      throw new AppError(413, "ATTACHMENT_ANIMATION_TOO_LARGE", "附件动画总像素量过大");
    }

    const originalMimeType = mimeType(format);
    const candidatePath = join(this.temporaryDirectory, `${originalSha256}-${Date.now()}.webp`);
    let selectedPath = sourcePath;
    let storedMimeType = originalMimeType;
    if (!options.preserveFormat && format !== "webp" && !isGif) {
      try {
        await sharp(sourcePath, { animated: true, limitInputPixels: maximumPixels, sequentialRead: true })
          .webp({ lossless: true, effort: 6 })
          .toFile(candidatePath);
        const converted = await sharp(candidatePath, { animated: true, limitInputPixels: maximumPixels }).metadata();
        const convertedPages = Math.max(1, Number(converted.pages ?? 1));
        if (pageCount > 1 && convertedPages !== pageCount) {
          throw new AppError(422, "ATTACHMENT_ANIMATION_LOST", "附件转换未能保留全部动画帧");
        }
        if ((await stat(candidatePath)).size < originalStats.size) {
          selectedPath = candidatePath;
          storedMimeType = "image/webp";
        }
      } catch {
        await rm(candidatePath, { force: true });
      }
    }

    try {
      const storedSha256 = selectedPath === sourcePath ? originalSha256 : await sha256File(selectedPath);
      const storedByteLength = (await stat(selectedPath)).size;
      const storageKey = `${storedSha256.slice(0, 2)}/${storedSha256}.${extensionForMime(storedMimeType)}`;
      const targetPath = this.resolvedStoragePath(storageKey);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      try {
        await copyFile(selectedPath, targetPath, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return {
        originalMimeType,
        storedMimeType,
        originalByteLength: originalStats.size,
        storedByteLength,
        originalSha256,
        storedSha256,
        storageKey,
        width,
        height: pageHeight,
        pageCount,
        animated: pageCount > 1
      };
    } finally {
      await rm(candidatePath, { force: true });
    }
  }
}
