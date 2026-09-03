/* global window */
'use strict';

(function exposePaycheckSetup(global) {
  const fixedFields = [
    ['federal_tax', 'paycheck-federal-tax'],
    ['social_security_tax', 'paycheck-social-security-tax'],
    ['medicare_tax', 'paycheck-medicare-tax'],
    ['retirement_401k', 'paycheck-retirement-401k'],
    ['health_insurance', 'paycheck-health-insurance']
  ];
  let setupData = null;
  let otherRowSequence = 0;

  function cents(value) { return Math.round((Number(value) || 0) * 100); }
  function money(value) { return (Number(value) || 0).toFixed(2); }
  function selectedDepositIds() {
    return [...$('paycheck-deposit-options').querySelectorAll('input:checked')].map(input => Number(input.value));
  }
  function selectedNetCents() {
    const ids = new Set(selectedDepositIds());
    return (setupData?.candidate_deposits || []).reduce((sum, deposit) => (
      ids.has(Number(deposit.id)) ? sum + cents(Math.abs(Number(deposit.amount))) : sum
    ), 0);
  }
  function depositLabel(deposit) {
    const mask = deposit.account_mask ? ` ••••${deposit.account_mask}` : '';
    return `${deposit.account_name || 'Account'}${mask}`;
  }

  function renderDepositOptions() {
    const existingIds = new Set((setupData.paycheck?.deposits || []).map(row => Number(row.transaction_id)));
    const deductionId = Number((setupData.paycheck?.deposits || []).find(row => row.deductions_applied)?.transaction_id || setupData.transaction.id);
    $('paycheck-deposit-options').innerHTML = setupData.candidate_deposits.map(deposit => {
      const checked = existingIds.size ? existingIds.has(Number(deposit.id)) : Number(deposit.id) === Number(setupData.transaction.id);
      const belongsElsewhere = deposit.paycheck_event_id && Number(deposit.paycheck_event_id) !== Number(setupData.paycheck?.id);
      const disabled = Number(deposit.id) === Number(setupData.transaction.id) || belongsElsewhere ? 'disabled' : '';
      return `<label class="paycheck-deposit-option">
        <input type="checkbox" value="${Number(deposit.id)}" ${checked ? 'checked' : ''} ${disabled} onchange="updatePaycheckBalance()">
        <span>${esc(deposit.display_name || 'Paycheck deposit')}<small class="paycheck-deposit-account">${esc(depositLabel(deposit))} · ${esc(String(deposit.date).slice(0, 10))}</small></span>
        <strong>${fmtTxAmount(Math.abs(Number(deposit.amount)))}</strong>
      </label>`;
    }).join('');
    const anchor = $('paycheck-deposit-options').querySelector(`input[value="${Number(setupData.transaction.id)}"]`);
    if (anchor) anchor.checked = true;
    refreshDeductionOptions(deductionId);
  }

  function refreshDeductionOptions(preferredId) {
    const selected = new Set(selectedDepositIds());
    const deposits = setupData.candidate_deposits.filter(row => selected.has(Number(row.id)));
    const select = $('paycheck-deduction-transaction');
    const prior = Number(preferredId || select.value || setupData.transaction.id);
    select.innerHTML = deposits.map(deposit => (
      `<option value="${Number(deposit.id)}">${esc(depositLabel(deposit))} — ${fmtTxAmount(Math.abs(Number(deposit.amount)))}</option>`
    )).join('');
    select.value = String(selected.has(prior) ? prior : Number(setupData.transaction.id));
  }

  function addPaycheckOtherDeduction(item = {}) {
    if ($('paycheck-other-deductions').children.length >= 12) return;
    otherRowSequence += 1;
    const row = document.createElement('div');
    row.className = 'paycheck-other-row';
    row.dataset.rowId = String(otherRowSequence);
    row.innerHTML = `
      <input class="paycheck-other-name" type="text" maxlength="80" placeholder="Deduction name" aria-label="Other deduction name" value="${esc(item.name || '')}" oninput="updatePaycheckBalance()">
      <input class="paycheck-other-amount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00" aria-label="Other deduction amount" value="${esc(item.amount || '')}" oninput="updatePaycheckBalance()">
      <button class="btn-ghost paycheck-other-remove" type="button" aria-label="Remove deduction" onclick="removePaycheckOtherDeduction(${otherRowSequence})">×</button>`;
    $('paycheck-other-deductions').appendChild(row);
    updatePaycheckBalance();
  }

  function removePaycheckOtherDeduction(rowId) {
    const row = $('paycheck-other-deductions').querySelector(`[data-row-id="${rowId}"]`);
    if (row) row.remove();
    updatePaycheckBalance();
  }

  function applyPaycheckValues(source, fallbackEmployer) {
    const importedNet = selectedNetCents() / 100;
    $('paycheck-member').value = String(source?.member_id || currentMember?.id || setupData.members[0]?.id || '');
    $('paycheck-employer').value = source?.employer || fallbackEmployer || '';
    $('paycheck-gross').value = money(source?.gross_earnings ?? importedNet);
    for (const [field, id] of fixedFields) $(id).value = money(source?.[field] || 0);
    $('paycheck-other-deductions').innerHTML = '';
    for (const item of source?.other_deductions || []) addPaycheckOtherDeduction(item);
    updatePaycheckBalance();
  }

  async function openPaycheckSetup() {
    if (!currentDetailId || currentMember?.role !== 'parent') return;
    const feedback = $('paycheck-setup-feedback');
    feedback.className = 'tx-detail-feedback';
    feedback.textContent = 'Loading paycheck setup…';
    $('paycheck-setup-overlay').classList.remove('hidden');
    syncModalOpenState();
    try {
      setupData = await api(`api/transactions/${currentDetailId}/paycheck-setup`);
      $('paycheck-member').innerHTML = setupData.members.map(member => (
        `<option value="${Number(member.id)}">${esc(member.avatar_emoji ? `${member.avatar_emoji} ${member.name}` : member.name)}</option>`
      )).join('');
      renderDepositOptions();
      const source = setupData.paycheck || setupData.latest_template;
      applyPaycheckValues(source, setupData.transaction.employer);
      $('paycheck-use-latest').classList.toggle('hidden', !!setupData.paycheck && !setupData.latest_template);
      if (setupData.paycheck?.reconciliation_status === 'source_changed') {
        feedback.className = 'tx-detail-feedback error';
        feedback.textContent = 'Plaid changed one of these deposits. Review the selected deposits and breakdown.';
      } else feedback.classList.add('hidden');
    } catch (err) {
      feedback.className = 'tx-detail-feedback error';
      feedback.textContent = err.message || 'Could not load paycheck setup';
    }
  }

  function closePaycheckSetup() {
    setupData = null;
    $('paycheck-setup-overlay').classList.add('hidden');
    syncModalOpenState();
  }

  function readOtherDeductions() {
    return [...$('paycheck-other-deductions').querySelectorAll('.paycheck-other-row')].map(row => ({
      name: row.querySelector('.paycheck-other-name').value.trim(),
      amount: money(row.querySelector('.paycheck-other-amount').value)
    }));
  }

  function updatePaycheckBalance() {
    if (!setupData) return;
    refreshDeductionOptions();
    const gross = cents($('paycheck-gross').value);
    const fixed = fixedFields.reduce((sum, [, id]) => sum + cents($(id).value), 0);
    const other = readOtherDeductions().reduce((sum, item) => sum + cents(item.amount), 0);
    const calculatedNet = gross - fixed - other;
    const importedNet = selectedNetCents();
    const difference = calculatedNet - importedNet;
    $('paycheck-imported-net').innerHTML = fmtTxAmount(importedNet / 100);
    const balance = $('paycheck-balance');
    balance.innerHTML = `<span>Calculated net</span><strong>${fmtTxAmount(calculatedNet / 100)}</strong><span>${difference === 0 ? 'Matches deposits' : `${fmtTxAmount(Math.abs(difference) / 100)} ${difference > 0 ? 'over' : 'under'}`}</span>`;
    balance.classList.toggle('balanced', difference === 0);
    balance.classList.toggle('unbalanced', difference !== 0);
    const otherValid = readOtherDeductions().every(item => item.name && cents(item.amount) > 0);
    $('paycheck-save').disabled = difference !== 0 || gross <= 0 || !selectedDepositIds().length
      || !$('paycheck-deduction-transaction').value || !$('paycheck-member').value
      || !$('paycheck-employer').value.trim() || !otherValid;
  }

  async function useLatestPaycheck() {
    if (!setupData) return;
    const query = new URLSearchParams({
      member_id: $('paycheck-member').value,
      employer: $('paycheck-employer').value.trim(),
      exclude_transaction_id: String(setupData.transaction.id)
    });
    const feedback = $('paycheck-setup-feedback');
    try {
      const result = await api(`api/paychecks/template?${query}`);
      if (!result.template) throw new Error('No earlier paycheck found for this employee and employer');
      applyPaycheckValues(result.template, $('paycheck-employer').value.trim());
      feedback.classList.add('hidden');
    } catch (err) {
      feedback.className = 'tx-detail-feedback error';
      feedback.textContent = err.message;
    }
  }

  async function savePaycheckSetup() {
    if (!setupData || $('paycheck-save').disabled) return;
    const feedback = $('paycheck-setup-feedback');
    const payload = {
      member_id: Number($('paycheck-member').value), employer: $('paycheck-employer').value.trim(),
      gross_earnings: money($('paycheck-gross').value), other_deductions: readOtherDeductions(),
      deposit_transaction_ids: selectedDepositIds(),
      deduction_transaction_id: Number($('paycheck-deduction-transaction').value)
    };
    for (const [field, id] of fixedFields) payload[field] = money($(id).value);
    try {
      $('paycheck-save').disabled = true;
      feedback.className = 'tx-detail-feedback';
      feedback.textContent = 'Saving paycheck…';
      await api(`api/transactions/${setupData.transaction.id}/paycheck`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      closePaycheckSetup();
      await loadTransactions();
      await refreshCurrentDetail();
    } catch (err) {
      feedback.className = 'tx-detail-feedback error';
      feedback.textContent = err.message || 'Could not save paycheck';
      updatePaycheckBalance();
    }
  }

  Object.assign(global, { openPaycheckSetup, closePaycheckSetup, addPaycheckOtherDeduction,
    removePaycheckOtherDeduction, updatePaycheckBalance, useLatestPaycheck, savePaycheckSetup });
  document.addEventListener('click', event => {
    const overlay = $('paycheck-setup-overlay');
    if (overlay && event.target === overlay) closePaycheckSetup();
  });
  document.addEventListener('keydown', event => {
    const overlay = $('paycheck-setup-overlay');
    if (!overlay || overlay.classList.contains('hidden') || event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    closePaycheckSetup();
  });
})(window);
