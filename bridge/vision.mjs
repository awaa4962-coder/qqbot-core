// bridge/vision.mjs — 图片理解（MiMo Vision + 豆包 Vision 兜底）
import { CFG } from './config.mjs';
import { log, logE } from './logger.mjs';
import { miMoContent, cleanThinking, isLeakedReasoning } from './thinking.mjs';
import { mimoVision } from './clients/providers/mimo.mjs';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB 单图上限

async function _downloadImages(imageUrls, label) {
  const contents = [];
  for (const url of imageUrls.slice(0, 3)) {
    try {
      const cl = parseInt((await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })).headers.get('content-length') || '0');
      if (cl > MAX_IMAGE_BYTES) { logE(label + ': image too large ' + (cl/1024/1024).toFixed(1) + 'MB, skipping'); continue; }
    } catch { /* HEAD may fail, continue with GET */ }
    try {
      const imgResp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!imgResp.ok) { logE(label + ': download failed HTTP ' + imgResp.status + ' ' + url.slice(0,60)); continue; }
      const buffer = Buffer.from(await imgResp.arrayBuffer());
      if (buffer.length > MAX_IMAGE_BYTES) { logE(label + ': image too large ' + (buffer.length/1024/1024).toFixed(1) + 'MB, skipping'); continue; }
      const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';
      const base64 = buffer.toString('base64');
      contents.push({ type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64 } });
      log(label + ': downloaded ' + (buffer.length/1024).toFixed(0) + 'KB ' + mimeType);
    } catch (e) { logE(label + ': failed to download image: ' + e.message); }
  }
  return contents;
}

export async function tryMiMoVision(imageUrls) {
  if (!imageUrls?.length || !CFG.mimoKey) return null;
  try {
    const imageContents = await _downloadImages(imageUrls, 'tryMiMoVision');
    if (!imageContents.length) { logE('tryMiMoVision: no images could be downloaded'); return null; }
    const result = await mimoVision(imageContents);
    const raw = miMoContent(result.raw?.choices?.[0]?.message);
    if (!raw) return null;
    // 防止泄露思维链到群聊
    const clean = cleanThinking(raw);
    if (clean && isLeakedReasoning(clean)) { log('tryMiMoVision: leaked reasoning filtered'); return null; }
    return clean || null;
  } catch (e) { logE('tryMiMoVision error: ' + e.message); return null; }
}

export async function tryDoubaoVision(imageUrls) {
  if (!imageUrls?.length || !CFG.doubaoKey) return null;
  try {
    const imageContents = await _downloadImages(imageUrls, 'tryDoubaoVision');
    if (!imageContents.length) { logE('tryDoubaoVision: no images could be downloaded'); return null; }
    const r = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + CFG.doubaoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'doubao-vision-pro-32k', messages: [{ role: 'user', content: [{ type: 'text', text: '请描述这些图片的内容，用中文回答，简洁一点。' }, ...imageContents] }], max_tokens: 300 }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json();
    return d?.choices?.[0]?.message?.content || null;
  } catch (e) { logE('tryDoubaoVision error: ' + e.message); return null; }
}
