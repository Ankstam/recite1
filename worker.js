function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 生成微软 Edge TTS 必需的 Sec-MS-GEC 动态校验哈希
async function generateSecMsGec(trustedToken) {
  const WIN_EPOCH = 11644473600n;
  const S_TO_NS = 10000000n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  let ticks = nowSec + WIN_EPOCH;
  ticks = ticks - (ticks % 300n);
  ticks = ticks * S_TO_NS;

  const strToHash = `${ticks.toString()}${trustedToken}`;
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(strToHash));
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function generateMuid() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// 1. 微软 Edge Neural 云端语音合成
async function synthesizeEdgeTts(text, voice = "en-US-JennyNeural", rateNum = 1.0) {
  const token = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const secMsGec = await generateSecMsGec(token);
  const gecVersion = "1-143.0.3650.75";
  const connId = crypto.randomUUID().replace(/-/g, "");
  const muid = generateMuid();

  const endpoints = [
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${token}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${gecVersion}&ConnectionId=${connId}`,
    `https://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=${token}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${gecVersion}&ConnectionId=${connId}`
  ];

  let ws = null;
  let lastStatus = 0;

  for (const ep of endpoints) {
    try {
      const upgradeRes = await fetch(ep, {
        headers: {
          "Upgrade": "websocket",
          "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
          "Cookie": `MUID=${muid};`
        }
      });
      lastStatus = upgradeRes.status;
      if (upgradeRes.webSocket) {
        ws = upgradeRes.webSocket;
        break;
      }
    } catch (_) {}
  }

  if (!ws) {
    throw new Error(`微软TTS握手被拒 (${lastStatus})`);
  }

  ws.accept();

  const ratePct = Math.round((Math.max(0.5, Math.min(2.0, rateNum)) - 1.0) * 100);
  const rateStr = `${ratePct >= 0 ? "+" : ""}${ratePct}%`;
  const langMatch = voice.match(/^([a-z]{2}-[A-Z]{2})/);
  const xmlLang = langMatch ? langMatch[1] : "en-US";
  const reqId = crypto.randomUUID().replace(/-/g, "");
  const timestamp = new Date().toISOString();

  const configMsg =
    `X-Timestamp:${timestamp}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
            outputFormat: "audio-24khz-48kbitrate-mono-mp3"
          }
        }
      }
    });

  const ssmlBody =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'>` +
    `<voice name='${escapeXml(voice)}'>` +
    `<prosody pitch='+0Hz' rate='${rateStr}' volume='+0%'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`;

  const ssmlMsg =
    `X-RequestId:${reqId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${timestamp}\r\n` +
    `Path:ssml\r\n\r\n` +
    ssmlBody;

  const chunks = [];
  const decoder = new TextDecoder();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error("微软TTS合成超时"));
    }, 12000);

    ws.addEventListener("message", event => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) {
          clearTimeout(timer);
          try { ws.close(); } catch (_) {}
          resolve();
        }
      } else if (event.data instanceof ArrayBuffer) {
        const buf = event.data;
        if (buf.byteLength > 2) {
          const headerLen = new DataView(buf).getUint16(0, false);
          if (2 + headerLen <= buf.byteLength) {
            const header = decoder.decode(buf.slice(2, 2 + headerLen));
            if (header.includes("Path:audio")) {
              chunks.push(new Uint8Array(buf.slice(2 + headerLen)));
            }
          }
        }
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("微软TTS连接异常"));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });

    ws.send(configMsg);
    ws.send(ssmlMsg);
  });

  if (chunks.length === 0) {
    throw new Error("微软TTS未返回音频数据");
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

// 2. Google 网页在线语音合成（支持长句自动分段拼接 MP3）
function splitTextForGoogle(text, maxLen = 160) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      parts.push(rest);
      break;
    }
    let cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return parts.filter(Boolean);
}

async function synthesizeGoogleWebTts(text, lang = "en-US") {
  const segments = splitTextForGoogle(text, 160);
  const buffers = [];

  for (const seg of segments) {
    const urls = [
      `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(seg)}`,
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(seg)}`
    ];

    let fetched = null;
    for (const u of urls) {
      try {
        const res = await fetch(u, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            "Referer": "https://translate.google.com/"
          }
        });
        if (res.ok) {
          fetched = new Uint8Array(await res.arrayBuffer());
          break;
        }
      } catch (_) {}
    }

    if (!fetched || fetched.byteLength === 0) {
      throw new Error("Google 网页音源请求失败");
    }
    buffers.push(fetched);
  }

  const total = buffers.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const b of buffers) {
    out.set(b, pos);
    pos += b.byteLength;
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // 获取微软全部可用发音人列表
    if (url.pathname === "/api/voices") {
      const token = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
      const secMsGec = await generateSecMsGec(token);
      const gecVersion = "1-143.0.3650.75";
      const endpoints = [
        `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?TrustedClientToken=${token}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${gecVersion}`,
        `https://api.msedgeservices.com/tts/cognitiveservices/voices/list?Ocp-Apim-Subscription-Key=${token}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${gecVersion}`
      ];
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
            },
            cf: { cacheTtl: 3600, cacheEverything: true }
          });
          if (res.ok) {
            const list = await res.json();
            return new Response(JSON.stringify(list), {
              headers: { ...cors, "Content-Type": "application/json;charset=UTF-8" }
            });
          }
        } catch (_) {}
      }
      return new Response(JSON.stringify([]), {
        headers: { ...cors, "Content-Type": "application/json;charset=UTF-8" }
      });
    }

    // 微软云端 TTS 接口
    if (url.pathname === "/api/tts") {
      const text = (url.searchParams.get("text") || "").trim();
      const voice = (url.searchParams.get("voice") || "en-US-JennyNeural").trim();
      const rate = parseFloat(url.searchParams.get("rate") || "1.0");
      if (!text) return new Response("Missing text", { status: 400, headers: cors });

      try {
        const audioBytes = await synthesizeEdgeTts(text, voice, rate);
        return new Response(audioBytes, {
          headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { ...cors, "Content-Type": "application/json;charset=UTF-8" }
        });
      }
    }

    // Google 网页在线 TTS 接口
    if (url.pathname === "/api/gtts") {
      const text = (url.searchParams.get("text") || "").trim();
      const lang = (url.searchParams.get("lang") || "en-US").trim();
      if (!text) return new Response("Missing text", { status: 400, headers: cors });

      try {
        const audioBytes = await synthesizeGoogleWebTts(text, lang);
        return new Response(audioBytes, {
          headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { ...cors, "Content-Type": "application/json;charset=UTF-8" }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
