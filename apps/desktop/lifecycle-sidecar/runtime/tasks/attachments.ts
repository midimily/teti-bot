import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  MAX_TASK_IMAGE_BYTES,
  MAX_TASK_IMAGE_DIMENSION,
  MAX_TASK_IMAGE_PARTS,
  MAX_TASK_IMAGE_TOTAL_BYTES,
  type TaskImageMimeType,
  type TaskImagePart
} from "../../../../../core/task/types.ts";
import { validateTaskImagePart } from "../../../../../core/task/validation.ts";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_TASK_ATTACHMENT_STORE_BYTES = 256 * 1024 * 1024;
const MAX_TASK_ATTACHMENT_STORE_FILES = 2_048;

export interface StagedTaskImage {
  part: TaskImagePart;
  path: string;
  safeFileName: string;
}

export type StoredTaskAttachmentPurpose = "input" | "artifact";

export interface TaskAttachmentStore {
  stageImage(sourcePath: string): Promise<StagedTaskImage>;
  getStagedImage(part: TaskImagePart): Promise<StagedTaskImage>;
  ingestImage(input: {
    taskId: string;
    purpose: StoredTaskAttachmentPurpose;
    part: TaskImagePart;
    sourcePath: string;
  }): Promise<string>;
  ingestGeneratedImage(taskId: string, sourcePath: string): Promise<StagedTaskImage>;
  resolveImage(input: {
    taskId: string;
    purpose: StoredTaskAttachmentPurpose;
    part: TaskImagePart;
  }): Promise<string | null>;
  removeTask(taskId: string): Promise<void>;
  cleanup(now?: Date): Promise<void>;
}

export class FileTaskAttachmentStore implements TaskAttachmentStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async stageImage(sourcePath: string): Promise<StagedTaskImage> {
    const canonicalSource = await requireRegularSourceFile(sourcePath);
    const sanitized = sanitizeImage(await readBoundedFile(canonicalSource));
    const attachmentId = randomUUID();
    const part = imagePart(attachmentId, sanitized);
    const path = this.stagedPath(part);
    await requireGlobalStoreQuota(this.root, path, sanitized.bytes.byteLength);
    await atomicPrivateWrite(path, sanitized.bytes);
    return { part, path, safeFileName: safeFileName(part) };
  }

  async getStagedImage(part: TaskImagePart): Promise<StagedTaskImage> {
    validateTaskImagePart(part);
    const path = this.stagedPath(part);
    await verifyStoredImage(path, part);
    return { part: structuredClone(part), path, safeFileName: safeFileName(part) };
  }

  async ingestImage(input: {
    taskId: string;
    purpose: StoredTaskAttachmentPurpose;
    part: TaskImagePart;
    sourcePath: string;
  }): Promise<string> {
    requireSafeTaskId(input.taskId);
    validateTaskImagePart(input.part);
    const canonicalSource = await requireRegularSourceFile(input.sourcePath);
    const sanitized = sanitizeImage(await readBoundedFile(canonicalSource));
    requireMatchingImage(input.part, sanitized);
    const destination = this.taskPath(input.taskId, input.purpose, input.part);
    try {
      await verifyStoredImage(destination, input.part);
      return destination;
    } catch {
      await requireTaskQuota(destination, sanitized.bytes.byteLength);
      await requireGlobalStoreQuota(this.root, destination, sanitized.bytes.byteLength);
      await atomicPrivateWrite(destination, sanitized.bytes);
      await verifyStoredImage(destination, input.part);
      return destination;
    }
  }

  async ingestGeneratedImage(taskId: string, sourcePath: string): Promise<StagedTaskImage> {
    requireSafeTaskId(taskId);
    const canonicalSource = await requireRegularSourceFile(sourcePath);
    const sanitized = sanitizeImage(await readBoundedFile(canonicalSource));
    const part = imagePart(randomUUID(), sanitized);
    const destination = this.taskPath(taskId, "artifact", part);
    await requireTaskQuota(destination, sanitized.bytes.byteLength);
    await requireGlobalStoreQuota(this.root, destination, sanitized.bytes.byteLength);
    await atomicPrivateWrite(destination, sanitized.bytes);
    await verifyStoredImage(destination, part);
    return { part, path: destination, safeFileName: safeFileName(part) };
  }

  async resolveImage(input: {
    taskId: string;
    purpose: StoredTaskAttachmentPurpose;
    part: TaskImagePart;
  }): Promise<string | null> {
    requireSafeTaskId(input.taskId);
    validateTaskImagePart(input.part);
    const path = this.taskPath(input.taskId, input.purpose, input.part);
    try {
      await verifyStoredImage(path, input.part);
      return path;
    } catch {
      return null;
    }
  }

  async removeTask(taskId: string): Promise<void> {
    requireSafeTaskId(taskId);
    await Promise.all([
      rm(join(this.root, "input", taskId), { recursive: true, force: true }),
      rm(join(this.root, "artifact", taskId), { recursive: true, force: true })
    ]);
  }

  async cleanup(now = new Date()): Promise<void> {
    await cleanupTree(join(this.root, "staged"), now.getTime() - TASK_ATTACHMENT_RETENTION_MS);
    for (const purpose of ["input", "artifact"] as const) {
      await cleanupTree(join(this.root, purpose), now.getTime() - TASK_ATTACHMENT_RETENTION_MS);
    }
  }

  private stagedPath(part: TaskImagePart): string {
    return join(this.root, "staged", `${part.attachmentId}${extensionFor(part.mimeType)}`);
  }

  private taskPath(
    taskId: string,
    purpose: StoredTaskAttachmentPurpose,
    part: TaskImagePart
  ): string {
    return join(this.root, purpose, taskId, `${part.attachmentId}${extensionFor(part.mimeType)}`);
  }
}

