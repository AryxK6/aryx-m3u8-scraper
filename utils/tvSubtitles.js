/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ARYX M3U8 SCRAPER — TV Subtitles Module v2.0.0
 *  Scrapes tvsubtitles.net for TV show subtitles, downloads ZIP archives,
 *  extracts .srt files, and converts them to .vtt format.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @fileoverview TV subtitle scraping pipeline: search show → find episode →
 * locate subtitle → download ZIP → extract SRT → convert to VTT.
 *
 * @author ARYX
 * @version 2.0.0
 * @license MIT
 */

import fetch from "node-fetch";
import * as cheerio from "cheerio";
import AdmZip from "adm-zip";
import srt2vtt from "srt-to-vtt";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ═══════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════

/** @type {string} Base URL for tvsubtitles.net */
const BASE_URL = "https://www.tvsubtitles.net";

/** @type {number} Default fetch timeout in milliseconds */
const FETCH_TIMEOUT_MS = 15000;

/** @type {number} Maximum retry attempts for fetch requests */
const DEFAULT_MAX_RETRIES = 3;

/** @type {number} Base delay for exponential backoff (ms) */
const RETRY_BASE_DELAY_MS = 1000;

/** @type {number} Maximum ZIP file size in bytes (50 MB) */
const MAX_ZIP_SIZE_BYTES = 50 * 1024 * 1024;

/** @type {number} Maximum SRT file size in bytes (5 MB) */
const MAX_SRT_SIZE_BYTES = 5 * 1024 * 1024;

/** @type {number} Default minimum random sleep delay (ms) */
const DEFAULT_SLEEP_MIN = 3000;

/** @type {number} Default maximum random sleep delay (ms) */
const DEFAULT_SLEEP_MAX = 5000;

/** @type {number} Maximum cached entries */
const CACHE_MAX_ENTRIES = 500;

/** @type {number} Cache TTL in milliseconds (30 minutes) */
const CACHE_TTL_MS = 30 * 60 * 1000;

// ═══════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════

/**
 * Module-level configuration — adjustable at runtime via configure().
 * @type {Object}
 */
let config = {
  sleepMin: DEFAULT_SLEEP_MIN,
  sleepMax: DEFAULT_SLEEP_MAX,
  maxRetries: DEFAULT_MAX_RETRIES,
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  maxZipSizeBytes: MAX_ZIP_SIZE_BYTES,
  maxSrtSizeBytes: MAX_SRT_SIZE_BYTES,
  enableCache: true,
};

/**
 * Updates module configuration at runtime.
 *
 * @param {Object} options - Configuration overrides
 * @param {number} [options.sleepMin] - Minimum delay between requests (ms)
 * @param {number} [options.sleepMax] - Maximum delay between requests (ms)
 * @param {number} [options.maxRetries] - Maximum fetch retry attempts
 * @param {number} [options.fetchTimeoutMs] - Fetch timeout (ms)
 * @param {number} [options.maxZipSizeBytes] - Max ZIP file size (bytes)
 * @param {number} [options.maxSrtSizeBytes] - Max SRT file size (bytes)
 * @param {boolean} [options.enableCache] - Enable/disable in-memory cache
 *
 * @example
 * configure({ sleepMin: 2000, sleepMax: 4000, maxRetries: 5 });
 */
export function configure(options = {}) {
  config = { ...config, ...options };
  Logger.info(`Configuration updated: ${JSON.stringify(config)}`);
}

// ═══════════════════════════════════════════════════════
//  STRUCTURED LOGGER
// ═══════════════════════════════════════════════════════

/** @type {Object} Structured logger with level-based output */
const Logger = {
  _fmt(level, msg, ctx = "TVSubs") {
    return `${new Date().toISOString()} [${level}] [${ctx}] ${msg}`;
  },
  info(msg, ctx) { console.log(this._fmt("INFO", msg, ctx)); },
  warn(msg, ctx) { console.warn(this._fmt("WARN", msg, ctx)); },
  error(msg, ctx) { console.error(this._fmt("ERROR", msg, ctx)); },
  debug(msg, ctx) {
    if (process.env.NODE_ENV === "development") console.debug(this._fmt("DEBUG", msg, ctx));
  },
};

