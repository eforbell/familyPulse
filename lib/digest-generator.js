'use strict';

// Backward-compat wrapper — delegates to new magic-actions module
const { generateWeeklyDigest } = require('./magic-actions/weekly-digest');

module.exports = { generateWeeklyDigest };
