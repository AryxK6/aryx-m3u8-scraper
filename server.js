/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ARYX M3U8 SCRAPER — Production Server v2.0.0
 *  High-performance HLS stream URL extractor & subtitle scraper API
 *  Powered by Playwright browser automation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @fileoverview Main Express server — handles stream extraction, subtitle
 * resolution, caching, browser lifecycle, health checks, and graceful shutdown.
 *
 * @author ARYX
 * @version 2.0.0
 * @license MIT
 */

import express, { json } from "express";
import cors from "cors";
import { chromium } from "playwright";
import pLimit from "p-limit";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { getTVSubtitleVTT } from "./utils/tvSubtitles.js";

dotenv.config();

// ═══════════════════════════════════════════════════════
//  CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════

/** @type {string} Application version */
const VERSION = "2.0.0";

/** @type {string} Application name */
const APP_NAME = "ARYX M3U8 SCRAPER";

/** @type {number} Server port */
const PORT = parseInt(process.env.PORT, 10) || 4000;

/** @type {number} Maximum cache entries before LRU eviction */
const CACHE_MAX_SIZE = parseInt(process.env.CACHE_MAX_SIZE, 10) || 200;

/** @type {number} Cache TTL in milliseconds */
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_MINUTES, 10) || 15) * 60 * 1000;

/** @type {number} Maximum concurrent provider scrapes */
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SCRAPES, 10) || 3;

/** @type {number} Navigation timeout for Playwright in ms */
const NAV_TIMEOUT = parseInt(process.env.NAVIGATION_TIMEOUT, 10) || 30000;

/** @type {number} Max retries for external API calls */
const MAX_RETRIES = 3;

/** @type {number} Base delay for exponential backoff (ms) */
const RETRY_BASE_DELAY = 1000;

// ──── API Keys ─────────────────────────────────────────

export const OPENSUB_API_KEY = process.env.OPENSUB_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;

/** @type {Object} Default headers for TMDB API requests */
export const tmdbHeaders = {
  Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
  "Content-Type": "application/json;charset=utf-8",
};

/**
 * Supported streaming provider domains.
 * Each provider has its own embed URL pattern.
 * @type {Array<{domain: string, name: string}>}
 */
const PROVIDERS = [
  { domain: "https://yapgrid.com", name: "YapGrid" },
];

/** @type {string[]} Allowed content types */
const ALLOWED_TYPES = ["movie", "tv"];

// ──── Language Config ──────────────────────────────────

/** @type {Object<string, string>} Language code to display name map */
export const LANGUAGE_NAMES = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  ar: "Arabic",
  hi: "Hindi",
  ur: "Urdu",
  tr: "Turkish",
  it: "Italian",
};

/** @type {string[]} Supported language codes */
export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

// ──── User-Agent Pool ──────────────────────────────────

/** @type {string[]} Rotating pool of realistic browser user agents */
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
];

/** @type {string[]} Allowed domains for subtitle proxy (SSRF protection) */
const SUBTITLE_PROXY_ALLOWED_DOMAINS = [
  "opensubtitles.com",
  "opensubtitles.org",
  "dl.opensubtitles.org",
  "vidsrc.stream",
  "cc.vidsrc.me",
  "sub.membed.net",
  "s.megastatics.com",
  "cdn.jsdelivr.net",
];

// ═══════════════════════════════════════════════════════
//  STRUCTURED LOGGER
// ═══════════════════════════════════════════════════════

/**
 * Production-grade structured logger with levels and color coding.
 */
const Logger = {
  _format(level, ctx, msg) {
    const ts = new Date().toISOString();
    const prefix = ctx ? `[${ctx}] ` : "";
    return `${ts} [${level}] ${prefix}${msg}`;
  },
  info(msg, ctx = APP_NAME) { console.log(this._format("INFO", ctx, msg)); },
  warn(msg, ctx = APP_NAME) { console.warn(this._format("WARN", ctx, msg)); },
  error(msg, ctx = APP_NAME) { console.error(this._format("ERROR", ctx, msg)); },
  debug(msg, ctx = APP_NAME) {
    if (process.env.NODE_ENV === "development") {
      console.debug(this._format("DEBUG", ctx, msg));
    }
  },
};