// ═══════════════════════════════════════════════════════
//  CUSTOM ERROR CLASSES
// ═══════════════════════════════════════════════════════

/**
 * Base error class for TV subtitle operations.
 */
class TVSubtitleError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} code - Machine-readable error code
   * @param {Error} [cause] - Original error
   */
  constructor(message, code = "TV_SUBTITLE_ERROR", cause) {
    super(message);
    this.name = "TVSubtitleError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** Error thrown when a TV show search fails. */
class TVSubtitleSearchError extends TVSubtitleError {
  constructor(message, cause) { super(message, "SEARCH_FAILED", cause); this.name = "TVSubtitleSearchError"; }
}

/** Error thrown when a subtitle download fails. */
class SubtitleDownloadError extends TVSubtitleError {
  constructor(message, cause) { super(message, "DOWNLOAD_FAILED", cause); this.name = "SubtitleDownloadError"; }
}

/** Error thrown when SRT → VTT conversion fails. */
class ConversionError extends TVSubtitleError {
  constructor(message, cause) { super(message, "CONVERSION_FAILED", cause); this.name = "ConversionError"; }
}

// ═══════════════════════════════════════════════════════
//  IN-MEMORY CACHE (Show ID + Episode ID lookups)
// ═══════════════════════════════════════════════════════

/** @type {Map<string, {value: any, ts: number}>} */
const lookupCache = new Map();

/**
 * Retrieves a value from the lookup cache.
 * @param {string} key
 * @returns {any|null}
 */
function cacheGet(key) {
  if (!config.enableCache) return null;
  const entry = lookupCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { lookupCache.delete(key); return null; }
  return entry.value;
}

/**
 * Stores a value in the lookup cache with LRU eviction.
 * @param {string} key
 * @param {any} value
 */
function cacheSet(key, value) {
  if (!config.enableCache) return;
  if (lookupCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    lookupCache.delete(oldest);
  }
  lookupCache.set(key, { value, ts: Date.now() });
}

// ═══════════════════════════════════════════════════════
//  HTTP HEADER ROTATION
// ═══════════════════════════════════════════════════════

/** @type {string[]} Pool of realistic browser user agents */
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
];

/**
 * Returns realistic browser-like headers with a randomly rotated User-Agent.
 * @returns {Object<string, string>}
 */
function getBrowserHeaders() {
  return {
    "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    Referer: `${BASE_URL}/`,
  };
}

// ═══════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * Returns a promise that resolves after the specified delay.
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleeps for a random duration between configurable min and max.
 * Adds jitter to avoid request pattern detection.
 *
 * @param {number} [min=config.sleepMin] - Minimum delay in ms
 * @param {number} [max=config.sleepMax] - Maximum delay in ms
 * @returns {Promise<void>}
 */
async function randomSleep(min = config.sleepMin, max = config.sleepMax) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  Logger.debug(`Sleeping for ${delay}ms`, "RateLimit");
  return sleep(delay);
}

/**
 * Fetches a URL with retry logic, exponential backoff, jitter, and AbortController timeout.
 *
 * @param {string} url - URL to fetch
 * @param {Object} [options={}] - Fetch options (method, headers, body, etc.)
 * @param {string} [ctx="Fetch"] - Logging context label
 * @returns {Promise<Response>}
 * @throws {Error} After all retry attempts are exhausted
 *
 * @example
 * const res = await fetchWithRetry("https://example.com/page", {}, "PageFetch");
 */
async function fetchWithRetry(url, options = {}, ctx = "Fetch") {
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs);

      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { ...getBrowserHeaders(), ...(options.headers || {}) },
      });
      clearTimeout(timeout);

      if (res.ok) return res;

      // Retry on server errors (5xx), fail immediately on client errors (4xx)
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`HTTP ${res.status} (client error) for ${url}`);
      }
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (attempt === config.maxRetries) {
        Logger.error(`All ${config.maxRetries} attempts failed for ${url}: ${err.message}`, ctx);
        throw err;
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
      Logger.warn(`Attempt ${attempt}/${config.maxRetries} failed, retry in ${Math.round(delay)}ms...`, ctx);
      await sleep(delay);
    }
  }
}

