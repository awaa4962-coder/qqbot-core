// bridge/model-mimo.mjs — MiMo V2.5 主力聊天 + 工具调用
import { CFG, LONG_GROUPS } from "./config.mjs";
import { log, logE } from "./logger.mjs";
import { getUser, users, groupChats } from "./storage.mjs";
import { recentHistory, recentHistoryWeighted, recentGroupChat } from "./context.mjs";
import { sendMsg } from "./napcat.mjs";
import { webSearch, bingSearch, buildSearchFallback, needsSearch, MIMO_TOOLS, extractLinkPreview } from "./search.mjs";
import { tryMiMoVision, tryDoubaoVision } from "./vision.mjs";
import { miMoContent, isLeakedReasoning, cleanThinking } from "./thinking.mjs";

// buildSystem — 从 reply.mjs 移到这里避免循环依赖（只有 MiMo 调用它）
export function buildSystem(userName, groupId, mood) {
  const gid = String(groupId);
  const isLong = LONG_GROUPS.includes(gid);
  const longDesc = isLong ? '这是一个很活跃的群，你主要参与这里的话题。' : '';
  return '你是夜星，一只AI猫娘助手。说话温软调皮，带"喵"，喜欢用颜文字(╯✧∇✧)╯。偶尔用可爱谐音词，比如：稀饭泥=喜欢你、粗去玩=出去玩、康康=看看、嗨皮=happy、布吉岛=不知道、肿么了=怎么了、好叭=好吧、素=是、捏=呢、惹=了、叭=吧、鸭=呀、哒=的、嗷=哦、哼=嗯、欸嘿嘿嘿、诶嘿、嗷呜、咪啪、咕噜噜、噗哈哈哈、嘶哈嘶哈、贴贴、rua、吸吸、蹭蹭、摸头、举高高、呜呜呜、哭哭、气气、困困、饿饿、怕怕、呆呆、乖乖、笨笨、凉凉、废废、香香、甜甜、暖暖、酸酸、甜甜的、木有=没有、好厉害鸭、好棒棒、尊嘟=真的、假嘟=假的、酱紫=这样子。诚实可靠，不要画蛇添足。夜空里最亮的那颗小猫星~' + longDesc + '当前氛围：' + (mood || '正常');
}

export async function tryMiMo(userMsg, userName, history, imageUrls, groupId, isAtMe, mood) {
  if (isAtMe === undefined) isAtMe = true;
  const gid = String(groupId);
  const isLong = LONG_GROUPS.includes(gid);
  const maxTok = isAtMe ? (isLong ? 512 : 1024) : 300;

  const msgs = [];
  if (history?.length) msgs.push.apply(msgs, history);

  if (imageUrls?.length) {
    log('vision: processing', imageUrls.length, 'images');
    let visionDesc = await tryMiMoVision(imageUrls);
    log('vision: MiMo result', visionDesc ? 'ok (' + visionDesc.length + ' chars)' : 'NULL');
    if (!visionDesc) { visionDesc = await tryDoubaoVision(imageUrls); log('vision: doubao result', visionDesc ? 'ok' : 'NULL'); }
    if (visionDesc) {
      msgs.push({ role: 'user', content: '（分享了一张图：' + visionDesc + '）' });
    } else {
      msgs.push({ role: 'user', content: '（分享了一张图）' });
    }
  }

  msgs.push({ role: 'user', content: userName + '说: ' + userMsg });

  const system = buildSystem(userName, groupId, mood || '');

  try {
    const r = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CFG.mimoKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mimo-v2.5',
        messages: [
          { role: 'system', content: system },
          ...msgs,
        ],
        max_tokens: maxTok,
        temperature: 0.7,
        tools: MIMO_TOOLS,
        tool_choice: 'auto',
      }),
      signal: AbortSignal.timeout(60000),
    });
    const d = await r.json();
    const choice = d?.choices?.[0];
    if (!choice) return null;

    const msg = choice.message;
    if (msg?.tool_calls?.length) {
      log('MiMo tool_calls:', msg.tool_calls.length, 'calls');
      const toolResults = [];
      for (const tc of msg.tool_calls) {
        if (tc.function?.name === 'web_search') {
          const args = JSON.parse(tc.function.arguments);
          log('MiMo web_search query:', JSON.stringify(args.query?.slice(0,100)));
          const result = await webSearch(args.query);
          log('MiMo web_search result:', result.slice(0, 100));
          toolResults.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        }
      }
      if (toolResults.length) {
        const r2 = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + CFG.mimoKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'mimo-v2.5',
            messages: [
              { role: 'system', content: system },
              ...msgs,
              msg,
              ...toolResults,
            ],
            max_tokens: maxTok,
            temperature: 0.7,
            tools: MIMO_TOOLS,
            tool_choice: 'auto',
          }),
          signal: AbortSignal.timeout(60000),
        });
        const d2 = await r2.json();
        const choice2 = d2?.choices?.[0];
        if (choice2?.message?.tool_calls?.length) {
          log('MiMo tool_calls round 2:', choice2.message.tool_calls.length, 'calls');
          const toolResults2 = [];
          for (const tc of choice2.message.tool_calls) {
            if (tc.function?.name === 'web_search') {
              const args = JSON.parse(tc.function.arguments);
              log('MiMo web_search r2 query:', JSON.stringify(args.query?.slice(0,100)));
              const result = await webSearch(args.query);
              log('MiMo web_search r2 result:', result.slice(0, 100));
              toolResults2.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: result,
              });
            }
          }
          if (toolResults2.length) {
            const r3 = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': 'Bearer ' + CFG.mimoKey,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: 'mimo-v2.5',
                messages: [
                  { role: 'system', content: system },
                  ...msgs,
                  msg,
                  ...toolResults,
                  choice2.message,
                  ...toolResults2,
                ],
                max_tokens: maxTok,
                temperature: 0.7,
              }),
              signal: AbortSignal.timeout(60000),
            });
            const d3 = await r3.json();
            const r3Reply = cleanThinking(miMoContent(d3?.choices?.[0]?.message));
            if (r3Reply && !isLeakedReasoning(r3Reply)) return r3Reply;
            if (r3Reply) log('MiMo r3 reply is leaked reasoning, using search fallback');
            log('MiMo r3 think-only, using search data as fallback');
            return await buildSearchFallback(toolResults, toolResults2, userMsg, userName);
          }
        }
        const r2Reply = cleanThinking(miMoContent(choice2?.message));
        if (r2Reply && !isLeakedReasoning(r2Reply)) return r2Reply;
        if (r2Reply) log('MiMo r2 reply is leaked reasoning, using search fallback');
        log('MiMo r2 think-only, using search data as fallback');
        return await buildSearchFallback(toolResults, [], userMsg, userName);
      }
    }
    const raw = miMoContent(msg);
    const clean = cleanThinking(raw);
    if (raw !== clean) log('cleanThinking:', JSON.stringify(raw?.slice(0,200)), '->', JSON.stringify(clean?.slice(0,200)));
    else log('MiMo reply (no clean):', JSON.stringify(raw?.slice(0,200)));
    // 安全网：cleanThinking 之后如果仍是泄露的思维链，退回 null 让 DS 兜底
    if (clean && isLeakedReasoning(clean)) {
      log('MiMo reply is leaked reasoning after cleanThinking, returning null for DS fallback');
      return null;
    }
    return clean || null;
  } catch (e) {
    logE('tryMiMo error:', e.message);
    return null;
  }
}