// ═══════════════════════════════════════════════════════
//  LRU CACHE
// ═══════════════════════════════════════════════════════

/**
 * Simple LRU cache with TTL support and size-based eviction.
 */
class LRUCache {
  /**
   * @param {number} maxSize - Maximum entries before eviction
   * @param {number} ttlMs - Time-to-live per entry in milliseconds
   */
  constructor(maxSize = 200, ttlMs = 900000) {
    /** @type {Map<string, {value: any, timestamp: number}>} */
    this._map = new Map();
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Retrieve a cached value.
   * @param {string} key
   * @returns {any|null} Cached value or null if expired/missing
   */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) { this._misses++; return null; }
    if (Date.now() - entry.timestamp > this._ttlMs) {
      this._map.delete(key);
      this._misses++;
      return null;
    }
    // Move to end (most recently used)
    this._map.delete(key);
    this._map.set(key, entry);
    this._hits++;
    return entry.value;
  }

  /**
   * Store a value in the cache.
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, { value, timestamp: Date.now() });
    // Evict oldest if over capacity
    while (this._map.size > this._maxSize) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }

  /** @returns {{size: number, maxSize: number, hits: number, misses: number, hitRate: string}} */
  stats() {
    const total = this._hits + this._misses;
    return {
      size: this._map.size,
      maxSize: this._maxSize,
      ttlMinutes: Math.round(this._ttlMs / 60000),
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? ((this._hits / total) * 100).toFixed(1) + "%" : "0%",
    };
  }
}

// ═══════════════════════════════════════════════════════
//  METRICS TRACKER
// ═══════════════════════════════════════════════════════

/** @type {Object} Simple in-memory metrics */
const metrics = {
  totalRequests: 0,
  successfulExtractions: 0,
  failedExtractions: 0,
  totalResponseTimeMs: 0,
  startedAt: Date.now(),
};

// ═══════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * Returns a random user agent from the pool.
 * @returns {string}
 */
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Fetch with exponential backoff retry logic.
 *
 * @param {string} url - URL to fetch
 * @param {Object} [options={}] - Fetch options
 * @param {number} [maxRetries=MAX_RETRIES] - Maximum retry attempts
 * @param {string} [ctx="Fetch"] - Logging context
 * @returns {Promise<Response>}
 * @throws {Error} After all retries exhausted
 */