/**
 * Validates that a string is a valid HTTP/HTTPS URL.
 *
 * @param {string} urlStr - URL to validate
 * @returns {boolean} True if valid
 */
function isValidUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Converts a readable stream to a string, with optional size limit.
 *
 * @param {import('stream').Readable} stream - Input stream
 * @param {number} [maxBytes=Infinity] - Maximum bytes to read
 * @returns {Promise<string>} Resulting string
 * @throws {Error} If stream exceeds maxBytes
 */
function streamToString(stream, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    let result = "";
    let bytesRead = 0;
    stream.on("data", (chunk) => {
      const str = chunk.toString();
      bytesRead += Buffer.byteLength(str);
      if (bytesRead > maxBytes) {
        stream.destroy();
        reject(new Error(`Stream exceeded size limit of ${maxBytes} bytes`));
        return;
      }
      result += str;
    });
    stream.on("end", () => resolve(result));
    stream.on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════
//  RELEASE EXTRACTION FROM FILENAME
// ═══════════════════════════════════════════════════════

/**
 * Extracts the release identifier (resolution, rip source, release group)
 * from a subtitle filename.
 *
 * @param {string} filename - The subtitle filename
 *   e.g. "Game of Thrones - 1x01 - Winter is Coming.720p HDTV.en.srt"
 * @returns {string} The extracted release string (e.g. "720p HDTV") or "UNKNOWN"
 *
 * @example
 * extractReleaseFromFilename("Show - 1x01 - Episode.720p.WEB-DL.LOL.en.srt")
 * // → "720p WEB-DL.LOL"
 *
 * @example
 * extractReleaseFromFilename("Show - 1x01 - Episode.HDTV.LOL.srt")
 * // → "HDTV.LOL"
 */
function extractReleaseFromFilename(filename) {
  if (!filename || typeof filename !== "string") return "UNKNOWN";

  const hyphenParts = filename.split(" - ");
  const lastPart = hyphenParts[2] || "";

  // Strip language code and extension
  const noExt = lastPart.replace(/\.en\.srt$|\.srt$/, "").trim();
  if (!noExt) return "UNKNOWN";

  const parts = noExt.split(".");
  const hasResolution = parts.some((p) => /\d{3,4}p/.test(p));

  if (hasResolution) {
    const resIndex = parts.findIndex((p) => /\d{3,4}p/.test(p));
    const releaseParts = parts.slice(resIndex);
    const [res, rip, group] = releaseParts;

    if (group) return `${res} ${rip}.${group}`;
    if (rip) return `${res} ${rip}`;
    return res;
  } else {
    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];

    if (secondLast && secondLast !== last) {
      return `${secondLast}.${last}`;
    }
    return last || "UNKNOWN";
  }
}

// ═══════════════════════════════════════════════════════
//  ZIP URL BUILDER
// ═══════════════════════════════════════════════════════

/**
 * Constructs the ZIP download URL from a parsed subtitle title string.
 *
 * @param {string} title - Subtitle title (e.g. "ShowName 1x01 Episode.720p HDTV")
 * @returns {string} Full URL to the ZIP file on tvsubtitles.net
 *
 * @example
 * buildZipUrlFromTitle("Breaking Bad 1x01 Pilot.720p HDTV")
 * // → "https://www.tvsubtitles.net/files/Breaking%20Bad_1x01_Pilot.720p%20HDTV.en.zip"
 */
