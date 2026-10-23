// 此脚本运行于网页 MAIN world。只修改像素读出的副本，不修改页面的绘图缓冲区。
// Worker / OffscreenCanvas、字体、GPU 元数据、音频和操作系统不在覆盖范围内。
(() => {
  'use strict';
  const identity = __MULTICC_FINGERPRINT_SEED__;
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  let siteSeed = identity[0] >>> 0;
  for (const ch of location.origin) siteSeed = Math.imul(siteSeed ^ ch.charCodeAt(0), 16777619) >>> 0;
  function hash(x, y, channel) {
    let n = siteSeed ^ Math.imul(x, identity[1] | 1) ^ Math.imul(y, identity[2] | 1) ^ Math.imul(channel + 1, identity[3] | 1);
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
    return (n ^ (n >>> 16)) >>> 0;
  }
  function perturb(bytes, width, height, x, y, offset = 0, stride = width * 4) {
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const i = offset + row * stride + col * 4;
        if (i + 3 >= bytes.length || bytes[i + 3] === 0) continue;
        const n = hash(x + col, y + row, 0);
        // 约每 16 个像素微调一个 RGB 分量的最低位，保留 alpha。
        if ((n & 15) === 0) bytes[i + ((n >>> 4) % 3)] ^= 1;
      }
    }
  }
  function wrap(proto, name, factory) {
    if (!proto) return;
    const d = descriptor(proto, name);
    if (!d || typeof d.value !== 'function' || !d.configurable) return;
    define(proto, name, { ...d, value: factory(d.value) });
  }
  const canvasProto = globalThis.HTMLCanvasElement?.prototype;
  const contextProto = globalThis.CanvasRenderingContext2D?.prototype;
  if (canvasProto && contextProto) {
    const getContext = canvasProto.getContext;
    const getImageData = contextProto.getImageData;
    const putImageData = contextProto.putImageData;
    const drawImage = contextProto.drawImage;
    const createElement = Document.prototype.createElement;
    function copyForExport(canvas) {
      if (!canvas.width || !canvas.height) return canvas;
      const copy = apply(createElement, document, ['canvas']);
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = apply(getContext, copy, ['2d']);
      apply(drawImage, ctx, [canvas, 0, 0]);
      const data = apply(getImageData, ctx, [0, 0, copy.width, copy.height]);
      perturb(data.data, data.width, data.height, 0, 0);
      apply(putImageData, ctx, [data, 0, 0]);
      return copy;
    }
    wrap(contextProto, 'getImageData', original => function getImageData(...args) {
      const result = apply(original, this, args);
      // float16 读出保持原样。对象参数避免再次隐式转换造成可观察的副作用。
      if (result.data instanceof Uint8ClampedArray && args.slice(0, 4).every(v => typeof v === 'number' && Number.isFinite(v))) {
        const x = Math.trunc(args[0]) + (args[2] < 0 ? Math.trunc(args[2]) : 0);
        const y = Math.trunc(args[1]) + (args[3] < 0 ? Math.trunc(args[3]) : 0);
        perturb(result.data, result.width, result.height, x, y);
      }
      return result;
    });
    for (const name of ['toDataURL', 'toBlob']) {
      wrap(canvasProto, name, original => function (...args) {
        let copy;
        try { copy = copyForExport(this); }
        // 跨域污染或不支持的画布继续由原生方法决定错误，不绕过浏览器安全检查。
        catch (_) { return apply(original, this, args); }
        return apply(original, copy, args);
      });
    }
  }
  for (const proto of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
    wrap(proto, 'readPixels', original => function readPixels(...args) {
      const result = apply(original, this, args);
      const [x, y, width, height, format, type, pixels] = args;
      // 只覆盖最常见的 RGBA/UNSIGNED_BYTE 数组读出；不接管 PBO、float、stride/skip 布局。
      if (format === 0x1908 && type === 0x1401 && pixels instanceof Uint8Array &&
          [x, y, width, height].every(Number.isInteger) && x >= 0 && y >= 0 && width > 0 && height > 0 &&
          x + width <= this.drawingBufferWidth && y + height <= this.drawingBufferHeight) {
        const offset = args[7] === undefined ? 0 : args[7];
        const alignment = this.getParameter(this.PACK_ALIGNMENT);
        const stride = Math.ceil(width * 4 / alignment) * alignment;
        const defaultBuffer = this.getParameter(this.FRAMEBUFFER_BINDING) === null &&
          (this.READ_FRAMEBUFFER_BINDING === undefined || this.getParameter(this.READ_FRAMEBUFFER_BINDING) === null) &&
          (this.PIXEL_PACK_BUFFER_BINDING === undefined || this.getParameter(this.PIXEL_PACK_BUFFER_BINDING) === null) &&
          (this.READ_BUFFER === undefined || this.getParameter(this.READ_BUFFER) === this.BACK);
        const simpleLayout = this.PACK_ROW_LENGTH === undefined ||
          (!this.getParameter(this.PACK_ROW_LENGTH) && !this.getParameter(this.PACK_SKIP_PIXELS) && !this.getParameter(this.PACK_SKIP_ROWS));
        if (defaultBuffer && simpleLayout && Number.isInteger(offset) && offset >= 0 && pixels.length >= offset + (height - 1) * stride + width * 4) {
          perturb(pixels, width, height, x, y, offset, stride);
        }
      }
      return result;
    });
  }
})();
