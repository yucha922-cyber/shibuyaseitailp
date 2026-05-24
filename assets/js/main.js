/* ================================================================
   NAORU整体 渋谷院 LP - main.js
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

  // ---------- 6. Testimonials carousel (1件ずつ表示) + ランダムアバター ----------
  document.querySelectorAll('[data-testimonials]').forEach(function (root) {
    const track = root.querySelector('.testimonials__track');
    const viewport = root.querySelector('.testimonials__viewport');
    const slides = Array.prototype.slice.call(root.querySelectorAll('.testimonial-card'));
    const prevBtn = root.querySelector('.testimonials__arrow--prev');
    const nextBtn = root.querySelector('.testimonials__arrow--next');
    const dotsWrap = root.querySelector('.testimonials__dots');
    if (!track || slides.length === 0) return;

    // --- ランダムな横顔シルエットのアバター ---
    const palettes = [
      'linear-gradient(135deg, #2c8a93 0%, #54adb5 100%)',
      'linear-gradient(135deg, #3e5277 0%, #647aa3 100%)',
      'linear-gradient(135deg, #6f9a82 0%, #93b9a2 100%)',
      'linear-gradient(135deg, #c08a63 0%, #d6a87f 100%)',
      'linear-gradient(135deg, #7d6f9a 0%, #9d90b8 100%)'
    ];
    slides.forEach(function (card) {
      const avatar = card.querySelector('.testimonial-card__avatar');
      if (!avatar) return;
      avatar.style.background = palettes[Math.floor(Math.random() * palettes.length)];
      const flip = Math.random() < 0.5 ? ' style="transform:scaleX(-1)"' : '';
      avatar.innerHTML =
        '<svg viewBox="0 0 64 64" fill="rgba(255,255,255,0.95)"' + flip + '>' +
        '<circle cx="36" cy="22" r="12.5"/>' +
        '<path d="M24 17 L15 22 L24 27 Z"/>' +
        '<path d="M11 64 V54 C11 43 22 38 34 38 C46 38 57 43 57 54 V64 Z"/>' +
        '</svg>';
    });

    // --- カルーセル制御（1ページに表示するカラム数だけ送る） ---
    const GAP = 16;
    let page = 0;
    let dots = [];

    function perView() {
      if (window.matchMedia('(min-width: 980px)').matches) return 3;
      if (window.matchMedia('(min-width: 640px)').matches) return 2;
      return 1;
    }
    function pageCount() {
      return Math.max(1, Math.ceil(slides.length / perView()));
    }

    function buildDots() {
      if (!dotsWrap) return;
      dotsWrap.innerHTML = '';
      dots = [];
      const count = pageCount();
      for (let i = 0; i < count; i++) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'testimonials__dot';
        dot.setAttribute('role', 'tab');
        dot.setAttribute('aria-label', (i + 1) + 'ページ目の口コミ');
        (function (idx) {
          dot.addEventListener('click', function () { go(idx); });
        })(i);
        dotsWrap.appendChild(dot);
        dots.push(dot);
      }
    }

    function go(i) {
      const count = pageCount();
      page = (i + count) % count;
      let x = page * (viewport.clientWidth + GAP);
      const max = track.scrollWidth - viewport.clientWidth;
      if (x > max) x = Math.max(0, max);
      track.style.transform = 'translateX(' + (-x) + 'px)';
      dots.forEach(function (d, di) { d.classList.toggle('is-active', di === page); });
    }

    if (prevBtn) prevBtn.addEventListener('click', function () { go(page - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { go(page + 1); });

    // スワイプ操作（モバイル）
    if (viewport) {
      let startX = null;
      viewport.addEventListener('touchstart', function (e) {
        startX = e.touches[0].clientX;
      }, { passive: true });
      viewport.addEventListener('touchend', function (e) {
        if (startX === null) return;
        const dx = e.changedTouches[0].clientX - startX;
        if (Math.abs(dx) > 40) go(page + (dx < 0 ? 1 : -1));
        startX = null;
      });
    }

    let resizeTimer = null;
    window.addEventListener('resize', function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        buildDots();
        if (page > pageCount() - 1) page = pageCount() - 1;
        go(page);
      }, 150);
    });

    buildDots();
    go(0);
  });

  // ---------- 7. Current year for footer ----------
  const yearEl = document.getElementById('current-year');
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }
})();