function buildZipUrlFromTitle(title) {
  if (!title || typeof title !== "string") {
    throw new TVSubtitleError("Cannot build ZIP URL from empty or invalid title");
  }

  Logger.debug(`Building ZIP URL from title: "${title}"`, "ZipBuilder");
  const clean = title.replace(/[()]/g, "").trim();

  const match = clean.match(/^(.+?)\s+(\d+x\d+)\s+(.+)$/);
  if (!match) {
    Logger.warn(`Unexpected title format, using fallback: "${clean}"`, "ZipBuilder");
    const fallback = clean.replace(/\s+/g, "_") + ".en.zip";
    return `${BASE_URL}/files/${fallback}`;
  }

  const [, showName, episodeCode, releaseInfo] = match;
  Logger.debug(`Parsed → Show: "${showName}" | Episode: "${episodeCode}" | Release: "${releaseInfo}"`, "ZipBuilder");

  const fileName = `${showName}_${episodeCode}_${releaseInfo}.en.zip`;
  return `${BASE_URL}/files/${encodeURIComponent(fileName)}`;
}

// ═══════════════════════════════════════════════════════
//  SCRAPING PIPELINE
// ═══════════════════════════════════════════════════════

/**
 * Searches tvsubtitles.net for a TV show and returns its internal ID.
 *
 * @param {string} title - TV show title to search for
 * @returns {Promise<string|null>} Show ID or null if not found
 * @throws {TVSubtitleSearchError} On network or parse failures
 *
 * @example
 * const showId = await searchTVShow("Breaking Bad");
 * // → "83"
 */
async function searchTVShow(title) {
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    throw new TVSubtitleSearchError("Title must be a non-empty string");
  }

  // Check cache first
  const cacheKey = `show:${title.toLowerCase().trim()}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    Logger.debug(`Cache HIT for show "${title}" → ID ${cached}`, "Search");
    return cached;
  }

  try {
    Logger.info(`Searching for TV show: "${title}"`, "Search");
    const searchRes = await fetchWithRetry(
      `${BASE_URL}/search.php`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ qs: title.trim() }).toString(),
      },
      "Search"
    );

    const html = await searchRes.text();
    const $ = cheerio.load(html);

    const link = $("a[href^='/tvshow-']")
      .filter(function () {
        return $(this).text().toLowerCase().includes(title.toLowerCase());
      })
      .first()
      .attr("href");

    if (!link) {
      Logger.warn(`No results found for "${title}"`, "Search");
      return null;
    }

    const idMatch = link.match(/tvshow-(\d+)\.html/);
    if (!idMatch) {
      Logger.warn(`Could not extract show ID from link: ${link}`, "Search");
      return null;
    }

    const showId = idMatch[1];
    Logger.info(`Found show "${title}" → ID: ${showId}`, "Search");
    cacheSet(cacheKey, showId);
    return showId;
  } catch (err) {
    Logger.error(`Search failed for "${title}": ${err.message}`, "Search");
    throw new TVSubtitleSearchError(`Failed to search for "${title}"`, err);
  }
}

/**
 * Finds the episode page ID from a TV show's season page.
 *
 * @param {string} showId - Internal tvsubtitles.net show ID
 * @param {number|string} seasonNumber - Season number
 * @param {number|string} episodeNumber - Episode number
 * @returns {Promise<string|null>} Episode page ID or null
 *
 * @example
 * const epId = await getEpisodePageId("83", 1, 1);
 * // → "12345"
 */
async function getEpisodePageId(showId, seasonNumber, episodeNumber) {
  if (!showId) throw new TVSubtitleError("showId is required");

  const season = parseInt(seasonNumber, 10);
  const episode = parseInt(episodeNumber, 10);
  if (!Number.isInteger(season) || season < 1) throw new TVSubtitleError("seasonNumber must be a positive integer");
  if (!Number.isInteger(episode) || episode < 1) throw new TVSubtitleError("episodeNumber must be a positive integer");

  // Check cache
  const cacheKey = `ep:${showId}:${season}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    Logger.debug(`Cache HIT for episode S${season}E${episode} → PageID ${cached}`, "Episode");
    return cached;
  }

  try {
    const url = `${BASE_URL}/tvshow-${showId}-${season}.html`;
    Logger.info(`Fetching season page: ${url}`, "Episode");

    const res = await fetchWithRetry(url, {}, "Episode");
    const html = await res.text();
    const $ = cheerio.load(html);

    let episodePageId = null;

    $("table.tableauto tr").each((_, row) => {
      const episodeCell = $(row).find("td").first().text().trim();
      const cellMatch = episodeCell.match(/^(\d+)x(\d+)$/);

      if (cellMatch && parseInt(cellMatch[1], 10) === season && parseInt(cellMatch[2], 10) === episode) {
        Logger.info(`Match found for S${season}E${episode}`, "Episode");

        const episodeLink = $(row).find("td").eq(1).find("a").attr("href");
        const linkMatch = episodeLink?.match(/episode-(\d+)\.html/);
        if (linkMatch) {
          episodePageId = linkMatch[1];
          Logger.info(`Episode Page ID: ${episodePageId}`, "Episode");
        }
      }
    });

    if (!episodePageId) {
      Logger.warn(`Episode S${season}E${episode} not found for show ${showId}`, "Episode");
      return null;
    }

    cacheSet(cacheKey, episodePageId);
    return episodePageId;
  } catch (err) {
    Logger.error(`Failed to get episode page: ${err.message}`, "Episode");
    return null;
  }
}

