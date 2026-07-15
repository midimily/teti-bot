import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const root = new URL("../../..", import.meta.url).pathname;
const desktopRoot = join(root, "apps", "desktop");
const tauriConfigPath = join(desktopRoot, "src-tauri", "tauri.conf.json");
const iconsDir = join(desktopRoot, "src-tauri", "icons");

const requiredPngs = [
  [join(desktopRoot, "assets", "icon-source.png"), 1024, 1024],
  [join(desktopRoot, "assets", "icon-inspection-sheet.png"), 1800, 1500],
  [join(iconsDir, "32x32.png"), 32, 32],
  [join(iconsDir, "128x128.png"), 128, 128],
  [join(iconsDir, "128x128@2x.png"), 256, 256],
  [join(iconsDir, "icon.png"), 512, 512],
  [join(iconsDir, "Teti.iconset", "icon_16x16.png"), 16, 16],
  [join(iconsDir, "Teti.iconset", "icon_32x32.png"), 32, 32],
  [join(iconsDir, "Teti.iconset", "icon_512x512@2x.png"), 1024, 1024]
] as const;

for (const [path, width, height] of requiredPngs) {
  assert.equal(existsSync(path), true, `missing ${path}`);
  assert.deepEqual(readPngSize(path), { width, height }, `wrong dimensions for ${path}`);
}

const icnsPath = join(iconsDir, "icon.icns");
assert.equal(existsSync(icnsPath), true, "missing macOS icon.icns");
assert.equal(readFileSync(icnsPath).subarray(0, 4).toString("ascii"), "icns", "icon.icns is not an icns file");

const config = JSON.parse(readFileSync(tauriConfigPath, "utf8")) as {
  bundle?: { icon?: string[] };
};
const configuredIcons = config.bundle?.icon ?? [];
assert.deepEqual(configuredIcons, [
  "icons/32x32.png",
  "icons/128x128.png",
  "icons/128x128@2x.png",
  "icons/icon.icns",
  "icons/icon.png"
]);
assert.equal(JSON.stringify(configuredIcons).toLowerCase().includes("tauri"), false);

for (const size of [16, 32]) {
  const iconPath = join(iconsDir, "Teti.iconset", `icon_${size}x${size}.png`);
  const pixels = readPngRgba(iconPath);
  assert.ok(countDarkEyePixels(pixels) >= (size === 16 ? 2 : 8), `${size}x${size} eyes are not visible enough`);
}

console.log("Teti desktop icon assets verified.");

function readPngSize(path: string): { width: number; height: number } {
  const buffer = readFileSync(path);
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG", `${path} is not a PNG`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function readPngRgba(path: string): { width: number; height: number; data: Buffer } {
  const buffer = readFileSync(path);
  const { width, height } = readPngSize(path);
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") {
      chunks.push(data);
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(chunks));
  const rgba = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const rawStart = y * (stride + 1);
    const filter = raw[rawStart];
    const row = Buffer.from(raw.subarray(rawStart + 1, rawStart + 1 + stride));
    const previous = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : undefined;
    unfilterRow(row, previous, filter, 4);
    row.copy(rgba, y * stride);
  }
  return { width, height, data: rgba };
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
        throw new Error(`unsupported PNG filter ${filter}`);
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

function countDarkEyePixels(image: { width: number; height: number; data: Buffer }): number {
  let dark = 0;
  for (let y = Math.floor(image.height * 0.38); y < Math.ceil(image.height * 0.58); y += 1) {
    for (let x = Math.floor(image.width * 0.35); x < Math.ceil(image.width * 0.67); x += 1) {
      const index = (y * image.width + x) * 4;
      const alpha = image.data[index + 3];
      const luminance = image.data[index] * 0.2126 + image.data[index + 1] * 0.7152 + image.data[index + 2] * 0.0722;
      if (alpha > 180 && luminance < 42) {
        dark += 1;
      }
    }
  }
  return dark;
}