async function fetchWithRetry(url, options = {}, maxRetries = MAX_RETRIES, ctx = "Fetch") {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok || res.status < 500) return res;
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err) {
      if (attempt === maxRetries) {
        Logger.error(`All ${maxRetries} attempts failed for ${url}: ${err.message}`, ctx);
        throw err;
      }
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 500;
      Logger.warn(`Attempt ${attempt}/${maxRetries} failed, retrying in ${Math.round(delay)}ms...`, ctx);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Validates that a URL's domain is in the allowed list (SSRF protection).
 * @param {string} urlStr - URL to validate
 * @param {string[]} allowedDomains - List of allowed domains
 * @returns {boolean}
 */
function isAllowedDomain(urlStr, allowedDomains) {
  try {
    const hostname = new URL(urlStr).hostname.toLowerCase();
    return allowedDomains.some((d) => hostname === d || hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

/**
 * Normalizes a subtitle URL for deduplication (strips query params, lowercases).
 * @param {string} url
 * @returns {string}
 */
function normalizeSubUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Builds the embed URL for a given provider.
 *
 * @param {string} domain - Provider domain
 * @param {string} type - "movie" or "tv"
 * @param {string} tmdbId - TMDB ID
 * @param {number} [season] - Season number (TV only)
 * @param {number} [episode] - Episode number (TV only)
 * @returns {string} Embed URL
 */
function buildProviderUrl(domain, type, tmdbId, season, episode) {
  if (domain.includes("yapgrid.com")) {
    return type === "tv"
      ? `${domain}/embed/tv/${tmdbId}/${season}/${episode}`
      : `${domain}/embed/movie/${tmdbId}`;
  }
  return type === "tv"
    ? `${domain}/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`
    : `${domain}/embed/movie?tmdb=${tmdbId}`;
}

// ═══════════════════════════════════════════════════════
//  ENVIRONMENT VALIDATION
// ═══════════════════════════════════════════════════════

/**
 * Validates required environment variables on startup.
 * Logs warnings for optional missing vars; throws for critical ones.
 */
function validateEnvironment() {
  const warnings = [];

  if (!TMDB_API_KEY) warnings.push("TMDB_API_KEY is not set — TMDB lookups will fail");
  if (!TMDB_BEARER_TOKEN) warnings.push("TMDB_BEARER_TOKEN is not set — TMDB auth will fail");
  if (!OPENSUB_API_KEY) warnings.push("OPENSUB_API_KEY is not set — OpenSubtitles lookups will fail");

  if (warnings.length > 0) {
    Logger.warn("=".repeat(60), "ENV");
    warnings.forEach((w) => Logger.warn(`⚠  ${w}`, "ENV"));
    Logger.warn("=".repeat(60), "ENV");
  }

  Logger.info(`PORT=${PORT}  CACHE_MAX=${CACHE_MAX_SIZE}  CACHE_TTL=${CACHE_TTL_MS / 60000}min  CONCURRENCY=${MAX_CONCURRENT}`, "ENV");
}

// ═══════════════════════════════════════════════════════
//  BROWSER MANAGEMENT
// ═══════════════════════════════════════════════════════

/** @type {import('playwright').Browser|null} */
let browser = null;

/**
 * Launches or restarts the headless Chromium browser.
 * @returns {Promise<import('playwright').Browser>}
 */
async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;

  Logger.info("Launching Chromium browser...", "Browser");
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--disable-extensions",
    ],
  });

  browser.on("disconnected", () => {
    Logger.warn("Browser disconnected — will relaunch on next request", "Browser");
    browser = null;
  });

  Logger.info("Chromium browser launched successfully", "Browser");
  return browser;
}

// ═══════════════════════════════════════════════════════
//  CORE SCRAPER
// ═══════════════════════════════════════════════════════

/**
 * Scrapes a single provider for HLS stream URLs and subtitles.
 *
 * @param {string} domain - Provider domain (e.g., "https://yapgrid.com")
 * @param {string} url - Full embed URL to scrape
 * @param {string} [requestId="N/A"] - Request ID for logging correlation
 * @returns {Promise<{hls_url: string|null, subtitles: string[], error: string|null}>}
 */