/**
 * Extracts the subtitle ID and title from an episode page.
 *
 * @param {string} episodePageId - Episode page ID from getEpisodePageId()
 * @returns {Promise<{subtitleId: string, subtitleTitle: string}|null>}
 *
 * @example
 * const meta = await getSubtitleIDAndEpisodeTitle("12345");
 * // → { subtitleId: "67890", subtitleTitle: "Show 1x01 Episode (720p HDTV)" }
 */
async function getSubtitleIDAndEpisodeTitle(episodePageId) {
  if (!episodePageId) throw new TVSubtitleError("episodePageId is required");

  try {
    const url = `${BASE_URL}/episode-${episodePageId}-en.html`;
    Logger.info(`Fetching episode subtitle page: ${url}`, "SubMeta");

    const res = await fetchWithRetry(url, {}, "SubMeta");
    const html = await res.text();
    const $ = cheerio.load(html);

    const anchor = $("a[href^='/subtitle-']").first();
    if (!anchor.length) {
      Logger.warn("No subtitle link found on episode page", "SubMeta");
      return null;
    }

    const subtitleId = anchor.attr("href")?.match(/subtitle-(\d+)\.html/)?.[1];

    const h5Text = anchor
      .find("h5")
      .clone()
      .find("img")
      .remove()
      .end()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    if (!h5Text || !subtitleId) {
      Logger.warn("Could not extract subtitle title or ID", "SubMeta");
      return null;
    }

    Logger.info(`Subtitle ID: ${subtitleId} | Title: "${h5Text}"`, "SubMeta");
    return { subtitleId, subtitleTitle: h5Text };
  } catch (err) {
    Logger.error(`Failed to get subtitle metadata: ${err.message}`, "SubMeta");
    return null;
  }
}

/**
 * Retrieves the actual filename from a subtitle's detail page.
 * Used to correct release info in the download URL.
 *
 * @param {string} subtitleId - Subtitle ID
 * @returns {Promise<string|null>} Actual filename or null
 */
async function getActualFilenameFromSubtitlePage(subtitleId) {
  if (!subtitleId) return null;

  try {
    const url = `${BASE_URL}/subtitle-${subtitleId}.html`;
    Logger.debug(`Fetching subtitle detail page: ${url}`, "SubDetail");

    const res = await fetchWithRetry(url, {}, "SubDetail");
    const html = await res.text();
    const $ = cheerio.load(html);

    let filename = null;

    $(".subtitle_grid div").each((_i, el) => {
      const label = $(el).text().trim().toLowerCase();
      if (label === "filename:") {
        filename = $(el).next().text().trim();
      }
    });

    if (!filename) {
      Logger.debug("Could not find filename on subtitle detail page", "SubDetail");
      return null;
    }

    Logger.debug(`Actual filename: "${filename}"`, "SubDetail");
    return filename;
  } catch (err) {
    Logger.error(`Failed to get filename from subtitle page: ${err.message}`, "SubDetail");
    return null;
  }
}

// ═══════════════════════════════════════════════════════
//  ZIP DOWNLOAD & SRT → VTT CONVERSION
// ═══════════════════════════════════════════════════════

