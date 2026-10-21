'use strict';

(function () {
  // ---------- Token CSRF ----------
  // Semua form POST otomatis diberi input `_csrf`; fetch non-GET diberi header.
  const metaCsrf = document.querySelector('meta[name="csrf-token"]');
  const csrfToken = metaCsrf ? String(metaCsrf.content || '') : '';

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    if (String(form.getAttribute('method') || 'get').toLowerCase() !== 'post') return;
    if (form.querySelector('input[name="_csrf"]')) return;
    if (!csrfToken) return;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = '_csrf';
    input.value = csrfToken;
    form.appendChild(input);
  }, true);

  if (csrfToken && typeof window.fetch === 'function') {
    const fetchAsli = window.fetch.bind(window);
    window.fetch = (sumber, opsi = {}) => {
      const metode = String(opsi.method || (sumber && sumber.method) || 'GET').toUpperCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(metode)) {
        const headers = new Headers(opsi.headers || {});
        headers.set('x-csrf-token', csrfToken);
        return fetchAsli(sumber, { ...opsi, headers });
      }
      return fetchAsli(sumber, opsi);
    };
  }

  const sidebar = document.getElementById('sidebar');
  const menuBtn = document.getElementById('menuBtn');
  const backdrop = document.getElementById('backdrop');

  function tutupMenu() {
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('show');
  }

  if (menuBtn && sidebar) {
    menuBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      if (backdrop) backdrop.classList.toggle('show');
    });
  }
  if (backdrop) backdrop.addEventListener('click', tutupMenu);

  // Pastikan menu yang sedang aktif terlihat saat daftar menu lebih panjang dari layar.
  const navAktif = document.querySelector('.sidebar .nav-link.active');
  if (navAktif && typeof navAktif.scrollIntoView === 'function') {
    navAktif.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------- Sidebar mini (desktop) ----------
  const collapseBtn = document.getElementById('collapseBtn');
  const KUNCI_MINI = 'tirtadesa_sidebar_mini';

  function teksMenu(link) {
    const ico = link.querySelector('.nav-ico');
    const isi = ico ? link.textContent.slice(ico.textContent.length) : link.textContent;
    return isi.replace(/\s+/g, ' ').trim();
  }

  function terapkanMini(mini) {
    document.documentElement.classList.toggle('sidebar-mini', mini);
    if (collapseBtn) {
      collapseBtn.textContent = mini ? '»' : '«';
      collapseBtn.setAttribute('aria-label', mini ? 'Perbesar menu' : 'Kecilkan menu');
      collapseBtn.title = mini ? 'Perbesar menu' : 'Kecilkan menu';
    }
    // Saat mini, teks menu tersembunyi → tampilkan sebagai tooltip.
    document.querySelectorAll('.sidebar .nav-link').forEach((link) => {
      link.title = mini ? teksMenu(link) : '';
    });
  }

  let mini = document.documentElement.classList.contains('sidebar-mini');
  terapkanMini(mini);

  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      mini = !document.documentElement.classList.contains('sidebar-mini');
      terapkanMini(mini);
      try { localStorage.setItem(KUNCI_MINI, mini ? '1' : '0'); } catch (e) { /* abaikan */ }
    });
  }

  // Konfirmasi aksi penting
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  // Salin nomor rekening / teks penting ke papan klip
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const teks = btn.dataset.copy || '';
      const asli = btn.textContent;
      try {
        await navigator.clipboard.writeText(teks);
        btn.textContent = 'Tersalin ✓';
      } catch (e) {
        btn.textContent = 'Gagal menyalin';
      }
      setTimeout(() => { btn.textContent = asli; }, 1600);
    });
  });

  // Tutup alert otomatis
  document.querySelectorAll('[data-flash]').forEach((el) => {
    const close = el.querySelector('.alert-close');
    if (close) close.addEventListener('click', () => el.remove());
    setTimeout(() => el.remove(), 7000);
  });

  // ---------- Layar loading ----------
  const appLoader = document.getElementById('appLoader');
  if (appLoader) {
    const KEY_SESI = 'tirtadesa_sudah_muat';
    const bacaSesi = (kunci) => {
      try { return sessionStorage.getItem(kunci) === '1'; } catch (e) { return false; }
    };
    const tulisSesi = (kunci) => {
      try { sessionStorage.setItem(kunci, '1'); } catch (e) { /* mode privat */ }
    };

    // Muat pertama dalam sesi tampil lebih lama agar tidak sekadar berkedip
    const minTampil = bacaSesi(KEY_SESI) ? 350 : 900;
    const mulai = Date.now();

    const sembunyikan = () => {
      const sisa = Math.max(0, minTampil - (Date.now() - mulai));
      setTimeout(() => {
        appLoader.classList.add('is-hidden');
        tulisSesi(KEY_SESI);
      }, sisa);
    };

    if (document.readyState === 'complete') sembunyikan();
    else window.addEventListener('load', sembunyikan, { once: true });

    // Pengaman bila ada aset yang gagal dimuat dan event load tidak pernah terjadi
    setTimeout(() => appLoader.classList.add('is-hidden'), 12000);

    let timerTampil = null;
    let timerTutup = null;
    const tutupPaksa = () => {
      clearTimeout(timerTampil);
      clearTimeout(timerTutup);
      appLoader.classList.add('is-hidden');
    };
    const tampilkan = () => {
      clearTimeout(timerTampil);
      clearTimeout(timerTutup);
      // Beri jeda singkat: navigasi yang instan tidak perlu memunculkan layar penuh
      timerTampil = setTimeout(() => {
        appLoader.classList.remove('is-hidden');
        // Jangan biarkan layar loading menggantung bila navigasi gagal,
        // dibatalkan, atau server tidak merespons.
        timerTutup = setTimeout(tutupPaksa, 8000);
      }, 180);
    };

    // Kembali dari cache (tombol Back) — pastikan overlay tidak tertinggal
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) tutupPaksa();
    });

    // Klik hanya memicu loading bila benar-benar menuju tautan lain.
    // Klik pada input/select di dalam form TIDAK boleh dianggap navigasi.
    const tautanAkanPindah = (target) => {
      const tautan = target.closest('a[href]');
      if (!tautan) return false;
      if ((tautan.target && tautan.target !== '_self') || tautan.hasAttribute('download')) return false;
      const href = tautan.getAttribute('href');
      if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return false;
      const tujuan = new URL(tautan.href, window.location.href);
      if (tujuan.origin !== window.location.origin) return false;
      return tujuan.href !== window.location.href;
    };

    const formAkanPindah = (form) => {
      if (!form) return false;
      if ((form.target && form.target !== '_self') || form.hasAttribute('data-no-loader')) return false;
      return true;
    };

    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (tautanAkanPindah(e.target)) tampilkan();
    });

    document.addEventListener('submit', (e) => {
      if (e.defaultPrevented || !e.target) return;
      if (formAkanPindah(e.target)) tampilkan();
    });
  }

  // ---------- Filter otomatis tanpa reload halaman ----------
  // Form filter (GET) langsung diterapkan saat pilihan/tanggal diubah, dan saat
  // berhenti mengetik 500 ms. Hasil diambil lewat fetch lalu hanya bagian
  // [data-hasil] yang diganti, dengan indikator proses kecil di pojok layar.
  function tampilkanProses() {
    let kotak = document.getElementById('prosesFilter');
    if (!kotak) {
      kotak = document.createElement('div');
      kotak.id = 'prosesFilter';
      kotak.className = 'proses-filter';
      kotak.innerHTML = '<span class="spinner"></span><span>Memuat data…</span>';
      document.body.appendChild(kotak);
    }
    kotak.classList.add('show');
  }

  function sembunyikanProses() {
    const kotak = document.getElementById('prosesFilter');
    if (kotak) kotak.classList.remove('show');
  }

  let permintaanFilter = null;

  async function terapkanFilter(form) {
    const url = new URL(form.getAttribute('action') || window.location.pathname, window.location.origin);
    new URLSearchParams(new FormData(form)).forEach((nilai, kunci) => {
      url.searchParams.set(kunci, nilai);
    });

    if (!document.querySelector('[data-hasil]') || typeof window.fetch !== 'function') {
      window.location.href = url.href;
      return;
    }

    if (permintaanFilter) permintaanFilter.abort();
    permintaanFilter = new AbortController();
    tampilkanProses();
    try {
      const res = await fetch(url.href, {
        headers: { 'X-Filter-Ajax': '1' },
        credentials: 'same-origin',
        signal: permintaanFilter.signal,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const teks = await res.text();
      const dokumenBaru = new DOMParser().parseFromString(teks, 'text/html');
      const bagianBaru = dokumenBaru.querySelectorAll('[data-hasil]');
      if (!bagianBaru.length) throw new Error('bagian hasil tidak ditemukan');
      bagianBaru.forEach((baru) => {
        const lama = document.querySelector(`[data-hasil="${baru.dataset.hasil}"]`);
        if (!lama) return;
        lama.innerHTML = baru.innerHTML;
        pasangModal(lama);
        pasangFilter(lama);
      });
      history.replaceState({}, '', url.href);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // Gagal mengambil sebagian data → kembali ke cara biasa.
      window.location.href = url.href;
      return;
    } finally {
      sembunyikanProses();
    }
  }

  function pasangFilter(root) {
    root.querySelectorAll('form.filters').forEach((form) => {
      if (form.dataset.filterTerpasang === '1') return;
      form.dataset.filterTerpasang = '1';
      if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') return;

      const kirim = () => terapkanFilter(form);
      form.querySelectorAll('select').forEach((el) => {
        el.addEventListener('change', kirim);
      });
      form.querySelectorAll('input[type="date"], input[type="month"], input[type="number"]').forEach((el) => {
        el.addEventListener('change', kirim);
      });
      form.querySelectorAll('input:not([type]), input[type="text"], input[type="search"]').forEach((el) => {
        let timer = null;
        el.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(kirim, 500);
        });
      });
      // Tombol Filter/Reset tetap berfungsi normal.
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (permintaanFilter) permintaanFilter.abort();
        terapkanFilter(form);
      });
    });
  }

  // ---------- Modal popup ----------
  function bukaModal(id) {
    const dlg = document.getElementById(id);
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');

    // Fokuskan isian pertama agar langsung bisa diketik
    const pertama = dlg.querySelector('input:not([type="hidden"]), select, textarea');
    if (pertama) setTimeout(() => pertama.focus(), 60);
  }

  function pasangModal(root) {
    root.querySelectorAll('[data-modal-open]').forEach((btn) => {
      if (btn.dataset.modalTerpasang === '1') return;
      btn.dataset.modalTerpasang = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        bukaModal(btn.dataset.modalOpen);
      });
    });

    root.querySelectorAll('dialog.modal').forEach((dlg) => {
      if (dlg.dataset.modalTerpasang === '1') return;
      dlg.dataset.modalTerpasang = '1';
      dlg.querySelectorAll('[data-modal-close]').forEach((btn) => {
        btn.addEventListener('click', () => dlg.close());
      });

      // Klik area gelap di luar kartu (atau tombol Esc) hanya menutup popup bila
      // belum ada isian yang diubah. Ini mencegah data yang sudah diketik hilang
      // gara-gara salah klik di luar popup.
      const isianForm = () => [...dlg.querySelectorAll('form input, form select, form textarea')]
        .filter((el) => !['hidden', 'submit', 'button', 'reset'].includes(el.type));
      const nilaiDari = (el) => (
        el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value
      );
      let nilaiAwal = null;
      dlg.addEventListener('toggle', () => {
        nilaiAwal = dlg.open
          ? new Map(isianForm().map((el) => [el, nilaiDari(el)]))
          : null;
      });
      const adaPerubahan = () => {
        if (!nilaiAwal) return false;
        return isianForm().some((el) => {
          if (el.type === 'file') return el.files.length > 0;
          return nilaiAwal.has(el) && nilaiAwal.get(el) !== nilaiDari(el);
        });
      };
      dlg._isianBerubah = adaPerubahan;
      dlg.addEventListener('click', (e) => {
        if (e.target !== dlg) return;
        // Popup berisi formulir tidak ditutup lewat klik area gelap
        // (penutupan lewat tombol × atau Batal), tanpa menampilkan notifikasi.
        if (dlg.querySelector('form')) return;
        dlg.close();
      });
    });
  }

  pasangFilter(document);
  pasangModal(document);

  // Buka popup otomatis bila diminta lewat URL (mis. /pasang?buka=modalPasang),
  // dipakai untuk tautan lama /pelanggan/baru atau pintasan dari menu lain.
  (function bukaDariUrl() {
    const id = new URLSearchParams(window.location.search).get('buka');
    if (id) bukaModal(id);
  })();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const dlg = document.querySelector('dialog.modal[open]');
    if (!dlg) return;
    e.preventDefault();
    if (typeof dlg._isianBerubah === 'function' && dlg._isianBerubah()) return;
    dlg.close();
  });

  // ---------- Jenis pendaftaran & dropdown wilayah (form gabung) ----------
  const API_WILAYAH = 'https://www.emsifa.com/api-wilayah-indonesia/api';
  const jenisRadios = document.querySelectorAll('input[name="jenis"]');
  const panelJenis = document.querySelectorAll('[data-jenis-panel]');
  const widgetWilayah = [];
  const terapkanSemuaWilayah = () => widgetWilayah.forEach((w) => w.terapkan());

  function isiWilayah(select, data, placeholder) {
    select.innerHTML = '';
    const kosong = document.createElement('option');
    kosong.value = '';
    kosong.textContent = placeholder;
    select.appendChild(kosong);
    data.forEach((item) => {
      const opt = document.createElement('option');
      opt.value = item.name;
      opt.dataset.id = item.id;
      opt.textContent = item.name;
      select.appendChild(opt);
    });
    select.dataset.siap = '1';
    select.disabled = false;
  }

  function kosongkanWilayah(select, placeholder) {
    select.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    select.appendChild(opt);
    delete select.dataset.siap;
    select.disabled = true;
  }

  async function ambilWilayah(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Gagal memuat wilayah');
    return res.json();
  }

  /**
   * Siapkan satu widget wilayah (dipakai untuk pendaftaran Desa maupun Dusun).
   * Mengembalikan kendali agar pemanggil bisa mengisi provinsi & menandai gagal.
   */
  function siapkanWilayah(widget) {
    const panel = widget.closest('[data-jenis-panel]');
    const kotakDropdown = widget.querySelector('.wilayah-dropdown');
    const kotakManual = widget.querySelector('.wilayah-manual');
    const tombol = widget.querySelector('.wilayah-toggle');
    const status = widget.querySelector('.wilayah-status');
    const el = {};
    widget.querySelectorAll('[data-wilayah-level]').forEach((s) => {
      el[s.dataset.wilayahLevel] = s;
    });
    const { provinsi, kabupaten, kecamatan, desa } = el;
    if (!provinsi || !kabupaten || !kecamatan || !desa || !kotakDropdown || !kotakManual) return null;

    function terapkan() {
      const aktif = !panel || !panel.hidden;
      const manual = !kotakManual.hidden;
      kotakDropdown.hidden = manual;
      [provinsi, kabupaten, kecamatan, desa].forEach((s) => {
        const siap = s === provinsi || s.dataset.siap === '1';
        s.disabled = !aktif || manual || !siap;
      });
      kotakManual.querySelectorAll('input, select, textarea').forEach((i) => {
        i.disabled = !aktif || !manual;
      });
      kotakDropdown.querySelectorAll('[data-required]').forEach((i) => {
        i.required = aktif && !manual;
      });
      kotakManual.querySelectorAll('[data-required]').forEach((i) => {
        i.required = aktif && manual;
      });
      if (tombol) tombol.textContent = manual ? 'Gunakan pilihan wilayah' : 'Isi manual';
    }

    function aktifkanManual(pesan) {
      kotakManual.hidden = false;
      kotakDropdown.hidden = true;
      if (status) status.textContent = pesan;
      terapkan();
    }

    provinsi.addEventListener('change', async () => {
      kosongkanWilayah(kabupaten, 'Pilih provinsi dulu');
      kosongkanWilayah(kecamatan, 'Pilih kabupaten dulu');
      kosongkanWilayah(desa, 'Pilih kecamatan dulu');
      terapkan();
      const id = provinsi.selectedOptions[0]?.dataset.id;
      if (!id) return;
      kabupaten.innerHTML = '<option>Memuat…</option>';
      try {
        isiWilayah(kabupaten, await ambilWilayah(`${API_WILAYAH}/regencies/${id}.json`), '— Pilih kabupaten/kota —');
      } catch (e) {
        kosongkanWilayah(kabupaten, 'Pilih provinsi dulu');
        aktifkanManual('Gagal memuat kabupaten/kota. Silakan isi manual.');
        return;
      }
      terapkan();
    });

    kabupaten.addEventListener('change', async () => {
      kosongkanWilayah(kecamatan, 'Pilih kabupaten dulu');
      kosongkanWilayah(desa, 'Pilih kecamatan dulu');
      terapkan();
      const id = kabupaten.selectedOptions[0]?.dataset.id;
      if (!id) return;
      kecamatan.innerHTML = '<option>Memuat…</option>';
      try {
        isiWilayah(kecamatan, await ambilWilayah(`${API_WILAYAH}/districts/${id}.json`), '— Pilih kecamatan —');
      } catch (e) {
        kosongkanWilayah(kecamatan, 'Pilih kabupaten dulu');
        aktifkanManual('Gagal memuat kecamatan. Silakan isi manual.');
        return;
      }
      terapkan();
    });

    kecamatan.addEventListener('change', async () => {
      kosongkanWilayah(desa, 'Pilih kecamatan dulu');
      terapkan();
      const id = kecamatan.selectedOptions[0]?.dataset.id;
      if (!id) return;
      desa.innerHTML = '<option>Memuat…</option>';
      try {
        isiWilayah(desa, await ambilWilayah(`${API_WILAYAH}/villages/${id}.json`), '— Pilih desa/kelurahan —');
      } catch (e) {
        kosongkanWilayah(desa, 'Pilih kecamatan dulu');
        aktifkanManual('Gagal memuat desa/kelurahan. Silakan isi manual.');
        return;
      }
      terapkan();
    });

    if (tombol) {
      tombol.addEventListener('click', () => {
        const keManual = kotakManual.hidden;
        if (keManual) {
          [['provinsi', provinsi], ['kabupaten', kabupaten], ['kecamatan', kecamatan], ['desa', desa]]
            .forEach(([kunci, sumber]) => {
              const target = kotakManual.querySelector(`[data-manual="${kunci}"]`);
              if (target && sumber && sumber.value) target.value = sumber.value;
            });
        }
        kotakManual.hidden = !keManual;
        kotakDropdown.hidden = keManual;
        terapkan();
      });
    }

    return {
      terapkan,
      isiProvinsi(data) {
        isiWilayah(provinsi, data, '— Pilih provinsi —');
        if (status) status.textContent = 'Pilih provinsi, lalu kabupaten/kota, kecamatan, dan desa/kelurahan.';
        terapkan();
      },
      gagal() {
        aktifkanManual('Data wilayah tidak dapat dimuat (butuh internet). Silakan isi manual.');
      },
    };
  }

  document.querySelectorAll('[data-wilayah]').forEach((widget) => {
    const kendali = siapkanWilayah(widget);
    if (kendali) widgetWilayah.push(kendali);
  });

  if (jenisRadios.length) {
    const aturJenis = () => {
      const aktif = [...jenisRadios].find((r) => r.checked)?.value;
      panelJenis.forEach((panel) => {
        const tampil = panel.dataset.jenisPanel === aktif;
        panel.hidden = !tampil;
        panel.querySelectorAll('[data-required]').forEach((el) => {
          el.required = tampil;
        });
        // Kolom wilayah diatur oleh widget (punya aturan sendiri).
        panel.querySelectorAll('input, select, textarea').forEach((el) => {
          if (el.closest('[data-wilayah]')) return;
          el.disabled = !tampil;
        });
      });
      terapkanSemuaWilayah();
      document.querySelectorAll('.join-type').forEach((label) => {
        const radio = label.querySelector('input[name="jenis"]');
        label.classList.toggle('aktif', Boolean(radio && radio.checked));
      });
    };
    jenisRadios.forEach((r) => r.addEventListener('change', aturJenis));
    aturJenis();
  }

  // Muat daftar provinsi sekali untuk semua widget (desa & dusun).
  if (widgetWilayah.length) {
    (async () => {
      try {
        const data = await ambilWilayah(`${API_WILAYAH}/provinces.json`);
        widgetWilayah.forEach((w) => w.isiProvinsi(data));
      } catch (e) {
        widgetWilayah.forEach((w) => w.gagal());
      }
    })();
  }

  // ---------- Tampilkan / sembunyikan password ----------
  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.togglePassword);
      if (!input) return;
      const tampil = input.type === 'password';
      input.type = tampil ? 'text' : 'password';
      btn.textContent = tampil ? '🙈' : '👁';
      btn.setAttribute('aria-label', tampil ? 'Sembunyikan password' : 'Tampilkan password');
      input.focus();
    });
  });

  // ---------- Isi otomatis akun demo ----------
  document.querySelectorAll('[data-demo-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const username = document.getElementById('username');
      const password = document.getElementById('password');
      if (!username || !password) return;
      username.value = btn.dataset.demoUser || '';
      password.value = btn.dataset.demoPass || '';
      password.focus();
    });
  });

  // ---------- Ingat saya: simpan username (bukan password) ----------
  const formLogin = document.querySelector('form.login-form');
  const inputUsername = document.getElementById('username');
  const inputPassword = document.getElementById('password');
  const cekIngat = document.getElementById('ingat');
  const KUNCI_USER = 'tirtadesa_username';

  if (formLogin && inputUsername && cekIngat) {
    try {
      const tersimpan = localStorage.getItem(KUNCI_USER);
      if (tersimpan && !inputUsername.value) {
        inputUsername.value = tersimpan;
        cekIngat.checked = true;
        if (inputPassword) setTimeout(() => inputPassword.focus(), 80);
      }
    } catch (e) { /* localStorage diblokir */ }

    formLogin.addEventListener('submit', () => {
      try {
        if (cekIngat.checked) localStorage.setItem(KUNCI_USER, inputUsername.value.trim());
        else localStorage.removeItem(KUNCI_USER);
      } catch (e) { /* abaikan */ }

      // Serahkan penyimpanan password ke password manager browser (bukan ke localStorage).
      if (cekIngat.checked && inputPassword && window.PasswordCredential && navigator.credentials) {
        try {
          const kredensial = new PasswordCredential({
            id: inputUsername.value.trim(),
            name: inputUsername.value.trim(),
            password: inputPassword.value,
          });
          navigator.credentials.store(kredensial).catch(() => {});
        } catch (e) { /* tidak didukung */ }
      }
    });
  }

  // Filter pilihan sumur berdasarkan dusun pada form pelanggan
  const dusunSel = document.getElementById('dusun_id');
  const sumurSel = document.getElementById('sumur_id');
  if (dusunSel && sumurSel) {
    const opsiAsli = [...sumurSel.options].map((o) => ({
      value: o.value,
      text: o.textContent,
      dusun: o.dataset.dusun,
    }));
    const terpilih = sumurSel.dataset.selected || sumurSel.value;
    const susunUlang = () => {
      const dusun = dusunSel.value;
      sumurSel.innerHTML = '';
      opsiAsli.forEach((o) => {
        if (!o.value || !dusun || o.dusun === dusun || o.dusun === undefined) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.text;
          opt.dataset.dusun = o.dusun || '';
          sumurSel.appendChild(opt);
        }
      });
      if (terpilih) sumurSel.value = terpilih;
    };
    dusunSel.addEventListener('change', susunUlang);
    susunUlang();
  }

  // Pratinjau pemakaian pada form baca meter
  const lalu = document.getElementById('angka_lalu');
  const kini = document.getElementById('angka_kini');
  const preview = document.getElementById('pemakaian_preview');
  if (lalu && kini && preview) {
    const hitung = () => {
      const a = parseFloat(lalu.value) || 0;
      const b = parseFloat(kini.value) || 0;
      const hasil = Math.max(0, b - a);
      preview.textContent = `${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(hasil)} m³`;
    };
    lalu.addEventListener('input', hitung);
    kini.addEventListener('input', hitung);
    hitung();
  }
})();

// ---------- Mode terang / gelap ----------
// Pilihan disimpan di localStorage dan diterapkan sebelum halaman digambar
// lewat partial `partials/tema` (agar tidak berkedip).
(() => {
  const KUNCI = 'tirtadesa_tema';
  const akar = document.documentElement;
  const tombol = document.querySelectorAll('[data-tema-toggle]');
  const gelap = () => akar.getAttribute('data-tema') === 'gelap';

  const perbaruiTombol = () => {
    tombol.forEach((btn) => {
      btn.textContent = gelap() ? '☀️' : '🌙';
      const label = gelap() ? 'Mode terang' : 'Mode gelap';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.setAttribute('aria-pressed', gelap() ? 'true' : 'false');
    });
  };

  tombol.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (gelap()) akar.removeAttribute('data-tema');
      else akar.setAttribute('data-tema', 'gelap');
      try {
        localStorage.setItem(KUNCI, gelap() ? 'gelap' : 'terang');
      } catch (e) {
        // localStorage diblokir: tema tetap berlaku untuk halaman ini.
      }
      perbaruiTombol();
    });
  });

  perbaruiTombol();
})();
