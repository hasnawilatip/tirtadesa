# TirtaDesa

Aplikasi **pengelolaan sumur bor** untuk pengelola air perumahan, dusun, kos, dan kawasan usaha. Catat meter pelanggan, terbitkan tagihan, catat pembayaran, dan pantau produksi air tiap sumur bor dari satu dashboard.

Pengelola baru dapat mendaftar lewat halaman publik **`/gabung`**; superadmin menindaklanjuti pendaftaran tersebut dari panel aplikasi.

![Stack](https://img.shields.io/badge/Node.js-20-3c873a) ![Express](https://img.shields.io/badge/Express-4-000000) ![SQLite](https://img.shields.io/badge/SQLite-3-07405e)

## Ringkasan fitur

- Login dengan 6 peran: superadmin, admin desa, admin dusun, petugas catat, kasir, dan **warga (pelanggan)**.
- **Portal warga**: akun warga ditautkan ke satu pelanggan (dipilih saat admin membuat akun di menu *Pengguna*). Warga hanya melihat **Ringkasan, Tagihan Saya (+ cetak struk & tombol Bayar online), Pemakaian, dan Keluhan** untuk dirinya sendiri; halaman operator otomatis dialihkan ke `/warga`. Akun demo: `warga / warga123`.
- **Buat akun warga dari data pelanggan**: menu **Pelanggan** punya tombol **Buat akun** di setiap baris pelanggan yang belum punya akun (username disarankan dari nomor pelanggan, kata sandi boleh dikosongkan → acak 6 karakter, ditampilkan sekali setelah dibuat). Saat menambah pelanggan baru, tersedia centang **Buatkan akun warga otomatis** yang langsung membuatkan akun dan menampilkan kredensialnya.
- **Pembayaran online warga (kanal disediakan superadmin)**: superadmin mengatur **saluran pembayaran** di menu **Pembayaran Online** — **transfer bank** (nomor rekening + atas nama), **QRIS** (unggah gambar QR), atau **link pembayaran** milik gateway/penyedia (mis. `https://pay.contoh.com/checkout?ref={kode}&amount={total}` dengan placeholder `{kode} {total} {tagihan} {pelanggan}`) — beserta instruksi, urutan tampil, status aktif, dan sakelar layanan global + catatan untuk warga. Di portal warga, setiap tagihan yang belum lunas punya tombol **Bayar**: warga memilih metode, diarahkan ke **rekening/QRIS/halaman pembayaran** yang disiapkan superadmin, lalu menekan *Lanjutkan pembayaran* sehingga terbit **kode referensi** (`BYR-2026-00001`) dan halaman instruksi + **unggah bukti** (gambar/PDF maks. 2 MB). Permintaan berstatus *Menunggu verifikasi* tampil di menu **Pembayaran Online** milik kasir/admin desa/dusun; satu klik **Verifikasi** membuat **kwitansi resmi** dan memperbarui status tagihan otomatis (atau **Tolak** dengan alasan yang tampil ke warga). Uji cepat: `node scripts/uji-bayar-online.js` (24 pemeriksaan).
- **Pendaftaran pengelola sumur bor** dengan pilihan jenis **Desa, Dusun, atau Individu/Usaha** — form menyesuaikan jenis. **Ketiga jenis** memakai dropdown bertingkat **Provinsi → Kabupaten/Kota → Kecamatan → Desa/Kelurahan** (data dari emsifa.com, dengan opsi isi manual bila offline); pada jenis Dusun kolom desa/kelurahan berfungsi sebagai **Desa induk** (nama dusun diisi terpisah), sedangkan pada jenis Individu/Usaha wilayah tersebut menjadi **alamat usaha**. Wilayah wajib lengkap — pendaftaran yang tidak memilih wilayah ditolak.
- **Dashboard ringkas & menarik**: kartu sapaan (hero) dengan ringkasan utama, kartu KPI berikon berwarna, serta aksi cepat ke menu yang sering dipakai — tersedia untuk superadmin maupun admin/pengelola. **Tampilan ponsel dioptimalkan** untuk admin & kasir: KPI dan aksi cepat 2 kolom, tombol berukuran sentuh, daftar tagihan menyembunyikan kolom kurang penting dengan kolom **Aksi (Bayar/Cetak) tetap terlihat**, dan tombol utama menyesuaikan peran (kasir mendapat pintasan *Tagihan & pembayaran*).
- **Sidebar bisa dikecilkan**: tombol `«` pada topbar menyusutkan menu menjadi rail ikon (tersimpan di browser, ada tooltip), dan otomatis menjadi drawer di layar HP.
- **Login aman & nyaman**: ingat saya (30 hari), tampilkan/sembunyikan password, lupa password dengan permintaan ke admin, rate limiting 5 percobaan/15 menit, serta akun demo yang bisa diklik (otomatis disembunyikan saat `NODE_ENV=production`).
- **Catat meter cepat (popup)**: di halaman Baca Meter, tombol **＋ Catat meter** membuka popup — pilih pelanggan lewat dropdown yang bisa dicari, angka meter lalu & data sambungan tampil otomatis, masukkan angka baru (pemakaian dihitung langsung), lalu simpan draf atau ajukan verifikasi.
- **Pencarian tagihan lewat nomor meter**: di halaman Tagihan, kolom pencarian mencari **nomor meter** lebih dulu (juga **nomor seri meter**, nama & nomor pelanggan). Cukup ketik sebagian nomor meter/seri → muncul saran pelanggan (meter · nama · nomor · dusun · SN seri); klik salah satu untuk menampilkan semua tagihan pelanggan itu tanpa perlu tahu namanya. Kata kunci juga bisa langsung di-Enter. Pencarian yang sama berlaku di daftar pelanggan.
- **Cetak struk tagihan**: tombol **Cetak** di daftar tagihan (dan di halaman detail) membuka lembar struk siap cetak berisi **logo, nama desa/usaha, dan pelaku usaha** (dari Profil Pengelola) beserta wilayah & kontak, data pelanggan, rincian biaya, total, sisa, serta riwayat pembayaran — lengkap dengan tombol *Cetak struk* (print). Kwitansi pembayaran memakai identitas yang sama. Kolom aksi daftar tagihan menyesuaikan status: **Bayar** (popup pencatatan pembayaran) untuk tagihan belum lunas, dan **Cetak** untuk tagihan yang sudah lunas.
- **Filter otomatis tanpa reload**: semua form filter (pelanggan, tagihan, sumur, keluhan, laporan, produksi, baca meter) langsung diterapkan begitu pilihan dropdown/tanggal diubah — kolom pencarian otomatis jalan setelah berhenti mengetik 0,5 detik. Hasil diambil lewat fetch dan hanya bagian hasil (termasuk ringkasan & tombol aksi) yang diganti, sambil menampilkan indikator **“Memuat data…”** di pojok layar. Tombol *Filter* tetap berfungsi sebagai cadangan.
- **Verifikasi massal**: di halaman Verifikasi, centang beberapa pembacaan (atau *pilih semua*) lalu aksi massal menyesuaikan tab: **Ajukan terpilih** (Draf/Ditolak) atau **Setujui/Tolak terpilih** (Diajukan).
- **Alur pasang baru (petugas → admin → gudang)**: menu **Pasang Baru** mencatat calon pelanggan (nama, alamat, dusun, sumur, golongan, jumlah penghuni) lewat **popup formulir** (tombol **+ Pendaftaran baru**), sekaligus **perhitungan pipa & bahan**: ukuran pipa dinas, panjang pipa (meter, otomatis disarankan jadi batang 4 m), kedalaman tapping, rincian bahan dengan sisa stok & harga, serta biaya jasa sehingga total perkiraan biaya langsung tampil. Baris bahan bisa ditambah lewat tombol **＋ Tambah baris bahan** (tombol di kepala tabel juga tersedia) dan **baris kosong baru muncul otomatis** begitu baris terakhir dipakai; di ponsel tabel bahan berubah menjadi kartu bertumpuk agar kolom jumlah/harga tidak perlu digeser. Petugas menyimpan **draf** atau langsung **mengajukan**; admin desa/dusun memeriksa lalu **menyetujui** (stok gudang otomatis dikurangi dan tercatat di mutasi bahan) atau **menolak** dengan alasan yang tampil kembali ke petugas. Setelah pemasangan selesai, admin/petugas menandai **selesai terpasang** (memilih **golongan tarif** wajib + sumur sumber bila belum ditentukan) dan sistem otomatis membuat **nomor pelanggan + nomor meter** beserta data sambungan (seri, merk, tipe). Pembatalan pendaftaran yang sudah disetujui **mengembalikan stok** ke gudang. Nomor pendaftaran (`PSR-000001`) dibuat otomatis.
- **Gudang bahan**: menu **Gudang Bahan** menampilkan stok material siap pakai (pipa, fitting, meter air, aksesoris, alat) beserta nilai stok, penanda **menipis/habis** dibanding stok minimum, filter kategori & kondisi, serta riwayat mutasi per bahan. Admin desa/dusun dapat menambah bahan (kode otomatis), mengubah data, mencatat **barang masuk**, dan **koreksi stok opname**; petugas & kasir hanya melihat stok. Setiap pengelola baru otomatis mendapat daftar bahan standar.
- **Pembelian bahan (pengadaan & pengeluaran)**: saat stok kosong/menipis admin menekan **Beli** pada bahan atau **Buat pembelian stok menipis** (isian jumlah otomatis disarankan) — keduanya membuka **popup pembelian** di menu **Pembelian Bahan** dengan tanggal, supplier/toko, metode (tunai/transfer/kredit), rincian bahan dengan **jumlah & harga satuan sesuai nota**, dan total otomatis. Nota bisa disimpan sebagai **draf** (belum mengubah stok) atau **langsung diterima**. Saat barang **diterima**, sistem menambah stok, menulis mutasi gudang dengan referensi nomor nota (`PB-000001`), dan memperbarui harga satuan bahan ke harga pembelian terakhir. Nota draf bisa diubah/dibatalkan/dihapus; nota yang sudah diterima tidak bisa dihapus. Total pembelian yang diterima otomatis muncul di **Laporan** pada kartu **Pengeluaran bahan <bulan periode>** beserta **sisa kas setelah pembelian**. Kasir dapat melihat daftar/nota (read-only), petugas tidak memiliki akses ke menu pembelian.
- **Periode tagihan otomatis**: periode bulan berjalan dibuat sendiri saat admin pengelola masuk (dashboard/periode) bila tidak ada periode lain yang terbuka; jatuh tempo bawaan **tanggal 20 bulan berikutnya** (form *Buka periode baru* mengikuti otomatis saat bulan/tahun diganti). **Tanggal terbit tagihan otomatis tanggal 21 bulan periode** (atau tanggal hari ini bila diterbitkan sebelum tanggal 21, sehingga tidak ada tagihan bertanggal masa depan). Jika periode bulan lalu masih terbuka, muncul peringatan + tombol **Tutup sekarang** lalu periode baru dibuat otomatis.
- **Kepegawaian & penggajian karyawan**: menu **Karyawan** mencatat data karyawan (nomor otomatis `KRY-0001`, NIK, jabatan, dusun, tanggal masuk/keluar, rekening) beserta komponen gaji — **gaji pokok, tunjangan tetap, potongan tetap, tarif lembur, dan potongan harian alpa**. **Absensi** mencatat kehadiran harian (hadir/izin/sakit/cuti/alpa/libur, jam masuk-keluar, jam lembur) dengan **isi cepat** untuk menandai semua karyawan pada satu tanggal. Menu **Penggajian** membuat slip draf sebulan sekali untuk seluruh karyawan aktif: upah lembur dihitung dari jam absensi, potongan alpa dari jumlah hari alpa (bila potongan harian 0 dipakai gaji pokok ÷ 25), dan **kasbon dipotong maksimal 50% gaji bersih**. Slip dapat **dihitung ulang** selama masih draf, **dicetak** dengan identitas desa/usaha, lalu ditandai **dibayar**. Menu **Kasbon** mencatat pinjaman karyawan (`KSB-0001`), cicilan manual, dan pembatalan. Gaji yang sudah dibayar otomatis muncul di **Laporan** pada kartu **Gaji karyawan <bulan periode>** beserta **sisa kas setelah pembelian & gaji**. Hanya admin desa dan admin dusun yang dapat mengakses menu ini; admin dusun dibatasi pada karyawan dusunnya. Uji regresi: `node scripts/uji-penggajian.js`.
- **Pelanggan hanya lahir dari pendaftaran pasang baru**: halaman Pelanggan tidak lagi punya form tambah langsung — tombol **+ Pasang pelanggan baru** membuka **popup** pendaftaran pasang baru (di halaman Pasang Baru), dan alamat lama `/pelanggan/baru` otomatis dialihkan ke sana. Data pelanggan baru beserta nomor pelanggan, nomor meter, dan sambungan dibuat sistem saat pendaftaran ditandai **selesai terpasang**. Perubahan data pelanggan tetap lewat tombol **Edit data** di halaman detail.
- **Kode dibuat otomatis**: dusun (`D01`), sumur (`SB-01`, urut per dusun), golongan tarif (`G1`), nomor pelanggan (`D01-0001`, urut per dusun), nomor meter (`MTR-000001`, urut global), dan nomor pendaftaran (`PSR-000001`) dibuat sistem. Saat **Edit data** pelanggan, nomor meter bersifat read-only dan hanya berubah lewat tombol **Ganti meter** di halaman detail.
- **Identitas meter fisik & ganti meter**: form ubah pelanggan mencatat **nomor seri pabrik**, **merk**, dan **tipe** meter di samping nomor meter & ukuran sambungan. Halaman detail pelanggan menampilkan seri/merk/tipe, tombol **Ganti meter** (khusus admin desa/dusun), dan tabel **Riwayat meter**: meter lama otomatis berstatus *Diganti* beserta tanggal lepas & alasan, sedangkan meter pengganti mendapat nomor meter baru (`MTR-…`) dari sistem. Nomor seri ikut ditampilkan di daftar pelanggan dan bisa dipakai sebagai kata kunci pencarian.
- **Formulir tambah data memakai popup** (pengguna, dusun, sumur, tarif, periode, produksi, keluhan, pembayaran, pendaftaran pasang baru, dan pembelian bahan). Popup berisi formulir **tidak tertutup karena klik di area gelap** (tanpa notifikasi) — penutupan lewat tombol **×/Batal**, atau Esc bila belum ada isian diubah — sehingga data tidak hilang karena salah klik. Tautan lama seperti `/pasang/baru` dan `/pembelian/baru` otomatis diarahkan ke halaman daftar dengan popup terbuka (`?buka=...`). URL aset (`app.js`, `style.css`) memakai versi otomatis agar browser selalu memuat skrip terbaru.
- **Branding per pengelola**: menu **Profil Pengelola** (URL `/profil-pengelola`, alias lama `/profil-desa`) menyimpan nama desa/dusun/usaha, **pelaku usaha (penanggung jawab)**, kecamatan, kabupaten, alamat, telepon, dan **logo usaha sendiri** (PNG/JPG/WebP maks. 2 MB). Halaman ini menyesuaikan jenis ruang kerja: **desa**, **dusun mandiri**, atau **individu/usaha**. Admin desa selalu dapat membuka; **admin dusun hanya dapat membuka bila ruang kerjanya terdaftar sebagai dusun mandiri** (bukan admin dusun di dalam desa). Logo ini dipakai di sidebar, struk tagihan, dan kwitansi; bila belum diunggah, otomatis memakai logo aplikasi.
- **Pengaturan branding aplikasi**: superadmin dapat mengganti nama aplikasi, tagline, dan unggah logo aplikasi (dipakai di halaman masuk, beranda, serta sebagai cadangan bila pengelola belum punya logo sendiri).
- **Panel superadmin**: menindaklanjuti pendaftaran pengelola dan mendaftarkan **akun admin** (superadmin, admin desa, admin dusun). Superadmin tidak mengelola data operasional maupun akun staf.
- **Paket langganan komersial (harga & kuota)**: menu **Paket Langganan** mengelola paket (nama, kode, harga per bulan, **batas pelanggan / sumur / dusun**, aktif/nonaktif, urutan) lewat popup — batas **0 = tanpa batas**. Paket awal: Demo (Rp 0), Starter (100 pelanggan · 2 sumur · 1 dusun), Growth (500 · 5 · 5), Bisnis (2.000 · 15 · 20), Enterprise (tanpa batas).
- **Pendaftar memilih paket**: formulir publik `/gabung` menampilkan kartu paket (harga + batas) dan wajib memilih satu. Pilihan tersimpan pada pendaftaran, tampil di panel **Pendaftaran**, lalu dipakai saat superadmin membuat akun — beserta **masa aktif awal 30 hari**. Beranda publik (`/`) memuat bagian **Paket langganan** (harga per bulan, batas pelanggan/sumur/dusun, deskripsi, dan tombol *Pilih paket* yang langsung membuka `/gabung?paket=<id>` dengan pilihan sudah terisi); paket diambil dari menu **Paket Langganan** sehingga perubahan harga langsung tampil di beranda.
- **Kelola langganan per pengelola**: menu **Langganan Pengelola** menampilkan paket, pemakaian kuota (pelanggan/sumur/dusun), sisa masa aktif, dan status per tenant. Superadmin dapat mengganti paket, menetapkan status (aktif/trial/ditangguhkan), mengubah tanggal berakhir, dan memilih **Masa aktif**: **mulai siklus baru 1 bulan dari hari ini**, **pertahankan tanggal berakhir**, atau **perpanjang +1/+3/+6/+12 bulan** — semuanya dari popup. Nama ruang kerja mengikuti identitas pendaftar: jenis **Desa/Dusun** memakai nama wilayah ("Desa X"), sedangkan **Individu/Usaha** memakai **nama usaha** yang diisi di formulir. Ruang kerja yang **belum berisi data operasional** dapat dihapus lewat tombol **Hapus** (berguna membatalkan pendaftaran ganda) — ruang kerja yang sudah punya pelanggan/tagihan/sumur tidak bisa dihapus, hanya dinonaktifkan. Uji regresi: `node scripts/uji-hapus-tenant.js`.
- **Harga paket dihitung per bulan**: masa aktif awal adalah **satu bulan**, bukan satu tahun. Mengganti paket otomatis memulai siklus baru 1 bulan dari hari ini (kecuali mode *pertahankan tanggal berakhir* dipilih saat paket tidak berubah). Pengelola lama yang belum punya paket, serta siklus lama yang pernah dibuat 1 tahun, diselaraskan otomatis ke siklus bulanan saat aplikasi dijalankan — perpanjangan manual tidak ikut diubah.
- **Kuota ditegakkan**: penambahan **sumur**, **dusun**, dan pembuatan **pelanggan** (saat pemasangan ditandai selesai) ditolak dengan pesan jelas bila batas paket tercapai. **Mengaktifkan kembali pelanggan yang nonaktif juga diperiksa**, sehingga batas paket tidak bisa dilewati lewat strategi *nonaktifkan → tambah → aktifkan lagi*. Dashboard tiap pengelola menampilkan kartu **Langganan & kuota** (bar pemakaian yang berubah merah saat penuh), dan superadmin melihat **pendapatan berjalan** dari paket pengelola aktif. **Peringatan kuota tidak ditampilkan menetap** — pesan seperti *“Kuota dusun paket Demo sudah penuh (1/1)”* hanya muncul saat admin benar-benar mencoba menambah dusun/sumur/pelanggan melebihi paket. Audit cepat: `node scripts/cek-kuota.js` (menampilkan pemakaian vs batas tiap pengelola, menandai yang melebihi); uji regresi: `node scripts/uji-kuota.js` (11 pemeriksaan: pelanggan ke-2 ditolak, aktivasi ulang ditolak saat penuh, sumur & dusun ditolak, kuota naik → boleh menambah).
- **Menu Langganan untuk admin desa/dusun**: halaman `/langganan` (menu sidebar **Langganan**) merangkum paket yang dipakai, harga per bulan, tanggal mulai/berakhir, sisa masa aktif, status langganan, pemakaian kuota pelanggan/sumur/dusun (bar + tabel terpakai/batas/sisa), peringatan bila masa aktif hampir habis atau status langganan bukan aktif, cara memperpanjang/menambah paket, serta daftar paket lain beserta harganya. Petugas dan kasir tidak memiliki akses ke halaman ini.
- **Tagihan langganan + tombol Bayar**: sistem otomatis membuat tagihan iuran **satu siklus ke depan** (nomor `LGN/2026/00001`, periode = akhir masa aktif → +1 bulan, nominal = harga paket) setiap kali belum ada tagihan terbuka. Tombol **Bayar sekarang** muncul di menu Langganan **hanya bila tagihan berstatus belum dibayar dan saluran pembayaran dari superadmin tersedia**; sesudah dibayar tombol berubah jadi *Lihat status / unggah bukti*. Halaman tagihan menyediakan rekening/QRIS/link pembayaran, unggah bukti (gambar/PDF maks. 2 MB), dan riwayat 6 tagihan terakhir. Superadmin memverifikasi di menu **Langganan Pengelola** → tagihan lunas, **masa aktif bertambah 1 bulan**, status *ditangguhkan* otomatis kembali *aktif*, dan tagihan siklus berikutnya langsung dibuat; bukti yang tidak sesuai dapat **ditolak** (kembali ke belum dibayar beserta alasannya). Perpanjangan manual oleh superadmin otomatis membatalkan tagihan terbuka yang belum dibayar agar tidak terjadi tagihan ganda. Uji cepat: `node scripts/uji-langganan-tagihan.js` (16 pemeriksaan).
- **Satu pengelola = satu ruang kerja**: setiap akun dari pendaftaran mendapat data desa sendiri (kosong) beserta satu dusun, tarif awal Rumah Tangga, dan **gudang bahan standar**. Seluruh query dibatasi per desa (pelanggan, sumur, tagihan, laporan, keluhan, produksi, pengguna, gudang, pembelian, pendaftaran pasang, audit), sehingga pengelola baru tidak melihat data pengelola lain.
- **Isolasi data teruji**: setiap alamat berbasis ID (pelanggan, sumur, tagihan, kwitansi, keluhan, produksi, pendaftaran pasang, pembelian, bahan, verifikasi periode) memeriksa pemilik datanya — pengelola/dusun lain mendapat **403** atau pesan *“data tidak ditemukan”*, bukan isi data. Admin dusun hanya melihat dusunnya, akun **warga** hanya melihat tagihan/pemakaian/keluhan miliknya sendiri, dan **superadmin** hanya mengelola akun admin (tidak menyentuh data operasional). Uji cepat: `node scripts/uji-isolasi.js` (jalankan terhadap server uji terpisah — lihat komentar di dalam skrip).
- **Akun dari pendaftaran**: tombol **Buat akun** pada daftar pendaftaran membuka popup yang sudah terisi nama pendaftar, username & kata sandi sementara otomatis (bisa diubah). Setelah disimpan, akun admin langsung aktif, pendaftaran otomatis berstatus **Diterima**, dan jenis pendaftaran menentukan peran awal (Desa/Individu → Admin Desa, Dusun → Admin Dusun).
- **Admin desa/dusun** mengelola data operasional (dusun, sumur bor, pelanggan, tarif, periode, tagihan, laporan) sekaligus akun stafnya: admin desa menangani petugas/kasir/warga, admin dusun menangani petugas/warga di dusunnya. Profil pengelola diatur admin desa; pada ruang kerja **dusun mandiri**, admin dusun juga dapat mengubah profilnya sendiri melalui menu **Profil Pengelola**.
- **Petugas catat** hanya mencatat meter dan mendaftarkan calon pelanggan lewat **Pasang Baru**; tidak dapat menambah/mengubah sumur bor maupun tarif.
- **Isolasi data per dusun** di server (policy/scope), bukan hanya menyembunyikan menu.
- Master dusun, sumur bor, pelanggan, sambungan/meter, golongan & tarif progresif.
- Periode tagihan bulanan: buka periode → catat meter (foto opsional) → verifikasi admin dusun → terbitkan tagihan massal.
- Tarif progresif per blok m³, abonemen, pemakaian minimum, denda. **Abonemen bulanan** diatur per golongan di menu **Tarif** → tombol **Edit abonemen & denda** (mis. Rumah Tangga Rp 5.000, Niaga Rp 10.000); nilai ini dipakai saat tagihan diterbitkan.
- Pembayaran tunai/transfer/QRIS, kwitansi bernomor, pembatalan dengan otorisasi.
- Produksi air per sumur (meter induk), perhitungan **NRW**.
- Keluhan pelanggan dan tindak lanjut.
- Laporan per dusun, tunggakan & umur tunggakan, neraca air, kas; ekspor CSV.
- Audit log aktivitas penting.

## Menjalankan

Prasyarat: **Node.js 20+**.

```bash
npm install
npm start
```

Buka <http://localhost:3000>.

Database SQLite dan data demo dibuat otomatis saat pertama kali dijalankan (`data/pdam.db`)
**hanya bila bukan mode produksi**. Salin `.env.example` menjadi `.env` untuk mengatur
lingkungan produksi.

### Keamanan & produksi

- **`SESSION_SECRET` wajib** (min. 32 karakter). Aplikasi di `NODE_ENV=production`
  menolak start bila nilainya kosong. Di pengembangan, nilai acak dibuat sekali dan
  disimpan di `data/.session-secret`.
- **Akun demo hanya untuk pengembangan.** Setel `SEED_DEMO=0` (bawaan produksi) agar
  database baru hanya berisi akun superadmin dari `SUPERADMIN_USERNAME`/`SUPERADMIN_PASSWORD`.
  Akun baru wajib mengganti kata sandi sementara saat masuk pertama.
- **CSRF**: semua formulir POST memakai token (disisipkan otomatis oleh `public/js/app.js`).
  Permintaan tanpa token ditolak `403`.
- **Upload aman**: berkas disimpan di `storage/uploads` (di luar `public/`), isinya
  diverifikasi lewat magic bytes, dan hanya disajikan lewat rute `/uploads/...` yang
  memeriksa hak akses. Logo aplikasi tetap dapat diakses publik.
- **2FA superadmin**: aktifkan di menu **Keamanan Akun → Autentikasi 2FA**
  (TOTP; kompatibel dengan Google/Microsoft Authenticator). Di produksi,
  `WAJIB_2FA_SUPERADMIN=1` memaksa superadmin mengaktifkannya.
- **Rate limit** login, formulir publik, dan unggahan disimpan di SQLite sehingga tetap
  berlaku setelah restart.
- **Di balik reverse proxy** setel `TRUST_PROXY=1` dan `COOKIE_SECURE=1` (HTTPS).
- **Cadangkan data** secara berkala: `npm run backup` (database + `storage/uploads`,
  menyimpan 7 salinan terakhir di `backups/`).

### Akun demo

| Peran | Username | Password |
|---|---|---|
| Superadmin | `superadmin` | `superadmin123` |
| Admin Desa | `admin` | `admin123` |
| Admin Dusun Krajan | `krajan` | `krajan123` |
| Admin Dusun Ngemplak | `ngemplak` | `ngemplak123` |
| Admin Dusun Sumber | `sumber` | `sumber123` |
| Petugas Catat | `petugas` | `petugas123` |
| Kasir | `kasir` | `kasir123` |

Data demo: 3 dusun, 4 sumur bor, 120 pelanggan, 3 periode tagihan historis, produksi harian, dan beberapa keluhan.

Akun `superadmin` otomatis dibuat saat aplikasi dijalankan (termasuk pada database lama). Segera ganti password setelah login pertama. Username/password awal dapat diatur lewat variabel lingkungan `SUPERADMIN_USERNAME` dan `SUPERADMIN_PASSWORD`.

### Perintah lain

```bash
npm run dev        # jalankan dengan auto-reload (node --watch)
npm run db:reset   # hapus & buat ulang database demo
npm run test:smoke # uji HTTP: login, RBAC, halaman utama (server harus berjalan)
npm run test:penggajian # uji absensi, slip gaji, kasbon & laporan (server harus berjalan)
npm run test:profil-tenant # uji profil pengelola pada tenant dusun mandiri (server harus berjalan)
```

## Alur penggunaan

1. **Superadmin** menindaklanjuti pendaftaran pengelola dan membuat akun admin (admin desa/admin dusun) lewat *Panel Superadmin*; identitas pengelola diatur sendiri oleh admin pengelola melalui *Profil Pengelola*.
2. **Admin desa** membuka periode bulanan di menu *Periode & Baca Meter*.
3. **Petugas / admin dusun** mencatat angka meter pelanggan (foto opsional).
4. **Admin dusun** memverifikasi pembacaan; yang disetujui menjadi final.
5. **Admin desa** menerbitkan tagihan massal dari pembacaan final.
6. **Kasir** mencatat pembayaran dan mencetak kwitansi.
6. **Admin desa/dusun** memantau dashboard, tunggakan, NRW, dan laporan bulanan.

## Struktur proyek

```
server.js                 # entry point Express
src/
├── db.js                 # koneksi SQLite, skema, seed, migrasi ringan
├── auth.js               # session, RBAC, scope dusun
├── helpers.js            # format rupiah/tanggal, terbilang, audit
├── services/tarif.js     # perhitungan tarif progresif
├── routes/               # auth, dashboard, master, periode, tagihan,
│                         # produksi, keluhan, laporan
└── views/                # EJS (layout + halaman per modul)
public/
├── css/style.css
├── js/app.js
└── uploads/meter/        # foto meter
scripts/
├── reset-db.js
└── smoke-test.js
data/pdam.db              # dibuat otomatis (tidak di-commit)
docs/                     # rancangan & skema MySQL
```

## Catatan implementasi

- Rancangan awal di `docs/RANCANGAN-APLIKASI-PDAM.md` mengusulkan Laravel + MySQL. Lingkungan pengembangan ini tidak memiliki PHP/MySQL, sehingga MVP dijalankan dengan **Node.js + Express + EJS + SQLite** agar langsung bisa dipakai. Model data, aturan bisnis, peran, dan alur tetap mengikuti rancangan.
- `docs/skema-database.sql` adalah DDL MySQL untuk versi produksi/Laravel; skema SQLite aktual ada di `src/db.js`.
- Untuk produksi: aktifkan HTTPS, ganti `SESSION_SECRET`, gunakan session store persisten, tambahkan CSRF protection, rate limit login, dan backup harian.
- Foto meter disimpan di `public/uploads/meter` (maks. 4 MB, hanya gambar).
- Notifikasi WhatsApp/SMS belum diimplementasikan (fase berikutnya).

## Dokumen rancangan

| Dokumen | Keterangan |
|---|---|
| [`docs/RANCANGAN-APLIKASI-PDAM.md`](docs/RANCANGAN-APLIKASI-PDAM.md) | Rancangan lengkap: peran, modul, alur, aturan bisnis, ERD, API, UX, roadmap, UAT |
| [`docs/skema-database.sql`](docs/skema-database.sql) | DDL MySQL + data contoh (versi produksi) |
