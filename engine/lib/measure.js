/* Sizes as File Fabric draws them, for laying out what an agent writes and
 * for checking what overlaps (t-12859aa2fb). NoteX has no browser to
 * measure in, so text is estimated a little wide and tall from File
 * Fabric's own fonts and line heights; once File Fabric has drawn a text it
 * saves _calculatedHeight, and the real height wins (t-2afecbd70b).
 *
 * File cards are drawn centred on their x, y (style.css .file-item,
 * translate(-50%, -50%)), so their box here is centred too - unlike
 * geometry.js's itemBBox, which keeps File Fabric's own getItemBBox
 * (t-8ba8064e60).
 */
import fs from 'node:fs';
import { areaBBox, polygonsOf } from './geometry.js';

// The user's margins inside a box: 39 px at the sides, 75 px at the top for its name.
export const M = {
  SIDE: 39, TOP: 75, BOTTOM: 39,
  GAP: 30, ROW_GAP: 80, TOTEM_GAP: 60, TOTEM_ABOVE: 100,
  TEXT_WIDTH: 620, FONT: 18,
  NOTE_W: 250, NOTE_MAX_W: 420, NOTE_MIN_H: 120,
  AREA_MIN_W: 200, AREA_MIN_H: 150, SCROLL_MIN_W: 400, SCROLL_MIN_H: 300,
  IMAGE_MAX_W: 480,
};

// Inter averages about half an em a character; 0.55 keeps an estimate on the wide side.
const INTER = 0.55;
// Notes are Consolas 14 px at line-height 1.4, inside 60 px top, 24 px sides and 20 px bottom padding (script.js L9522).
const NOTE = { FONT: 14, CHAR: 7.7, LINE: 19.6, PAD_TOP: 60, PAD_SIDE: 24, PAD_BOTTOM: 20, CHECKBOX: 22 };

const wrapCount = (line, perLine) => {
  if (!line.length) return 1;
  let lines = 1, used = 0;
  for (const word of line.split(' ')) {
    const w = word.length;
    if (used === 0) { used = w; while (used > perLine) { lines++; used -= perLine; } continue; }
    if (used + 1 + w <= perLine) used += 1 + w;
    else { lines++; used = w; while (used > perLine) { lines++; used -= perLine; } }
  }
  return lines;
};

/* A text drawing: as wide as its longest line up to the user's 620 px, and
 * as tall as its wrapped lines at File Fabric's line-height 1.2. */
export function measureText(text, { size = M.FONT, maxWidth = M.TEXT_WIDTH } = {}) {
  const char = size * INTER;
  const lines = String(text).split('\n');
  const longest = Math.max(...lines.map((l) => l.length));
  const width = Math.round(Math.max(40, Math.min(maxWidth, longest * char + 4)));
  const perLine = Math.max(1, Math.floor(width / char));
  const count = lines.reduce((s, l) => s + wrapCount(l, perLine), 0);
  return { w: width, h: Math.ceil(count * size * 1.2) };
}

// getLineFontSize, script.js L757, for a note's "#" lines at its 14 px.
const headingSize = (level) => NOTE.FONT * ([2.0, 1.5, 1.25, 1.1, 1.0, 1.0][level - 1]);

/* A note: wide enough for its longest line within 250-420 px, tall enough
 * for every line, checkbox lines a little narrower for the box. */