interface SanitizedImage {
  bytes: Buffer;
  mimeType: TaskImageMimeType;
  width: number;
  height: number;
}

function sanitizeImage(source: Buffer): SanitizedImage {
  if (source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return sanitizePng(source);
  if (source.length >= 4 && source[0] === 0xff && source[1] === 0xd8) return sanitizeJpeg(source);
  throw new Error("TASK_IMAGE_TYPE_UNSUPPORTED");
}

function sanitizePng(source: Buffer): SanitizedImage {
  const chunks: Buffer[] = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > MAX_TASK_IMAGE_BYTES || end > source.length) throw new Error("TASK_IMAGE_INVALID");
    const type = source.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("TASK_IMAGE_INVALID");
    if (type === "IHDR") {
      if (sawHeader || length !== 13 || offset !== PNG_SIGNATURE.length) throw new Error("TASK_IMAGE_INVALID");
      width = source.readUInt32BE(offset + 8);
      height = source.readUInt32BE(offset + 12);
      sawHeader = true;
    }
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (length !== 0) throw new Error("TASK_IMAGE_INVALID");
      sawEnd = true;
    }
    if (isSafePngChunk(type)) chunks.push(source.subarray(offset, end));
    offset = end;
    if (sawEnd) break;
  }
  if (!sawHeader || !sawData || !sawEnd || offset !== source.length) throw new Error("TASK_IMAGE_INVALID");
  requireDimensions(width, height);
  const bytes = Buffer.concat(chunks);
  requireBoundedBytes(bytes);
  return { bytes, mimeType: "image/png", width, height };
}

function isSafePngChunk(type: string): boolean {
  const critical = type[0] === type[0]?.toUpperCase();
  return critical || ["tRNS", "gAMA", "cHRM", "sRGB"].includes(type);
}

function sanitizeJpeg(source: Buffer): SanitizedImage {
  const chunks: Buffer[] = [source.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  let foundScan = false;
  while (offset < source.length) {
    if (source[offset] !== 0xff) throw new Error("TASK_IMAGE_INVALID");
    while (source[offset] === 0xff) offset += 1;
    if (offset >= source.length) throw new Error("TASK_IMAGE_INVALID");
    const marker = source[offset++]!;
    const markerStart = offset - 2;
    if (marker === 0xd9) {
      chunks.push(source.subarray(markerStart, offset));
      break;
    }
    if (marker === 0xda) {
      if (offset + 2 > source.length) throw new Error("TASK_IMAGE_INVALID");
      const length = source.readUInt16BE(offset);
      if (length < 2 || offset + length > source.length) throw new Error("TASK_IMAGE_INVALID");
      chunks.push(source.subarray(markerStart));
      foundScan = true;
      offset = source.length;
      break;
    }
    if (isStandaloneJpegMarker(marker)) {
      chunks.push(source.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > source.length) throw new Error("TASK_IMAGE_INVALID");
    const length = source.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > source.length) throw new Error("TASK_IMAGE_INVALID");
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) throw new Error("TASK_IMAGE_INVALID");
      height = source.readUInt16BE(offset + 3);
      width = source.readUInt16BE(offset + 5);
    }
    if (!isPrivateJpegSegment(marker)) chunks.push(source.subarray(markerStart, end));
    offset = end;
  }
  if (!foundScan || !width || !height || source.at(-2) !== 0xff || source.at(-1) !== 0xd9) {
    throw new Error("TASK_IMAGE_INVALID");
  }
  requireDimensions(width, height);
  const bytes = Buffer.concat(chunks);
  requireBoundedBytes(bytes);
  return { bytes, mimeType: "image/jpeg", width, height };
}

function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function isJpegStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
    .includes(marker);
}

function isPrivateJpegSegment(marker: number): boolean {
  return marker === 0xe1 || marker === 0xed || marker === 0xfe;
}

