'use strict';

// Download an official Stockfish release into tools/stockfish, outside the
// extension source and outside any package artifact.
//
// Provenance (source URL, release tag, asset name, SHA-256 and license) is
// written next to the binary. The Nyx extension never bundles or ships it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const TOOLS_DIR = path.join(ROOT, 'tools', 'stockfish');
const REPO = 'official-stockfish/Stockfish';
const DEFAULT_TAG = 'sf_19';
const USER_AGENT = 'nyx-chess-stockfish-analysis/1.0';

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeTag(tag) {
  return String(tag).replace(/[^A-Za-z0-9._-]/g, '_');
}

function assetNameForArch(arch = process.arch) {
  if (arch === 'arm64') return 'stockfish-windows-arm64-universal.zip';
  if (arch === 'x64' || arch === 'ia32') return 'stockfish-windows-x86-64-universal.zip';
  throw new Error(`No official Windows Stockfish asset is configured for architecture "${arch}"`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function extractZip(zipFile, destination) {
  fs.mkdirSync(destination, { recursive: true });
  try {
    execFileSync('tar', ['-xf', zipFile, '-C', destination], { stdio: 'pipe' });
    return;
  } catch (error) {
    // Windows also ships PowerShell; use it if tar is unavailable.
    try {
      const escapedZip = zipFile.replace(/'/g, "''");
      const escapedDest = destination.replace(/'/g, "''");
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDest}' -Force`
      ], { stdio: 'pipe' });
    } catch (fallbackError) {
      throw new Error(`Could not extract ${zipFile}: ${error.message}; ${fallbackError.message}`);
    }
  }
}

function findExecutable(directory) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^stockfish.*\.exe$/i.test(entry.name)) found.push(full);
    }
  };
  walk(directory, 0);
  found.sort((a, b) => {
    const score = (value) => (/universal/i.test(value) ? 2 : /avx2/i.test(value) ? 1 : 0);
    return score(b) - score(a) || a.localeCompare(b);
  });
  return found[0] || null;
}

async function ensureStockfish(options = {}) {
  const tag = options.tag || DEFAULT_TAG;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const finalDir = path.join(TOOLS_DIR, safeTag(tag));
  const provenancePath = path.join(finalDir, 'provenance.json');

  if (!options.force && fs.existsSync(provenancePath)) {
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    if (provenance.executable && fs.existsSync(provenance.executable)) {
      log(`Using existing Stockfish ${provenance.tag}: ${provenance.executable}`);
      return { executable: provenance.executable, provenance, provenancePath, reused: true };
    }
  }

  const releaseUrl = tag === 'latest'
    ? `https://api.github.com/repos/${REPO}/releases/latest`
    : `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`;
  log(`Resolving ${REPO} release ${tag}...`);
  const release = await fetchJson(releaseUrl);
  const resolvedTag = release.tag_name;
  const assetName = assetNameForArch(process.arch);
  const asset = (release.assets || []).find((candidate) => candidate.name === assetName);
  if (!asset) {
    throw new Error(
      `Release ${resolvedTag} has no asset named ${assetName}. ` +
      `Available assets: ${(release.assets || []).map((a) => a.name).join(', ')}`
    );
  }

  fs.mkdirSync(finalDir, { recursive: true });
  const zipPath = path.join(finalDir, asset.name);
  const expected = asset.digest && asset.digest.startsWith('sha256:')
    ? asset.digest.slice('sha256:'.length)
    : null;

  let buffer = null;
  let sha256 = null;
  if (fs.existsSync(zipPath)) {
    const existing = fs.readFileSync(zipPath);
    const existingHash = sha256Buffer(existing);
    if (!expected || existingHash.toLowerCase() === expected.toLowerCase()) {
      buffer = existing;
      sha256 = existingHash;
      log(`Reusing verified download ${zipPath}`);
    } else {
      log(`Existing ${zipPath} does not match the release digest; downloading again.`);
    }
  }
  if (!buffer) {
    log(`Downloading ${asset.browser_download_url} (${asset.size} bytes)...`);
    buffer = await fetchBuffer(asset.browser_download_url);
    sha256 = sha256Buffer(buffer);
    fs.writeFileSync(zipPath, buffer);
  }
  if (expected && expected.toLowerCase() !== sha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${expected}, got ${sha256}`);
  }

  const extractDir = path.join(finalDir, 'extracted');
  log(`Extracting to ${extractDir}...`);
  extractZip(zipPath, extractDir);
  const executable = findExecutable(extractDir);
  if (!executable) throw new Error(`No stockfish*.exe found after extracting ${zipPath}`);

  const provenance = {
    kind: 'stockfish-external-diagnostic-binary',
    sourceRepository: `https://github.com/${REPO}`,
    releaseApi: releaseUrl,
    releaseTag: resolvedTag,
    releaseName: release.name || null,
    publishedAt: release.published_at || null,
    assetName: asset.name,
    downloadUrl: asset.browser_download_url,
    assetSize: buffer.length,
    sha256,
    sha256Source: expected ? 'GitHub release asset digest' : 'computed locally (release had no digest)',
    downloadedAt: new Date().toISOString(),
    executable,
    executableSha256: sha256Buffer(fs.readFileSync(executable)),
    license: 'GPL-3.0-or-later',
    licenseFile: path.join(extractDir, 'stockfish', 'Copying.txt'),
    distribution: 'Not bundled with the Nyx Chess extension. External analysis tool only.',
    note: 'Stockfish is used only to analyze recorded Nyx games; no Stockfish code or weights are imported into Nyx.'
  };
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  log(`Stockfish ${resolvedTag} ready: ${executable}`);
  log(`SHA-256 ${sha256}`);
  return { executable, provenance, provenancePath, reused: false };
}

function findProvenanceForExecutable(executable) {
  const resolved = path.resolve(executable);
  let directory = path.dirname(resolved);
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(directory, 'provenance.json');
    if (fs.existsSync(candidate)) {
      try {
        const provenance = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (provenance.executable && path.resolve(provenance.executable) === resolved) {
          return { path: candidate, provenance };
        }
      } catch { /* keep looking */ }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function discoverStockfish(options = {}) {
  const explicit = options.explicit || null;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`--stockfish path does not exist or is not a file: ${resolved}`);
    }
    const found = findProvenanceForExecutable(resolved);
    return {
      executable: resolved,
      source: 'explicit --stockfish path',
      provenance: found ? found.provenance : null,
      provenancePath: found ? found.path : null
    };
  }

  const candidates = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, 'stockfish.exe'));
    candidates.push(path.join(dir, 'stockfish'));
  }

  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  for (const base of [
    localAppData ? path.join(localAppData, 'Programs', 'Stockfish') : null,
    programFiles ? path.join(programFiles, 'Stockfish') : null,
    programFilesX86 ? path.join(programFilesX86, 'Stockfish') : null,
    path.join(ROOT, 'tools', 'stockfish')
  ]) {
    if (!base || !fs.existsSync(base)) continue;
    const found = findExecutable(base);
    if (found) candidates.push(found);
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const resolved = path.resolve(candidate);
      const found = findProvenanceForExecutable(resolved);
      return {
        executable: resolved,
        source: 'PATH or narrow install location',
        provenance: found ? found.provenance : null,
        provenancePath: found ? found.path : null
      };
    }
  }
  return null;
}

module.exports = {
  DEFAULT_TAG,
  TOOLS_DIR,
  ensureStockfish,
  discoverStockfish,
  findProvenanceForExecutable,
  assetNameForArch,
  findExecutable,
  sha256Buffer
};
