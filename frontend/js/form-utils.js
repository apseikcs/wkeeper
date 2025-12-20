(function (window) {
  // Setup scroll lock observer for modals
  const modalRoot = document.getElementById('modalRoot');
  if (modalRoot) {
    const observer = new MutationObserver((mutations) => {
      // If modal has content, lock scroll. If empty, unlock.
      if (modalRoot.innerHTML.trim()) {
        document.body.style.overflow = 'hidden';
      } else {
        document.body.style.overflow = '';
      }
    });
    observer.observe(modalRoot, { childList: true, subtree: true, characterData: true });
  }

  function findSubmitButton(form) {
    return form.querySelector('button[type="submit"]') || form.querySelector('button');
  }

  function disable(form, opts) {
    const btn = findSubmitButton(form);
    if (!btn) return () => {};
    if (btn.__wk_disabled) return () => {};
    btn.__wk_disabled = true;
    btn.disabled = true;
    if (opts && opts.spinnerClass) {
      btn.classList.add(opts.spinnerClass);
    }
    if (opts && opts.text) {
      btn.__wk_orig_text = btn.textContent;
      btn.textContent = opts.text;
    }
    return function enable() {
      btn.__wk_disabled = false;
      btn.disabled = false;
      if (opts && opts.spinnerClass) {
        btn.classList.remove(opts.spinnerClass);
      }
      if (opts && opts.text && btn.__wk_orig_text !== undefined) {
        btn.textContent = btn.__wk_orig_text;
        delete btn.__wk_orig_text;
      }
    };
  }

  window.formUtils = {
    enableScrollLock: function () {
      document.body.style.overflow = 'hidden';
    },
    disableScrollLock: function () {
      document.body.style.overflow = '';
    },
    disableDuring: async function (form, promiseFactory, opts) {
      const enable = disable(form, opts || {});
      try {
        return await promiseFactory();
      } finally {
        enable();
      }
    },
    disable: disable,
    // Helper to normalize API responses with optional pagination
    // Returns array from: direct array, { items: [...] }, or { page, limit, items: [...] }
    extractItems: function (data) {
      if (Array.isArray(data)) return data;
      if (data && data.items && Array.isArray(data.items)) return data.items;
      return [];
    },
    // Pagination UI Component Generator (Tailwind only, responsive)
    // Usage: createPaginationControls({ currentPage, totalPages, onPageChange, position: 'top-right' })
    createPaginationControls: function (opts) {
      const { currentPage, totalPages, onPageChange, position = 'bottom-center', id = 'pagination' } = opts;
      
      const container = document.createElement('div');
      container.id = id;
      
      // Layer 1: Previous buttons (<<, <)
      const leftLayerEl = document.createElement('div');
      leftLayerEl.className = 'flex gap-1';
      
      const firstPageBtn = document.createElement('button');
      firstPageBtn.className = 'px-2 py-1 text-xs sm:text-sm bg-gray-200 hover:bg-gray-300 text-gray-800 rounded disabled:opacity-50 disabled:cursor-not-allowed';
      firstPageBtn.textContent = '<<';
      firstPageBtn.disabled = currentPage <= 1;
      firstPageBtn.addEventListener('click', () => onPageChange(1));
      leftLayerEl.appendChild(firstPageBtn);
      
      const prevBtn = document.createElement('button');
      prevBtn.className = 'px-2 py-1 text-xs sm:text-sm bg-gray-200 hover:bg-gray-300 text-gray-800 rounded disabled:opacity-50 disabled:cursor-not-allowed';
      prevBtn.textContent = '<';
      prevBtn.disabled = currentPage <= 1;
      prevBtn.addEventListener('click', () => onPageChange(currentPage - 1));
      leftLayerEl.appendChild(prevBtn);
      
      // Layer 2: Slider + Page input
      const sliderLayerEl = document.createElement('div');
      sliderLayerEl.className = 'flex gap-2 items-center flex-1 justify-center px-2 min-w-0';
      
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '1';
      slider.max = String(totalPages);
      slider.value = String(currentPage);
      slider.className = 'w-full max-w-xs h-2 bg-gray-300 rounded-lg appearance-none cursor-pointer accent-blue-600';
      slider.addEventListener('change', (e) => onPageChange(Number(e.target.value)));
      sliderLayerEl.appendChild(slider);
      
      const pageInputContainer = document.createElement('div');
      pageInputContainer.className = 'flex items-center gap-1 whitespace-nowrap text-xs sm:text-sm';
      
      const pageInput = document.createElement('input');
      pageInput.type = 'number';
      pageInput.min = '1';
      pageInput.max = String(totalPages);
      pageInput.value = String(currentPage);
      pageInput.className = 'w-12 px-2 py-1 border border-gray-300 rounded text-center';
      pageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const page = Math.max(1, Math.min(totalPages, Number(e.target.value)));
          onPageChange(page);
        }
      });
      pageInput.addEventListener('blur', (e) => {
        const page = Math.max(1, Math.min(totalPages, Number(e.target.value)));
        pageInput.value = String(currentPage);
      });
      pageInputContainer.appendChild(pageInput);
      
      const ofLabel = document.createElement('span');
      ofLabel.textContent = ` / ${totalPages}`;
      pageInputContainer.appendChild(ofLabel);
      
      sliderLayerEl.appendChild(pageInputContainer);
      
      // Layer 3: Next buttons (>, >>)
      const rightLayerEl = document.createElement('div');
      rightLayerEl.className = 'flex gap-1';
      
      const nextBtn = document.createElement('button');
      nextBtn.className = 'px-2 py-1 text-xs sm:text-sm bg-gray-200 hover:bg-gray-300 text-gray-800 rounded disabled:opacity-50 disabled:cursor-not-allowed';
      nextBtn.textContent = '>';
      nextBtn.disabled = currentPage >= totalPages;
      nextBtn.addEventListener('click', () => onPageChange(currentPage + 1));
      rightLayerEl.appendChild(nextBtn);
      
      const lastPageBtn = document.createElement('button');
      lastPageBtn.className = 'px-2 py-1 text-xs sm:text-sm bg-gray-200 hover:bg-gray-300 text-gray-800 rounded disabled:opacity-50 disabled:cursor-not-allowed';
      lastPageBtn.textContent = '>>';
      lastPageBtn.disabled = currentPage >= totalPages;
      lastPageBtn.addEventListener('click', () => onPageChange(totalPages));
      rightLayerEl.appendChild(lastPageBtn);
      
      // Main container - responsive layout with 3 layers
      if (position === 'top-right') {
        container.className = 'flex flex-col-reverse sm:flex-row gap-2 items-center justify-end mb-4';
      } else if (position === 'bottom-center') {
        container.className = 'flex flex-col-reverse sm:flex-row gap-2 items-center justify-center mt-4 pt-4 border-t border-gray-300';
      } else {
        container.className = 'flex flex-col-reverse sm:flex-row gap-2 items-center justify-between p-4';
      }
      
      container.appendChild(leftLayerEl);
      container.appendChild(sliderLayerEl);
      container.appendChild(rightLayerEl);
      
      return container;
    }
  };
})(window);
