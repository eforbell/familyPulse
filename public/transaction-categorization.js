/* global window */
'use strict';

(function exposeTransactionCategorizationUI(global) {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function plainCategoryName(name) {
    return String(name || '')
      .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}\u200D\uFE0F\s]+/gu, '')
      .trim();
  }

  function renderCategoryLine(tx, extraBadges = '') {
    const provenanceBadge = tx.categorization_source && tx.categorization_source !== 'manual'
      ? `<span class="status-tag info" title="Categorized by ${escapeHtml(tx.categorization_source)}">${escapeHtml(tx.categorization_source)}</span>`
      : '';
    const suggestionChip = !tx.category_id && tx.suggested_category_id
      ? `<div class="tx-suggestion" onclick="event.stopPropagation()">
          <span class="tx-suggestion-label">Suggest: ${escapeHtml(plainCategoryName(tx.suggested_category_name))}</span>
          <button class="btn-ghost btn-xs" onclick="acceptCategorySuggestion(event, ${Number(tx.id)})">Accept</button>
          <button class="btn-ghost btn-xs" onclick="rejectCategorySuggestion(event, ${Number(tx.id)})">Reject</button>
        </div>`
      : '';

    if (tx.category_name) {
      return `<div class="tx-cat-line"><span class="cat-dot" style="background:${escapeHtml(tx.category_color || '#6F6A5E')}"></span><span>${escapeHtml(plainCategoryName(tx.category_name))}</span>${provenanceBadge}${extraBadges}</div>`;
    }

    return `<div class="tx-cat-line uncat"><span class="cat-dot"></span><span>Uncategorized · tap to assign</span>${extraBadges}</div>${suggestionChip}`;
  }

  function renderDetailCategory(tx) {
    const provenance = tx.categorization_source && tx.categorization_source !== 'manual'
      ? ` <span class="status-tag info">${escapeHtml(tx.categorization_source)}</span>`
      : '';
    const suggestion = !tx.category_name && tx.suggested_category_name
      ? ` <span class="status-tag info">suggested: ${escapeHtml(plainCategoryName(tx.suggested_category_name))}</span>`
      : '';
    return `${escapeHtml(plainCategoryName(tx.category_name) || 'Uncategorized')}${provenance}${suggestion}`;
  }

  global.TransactionCategorizationUI = { renderCategoryLine, renderDetailCategory };
})(window);