async function scrapeProvider(domain, url, requestId = "N/A") {
  const ctx = `Scraper:${new URL(domain).hostname}`;
  Logger.info(`Starting scrape | URL: ${url} | ReqID: ${requestId}`, ctx);

  const activeBrowser = await ensureBrowser();
  const context = await activeBrowser.newContext({
    userAgent: getRandomUserAgent(),
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  const page = await context.newPage();

  let hlsUrl = null;
  const subtitleSet = new Set();

  /** @param {string} reqUrl */
  const isSubtitle = (reqUrl) =>
    /\.(vtt|srt)(\?.*)?$/.test(reqUrl) || reqUrl.includes(".vtt") || reqUrl.includes(".srt");

  /** @param {string} reqUrl */
  const trackSubtitle = (reqUrl) => {
    const normalized = normalizeSubUrl(reqUrl);
    if (!subtitleSet.has(normalized)) {
      subtitleSet.add(normalized);
      Logger.debug(`Found subtitle: ${reqUrl}`, ctx);
    }
  };

  try {
    // Intercept all network requests
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url();
      if (!hlsUrl && reqUrl.includes(".m3u8")) {
        hlsUrl = reqUrl;
        Logger.info(`✓ Found HLS URL: ${hlsUrl}`, ctx);
      }
      if (isSubtitle(reqUrl)) trackSubtitle(reqUrl);
      route.continue();
    });

    // Also listen via page events for requests fired by iframes
    page.on("request", (request) => {
      const reqUrl = request.url();
      if (!hlsUrl && reqUrl.includes(".m3u8")) {
        hlsUrl = reqUrl;
        Logger.info(`✓ Found HLS URL (event): ${hlsUrl}`, ctx);
      }
      if (isSubtitle(reqUrl)) trackSubtitle(reqUrl);
    });

    page.on("frameattached", (frame) => {
      Logger.debug(`Frame attached: ${frame.url()}`, ctx);
    });

    // Navigate to the embed page
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    Logger.debug("Page loaded, looking for player element...", ctx);

    // Wait for player element with flexible selector fallback
    const frameElement = await page
      .waitForSelector("#the_frame, iframe[src], .player, video, .video-container, body", {
        timeout: 15000,
      })
      .catch(() => null);

    if (frameElement) {
      const box = await frameElement.boundingBox();

      if (box && box.width > 0 && box.height > 0) {
        const clickX = box.x + box.width / 2;
        const clickY = box.y + box.height / 2;
        Logger.debug(`Clicking player at (${clickX.toFixed(0)}, ${clickY.toFixed(0)})`, ctx);
        await page.mouse.move(clickX, clickY);
        await page.mouse.click(clickX, clickY);
      } else {
        Logger.debug("Fallback: clicking viewport center", ctx);
        await page.mouse.click(960, 540);
      }

      // Wait for HLS stream initialization
      await page.waitForTimeout(7000);

      // Explicitly wait for .m3u8 response if not found yet
      if (!hlsUrl) {
        await page
          .waitForResponse((resp) => resp.url().includes(".m3u8"), { timeout: 8000 })
          .catch(() => Logger.debug(".m3u8 not detected within extended timeout", ctx));
      }

      // Extra wait for late-loading subtitles
      if (subtitleSet.size === 0) {
        await page.waitForTimeout(4000);
      }
    } else {
      throw new Error("Player element/iframe not found on page");
    }

    await page.close().catch(() => {});
    await context.close().catch(() => {});

    if (!hlsUrl) throw new Error("HLS URL not found after full page interaction");

    const subtitles = [...subtitleSet].map((normalized) => normalized);
    Logger.info(`✓ Scrape complete | HLS: found | Subtitles: ${subtitles.length}`, ctx);
    return { hls_url: hlsUrl, subtitles, error: null };
  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    Logger.error(`Scrape failed: ${error.message}`, ctx);
    return { hls_url: null, subtitles: [], error: error.message };
  }
}

// ═══════════════════════════════════════════════════════
//  TMDB INTEGRATION
// ═══════════════════════════════════════════════════════

/**
 * Resolves a TMDB ID to an IMDb ID via the TMDB external_ids API.
 *
 * @param {string} tmdbId - TMDB movie/TV ID
 * @param {string} [type="movie"] - Content type: "movie" or "tv"
 * @returns {Promise<string|null>} IMDb ID (e.g., "tt1234567") or null
 * @throws {Error} If TMDB API request fails after retries
 */
async function getIMDbIdFromTMDB(tmdbId, type = "movie") {
  const url = `https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
  const response = await fetchWithRetry(url, { headers: tmdbHeaders }, MAX_RETRIES, "TMDB");
  if (!response.ok) throw new Error(`TMDB API returned ${response.status}`);
  const data = await response.json();
  return data.imdb_id || null;
}

// ═══════════════════════════════════════════════════════
//  OPENSUBTITLES INTEGRATION
// ═══════════════════════════════════════════════════════

/**
 * Searches OpenSubtitles for subtitles matching an IMDb ID.
 *
 * @param {string} imdbId - IMDb ID (e.g., "tt1234567")
 * @returns {Promise<Array<{language: string, language_name: string, file_id: number, download_count: number}>>}
 */
async function searchSubtitles(imdbId) {
  const url = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdbId}&per_page=100&page=1`;
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        "Api-Key": OPENSUB_API_KEY,
        "User-Agent": `${APP_NAME} v${VERSION}`,
      },
    },
    MAX_RETRIES,
    "OpenSub"
  );

  if (!res.ok) {
    Logger.error(`OpenSubtitles search failed: HTTP ${res.status}`, "OpenSub");
    return [];
  }

  const json = await res.json();
  if (!json.data || json.data.length === 0) return [];

  return json.data
    .filter(
      (item) =>
        item.attributes?.files?.[0]?.file_id &&
        COMMON_LANGUAGES.includes(item.attributes.language)
    )
    .map((item) => {
      const file = item.attributes.files[0];
      const lang = item.attributes.language;
      return {
        language: lang,
        language_name: LANGUAGE_NAMES[lang] || lang,
        file_id: file.file_id,
        download_count: item.attributes.download_count || 0,
      };
    })
    .sort((a, b) => b.download_count - a.download_count)
    .slice(0, 5);
}