/**
 * Downloads a subtitle ZIP file, extracts the .srt, and converts it to .vtt.
 *
 * Includes protections:
 * - ZIP file size limit (default 50 MB)
 * - SRT file size limit (default 5 MB)
 * - Zip bomb detection (entry count limit)
 *
 * @param {string} zipUrl - URL of the subtitle ZIP file
 * @returns {Promise<string|null>} VTT subtitle text, or null on failure
 * @throws {SubtitleDownloadError} On download failure
 * @throws {ConversionError} On conversion failure
 *
 * @example
 * const vtt = await downloadAndConvertToVTT("https://www.tvsubtitles.net/files/Sub.en.zip");
 */
async function downloadAndConvertToVTT(zipUrl) {
  if (!zipUrl || !isValidUrl(zipUrl)) {
    throw new SubtitleDownloadError(`Invalid ZIP URL: ${zipUrl}`);
  }

  try {
    Logger.info(`Downloading ZIP: ${zipUrl}`, "Download");
    const zipRes = await fetchWithRetry(zipUrl, {}, "Download");

    if (!zipRes.ok) {
      throw new SubtitleDownloadError(`HTTP ${zipRes.status} downloading ZIP`);
    }

    // Check content-length if available (zip bomb prevention)
    const contentLength = parseInt(zipRes.headers.get("content-length") || "0", 10);
    if (contentLength > config.maxZipSizeBytes) {
      throw new SubtitleDownloadError(
        `ZIP too large: ${Math.round(contentLength / 1048576)}MB exceeds ${Math.round(config.maxZipSizeBytes / 1048576)}MB limit`
      );
    }

    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());

    // Double-check actual size
    if (zipBuffer.length > config.maxZipSizeBytes) {
      throw new SubtitleDownloadError(
        `ZIP actual size ${Math.round(zipBuffer.length / 1048576)}MB exceeds limit`
      );
    }

    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    // Zip bomb check: too many entries
    if (entries.length > 100) {
      throw new SubtitleDownloadError(`Suspicious ZIP: ${entries.length} entries (possible zip bomb)`);
    }

    const srtEntry = entries.find((entry) => entry.entryName.endsWith(".srt"));
    if (!srtEntry) {
      throw new ConversionError("No .srt file found in ZIP archive");
    }

    // SRT size check
    if (srtEntry.header.size > config.maxSrtSizeBytes) {
      throw new ConversionError(
        `SRT file too large: ${Math.round(srtEntry.header.size / 1048576)}MB exceeds ${Math.round(config.maxSrtSizeBytes / 1048576)}MB limit`
      );
    }

    Logger.debug(`Extracting: ${srtEntry.entryName} (${srtEntry.header.size} bytes)`, "Convert");

    const srtBuffer = srtEntry.getData();
    const srtStream = Readable.from(srtBuffer);
    const vttStream = srtStream.pipe(srt2vtt());

    const vttText = await streamToString(vttStream, config.maxSrtSizeBytes);

    Logger.info(`Conversion successful (${vttText.length} chars)`, "Convert");
    Logger.debug(`VTT preview: ${vttText.slice(0, 200)}...`, "Convert");
    return vttText;
  } catch (err) {
    if (err instanceof TVSubtitleError) throw err;
    Logger.error(`Download/conversion failed: ${err.message}`, "Download");
    return null;
  }
}

// ═══════════════════════════════════════════════════════
//  MAIN EXPORT — TV SUBTITLE PIPELINE
// ═══════════════════════════════════════════════════════

/**
 * Full pipeline: searches for a TV show, locates the episode subtitle,
 * downloads the ZIP, extracts the SRT, and returns converted VTT text.
 *
 * Pipeline steps:
 *   1. Search show by title → get show ID
 *   2. Find episode page → get episode page ID
 *   3. Get subtitle metadata → subtitle ID + title
 *   4. (Optional) Get actual filename for release correction
 *   5. Build ZIP URL from corrected title
 *   6. Download ZIP → extract SRT → convert to VTT
 *
 * @param {string} title - TV show title (e.g., "Breaking Bad")
 * @param {number|string} season - Season number (e.g., 1)
 * @param {number|string} episode - Episode number (e.g., 1)
 * @returns {Promise<string|null>} VTT subtitle content, or null if not found
 *
 * @example
 * const vtt = await getTVSubtitleVTT("Breaking Bad", 1, 1);
 * if (vtt) {
 *   res.set("Content-Type", "text/vtt").send(vtt);
 * }
 */
