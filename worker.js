function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
      "Content-Type": "application/json;charset=UTF-8",
      "Cache-Control": "no-store"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || "main";
    const ghHeaders = {
      "User-Agent": "CF-Vocab-Player",
      "Accept": "application/vnd.github+json",
      ...(env.GITHUB_TOKEN && { Authorization: `Bearer ${env.GITHUB_TOKEN}` })
    };

    // 1. 获取 books/ 目录下的所有 JSON 词库列表
    if (url.pathname === "/api/books" && request.method === "GET") {
      if (!owner || !repo) {
        return new Response(JSON.stringify([]), { headers: cors });
      }
      const api = `https://api.github.com/repos/${owner}/${repo}/contents/books?ref=${branch}&t=${Date.now()}`;
      const res = await fetch(api, { headers: ghHeaders });
      if (!res.ok) {
        return new Response(JSON.stringify([]), { headers: cors });
      }
      const files = await res.json();
      const books = Array.isArray(files)
        ? files
            .filter(f => f.name.endsWith(".json"))
            .map(f => ({
              id: `repo:${f.name}`,
              name: f.name.replace(/\.json$/i, ""),
              file: f.name,
              sha: f.sha
            }))
        : [];
      return new Response(JSON.stringify(books), { headers: cors });
    }

    // 2. 单个词库文件的 读取(GET) / 新建与修改(PUT) / 删除(DELETE)
    if (url.pathname.startsWith("/api/book/")) {
      const rawName = decodeURIComponent(url.pathname.replace("/api/book/", ""));
      const safeFile = rawName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5.]/g, "_");
      const fileName = safeFile.endsWith(".json") ? safeFile : `${safeFile}.json`;
      const ghApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/books/${encodeURIComponent(fileName)}`;

      // 读取词库内容（直接走 GitHub API 保证修改后立即生效，无 CDN 延迟）
      if (request.method === "GET") {
        const res = await fetch(`${ghApiUrl}?ref=${branch}&t=${Date.now()}`, { headers: ghHeaders });
        if (!res.ok) {
          return new Response(JSON.stringify({ error: "未找到该词库文件" }), { status: 404, headers: cors });
        }
        const meta = await res.json();
        const contentStr = base64ToUtf8(meta.content || "");
        return new Response(contentStr, { headers: cors });
      }

      // 写操作鉴权校验
      if (!env.GITHUB_TOKEN) {
        return new Response(JSON.stringify({ error: "Cloudflare 未配置 GITHUB_TOKEN 环境变量" }), { status: 500, headers: cors });
      }
      if (env.ADMIN_PASSWORD) {
        const clientPwd = request.headers.get("X-Admin-Password") || "";
        if (clientPwd !== env.ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ error: "云端管理密码错误，请在设置中核对" }), { status: 401, headers: cors });
        }
      }

      // 先查询目标文件是否已存在以获取最新 sha
      let existingSha = null;
      const checkRes = await fetch(`${ghApiUrl}?ref=${branch}&t=${Date.now()}`, { headers: ghHeaders });
      if (checkRes.ok) {
        const existingData = await checkRes.json();
        existingSha = existingData.sha;
      }

      // 新建或覆盖保存词库
      if (request.method === "PUT") {
        const bodyText = await request.text();
        const payload = {
          message: `${existingSha ? "Update" : "Create"} vocab book: ${fileName}`,
          content: utf8ToBase64(bodyText),
          branch,
          ...(existingSha && { sha: existingSha })
        };
        const putRes = await fetch(ghApiUrl, {
          method: "PUT",
          headers: { ...ghHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const putData = await putRes.json();
        if (!putRes.ok) {
          return new Response(JSON.stringify({ error: putData.message || "GitHub 保存失败" }), { status: putRes.status, headers: cors });
        }
        return new Response(JSON.stringify({ ok: true, file: fileName }), { headers: cors });
      }

      // 删除词库文件
      if (request.method === "DELETE") {
        if (!existingSha) {
          return new Response(JSON.stringify({ ok: true, alreadyDeleted: true }), { headers: cors });
        }
        const delRes = await fetch(ghApiUrl, {
          method: "DELETE",
          headers: { ...ghHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `Delete vocab book: ${fileName}`,
            sha: existingSha,
            branch
          })
        });
        if (!delRes.ok) {
          const delErr = await delRes.json();
          return new Response(JSON.stringify({ error: delErr.message || "GitHub 删除失败" }), { status: delRes.status, headers: cors });
        }
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
