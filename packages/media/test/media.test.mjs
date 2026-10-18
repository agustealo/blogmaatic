import assert from "node:assert/strict";
import test from "node:test";

import {
  assertImagePlanRenderableWithoutTransformer,
  inspectImageBytes,
  normalizeImageTransformSpec,
  planImageTransform,
} from "../dist/index.js";

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
