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

  function cents(value) {
    return Math.round((Number(value) || 0) * 100);
  }

  function money(value) {
    return (Number(value) || 0).toFixed(2);
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
      <button class="btn-ghost paycheck-other-remove" type="button" aria-label="Remove deduction" onclick="removePaycheckOtherDeduction(${otherRowSequence})">×</button>
    `;
    $('paycheck-other-deductions').appendChild(row);
    updatePaycheckBalance();
  }

  function removePaycheckOtherDeduction(rowId) {
    const row = $('paycheck-other-deductions').querySelector(`[data-row-id="${rowId}"]`);
    if (row) row.remove();
    updatePaycheckBalance();
  }

  function applyPaycheckValues(source, fallbackEmployer) {
    const importedNet = Math.abs(Number(setupData.transaction.amount));
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
      $('paycheck-imported-net').textContent = fmtTxAmount(Math.abs(Number(setupData.transaction.amount)));
      $('paycheck-member').innerHTML = setupData.members.map(member => (
        `<option value="${Number(member.id)}">${esc(member.avatar_emoji ? `${member.avatar_emoji} ${member.name}` : member.name)}</option>`
      )).join('');
      const source = setupData.paycheck || setupData.latest_template;
      applyPaycheckValues(source, setupData.transaction.employer);
      $('paycheck-use-latest').classList.toggle('hidden', !!setupData.paycheck && !setupData.latest_template);
      if (setupData.paycheck?.reconciliation_status === 'source_changed') {
        feedback.className = 'tx-detail-feedback error';
        feedback.textContent = `Plaid changed this deposit from ${fmtTxAmount(setupData.paycheck.source_net_amount)}. Review the breakdown so it matches the current deposit.`;
      } else {
        feedback.classList.add('hidden');
      }
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
    const gross = cents($('paycheck-gross').value);
    const fixed = fixedFields.reduce((sum, [, id]) => sum + cents($(id).value), 0);
    const other = readOtherDeductions().reduce((sum, item) => sum + cents(item.amount), 0);
    const calculatedNet = gross - fixed - other;
    const importedNet = cents(Math.abs(Number(setupData.transaction.amount)));
    const difference = calculatedNet - importedNet;
    const balance = $('paycheck-balance');
    balance.innerHTML = `<span>Calculated net</span><strong>${fmtTxAmount(calculatedNet / 100)}</strong><span>${difference === 0 ? 'Matches deposit' : `${fmtTxAmount(Math.abs(difference) / 100)} ${difference > 0 ? 'over' : 'under'}`}</span>`;
    balance.classList.toggle('balanced', difference === 0);
    balance.classList.toggle('unbalanced', difference !== 0);
    const otherValid = readOtherDeductions().every(item => item.name && cents(item.amount) > 0);
    $('paycheck-save').disabled = difference !== 0 || gross <= 0 || !$('paycheck-member').value
      || !$('paycheck-employer').value.trim() || !otherValid;
  }

  async function useLatestPaycheck() {
    if (!setupData) return;
    const memberId = $('paycheck-member').value;
    const employer = $('paycheck-employer').value.trim();
    const query = new URLSearchParams({
      member_id: memberId,
      employer,
      exclude_transaction_id: String(setupData.transaction.id)
    });
    const feedback = $('paycheck-setup-feedback');
    try {
      const result = await api(`api/paychecks/template?${query}`);
      if (!result.template) throw new Error('No earlier paycheck found for this employee and employer');
      applyPaycheckValues(result.template, employer);
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
      member_id: Number($('paycheck-member').value),
      employer: $('paycheck-employer').value.trim(),
      gross_earnings: money($('paycheck-gross').value),
      other_deductions: readOtherDeductions()
    };
    for (const [field, id] of fixedFields) payload[field] = money($(id).value);

    try {
      $('paycheck-save').disabled = true;
      feedback.className = 'tx-detail-feedback';
      feedback.textContent = 'Saving paycheck…';
      await api(`api/transactions/${setupData.transaction.id}/paycheck`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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

  Object.assign(global, {
    openPaycheckSetup,
    closePaycheckSetup,
    addPaycheckOtherDeduction,
    removePaycheckOtherDeduction,
    updatePaycheckBalance,
    useLatestPaycheck,
    savePaycheckSetup
  });

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