/**
 * Retrieves a temporary download URL for a subtitle file from OpenSubtitles.
 *
 * @param {number} fileId - OpenSubtitles file ID
 * @returns {Promise<string>} Direct download URL
 * @throws {Error} If download URL fetch fails
 */
async function getSubtitleDownloadUrl(fileId) {
  const res = await fetchWithRetry(
    "https://api.opensubtitles.com/api/v1/download",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": OPENSUB_API_KEY,
        "User-Agent": `${APP_NAME} v${VERSION}`,
      },
      body: JSON.stringify({ file_id: fileId }),
    },
    MAX_RETRIES,
    "OpenSub"
  );

  if (!res.ok) {
    const text = await res.text();
    Logger.error(`Failed to get download link: ${text}`, "OpenSub");
    throw new Error("Subtitle download URL fetch failed");
  }

  const json = await res.json();
  return json.link;
}

// ═══════════════════════════════════════════════════════
//  EXPRESS APP SETUP
// ═══════════════════════════════════════════════════════

const app = express();
const cache = new LRUCache(CACHE_MAX_SIZE, CACHE_TTL_MS);
const limit = pLimit(MAX_CONCURRENT);

// ──── Middleware ────────────────────────────────────────

// CORS configuration
const corsOrigins = process.env.CORS_ORIGINS;
app.use(
  cors(
    corsOrigins && corsOrigins !== "*"
      ? { origin: corsOrigins.split(",").map((o) => o.trim()), credentials: true }
      : {}
  )
);

// Body parsing with size limit
app.use(json({ limit: "1mb" }));

// Request ID + timing middleware
app.use((req, _res, next) => {
  req.requestId = randomUUID().slice(0, 8);
  req.startTime = Date.now();
  metrics.totalRequests++;
  next();
});

// Response time header
app.use((_req, res, next) => {
  const originalSend = res.send.bind(res);
  res.send = function (body) {
    const elapsed = Date.now() - (_req.startTime || Date.now());
    res.setHeader("X-Response-Time", `${elapsed}ms`);
    res.setHeader("X-Request-Id", _req.requestId || "unknown");
    res.setHeader("X-Powered-By", APP_NAME);
    metrics.totalResponseTimeMs += elapsed;
    return originalSend(body);
  };
  next();
});

// ═══════════════════════════════════════════════════════
//  API ROUTES — /api/v1
// ═══════════════════════════════════════════════════════

// ──── Root ─────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    name: APP_NAME,
    version: VERSION,
    status: "running",
    endpoints: [
      "GET /api/v1/extract",
      "GET /api/v1/movie-subtitles",
      "GET /api/v1/tv-subtitles",
      "GET /api/v1/subtitle-proxy",
      "GET /api/v1/health",
      "GET /api/v1/cache-stats",
    ],
    timestamp: new Date().toISOString(),
  });
});

// ──── Health Check ─────────────────────────────────────

/**
 * GET /api/v1/health
 * Returns server health, browser status, memory, cache stats, and uptime.
 */
