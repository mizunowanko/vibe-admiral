/**
 * Static file server for production mode.
 *
 * Serves Vite build output (dist/) from the Engine HTTP server,
 * eliminating the need for a separate Vite dev server in production.
 * SPA fallback: non-API, non-WS requests return index.html.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

/**
 * Create a static file handler that serves from the given directory.
 * Returns null if the directory doesn't exist (e.g., not built yet).
 */
export function createStaticHandler(
  distDir: string,
): ((req: IncomingMessage, res: ServerResponse) => boolean) | null {
  if (!existsSync(distDir)) {
    console.warn(`[static-server] dist directory not found: ${distDir} — static serving disabled`);
    return null;
  }

  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) {
    console.warn(`[static-server] index.html not found in ${distDir} — static serving disabled`);
    return null;
  }

  console.log(`[static-server] Serving static files from ${distDir}`);

  /**
   * Try to serve a static file for the given request.
   * Returns true if the request was handled, false otherwise (pass to API handler).
   */
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Skip API and WebSocket routes
    if (pathname.startsWith("/api/") || pathname === "/ws") {
      return false;
    }

    // Try to serve the exact file
    const safePath = pathname.replace(/\.\./g, "");
    const filePath = join(distDir, safePath);

    try {
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        serveFile(res, filePath);
        return true;
      }
    } catch {
      // Fall through to SPA fallback
    }

    // SPA fallback: serve index.html for all other routes
    serveFile(res, indexPath);
    return true;
  };
}

function serveFile(res: ServerResponse, filePath: string): void {
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}
