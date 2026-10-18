import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  assertImagePlanRenderableWithoutTransformer,
  inspectImageBytes,
  normalizeImageTransformSpec,
  planImageTransform,
  renderImageTransform,
  renderImageTransformCached,
} from "../dist/index.js";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function validPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      row[offset] = 40 + (x % 180);
      row[offset + 1] = 80 + (y % 160);
      row[offset + 2] = 180;
      row[offset + 3] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  Buffer.from("IHDR").copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width, height) {
  return Buffer.from([
    0xff,0xd8,
    0xff,0xc0,0x00,0x11,0x08,
    (height >> 8) & 0xff,height & 0xff,
    (width >> 8) & 0xff,width & 0xff,
    0x03,0x01,0x11,0x00,0x02,0x11,0x00,0x03,0x11,0x00,
    0xff,0xd9,
  ]);
}

test("image metadata uses actual PNG and JPEG bytes", () => {
  assert.deepEqual(inspectImageBytes(png(1200, 630)), {
    mediaType: "image/png",
    width: 1200,
    height: 630,
    byteLength: 24,
  });
  const jpegInfo = inspectImageBytes(jpeg(1600, 900));
  assert.equal(jpegInfo.mediaType, "image/jpeg");
  assert.equal(jpegInfo.width, 1600);
  assert.equal(jpegInfo.height, 900);
});

test("transform planning is deterministic and captures destination dimensions", () => {
  const bytes = png(1600, 900);
  const first = planImageTransform({
    bytes,
    spec: { width: 1200, height: 630, fit: "cover", format: "jpeg", quality: 82, maxBytes: 5000000 },
  });
  const second = planImageTransform({
    bytes,
    spec: { maxBytes: 5000000, quality: 82, format: "jpeg", fit: "cover", height: 630, width: 1200 },
  });
  assert.equal(first.transformationFingerprint, second.transformationFingerprint);
  assert.equal(first.derivedAssetId, second.derivedAssetId);
  assert.deepEqual(first.output, {
    mediaType: "image/jpeg",
    width: 1200,
    height: 630,
    maxBytes: 5000000,
  });
  assert.equal(first.renderRequired, true);
});

test("identity plans can deliver without a renderer while real transforms fail closed", () => {
  const identity = planImageTransform({ bytes: png(1200, 630), spec: { quality: 85 } });
  assert.equal(identity.renderRequired, false);
  assert.doesNotThrow(() => assertImagePlanRenderableWithoutTransformer(identity));

  const transform = planImageTransform({ bytes: png(1200, 630), spec: { width: 600 } });
  assert.equal(transform.renderRequired, true);
  assert.throws(() => assertImagePlanRenderableWithoutTransformer(transform), /requires a media renderer/);
});

test("transform constraints validate focal point and bounds", () => {
  assert.throws(() => normalizeImageTransformSpec({ width: 0 }), /Image width/);
  assert.throws(() => normalizeImageTransformSpec({ quality: 101 }), /quality/);
  assert.throws(() => normalizeImageTransformSpec({ focalPoint: { x: -0.1, y: 0.5 } }), /focalPoint.x/);
});


test("sharp renderer materializes the exact planned format and dimensions", async () => {
  const source = validPng(16, 9);
  const plan = planImageTransform({
    bytes: source,
    spec: {
      width: 12,
      height: 6,
      fit: "cover",
      focalPoint: { x: 0.25, y: 0.5 },
      format: "jpeg",
      quality: 82,
      maxBytes: 200000,
    },
  });
  const rendered = await renderImageTransform({ bytes: source, plan });
  assert.equal(rendered.mediaType, "image/jpeg");
  assert.equal(rendered.width, 12);
  assert.equal(rendered.height, 6);
  assert.ok(rendered.byteLength <= 200000);
  assert.match(rendered.outputFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(rendered.transformationFingerprint, plan.transformationFingerprint);
});

test("derived image cache reuses the transformation fingerprint identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "blogmaatic-media-cache-test-"));
  const sourcePath = join(root, "source.png");
  const cacheDirectory = join(root, "cache");
  const source = validPng(20, 10);
  await writeFile(sourcePath, source);
  try {
    const plan = planImageTransform({
      bytes: source,
      spec: { width: 10, height: 10, fit: "cover", format: "webp", quality: 80 },
    });
    const first = await renderImageTransformCached({ sourcePath, plan, cacheDirectory });
    const second = await renderImageTransformCached({ sourcePath, plan, cacheDirectory });
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(first.cachePath, second.cachePath);
    assert.equal(first.outputFingerprint, second.outputFingerprint);
    assert.equal(first.derivedAssetId, second.derivedAssetId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
