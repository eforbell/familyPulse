'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_TRANSACTION_FILES_DIR = '/data/apps/familyPulse/transaction-files';

function getTransactionFilesRoot() {
  return process.env.FP_TRANSACTION_FILES_DIR || DEFAULT_TRANSACTION_FILES_DIR;
}

function ensureSafeExtension(ext) {
  const cleaned = String(ext || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '');
  if (!cleaned.startsWith('.') || cleaned.length < 2 || cleaned.length > 10) {
    return '';
  }
  return cleaned;
}

function buildStoredFilename(originalFilename) {
  const ext = ensureSafeExtension(path.extname(originalFilename));
  return `${crypto.randomUUID()}${ext}`;
}

function buildAttachmentPath(storedFilename) {
  return path.join(getTransactionFilesRoot(), path.basename(storedFilename));
}

async function ensureTransactionFilesDir(rootDir = getTransactionFilesRoot()) {
  await fs.mkdir(rootDir, { recursive: true, mode: 0o750 });
  return rootDir;
}

async function safeDeleteAttachmentFile(storedFilename) {
  if (!storedFilename) return false;
  const filePath = buildAttachmentPath(storedFilename);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = {
  DEFAULT_TRANSACTION_FILES_DIR,
  getTransactionFilesRoot,
  buildStoredFilename,
  buildAttachmentPath,
  ensureTransactionFilesDir,
  safeDeleteAttachmentFile
};
