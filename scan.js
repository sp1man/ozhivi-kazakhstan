// Обработка фото раскраски: находим толстую рамку шаблона, обрезаем по ней,
// убираем белую бумагу (делаем прозрачной) и подрезаем по самому рисунку.
window.Scan = (function () {
  function loadImage(src) {
    return new Promise((ok, bad) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = bad;
      img.src = src;
    });
  }

  function fileToDataURL(file) {
    return new Promise((ok, bad) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = bad;
      r.readAsDataURL(file);
    });
  }

  // Уменьшаем фото до maxSide — и для отправки с телефона, и для обработки.
  function downscale(img, maxSide) {
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const c = document.createElement('canvas');
    c.width = Math.round((img.naturalWidth || img.width) * k);
    c.height = Math.round((img.naturalHeight || img.height) * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function otsu(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = gray.length - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }

  // Рамка шаблона — самое крупное тёмное «кольцо», не касающееся краёв фото
  // (стол или фон вокруг листа касаются краёв и отсеиваются).
  function findFrame(gray, w, h, thr) {
    const k = Math.min(1, 360 / Math.max(w, h));
    const sw = Math.round(w * k), sh = Math.round(h * k);
    const dark = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++)
        dark[y * sw + x] = gray[Math.floor(y / k) * w + Math.floor(x / k)] < thr ? 1 : 0;
    const seen = new Uint8Array(sw * sh);
    const stack = [];
    let best = null;
    for (let s = 0; s < sw * sh; s++) {
      if (!dark[s] || seen[s]) continue;
      let n = 0, x0 = sw, y0 = sh, x1 = 0, y1 = 0, edge = false;
      stack.push(s); seen[s] = 1;
      while (stack.length) {
        const p = stack.pop(), x = p % sw, y = (p / sw) | 0;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === sw - 1 || y === sh - 1) edge = true;
        for (const q of [p - 1, p + 1, p - sw, p + sw]) {
          if (q < 0 || q >= sw * sh || seen[q] || !dark[q]) continue;
          if ((q === p - 1 && x === 0) || (q === p + 1 && x === sw - 1)) continue;
          seen[q] = 1; stack.push(q);
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, area = bw * bh;
      if (edge || bw < sw * 0.3 || bh < sh * 0.2) continue;
      if (n / area > 0.45 || bw / bh > 1.6 || bh / bw > 1.6) continue;
      if (!best || area > best.area) best = { x0, y0, bw, bh, area };
    }
    if (!best) return null;
    // толщина рамки: идём от левого края кольца вправо по средней строке
    const my = best.y0 + (best.bh >> 1);
    let t = 0;
    while (t < best.bw / 4 && dark[my * sw + best.x0 + t]) t++;
    const inset = t + Math.max(2, Math.round(best.bw * 0.02));
    return {
      x: Math.round((best.x0 + inset) / k), y: Math.round((best.y0 + inset) / k),
      w: Math.round((best.bw - 2 * inset) / k), h: Math.round((best.bh - 2 * inset) / k),
    };
  }

  async function process(src) {
    const img = typeof src === 'string' ? await loadImage(src) : src;
    let c = downscale(img, 1100);
    let ctx = c.getContext('2d', { willReadFrequently: true });
    let { width: w, height: h } = c;
    let px = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) gray[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) | 0;
    const thr = Math.min(otsu(gray), 110);

    const fr = findFrame(gray, w, h, thr);
    if (fr) {
      const cc = document.createElement('canvas');
      cc.width = fr.w; cc.height = fr.h;
      cc.getContext('2d').drawImage(c, fr.x, fr.y, fr.w, fr.h, 0, 0, fr.w, fr.h);
      c = cc; ctx = c.getContext('2d', { willReadFrequently: true });
      w = c.width; h = c.height;
    }

    const data = ctx.getImageData(0, 0, w, h);
    px = data.data;
    // Цвет бумаги — светлый процентиль яркости (фото бывает серым и неровно освещённым).
    const lums = [];
    for (let i = 0; i < px.length; i += 16) lums.push(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
    lums.sort((a, b) => a - b);
    const paper = lums[Math.floor(lums.length * 0.9)] || 255;
    const cut = paper * 0.8, soft = paper * 0.68;

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        let a = 255;
        if (sat < 38) {
          if (lum >= cut) a = 0;
          else if (lum > soft) a = Math.round(255 * (cut - lum) / (cut - soft));
        }
        px[i + 3] = a;
        if (a > 40) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    ctx.putImageData(data, 0, 0);
    if (maxX < 0) return c;
    const pad = 4;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1; out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  // Обрезка прозрачных полей вокруг рисунка.
  function trim(c) {
    const { width: w, height: h } = c;
    const px = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 20) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return c;
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  return { process, loadImage, fileToDataURL, downscale, trim };
})();