app.get("/api/v1/health", (_req, res) => {
  const mem = process.memoryUsage();
  const uptimeS = Math.floor((Date.now() - metrics.startedAt) / 1000);
  const avgResponseTime =
    metrics.totalRequests > 0
      ? Math.round(metrics.totalResponseTimeMs / metrics.totalRequests)
      : 0;

  res.json({
    success: true,
    data: {
      status: "healthy",
      version: VERSION,
      uptime: `${Math.floor(uptimeS / 3600)}h ${Math.floor((uptimeS % 3600) / 60)}m ${uptimeS % 60}s`,
      browser: browser && browser.isConnected() ? "connected" : "disconnected",
      memory: {
        rss: `${Math.round(mem.rss / 1048576)}MB`,
        heapUsed: `${Math.round(mem.heapUsed / 1048576)}MB`,
        heapTotal: `${Math.round(mem.heapTotal / 1048576)}MB`,
      },
      cache: cache.stats(),
      metrics: {
        totalRequests: metrics.totalRequests,
        successfulExtractions: metrics.successfulExtractions,
        failedExtractions: metrics.failedExtractions,
        avgResponseTimeMs: avgResponseTime,
      },
      providers: PROVIDERS.map((p) => p.name),
      nodeVersion: process.version,
    },
    timestamp: new Date().toISOString(),
  });
});

// ──── Cache Stats ──────────────────────────────────────

app.get("/api/v1/cache-stats", (_req, res) => {
  res.json({ success: true, data: cache.stats(), timestamp: new Date().toISOString() });
});

// ──── Extract (HLS Stream Scraper) ─────────────────────

/**
 * GET /api/v1/extract
 *
 * Scrapes multiple providers for HLS (.m3u8) stream URLs and subtitles.
 *
 * @query {string} tmdb_id - TMDB movie or TV show ID (required, numeric)
 * @query {string} [type=movie] - Content type: "movie" or "tv"
 * @query {number} [season] - Season number (required for type=tv)
 * @query {number} [episode] - Episode number (required for type=tv)
 */
