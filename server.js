"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const CryptoJS = require("crypto-js");

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_DIR = path.join(__dirname, "public");
const BASE_URL = "https://m440.in";
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

const chapterCache = new Map();
let exisCache = { text: "", expiresAt: 0 };

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
  });
  res.end(body);
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/javascript,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-CL,es;q=0.9,en;q=0.8",
      Referer: `${BASE_URL}/`,
    },
  });

  if (!response.ok) {
    throw new Error(`${url} respondió con ${response.status}`);
  }

  return response.text();
}

async function getExisScript() {
  const now = Date.now();

  if (exisCache.text && exisCache.expiresAt > now) {
    return exisCache.text;
  }

  const text = await fetchText(`${BASE_URL}/js/exis.js`);
  exisCache = {
    text,
    expiresAt: now + 6 * 60 * 60 * 1000,
  };

  return text;
}

function extractUsaPoncho(html) {
  const match = html.match(
    /const\s+UsaPoncho\s*=\s*("(?:\\.|[^"\\])*")\s*;/s
  );

  if (!match) {
    throw new Error("No se encontró UsaPoncho en la ficha del manga");
  }

  return JSON.parse(match[1]);
}

async function decryptChapters(mangaUrl) {
  const cached = chapterCache.get(mangaUrl);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const [html, exis] = await Promise.all([
    fetchText(mangaUrl),
    getExisScript(),
  ]);

  const quietConsole = {
    log() {},
    info() {},
    warn() {},
    error() {},
    trace() {},
    debug() {},
  };

  const context = {
    CryptoJS,
    UsaPoncho: extractUsaPoncho(html),
    console: quietConsole,
  };

  vm.createContext(context);
  vm.runInContext(exis, context, { timeout: 5000 });

  const serialized = vm.runInContext(
    'typeof jschaptertemp !== "undefined" ? JSON.stringify(jschaptertemp) : ""',
    context,
    { timeout: 1000 }
  );

  if (!serialized) {
    throw new Error("No se pudo obtener jschaptertemp");
  }

  const chapters = JSON.parse(serialized);

  if (!Array.isArray(chapters)) {
    throw new Error("La lista descifrada no es un arreglo");
  }

  chapterCache.set(mangaUrl, {
    value: chapters,
    expiresAt: now + 30 * 60 * 1000,
  });

  return chapters;
}

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const fullPath = path.resolve(PUBLIC_DIR, relative);

  if (!fullPath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    return null;
  }

  return fullPath;
}

function serveStatic(pathname, res) {
  const fullPath = safeStaticPath(pathname);

  if (!fullPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return false;
  }

  const extension = path.extname(fullPath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".aix": "application/octet-stream",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };

  res.writeHead(200, {
    "Content-Type": contentTypes[extension] || "application/octet-stream",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": extension === ".json" ? "no-cache" : "public, max-age=3600",
  });

  fs.createReadStream(fullPath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      return res.end();
    }

    if (requestUrl.pathname === "/health") {
      return send(res, 200, "YRepo M440 OK");
    }

    if (requestUrl.pathname === "/m440/chapters") {
      const rawUrl = requestUrl.searchParams.get("url");

      if (!rawUrl) {
        return send(res, 400, "Falta el parámetro url");
      }

      let mangaUrl;

      try {
        mangaUrl = new URL(rawUrl);
      } catch {
        return send(res, 400, "URL inválida");
      }

      if (
        mangaUrl.protocol !== "https:" ||
        mangaUrl.hostname !== "m440.in" ||
        !mangaUrl.pathname.startsWith("/manga/")
      ) {
        return send(res, 400, "URL no permitida");
      }

      const chapters = await decryptChapters(mangaUrl.toString());

      return send(
        res,
        200,
        JSON.stringify(chapters),
        "application/json; charset=utf-8"
      );
    }

    if (requestUrl.pathname === "/") {
      const indexPath = path.join(PUBLIC_DIR, "index.min.json");
      const listExists = fs.existsSync(indexPath);

      return send(
        res,
        200,
        `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YRepo M440</title>
<style>
body{font-family:system-ui;margin:40px;max-width:760px;line-height:1.5}
code{background:#f2f2f2;padding:4px 7px;border-radius:6px;word-break:break-all}
</style>
</head>
<body>
<h1>YRepo M440 activo</h1>
<p>Proxy de capítulos: <strong>activo</strong>.</p>
<p>Lista de Aidoku: ${
          listExists
            ? `<code>https://${req.headers.host}/index.min.json</code>`
            : "todavía no generada"
        }</p>
</body>
</html>`,
        "text/html; charset=utf-8"
      );
    }

    if (serveStatic(requestUrl.pathname, res)) {
      return;
    }

    return send(res, 404, "No encontrado");
  } catch (error) {
    console.error(error);
    return send(res, 500, `Error: ${error.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`YRepo M440 escuchando en el puerto ${PORT}`);
});
