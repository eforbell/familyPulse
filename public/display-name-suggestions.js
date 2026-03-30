'use strict';

(function () {
  function createDisplayNameSuggestionController(config) {
    let suggestions = [];
    let activeIndex = -1;
    let requestId = 0;
    let debounceTimer = null;
    let pointerDownInside = false;

    function getInput() {
      return config.getInput();
    }

    function getRoot() {
      return config.getRoot();
    }

    function getMinLength() {
      return config.minLength || 2;
    }

    function bind() {
      const input = getInput();
      const root = getRoot();
      if (!input || !root) return;

      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('aria-controls', root.id);
      root.setAttribute('role', 'listbox');

      input.addEventListener('input', handleInput);
      input.addEventListener('keydown', handleKeydown);
      input.addEventListener('blur', () => {
        if (pointerDownInside) return;
        hide();
      });

      root.addEventListener('mousedown', () => {
        pointerDownInside = true;
      });
      root.addEventListener('mouseup', () => {
        pointerDownInside = false;
      });
      root.addEventListener('mouseleave', () => {
        pointerDownInside = false;
      });
      root.addEventListener('click', event => {
        const button = event.target.closest('[data-suggestion-index]');
        if (!button) return;
        const index = parseInt(button.dataset.suggestionIndex, 10);
        if (!Number.isInteger(index)) return;
        select(index);
      });
    }

    function handleInput() {
      clearTimeout(debounceTimer);
      if (!config.shouldSuggest()) {
        hide();
        return;
      }
      debounceTimer = setTimeout(load, config.debounceMs || 180);
    }

    async function load() {
      const input = getInput();
      if (!input || !config.shouldSuggest()) {
        hide();
        return;
      }

      const query = input.value.trim();
      if (query.length < getMinLength()) {
        hide();
        return;
      }

      const currentRequestId = ++requestId;
      try {
        const data = await config.fetchSuggestions(query);
        if (currentRequestId !== requestId) return;
        suggestions = Array.isArray(data) ? data : [];
        activeIndex = -1;
        render();
      } catch {
        if (currentRequestId !== requestId) return;
        hide();
      }
    }

    function render() {
      const root = getRoot();
      const input = getInput();
      if (!root || !input) return;

      if (!suggestions.length) {
        hide();
        return;
      }

      root.innerHTML = suggestions.map((suggestion, index) => `
        <button
          id="${root.id}-option-${index}"
          type="button"
          role="option"
          aria-selected="${index === activeIndex ? 'true' : 'false'}"
          data-suggestion-index="${index}"
          class="tx-display-name-suggestion ${index === activeIndex ? 'active' : ''}"
        >
          <span>${config.escapeHtml(suggestion.label)}</span>
          <span class="tx-display-name-suggestion-meta">${suggestion.usage_count} tx · last seen ${config.formatDate(suggestion.last_seen_date)}</span>
        </button>
      `).join('');

      root.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
      if (activeIndex >= 0) {
        input.setAttribute('aria-activedescendant', `${root.id}-option-${activeIndex}`);
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function hide() {
      const root = getRoot();
      const input = getInput();
      suggestions = [];
      activeIndex = -1;
      requestId++;
      clearTimeout(debounceTimer);
      pointerDownInside = false;
      if (root) {
        root.innerHTML = '';
        root.classList.add('hidden');
      }
      if (input) {
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
      }
    }

    function select(index) {
      const suggestion = suggestions[index];
      const input = getInput();
      if (!suggestion || !input) return;
      input.value = suggestion.label;
      hide();
      if (typeof config.onSelect === 'function') {
        config.onSelect(suggestion);
      }
    }

    function handleKeydown(event) {
      if (!suggestions.length) {
        if (event.key === 'Escape') hide();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % suggestions.length;
        render();
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeIndex = activeIndex < 0 ? suggestions.length - 1 : (activeIndex - 1 + suggestions.length) % suggestions.length;
        render();
        return;
      }

      if (event.key === 'Enter' && activeIndex >= 0) {
        event.preventDefault();
        select(activeIndex);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        hide();
      }
    }

    return {
      bind,
      hide
    };
  }

  window.createDisplayNameSuggestionController = createDisplayNameSuggestionController;
})();
