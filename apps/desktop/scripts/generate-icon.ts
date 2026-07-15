import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../../..", import.meta.url).pathname;
const desktopRoot = join(root, "apps", "desktop");
const brandLogoPath = process.env.TETI_ICON_LOGO_PATH ?? join(desktopRoot, "assets", "teti-logo-default.png");
const sourcePath = join(desktopRoot, "assets", "icon-source.png");
const inspectionPath = join(desktopRoot, "assets", "icon-inspection-sheet.png");
const iconsDir = join(desktopRoot, "src-tauri", "icons");
const iconsetDir = join(iconsDir, "Teti.iconset");

const iconsetSizes = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
] as const;

const tauriPngSizes = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512]
] as const;

function main(): void {
  mkdirSync(dirname(sourcePath), { recursive: true });
  mkdirSync(iconsDir, { recursive: true });
  mkdirSync(iconsetDir, { recursive: true });

  writePng(sourcePath, renderTetiIcon(1024));

  for (const [name, size] of iconsetSizes) {
    const path = join(iconsetDir, name);
    writePng(path, renderTetiIcon(size));
    normalizePng(path);
  }

  for (const [name, size] of tauriPngSizes) {
    const path = join(iconsDir, name);
    writePng(path, renderTetiIcon(size));
    normalizePng(path);
  }

  writePng(inspectionPath, renderInspectionSheet());

  const icnsPath = join(iconsDir, "icon.icns");
  const iconutil = spawnSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath], {
    stdio: "inherit"
  });
  if (iconutil.status !== 0) {
    console.warn("iconutil failed; writing icon.icns with the built-in ICNS PNG container fallback.");
    writeIcns(icnsPath);
  }

  console.log(`Created ${sourcePath}`);
  console.log(`Created ${inspectionPath}`);
  console.log(`Created ${icnsPath}`);
}

function normalizePng(path: string): void {
  const normalizedPath = `${path}.normalized`;
  const result = spawnSync("sips", ["-s", "format", "png", path, "--out", normalizedPath], {
    stdio: "ignore"
  });
  if (result.status !== 0) {
    throw new Error(`sips failed to normalize ${path}`);
  }
  renameSync(normalizedPath, path);
}

interface ImageData {
  width: number;
  height: number;
  data: Uint8Array;
}

type Color = [number, number, number, number];
let preparedLogo: ImageData | null = null;

function renderTetiIcon(size: number): ImageData {
  const logo = preparedLogo ??= prepareLogoSource(readPng(brandLogoPath));
  return resizeImage(logo, size, size);
}

function renderInspectionSheet(): ImageData {
  const sheet = createImage(1800, 1500, [247, 250, 255, 255]);
  fillRect(sheet, 0, 0, sheet.width, sheet.height, [8, 14, 26, 255]);
  fillRect(sheet, 36, 36, sheet.width - 72, sheet.height - 72, [247, 250, 255, 255]);
  drawText(sheet, "TETI MACOS ICON SIZE CHECK", 70, 72, 4, [0, 16, 32, 255]);

  const placements = [
    [70, 132, 1024, 4],
    [1160, 132, 512, 4],
    [1160, 740, 256, 3],
    [1478, 740, 128, 3],
    [1478, 942, 64, 2],
    [1572, 958, 32, 2],
    [1628, 966, 16, 2]
  ] as const;

  for (const [x, y, size, labelScale] of placements) {
    blit(sheet, renderTetiIcon(size), x, y);
    drawText(sheet, `${size}x${size}`, x, y + size + 18, labelScale, [0, 16, 32, 255]);
  }

  fillRect(sheet, 1160, 1120, 512, 248, [0, 16, 32, 255]);
  blit(sheet, renderTetiIcon(128), 1218, 1172);
  blit(sheet, renderTetiIcon(32), 1398, 1220);
  blit(sheet, renderTetiIcon(16), 1460, 1228);
  drawText(sheet, "DARK DOCK", 1218, 1322, 3, [247, 250, 255, 255]);

  return sheet;
}