app.get("/api/v1/extract", async (req, res) => {
  const type = req.query.type || "movie";
  const tmdbId = req.query.tmdb_id;
  const season = req.query.season ? parseInt(req.query.season, 10) : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode, 10) : undefined;

  // ── Input Validation ──
  if (!tmdbId || !/^\d+$/.test(tmdbId)) {
    return res.status(400).json({
      success: false,
      error: "tmdb_id query param is required and must be numeric",
      timestamp: new Date().toISOString(),
    });
  }

  if (!ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({
      success: false,
      error: `type must be one of: ${ALLOWED_TYPES.join(", ")}`,
      timestamp: new Date().toISOString(),
    });
  }

  if (type === "tv") {
    if (!season || !episode || season < 1 || episode < 1 || !Number.isInteger(season) || !Number.isInteger(episode)) {
      return res.status(400).json({
        success: false,
        error: "season and episode must be positive integers for TV shows",
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Cache Check ──
  const cacheKey = `extract:${type}:${tmdbId}:${season || 0}:${episode || 0}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    Logger.info(`Cache HIT for ${cacheKey} | ReqID: ${req.requestId}`, "Cache");
    return res.json({ ...cached, meta: { ...cached.meta, cached: true } });
  }

  Logger.info(`Extraction started | type=${type} tmdb=${tmdbId} s=${season} e=${episode} | ReqID: ${req.requestId}`, "Extract");

  // ── Build provider URLs ──
  const providerUrls = PROVIDERS.map((p) => ({
    ...p,
    url: buildProviderUrl(p.domain, type, tmdbId, season, episode),
  }));

  try {
    const resultsArr = await Promise.all(
      providerUrls.map((p) =>
        limit(async () => {
          try {
            const result = await scrapeProvider(p.domain, p.url, req.requestId);
            return [p.name, result];
          } catch (err) {
            Logger.error(`[${p.name}] Fatal error: ${err.message}`, "Extract");
            return [p.name, { hls_url: null, subtitles: [], error: err.message }];
          }
        })
      )
    );

    const results = Object.fromEntries(resultsArr);
    const success = Object.values(results).some((r) => r.hls_url);

    if (success) metrics.successfulExtractions++;
    else metrics.failedExtractions++;

    const response = {
      success,
      results,
      meta: {
        tmdb_id: tmdbId,
        type,
        season: season || null,
        episode: episode || null,
        providers_queried: PROVIDERS.length,
        cached: false,
      },
      timestamp: new Date().toISOString(),
    };

    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    metrics.failedExtractions++;
    Logger.error(`Unexpected extraction error: ${err.message}`, "Extract");
    res.status(500).json({
      success: false,
      error: "Unexpected server error during extraction",
      timestamp: new Date().toISOString(),
    });
  }
});

// ──── Movie Subtitles ──────────────────────────────────

/**
 * GET /api/v1/movie-subtitles
 *
 * Fetches subtitles for movies via TMDB → IMDb → OpenSubtitles pipeline.
 *
 * @query {string} tmdb_id - TMDB movie ID (required)
 * @query {string} [type=movie] - Content type
 */
app.get("/api/v1/movie-subtitles", async (req, res) => {
  const { tmdb_id: tmdbId, type = "movie" } = req.query;

  if (!tmdbId || !/^\d+$/.test(tmdbId)) {
    return res.status(400).json({
      success: false,
      error: "tmdb_id is required and must be numeric",
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const imdbId = await getIMDbIdFromTMDB(tmdbId, type);
    if (!imdbId) {
      return res.status(404).json({
        success: false,
        error: "IMDb ID not found for this TMDB entry",
        timestamp: new Date().toISOString(),
      });
    }

    const baseList = await searchSubtitles(imdbId);

    const subtitles = (
      await Promise.all(
        baseList.map(async (sub) => {
          if (sub.url) return sub;
          try {
            const url = await getSubtitleDownloadUrl(sub.file_id);
            return { language: sub.language, language_name: sub.language_name, url };
          } catch {
            return null;
          }
        })
      )
    ).filter(Boolean);

    res.json({
      success: true,
      data: { subtitles },
      meta: { tmdb_id: tmdbId, imdb_id: imdbId, type, count: subtitles.length },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    Logger.error(`Movie subtitle error: ${err.message}`, "Subtitles");
    res.status(500).json({
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ──── TV Subtitles ─────────────────────────────────────

/**
 * GET /api/v1/tv-subtitles
 *
 * Fetches subtitles for TV shows via tvsubtitles.net scraping.
 *
 * @query {string} title - TV show title (required)
 * @query {number} season - Season number (required)
 * @query {number} episode - Episode number (required)
 * @query {string} type - Must be "tv"
 */
app.get("/api/v1/tv-subtitles", async (req, res) => {
  const { title, season, episode, type } = req.query;

  if (!title || !season || !episode) {
    return res.status(400).json({
      success: false,
      error: "title, season, and episode are required",
      timestamp: new Date().toISOString(),
    });
  }

  if (type !== "tv") {
    return res.status(400).json({
      success: false,
      error: 'type must be "tv" for this endpoint',
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const vtt = await getTVSubtitleVTT(title, season, episode);
    if (!vtt) {
      return res.status(404).json({
        success: false,
        error: "No subtitle found for this episode",
        timestamp: new Date().toISOString(),
      });
    }
    res.set("Content-Type", "text/vtt").send(vtt);
  } catch (err) {
    Logger.error(`TV subtitle error: ${err.message}`, "Subtitles");
    res.status(500).json({
      success: false,
      error: "Internal server error fetching TV subtitles",
      timestamp: new Date().toISOString(),
    });
  }
});

// ──── Subtitle Proxy (SRT → VTT Converter) ────────────

/**
 * GET /api/v1/subtitle-proxy
 *
 * Proxies and converts an external .srt subtitle file to .vtt format.
 * Includes SSRF protection via domain allowlist.
 *
 * @query {string} url - URL of the .srt or .vtt subtitle file
 */
app.get("/api/v1/subtitle-proxy", async (req, res) => {
  const fileUrl = req.query.url;

  if (!fileUrl) {
    return res.status(400).json({
      success: false,
      error: "Missing subtitle URL parameter",
      timestamp: new Date().toISOString(),
    });
  }

  // SSRF Protection
  if (!isAllowedDomain(fileUrl, SUBTITLE_PROXY_ALLOWED_DOMAINS)) {
    Logger.warn(`SSRF blocked: ${fileUrl}`, "Security");
    return res.status(403).json({
      success: false,
      error: "Subtitle domain not in allowlist",
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const subtitleRes = await fetchWithRetry(fileUrl, {}, 2, "SubProxy");
    const srt = await subtitleRes.text();

    const vtt =
      "WEBVTT\n\n" +
      srt
        .replace(/\r+/g, "")
        .replace(/^\s+|\s+$/g, "")
        .split("\n")
        .map((line) => line.replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g, "$1:$2:$3.$4"))
        .join("\n");

    res.setHeader("Content-Type", "text/vtt");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(vtt);
  } catch (err) {
    Logger.error(`Subtitle proxy error: ${err.message}`, "SubProxy");
    res.status(500).json({
      success: false,
      error: "Failed to fetch or convert subtitle",
      timestamp: new Date().toISOString(),
    });
  }
});

// ──── Legacy route redirects (backwards compatibility) ──

app.get("/extract", (req, res) => res.redirect(307, `/api/v1/extract?${new URL(req.url, `http://${req.headers.host}`).searchParams}`));
app.get("/movie-subtitles", (req, res) => res.redirect(307, `/api/v1/movie-subtitles?${new URL(req.url, `http://${req.headers.host}`).searchParams}`));
app.get("/tv-subtitles", (req, res) => res.redirect(307, `/api/v1/tv-subtitles?${new URL(req.url, `http://${req.headers.host}`).searchParams}`));
app.get("/subtitle-proxy", (req, res) => res.redirect(307, `/api/v1/subtitle-proxy?${new URL(req.url, `http://${req.headers.host}`).searchParams}`));

// ──── 404 Handler ──────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    hint: "Visit / for available endpoints",
    timestamp: new Date().toISOString(),
  });
});

// ──── Global Error Handler ─────────────────────────────

app.use((err, _req, res, _next) => {
  Logger.error(`Unhandled route error: ${err.message}`, "Express");
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════
//  SERVER STARTUP
// ═══════════════════════════════════════════════════════

(async () => {
  try {
    validateEnvironment();
    await ensureBrowser();

    app.listen(PORT, () => {
      Logger.info("═".repeat(55), "Server");
      Logger.info(`🚀 ${APP_NAME} v${VERSION}`, "Server");
      Logger.info(`   Running at http://localhost:${PORT}`, "Server");
      Logger.info(`   Providers: ${PROVIDERS.length} configured`, "Server");
      Logger.info(`   Environment: ${process.env.NODE_ENV || "development"}`, "Server");
      Logger.info("═".repeat(55), "Server");
    });
  } catch (err) {
    Logger.error(`Fatal startup error: ${err.message}`, "Server");
    process.exit(1);
  }
})();

// ═══════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════

/**
 * Handles graceful shutdown — closes browser, drains connections, exits.
 * @param {string} signal - The signal that triggered shutdown
 */
async function gracefulShutdown(signal) {
  Logger.info(`${signal} received — starting graceful shutdown...`, "Shutdown");

  // Force exit after 10 seconds
  const forceTimer = setTimeout(() => {
    Logger.error("Forced shutdown after 10s timeout", "Shutdown");
    process.exit(1);
  }, 10000);

  try {
    if (browser) {
      Logger.info("Closing Chromium browser...", "Shutdown");
      await browser.close();
    }
    Logger.info("Shutdown complete. Goodbye! 👋", "Shutdown");
    clearTimeout(forceTimer);
    process.exit(0);
  } catch (err) {
    Logger.error(`Error during shutdown: ${err.message}`, "Shutdown");
    clearTimeout(forceTimer);
    process.exit(1);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  Logger.error(`Unhandled Promise Rejection: ${reason}`, "Process");
});
process.on("uncaughtException", (err) => {
  Logger.error(`Uncaught Exception: ${err.message}`, "Process");
  gracefulShutdown("uncaughtException");
});
