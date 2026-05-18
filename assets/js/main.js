/* ================================================================
   NAORU整体 渋谷店 LP - main.js
   - FAQ accordion
   - Sticky CTA show/hide
   - Smooth scroll
   - Reveal animation on scroll
   - Form validation & submit
   ================================================================ */

(function () {
  'use strict';

  // ---------- 1. FAQ Accordion ----------
  document.querySelectorAll('.faq__item').forEach(function (item) {
    const q = item.querySelector('.faq__q');
    if (!q) return;
    q.addEventListener('click', function () {
      const isOpen = item.classList.contains('is-open');
      item.classList.toggle('is-open', !isOpen);
      q.setAttribute('aria-expanded', String(!isOpen));
    });
  });

  // ---------- 2. Sticky bottom CTA ----------
  const stickyCta = document.querySelector('.sticky-cta');
  const fv = document.querySelector('.fv');
  if (stickyCta && fv) {
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        // FVが見えなくなったら表示
        stickyCta.classList.toggle('is-visible', !entry.isIntersecting);
      });
    }, { threshold: 0.1 });
    observer.observe(fv);
  }

  // ---------- 3. Smooth scroll for anchor links ----------
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      const href = a.getAttribute('href');
      if (!href || href === '#') return;
      const target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      const headerH = 60;
      const top = target.getBoundingClientRect().top + window.pageYOffset - headerH - 8;
      window.scrollTo({ top: top, behavior: 'smooth' });
    });
  });

  // ---------- 4. Reveal animation on scroll ----------
  if ('IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal').forEach(function (el) {
      revealObserver.observe(el);
    });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) {
      el.classList.add('is-visible');
    });
  }

  // ---------- 5. Form validation & submission ----------
  const form = document.getElementById('reservation-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      let valid = true;

      // Honeypot check (spam bot detection)
      const honeypot = form.querySelector('input[name="website"]');
      if (honeypot && honeypot.value) {
        return false;
      }

      // Required fields validation
      form.querySelectorAll('[data-required="true"]').forEach(function (input) {
        const field = input.closest('.form__field');
        if (!field) return;
        const errorEl = field.querySelector('.form__error');
        let isValid = true;
        const val = input.value.trim();

        if (!val) {
          isValid = false;
          if (errorEl) errorEl.textContent = 'こちらは必須項目です。';
        } else if (input.type === 'tel') {
          const telRegex = /^[0-9\-+\s()]{10,}$/;
          if (!telRegex.test(val)) {
            isValid = false;
            if (errorEl) errorEl.textContent = '電話番号の形式をご確認ください。';
          }
        }

        field.classList.toggle('has-error', !isValid);
        if (!isValid) valid = false;
      });

      // Privacy policy checkbox
      const consent = form.querySelector('input[name="consent"]');
      if (consent && !consent.checked) {
        alert('プライバシーポリシーへの同意が必要です。');
        valid = false;
      }

      if (!valid) {
        // Scroll to first error
        const firstError = form.querySelector('.has-error');
        if (firstError) {
          firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }

      // Prevent double submission
      const submitBtn = form.querySelector('.form__submit');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '送信中...';
      }

      // 実装フェーズでは fetch() で予約管理APIまたはフォーム送信先に送信
      // 現状はサンクスページへの遷移のみ（CV計測タグはサンクスページで発火）
      setTimeout(function () {
        window.location.href = 'thanks.html';
      }, 600);
    });

    // Clear error on input
    form.querySelectorAll('.form__input, .form__select, .form__textarea').forEach(function (input) {
      input.addEventListener('input', function () {
        const field = input.closest('.form__field');
        if (field && field.classList.contains('has-error')) {
          field.classList.remove('has-error');
        }
      });
    });
  }

  // ---------- 6. Current year for footer ----------
  const yearEl = document.getElementById('current-year');
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }
})();
