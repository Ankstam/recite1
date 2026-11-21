export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json;charset=UTF-8"
    };

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    const branch = env.GITHUB_BRANCH || "main";

    // 1. 扫描仓库 books/ 目录下的所有 JSON 单词册
    if (url.pathname === "/api/books") {
      if (!owner || !repo) {
        return new Response(JSON.stringify([]), { headers: cors });
      }
      const api = `https://api.github.com/repos/${owner}/${repo}/contents/books?ref=${branch}`;
      const res = await fetch(api, {
        headers: {
          "User-Agent": "CF-Vocab-Player",
          ...(env.GITHUB_TOKEN && { Authorization: `Bearer ${env.GITHUB_TOKEN}` })
        },
        cf: { cacheTtl: 300, cacheEverything: true }
      });

      if (!res.ok) {
        return new Response(JSON.stringify([]), { headers: cors });
      }

      const files = await res.json();
      const books = Array.isArray(files)
        ? files
            .filter(f => f.name.endsWith(".json"))
            .map(f => ({ id: `repo:${f.name}`, name: f.name.replace(/\.json$/i, ""), file: f.name }))
        : [];
      return new Response(JSON.stringify(books), { headers: cors });
    }

    // 2. 获取指定仓库单词册内容
    if (url.pathname.startsWith("/api/book/")) {
      const file = decodeURIComponent(url.pathname.replace("/api/book/", ""));
      const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/books/${file}`;
      const res = await fetch(raw, {
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      if (!res.ok) {
        return new Response(JSON.stringify({ error: "Book not found" }), { status: 404, headers: cors });
      }
      return new Response(await res.text(), { headers: cors });
    }

    // 3. 其余静态资源（HTML/CSS/JS）由 Cloudflare 边缘托管返回
    return env.ASSETS.fetch(request);
  }
};