export function measureNote(text, { width = null } = {}) {
  const lines = String(text).split('\n');
  const longest = Math.max(...lines.map((l) => l.length));
  const w = width || Math.round(Math.max(M.NOTE_W, Math.min(M.NOTE_MAX_W, longest * NOTE.CHAR + 2 * NOTE.PAD_SIDE + NOTE.CHECKBOX)));
  const inner = w - 2 * NOTE.PAD_SIDE;
  let h = 0;
  for (const line of lines) {
    const head = /^(#{1,6})\s*(.*)$/.exec(line);
    if (head) {
      const fs = headingSize(head[1].length);
      h += wrapCount(head[2], Math.max(1, Math.floor(inner / (fs * INTER)))) * fs * 1.2 + fs * 0.4;
      continue;
    }
    const cb = /^(\s*)-\s*\[[ xX]\]\s*(.*)$/.exec(line);
    const body = cb ? cb[1] + cb[2] : line;
    const room = inner - (cb ? NOTE.CHECKBOX : 0);
    h += wrapCount(body, Math.max(1, Math.floor(room / NOTE.CHAR))) * NOTE.LINE;
  }
  return { w, h: Math.max(M.NOTE_MIN_H, Math.ceil(NOTE.PAD_TOP + h + NOTE.PAD_BOTTOM + 10)) };
}

// isImageFile and isPdfFile, script.js L3583.
const ext = (name) => String(name).split('.').pop().toLowerCase();
export const isImageName = (name) => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext(name));
export const isPdfName = (name) => ext(name) === 'pdf';

/* An image's real width and height from its first bytes: PNG, JPEG, GIF,
 * WebP and BMP. null for anything else (SVG, ICO), which is then shown at
 * File Fabric's own 200 px square. */
export function imageSize(file) {
  let b;
  try {
    const fd = fs.openSync(file, 'r');
    try { b = Buffer.alloc(64 * 1024); b = b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length >= 26 && b.toString('ascii', 0, 2) === 'BM') return { w: b.readInt32LE(18), h: Math.abs(b.readInt32LE(22)) };
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/* What File Fabric shows a file as: an image at its imageWidth x
 * imageHeight with 6 px padding and its name below; anything else as a
 * card 80 px wide inside 12 px padding, its name broken over lines of
 * about 11 characters (style.css .file-item, .file-main-content). */
export function fileSize(f) {
  if (f.isImage) {
    const w = f.imageWidth || 200, h = f.imageHeight || w;
    return { w: w + 14, h: h + 36 };
  }
  if (f.isPinnedPdfPage) return { w: (f.imageWidth || 200) + 2, h: (f.imageHeight || 260) + 36 };
  const lines = Math.max(1, Math.ceil(String(f.name || 'file').length / 11));
  return { w: 106, h: 98 + lines * 15 };
}

/* The size an image is shown at: its real size, no wider than 480 px. */
export function imageShown(real) {
  if (!real || !real.w || !real.h) return { w: 200, h: 200 };
  const w = Math.min(M.IMAGE_MAX_W, real.w);
  return { w, h: Math.max(1, Math.round(w * real.h / real.w)) };
}

/* ------------------------------------------------------ boxes on canvas */

/* The text of a text drawing as words, for measuring: File Fabric keeps HTML. */
export function textOf(d) {
  return String(d.text || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|h[1-6])>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n$/, '');
}

export function textBox(d) {
  const est = measureText(textOf(d), { size: d.fontSize || M.FONT, maxWidth: d.width || M.TEXT_WIDTH });
  const w = d._calculatedWidth ?? d.width ?? est.w;
  const h = d._calculatedHeight ?? est.h;
  const minX = d.textAlign === 'center' ? d.x - w / 2 : d.textAlign === 'right' ? d.x - w : d.x;
  return { minX, minY: d.y, maxX: minX + w, maxY: d.y + h, measured: d._calculatedHeight != null };
}

export function fileBox(f) {
  const { w, h } = fileSize(f);
  return { minX: f.x - w / 2, minY: f.y - h / 2, maxX: f.x + w / 2, maxY: f.y + h / 2 };
}

const pointsBox = (pts) => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
};

/* Any item's box as it shows on the canvas; null for what has no place. */
export function visualBox(item, kind) {
  if (kind === 'area') return polygonsOf(item).length ? areaBBox(item) : null;
  if (kind === 'file') return fileBox(item);
  if (kind === 'totem') return { minX: item.x, minY: item.y, maxX: item.x, maxY: item.y };
  if (item.type === 'text') return textBox(item);
  if (item.start && item.end) return pointsBox([item.start, item.end]);
  if (Array.isArray(item.points) && item.points.length) return pointsBox(item.points);
  if (item.x !== undefined && item.y !== undefined) return { minX: item.x, minY: item.y, maxX: item.x + 100, maxY: item.y + 50 };
  return null;
}