function imagePart(attachmentId: string, image: SanitizedImage): TaskImagePart {
  const part: TaskImagePart = {
    kind: "image",
    attachmentId,
    mimeType: image.mimeType,
    byteLength: image.bytes.byteLength,
    width: image.width,
    height: image.height,
    sha256: digest(image.bytes)
  };
  validateTaskImagePart(part);
  return part;
}

function requireMatchingImage(part: TaskImagePart, image: SanitizedImage): void {
  if (part.mimeType !== image.mimeType
    || part.byteLength !== image.bytes.byteLength
    || part.width !== image.width
    || part.height !== image.height
    || part.sha256 !== digest(image.bytes)) {
    throw new Error("TASK_ATTACHMENT_MISMATCH");
  }
}

async function verifyStoredImage(path: string, part: TaskImagePart): Promise<void> {
  const canonical = await realpath(path);
  if (basename(canonical) !== basename(path)) throw new Error("TASK_ATTACHMENT_PATH_INVALID");
  const image = sanitizeImage(await readBoundedFile(canonical));
  requireMatchingImage(part, image);
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_TASK_IMAGE_BYTES) {
    throw new Error("TASK_IMAGE_SIZE_INVALID");
  }
  const bytes = await readFile(path);
  requireBoundedBytes(bytes);
  return bytes;
}

async function requireRegularSourceFile(sourcePath: string): Promise<string> {
  if (typeof sourcePath !== "string" || !sourcePath.startsWith("/") || sourcePath.includes("\0")) {
    throw new Error("TASK_IMAGE_PATH_INVALID");
  }
  const canonical = await realpath(sourcePath);
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error("TASK_IMAGE_PATH_INVALID");
  const extension = extname(canonical).toLowerCase();
  if (![".png", ".jpg", ".jpeg"].includes(extension)) throw new Error("TASK_IMAGE_TYPE_UNSUPPORTED");
  return canonical;
}

async function atomicPrivateWrite(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function cleanupTree(root: string, cutoff: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await cleanupTree(path, cutoff);
      const remaining = await readdir(path).catch(() => ["retained"]);
      if (remaining.length === 0) await rm(path, { recursive: true, force: true });
      continue;
    }
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs <= cutoff) await rm(path, { force: true });
  }
}

async function requireTaskQuota(destination: string, incomingBytes: number): Promise<void> {
  const directory = dirname(destination);
  const destinationName = basename(destination);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  let fileCount = 0;
  let byteLength = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === destinationName) continue;
    const info = await stat(join(directory, entry.name));
    fileCount += 1;
    byteLength += info.size;
  }
  if (fileCount >= MAX_TASK_IMAGE_PARTS
    || byteLength + incomingBytes > MAX_TASK_IMAGE_TOTAL_BYTES) {
    throw new Error("TASK_ATTACHMENT_QUOTA_EXCEEDED");
  }
}

async function requireGlobalStoreQuota(
  root: string,
  replacementPath: string,
  incomingBytes: number
): Promise<void> {
  const usage = await treeUsage(root, replacementPath);
  if (usage.files >= MAX_TASK_ATTACHMENT_STORE_FILES
    || usage.bytes + incomingBytes > MAX_TASK_ATTACHMENT_STORE_BYTES) {
    throw new Error("TASK_ATTACHMENT_STORE_FULL");
  }
}

async function treeUsage(
  root: string,
  replacementPath: string
): Promise<{ files: number; bytes: number }> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return { files: 0, bytes: 0 };
    throw error;
  }
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await treeUsage(path, replacementPath);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }
    if (!entry.isFile() || path === replacementPath) continue;
    const info = await stat(path);
    files += 1;
    bytes += info.size;
    if (files >= MAX_TASK_ATTACHMENT_STORE_FILES || bytes > MAX_TASK_ATTACHMENT_STORE_BYTES) break;
  }
  return { files, bytes };
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0
    || width > MAX_TASK_IMAGE_DIMENSION || height > MAX_TASK_IMAGE_DIMENSION) {
    throw new Error("TASK_IMAGE_DIMENSIONS_INVALID");
  }
}

function requireBoundedBytes(bytes: Buffer): void {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_TASK_IMAGE_BYTES) {
    throw new Error("TASK_IMAGE_SIZE_INVALID");
  }
}

function requireSafeTaskId(taskId: string): void {
  if (!SAFE_ID_PATTERN.test(taskId)) throw new Error("TASK_ID_INVALID");
}

function safeFileName(part: TaskImagePart): string {
  return `teti-task-${part.attachmentId}${extensionFor(part.mimeType)}`;
}

function extensionFor(mimeType: TaskImageMimeType): ".png" | ".jpg" {
  return mimeType === "image/png" ? ".png" : ".jpg";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
