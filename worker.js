function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 合成微软 Edge Neural TTS 音频流（返回 MP3）
async function synthesizeEdgeTts(text, voice = "en-US-JennyNeural", rateNum = 1.0) {
  const token = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const connId = crypto.randomUUID().replace(/-/g, "");
  const endpoint = `https://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=${token}&ConnectionId=${connId}`;

  const upgradeRes = await fetch(endpoint, {
    headers: {
      "Upgrade": "websocket",
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
    }
  });

  const ws = upgradeRes.webSocket;
  if (!ws) {
    throw new Error(`TTS WebSocket 握手失败 (${upgradeRes.status})`);
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
      reject(new Error("TTS 合成超时"));
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
      reject(new Error("TTS 连接中断"));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });

    ws.send(configMsg);
    ws.send(ssmlMsg);
  });

  if (chunks.length === 0) {
    throw new Error("未收到音频数据");
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

    // 1. 获取微软 Edge TTS 全部可用发音人列表
    if (url.pathname === "/api/voices") {
      const token = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
      const endpoints = [
        `https://api.msedgeservices.com/tts/cognitiveservices/voices/list?Ocp-Apim-Subscription-Key=${token}`,
        `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?TrustedClientToken=${token}`
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

    // 2. 微软 Edge TTS 音频合成接口
    if (url.pathname === "/api/tts") {
      const text = (url.searchParams.get("text") || "").trim();
      const voice = (url.searchParams.get("voice") || "en-US-JennyNeural").trim();
      const rate = parseFloat(url.searchParams.get("rate") || "1.0");

      if (!text) {
        return new Response("Missing text", { status: 400, headers: cors });
      }

      try {
        const audioBytes = await synthesizeEdgeTts(text, voice, rate);
        return new Response(audioBytes, {
          headers: {
            ...cors,
            "Content-Type": "audio/mpeg",
            "Cache-Control": "public, max-age=86400"
          }
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