export async function getTVSubtitleVTT(title, season, episode) {
  // Input validation
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    Logger.error("title must be a non-empty string", "Pipeline");
    return null;
  }

  const seasonNum = parseInt(season, 10);
  const episodeNum = parseInt(episode, 10);
  if (!Number.isInteger(seasonNum) || seasonNum < 1) {
    Logger.error(`Invalid season: ${season} (must be positive integer)`, "Pipeline");
    return null;
  }
  if (!Number.isInteger(episodeNum) || episodeNum < 1) {
    Logger.error(`Invalid episode: ${episode} (must be positive integer)`, "Pipeline");
    return null;
  }

  Logger.info(`═══ Pipeline start: "${title}" S${seasonNum}E${episodeNum} ═══`, "Pipeline");

  try {
    // Step 1: Search for show
    const showId = await searchTVShow(title);
    if (!showId) {
      Logger.warn(`Show not found: "${title}"`, "Pipeline");
      return null;
    }

    await randomSleep();

    // Step 2: Get episode page ID
    const episodeId = await getEpisodePageId(showId, seasonNum, episodeNum);
    if (!episodeId) {
      Logger.warn(`Episode S${seasonNum}E${episodeNum} not found`, "Pipeline");
      return null;
    }

    await randomSleep();

    // Step 3: Get subtitle metadata
    const subtitleMeta = await getSubtitleIDAndEpisodeTitle(episodeId);
    if (!subtitleMeta) {
      Logger.warn("No subtitle metadata found", "Pipeline");
      return null;
    }

    const { subtitleId, subtitleTitle } = subtitleMeta;

    // Step 4: Get actual filename for release correction
    const actualFilename = await getActualFilenameFromSubtitlePage(subtitleId);
    let finalTitle = subtitleTitle;

    if (actualFilename) {
      const correctRelease = extractReleaseFromFilename(actualFilename);
      const releaseMatch = subtitleTitle.match(/\(([^)]+)\)/);
      const currentRelease = releaseMatch ? releaseMatch[1] : null;

      if (currentRelease) {
        if (currentRelease.includes(".") || currentRelease.includes(" ")) {
          if (currentRelease !== correctRelease) {
            Logger.info(`Correcting release: "(${currentRelease})" → "(${correctRelease})"`, "Pipeline");
            finalTitle = subtitleTitle.replace(/\([^)]+\)/, `(${correctRelease})`);
          }
        } else {
          finalTitle = subtitleTitle.replace(/\([^)]+\)/, `(${currentRelease})`);
        }
      }
    }

    await randomSleep();

    // Step 5: Build ZIP URL
    const zipUrl = buildZipUrlFromTitle(finalTitle);
    Logger.info(`ZIP URL: ${zipUrl}`, "Pipeline");

    await randomSleep();

    // Step 6: Download and convert
    const vttContent = await downloadAndConvertToVTT(zipUrl);

    if (vttContent) {
      Logger.info(`═══ Pipeline complete: "${title}" S${seasonNum}E${episodeNum} ✓ ═══`, "Pipeline");
    } else {
      Logger.warn(`═══ Pipeline finished with no result for "${title}" S${seasonNum}E${episodeNum} ═══`, "Pipeline");
    }

    return vttContent;
  } catch (err) {
    Logger.error(`Pipeline failed for "${title}" S${seasonNum}E${episodeNum}: ${err.message}`, "Pipeline");
    return null;
  }
}

// ═══════════════════════════════════════════════════════
//  ADDITIONAL EXPORTS (for testing)
// ═══════════════════════════════════════════════════════

export {
  extractReleaseFromFilename,
  buildZipUrlFromTitle,
  TVSubtitleError,
  TVSubtitleSearchError,
  SubtitleDownloadError,
  ConversionError,
};
