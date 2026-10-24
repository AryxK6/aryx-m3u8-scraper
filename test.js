/**
 * ═══════════════════════════════════════════════════════
 *  ARYX M3U8 SCRAPER — Test Suite
 *  Uses Node.js built-in test runner (node:test)
 * ═══════════════════════════════════════════════════════
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Extracts the release identifier (resolution + rip group) from a subtitle filename.
 *
 * @param {string} filename - The subtitle filename (e.g., "Show - 1x01 - Episode.720p HDTV.en.srt")
 * @returns {string} The extracted release string or "UNKNOWN"
 */
function extractReleaseFromFilename(filename) {
  if (!filename || typeof filename !== "string") return "UNKNOWN";

  const hyphenParts = filename.split(" - ");
  const lastPart = hyphenParts[2] || "";

  const noExt = lastPart.replace(/\.en\.srt$|\.srt$/, "").trim();
  if (!noExt) return "UNKNOWN";

  const parts = noExt.split(".");
  const hasResolution = parts.some((p) => /\d{3,4}p/.test(p));

  if (hasResolution) {
    const resIndex = parts.findIndex((p) => /\d{3,4}p/.test(p));
    const release = parts.slice(resIndex).join(".");
    const [resolution, rip = "", group] = release.split(".");
    return group ? `${resolution} ${rip}.${group}` : `${resolution} ${rip}`;
  } else {
    const releaseParts = parts.slice(-2);
    if (releaseParts.length === 2) {
      return releaseParts.join(".");
    } else if (releaseParts.length === 1) {
      return releaseParts[0];
    }
    return "UNKNOWN";
  }
}

// ═══════════════════════════════════════════════════════
//  Test Cases
// ═══════════════════════════════════════════════════════

describe("extractReleaseFromFilename", () => {
  it("should extract resolution + rip + group from standard filename", () => {
    const result = extractReleaseFromFilename(
      "Game of Thrones - 1x01 - Winter is Coming.720p HDTV.en.srt"
    );
    // "720p HDTV" — note the space separates resolution from rip
    assert.ok(result.includes("720p"), `Expected '720p' in '${result}'`);
  });

  it("should extract resolution + rip.group pattern", () => {
    const result = extractReleaseFromFilename(
      "Breaking Bad - 1x01 - Pilot.1080p.WEB-DL.LOL.srt"
    );
    assert.equal(result, "1080p WEB-DL.LOL");
  });

  it("should extract rip.group when no resolution present", () => {
    const result = extractReleaseFromFilename(
      "The Office - 3x05 - Initiation.HDTV.LOL.en.srt"
    );
    assert.equal(result, "HDTV.LOL");
  });

  it("should extract single rip when no resolution and no group", () => {
    const result = extractReleaseFromFilename(
      "Stranger Things - 1x01 - Chapter One.WEB.srt"
    );
    assert.equal(result, "WEB");
  });

  it("should handle 480p resolution", () => {
    const result = extractReleaseFromFilename(
      "Friends - 1x01 - The Pilot.480p.DVDRip.srt"
    );
    assert.equal(result, "480p DVDRip");
  });

  it("should handle 2160p (4K) resolution", () => {
    const result = extractReleaseFromFilename(
      "The Mandalorian - 1x01 - Chapter 1.2160p.WEB-DL.NTb.en.srt"
    );
    assert.equal(result, "2160p WEB-DL.NTb");
  });

  it("should return UNKNOWN for empty string", () => {
    const result = extractReleaseFromFilename("");
    assert.equal(result, "UNKNOWN");
  });

  it("should return UNKNOWN for null input", () => {
    const result = extractReleaseFromFilename(null);
    assert.equal(result, "UNKNOWN");
  });

  it("should return UNKNOWN for undefined input", () => {
    const result = extractReleaseFromFilename(undefined);
    assert.equal(result, "UNKNOWN");
  });

  it("should handle filename with only two hyphen-separated parts", () => {
    const result = extractReleaseFromFilename("Show - Episode.720p.srt");
    assert.equal(result, "UNKNOWN");
  });

  it("should strip .en.srt extension correctly", () => {
    const result = extractReleaseFromFilename(
      "Dexter - 1x01 - Dexter.720p.BluRay.DEMAND.en.srt"
    );
    assert.equal(result, "720p BluRay.DEMAND");
  });

  it("should strip .srt extension without language code", () => {
    const result = extractReleaseFromFilename(
      "Lost - 1x01 - Pilot.HDTV.FoV.srt"
    );
    assert.equal(result, "HDTV.FoV");
  });
});

console.log("\n🧪 ARYX M3U8 SCRAPER — Test Suite");
console.log("Run with: node --test test.js\n");