function createImage(width: number, height: number, color: Color = [0, 0, 0, 0]): ImageData {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color[0];
    data[index + 1] = color[1];
    data[index + 2] = color[2];
    data[index + 3] = color[3];
  }
  return { width, height, data };
}

function readPng(path: string): ImageData {
  const buffer = readFileSync(path);
  if (!buffer.subarray(1, 4).equals(Buffer.from("PNG"))) {
    throw new Error(`${path} is not a PNG`);
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  if (bitDepth !== 8 || ![2, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG format for ${path}; expected 8-bit RGB or RGBA`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") {
      idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }

  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const unpacked = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const rawStart = y * (stride + 1);
    const row = Buffer.from(inflated.subarray(rawStart + 1, rawStart + 1 + stride));
    const previous = y > 0 ? unpacked.subarray((y - 1) * stride, y * stride) : undefined;
    unfilterRow(row, previous, inflated[rawStart], channels);
    row.copy(unpacked, y * stride);
  }

  const image = createImage(width, height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceIndex = pixel * channels;
    const targetIndex = pixel * 4;
    image.data[targetIndex] = unpacked[sourceIndex];
    image.data[targetIndex + 1] = unpacked[sourceIndex + 1];
    image.data[targetIndex + 2] = unpacked[sourceIndex + 2];
    image.data[targetIndex + 3] = channels === 4 ? unpacked[sourceIndex + 3] : 255;
  }
  return image;
}

function prepareLogoSource(source: ImageData): ImageData {
  const masked = removeConnectedWhiteBackground(source);
  const bounds = alphaBounds(masked);
  const canvas = createImage(1024, 1024);
  const sourceWidth = bounds.right - bounds.left + 1;
  const sourceHeight = bounds.bottom - bounds.top + 1;
  const maxWidth = 828;
  const maxHeight = 784;
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  const targetWidth = Math.round(sourceWidth * scale);
  const targetHeight = Math.round(sourceHeight * scale);
  const targetX = Math.round((1024 - targetWidth) / 2);
  const targetY = Math.round((1024 - targetHeight) / 2 + 8);
  drawResampledRegion(canvas, masked, bounds.left, bounds.top, sourceWidth, sourceHeight, targetX, targetY, targetWidth, targetHeight);
  return canvas;
}

function removeConnectedWhiteBackground(source: ImageData): ImageData {
  const result = {
    width: source.width,
    height: source.height,
    data: new Uint8Array(source.data)
  };
  const visited = new Uint8Array(source.width * source.height);
  const queue: number[] = [];

  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) {
      return;
    }
    const pixel = y * source.width + x;
    if (visited[pixel]) {
      return;
    }
    const index = pixel * 4;
    if (!isBackgroundWhite(source.data[index], source.data[index + 1], source.data[index + 2])) {
      return;
    }
    visited[pixel] = 1;
    queue.push(pixel);
  };

  for (let x = 0; x < source.width; x += 1) {
    enqueue(x, 0);
    enqueue(x, source.height - 1);
  }
  for (let y = 0; y < source.height; y += 1) {
    enqueue(0, y);
    enqueue(source.width - 1, y);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const pixel = queue[index];
    const x = pixel % source.width;
    const y = Math.floor(pixel / source.width);
    result.data[pixel * 4 + 3] = 0;
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }

  return result;
}

function isBackgroundWhite(r: number, g: number, b: number): boolean {
  return r >= 245 && g >= 245 && b >= 245 && Math.max(r, g, b) - Math.min(r, g, b) <= 8;
}

function alphaBounds(image: ImageData): { left: number; top: number; right: number; bottom: number } {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > 8) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left || bottom < top) {
    throw new Error("Could not find non-background pixels in the Teti logo source");
  }
  return { left, top, right, bottom };
}

function resizeImage(source: ImageData, width: number, height: number): ImageData {
  const target = createImage(width, height);
  drawResampledRegion(target, source, 0, 0, source.width, source.height, 0, 0, width, height);
  return target;
}

function drawResampledRegion(
  target: ImageData,
  source: ImageData,
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
  targetX: number,
  targetY: number,
  targetWidth: number,
  targetHeight: number
): void {
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = sourceX + ((x + 0.5) / targetWidth) * sourceWidth - 0.5;
      const sy = sourceY + ((y + 0.5) / targetHeight) * sourceHeight - 0.5;
      const color = sampleBilinear(source, sx, sy);
      blendPixel(target, targetX + x, targetY + y, color, color[3] / 255);
    }
  }
}

function sampleBilinear(image: ImageData, x: number, y: number): Color {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(image.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
  const tx = clamp01(x - x0);
  const ty = clamp01(y - y0);
  const c00 = getPixel(image, x0, y0);
  const c10 = getPixel(image, x1, y0);
  const c01 = getPixel(image, x0, y1);
  const c11 = getPixel(image, x1, y1);
  return [0, 1, 2, 3].map((channel) => {
    const top = c00[channel] + (c10[channel] - c00[channel]) * tx;
    const bottom = c01[channel] + (c11[channel] - c01[channel]) * tx;
    return Math.round(top + (bottom - top) * ty);
  }) as Color;
}

function getPixel(image: ImageData, x: number, y: number): Color {
  const index = (y * image.width + x) * 4;
  return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]] as Color;
}

function unfilterRow(row: Buffer, previous: Buffer | undefined, filter: number, bytesPerPixel: number): void {
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const up = previous?.[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous?.[index - bytesPerPixel] ?? 0 : 0;
    switch (filter) {
      case 0:
        break;
      case 1:
        row[index] = (row[index] + left) & 0xff;
        break;
      case 2:
        row[index] = (row[index] + up) & 0xff;
        break;
      case 3:
        row[index] = (row[index] + Math.floor((left + up) / 2)) & 0xff;
        break;
      case 4:
        row[index] = (row[index] + paeth(left, up, upLeft)) & 0xff;
        break;
      default:
        throw new Error(`Unsupported PNG filter ${filter}`);
    }
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  return upDistance <= upLeftDistance ? up : upLeft;
}

function writePng(path: string, image: ImageData): void {
  const raw = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rowStart = y * (image.width * 4 + 1);
    raw[rowStart] = 0;
    raw.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), rowStart + 1);
  }

  const chunks = [
    chunk("IHDR", ihdr(image.width, image.height)),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ];
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]));
}

function writeIcns(path: string): void {
  const entries = [
    ["icp4", "icon_16x16.png"],
    ["icp5", "icon_32x32.png"],
    ["icp6", "icon_32x32@2x.png"],
    ["ic07", "icon_128x128.png"],
    ["ic08", "icon_128x128@2x.png"],
    ["ic09", "icon_256x256@2x.png"],
    ["ic10", "icon_512x512@2x.png"]
  ] as const;
  const chunks = entries.map(([type, file]) => {
    const data = readFileSync(join(iconsetDir, file));
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 8);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  writeFileSync(path, Buffer.concat([header, ...chunks]));
}

function ihdr(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  return buffer;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fillRect(image: ImageData, x: number, y: number, width: number, height: number, color: Color): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(image.width, Math.ceil(x + width));
  const bottom = Math.min(image.height, Math.ceil(y + height));
  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      blendPixel(image, px, py, color, color[3] / 255);
    }
  }
}

function fillRoundedRect(
  image: ImageData,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  colorForPixel: (x: number, y: number) => Color
): void {
  const left = Math.max(0, Math.floor(x - 2));
  const top = Math.max(0, Math.floor(y - 2));
  const right = Math.min(image.width, Math.ceil(x + width + 2));
  const bottom = Math.min(image.height, Math.ceil(y + height + 2));
  const cx = x + width / 2;
  const cy = y + height / 2;
  const bx = width / 2 - radius;
  const by = height / 2 - radius;

  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      const qx = Math.abs(px + 0.5 - cx) - bx;
      const qy = Math.abs(py + 0.5 - cy) - by;
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      const outside = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
      const coverage = clamp01(0.5 - outside);
      if (coverage > 0) {
        const color = colorForPixel(px, py);
        blendPixel(image, px, py, color, coverage * (color[3] / 255));
      }
    }
  }
}

function fillEllipse(image: ImageData, cx: number, cy: number, rx: number, ry: number, color: Color): void {
  const left = Math.max(0, Math.floor(cx - rx - 2));
  const top = Math.max(0, Math.floor(cy - ry - 2));
  const right = Math.min(image.width, Math.ceil(cx + rx + 2));
  const bottom = Math.min(image.height, Math.ceil(cy + ry + 2));

  for (let py = top; py < bottom; py += 1) {
    for (let px = left; px < right; px += 1) {
      const dx = (px + 0.5 - cx) / rx;
      const dy = (py + 0.5 - cy) / ry;
      const distance = Math.hypot(dx, dy);
      const coverage = clamp01((1 - distance) * Math.max(rx, ry));
      if (coverage > 0) {
        blendPixel(image, px, py, color, coverage * (color[3] / 255));
      }
    }
  }
}

function blendPixel(image: ImageData, x: number, y: number, color: Color, coverage: number): void {
  const index = (y * image.width + x) * 4;
  const srcA = clamp01(coverage);
  const dstA = image.data[index + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) {
    return;
  }
  image.data[index] = Math.round((color[0] * srcA + image.data[index] * dstA * (1 - srcA)) / outA);
  image.data[index + 1] = Math.round((color[1] * srcA + image.data[index + 1] * dstA * (1 - srcA)) / outA);
  image.data[index + 2] = Math.round((color[2] * srcA + image.data[index + 2] * dstA * (1 - srcA)) / outA);
  image.data[index + 3] = Math.round(outA * 255);
}

function blit(target: ImageData, source: ImageData, x: number, y: number): void {
  for (let py = 0; py < source.height; py += 1) {
    for (let px = 0; px < source.width; px += 1) {
      const srcIndex = (py * source.width + px) * 4;
      const color: Color = [
        source.data[srcIndex],
        source.data[srcIndex + 1],
        source.data[srcIndex + 2],
        source.data[srcIndex + 3]
      ];
      blendPixel(target, x + px, y + py, color, color[3] / 255);
    }
  }
}

function mixColor(a: Color, b: Color, amount: number): Color {
  const t = clamp01(amount);
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t)
  ];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const font: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "A": ["111", "101", "111", "101", "101"],
  "C": ["111", "100", "100", "100", "111"],
  "D": ["110", "101", "101", "101", "110"],
  "E": ["111", "100", "111", "100", "111"],
  "H": ["101", "101", "111", "101", "101"],
  "I": ["111", "010", "010", "010", "111"],
  "K": ["101", "101", "110", "101", "101"],
  "M": ["101", "111", "111", "101", "101"],
  "N": ["101", "111", "111", "111", "101"],
  "O": ["111", "101", "101", "101", "111"],
  "R": ["110", "101", "110", "101", "101"],
  "S": ["111", "100", "111", "001", "111"],
  "T": ["111", "010", "010", "010", "010"],
  "X": ["101", "101", "010", "101", "101"],
  "Z": ["111", "001", "010", "100", "111"],
  " ": ["000", "000", "000", "000", "000"],
  "x": ["000", "101", "010", "101", "000"]
};

function drawText(image: ImageData, text: string, x: number, y: number, scale: number, color: Color): void {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    const glyph = font[char] ?? font[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === "1") {
          fillRect(image, cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += 4 * scale;
  }
}

main();
