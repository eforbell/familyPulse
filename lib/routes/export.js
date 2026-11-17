'use strict';

const { Router } = require('express');
const { mkdtemp, rm } = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pool } = require('../db');
const { requireParent } = require('../auth');
const { withExportSnapshot, writeCsv } = require('../data-export');
const logger = require('../logger');

const router = Router();

router.get('/api/export', requireParent, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  const format = req.query.format || 'csv';
  if (format !== 'csv') {
    return res.status(400).json({ error: 'Choose csv export format' });
  }

  let directory;
  try {
    // Prepare the complete snapshot before sending headers. A query or write
    // failure must not masquerade as a successful, silently incomplete dump.
    directory = await mkdtemp(path.join(tmpdir(), 'familypulse-export-'));
    const filename = `familypulse-transactions-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
    const file = path.join(directory, filename);
    await withExportSnapshot(pool, client => writeCsv(client, createWriteStream(file, { mode: 0o600 })));
    if (req.destroyed || res.destroyed) {
      await rm(directory, { recursive: true, force: true });
      return;
    }
    res.type('text/csv');
    res.download(file, filename, async err => {
      await rm(directory, { recursive: true, force: true }).catch(cleanupErr => {
        logger.error('Export cleanup failed', { error: cleanupErr.message });
      });
      if (err && !res.destroyed) res.destroy();
    });
  } catch (err) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(cleanupErr => {
      logger.error('Export cleanup failed', { error: cleanupErr.message });
    });
    logger.error('Data export failed', { error: err.message });
    if (!res.destroyed) res.status(500).json({ error: 'Export failed. Please try again.' });
  }
});

module.exports = router;
