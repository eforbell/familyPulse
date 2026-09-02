/* global window */
'use strict';

(function exposeTransactionSplitEditor(global) {
  let splitAllocationRowSeq = 0;

  function showCategoryPickerPanel() {
    $('category-picker-panel').classList.remove('hidden');
    $('split-editor-panel').classList.add('hidden');
    if (assignTarget) $('cat-overlay-title').textContent = 'Assign Category';
  }

  function splitCategoryOptions(selectedCategoryId = '') {
    return `<option value="">Choose category</option>${categories.filter(category => !category.is_transfer_class).map(category => `
      <option value="${Number(category.id)}" ${String(category.id) === String(selectedCategoryId) ? 'selected' : ''}>${esc(plainCategoryName(category.name))}</option>
    `).join('')}`;
  }

  function appendSplitAllocationRow({ category_id = '', amount = '' } = {}) {
    splitAllocationRowSeq += 1;
    const row = document.createElement('div');
    row.className = 'split-allocation-row';
    row.dataset.rowId = String(splitAllocationRowSeq);
    row.innerHTML = `
      <select class="split-allocation-category" aria-label="Split category" onchange="updateSplitEditorBalance()">
        ${splitCategoryOptions(category_id)}
      </select>
      <input class="split-allocation-amount" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(amount)}" aria-label="Allocation amount" oninput="updateSplitEditorBalance()">
      <button class="btn-ghost split-allocation-remove" type="button" aria-label="Remove allocation" onclick="removeSplitAllocationRow(${splitAllocationRowSeq})">×</button>
    `;
    $('split-allocation-rows').appendChild(row);
  }

  function openSplitEditor() {
    const tx = assignTarget?.transaction;
    if (!tx || tx.pending || tx.is_transfer || tx.is_compound) return;
    $('category-picker-panel').classList.add('hidden');
    $('split-editor-panel').classList.remove('hidden');
    $('cat-overlay-title').textContent = tx.is_split ? 'Edit Split' : 'Split Transaction';
    $('split-editor-total').innerHTML = fmtTxAmount(Math.abs(Number(tx.amount)));
    $('split-allocation-rows').innerHTML = '';
    $('split-editor-error').classList.add('hidden');

    const existing = Array.isArray(tx.category_allocations) ? tx.category_allocations : [];
    for (const allocation of existing) {
      appendSplitAllocationRow({
        category_id: allocation.category_id,
        amount: Math.abs(Number(allocation.amount)).toFixed(2)
      });
    }
    if (existing.length < 2) appendSplitAllocationRow();
    if (existing.length === 0) appendSplitAllocationRow();
    updateSplitEditorBalance();
  }

  function addSplitAllocationRow() {
    if ($('split-allocation-rows').children.length >= 24) return;
    appendSplitAllocationRow();
    updateSplitEditorBalance();
  }

  function removeSplitAllocationRow(rowId) {
    const rows = $('split-allocation-rows').querySelectorAll('.split-allocation-row');
    if (rows.length <= 2) return;
    const row = $('split-allocation-rows').querySelector(`[data-row-id="${rowId}"]`);
    if (row) row.remove();
    updateSplitEditorBalance();
  }

  function readSplitEditorRows() {
    return [...$('split-allocation-rows').querySelectorAll('.split-allocation-row')].map(row => ({
      categoryId: Number(row.querySelector('.split-allocation-category').value) || null,
      cents: Math.round((Number(row.querySelector('.split-allocation-amount').value) || 0) * 100)
    }));
  }

  function updateSplitEditorBalance() {
    const targetCents = Math.round(Math.abs(Number(assignTarget?.transaction?.amount || 0)) * 100);
    const allocatedCents = readSplitEditorRows().reduce((sum, row) => sum + row.cents, 0);
    const remainingCents = targetCents - allocatedCents;
    const remaining = $('split-editor-remaining');
    remaining.innerHTML = `Remaining ${fmtTxAmount(Math.abs(remainingCents) / 100)}${remainingCents < 0 ? ' over' : ''}`;
    remaining.classList.toggle('balanced', remainingCents === 0);
    remaining.classList.toggle('unbalanced', remainingCents !== 0);
    $('split-editor-save').disabled = remainingCents !== 0;
  }

  async function saveSplitAllocations() {
    const tx = assignTarget?.transaction;
    if (!tx) return;
    const rows = readSplitEditorRows();
    const error = $('split-editor-error');
    const categoryIds = rows.map(row => row.categoryId);
    if (rows.length < 2 || categoryIds.some(id => !id) || rows.some(row => row.cents <= 0)) {
      error.textContent = 'Choose a category and positive amount for every split.';
      error.classList.remove('hidden');
      return;
    }
    if (new Set(categoryIds).size !== categoryIds.length) {
      error.textContent = 'Use each category only once.';
      error.classList.remove('hidden');
      return;
    }

    const direction = Number(tx.amount) < 0 ? -1 : 1;
    try {
      await api(`api/transactions/${tx.id}/allocations`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allocations: rows.map(row => ({
            category_id: row.categoryId,
            amount: (direction * row.cents / 100).toFixed(2)
          }))
        })
      });
      closeCategoryOverlay();
      await loadTransactions();
      if (currentDetailId === tx.id) await refreshCurrentDetail();
    } catch (err) {
      error.textContent = err.message || 'Could not save split';
      error.classList.remove('hidden');
    }
  }


  Object.assign(global, {
    showCategoryPickerPanel,
    openSplitEditor,
    addSplitAllocationRow,
    removeSplitAllocationRow,
    updateSplitEditorBalance,
    saveSplitAllocations
  });
})(window);
