# WireGuard Chrome Tunnel

Sadece Chrome'u WireGuard üzerinden tüneller — cihazın geri kalanına dokunmaz.
WireGuard, [wireproxy](https://github.com/whyvl/wireproxy) ile kullanıcı alanında
çalışır ve yerel bir SOCKS5 proxy (`127.0.0.1:25344`) açar; ağ bağdaştırıcısı veya
sistem rotası oluşturulmaz.

## Özellikler

- **Tüm Chrome** — Chrome'un bütün trafiği tünelden geçer. Tünel düşerse Chrome
  doğrudan bağlanmaz (kill switch).
- **Seçili sekmeler** — yalnızca eklediğin sekmeler tünellenir. Sekmenin bağlandığı
  hostlar otomatik öğrenilir; öğrenilmeden önce engellenir, böylece sızıntı olmaz.
  > Chrome sekme bazlı proxy desteklemez: tüneldeki bir siteyi başka bir sekmede
  > açarsan o istekler de tünelden geçer.
- **ProtonVPN konum seçici** — Chrome'da açık Proton oturumunu kullanarak hesabının
  erişebildiği ülkeleri listeler, seçilen ülke için WireGuard profili üretip bağlanır.
  Her profilde **↻** aynı ülkeden başka sunucuya geçer, **✕** profili Proton
  hesabından da kaldırır.
- WebRTC IP sızıntısı tünel açıkken engellenir.

## Kurulum

1. Python 3.11+ ve bağımlılıklar: `pip install -r requirements.txt`
2. `Servis kurulum.bat` → **[7]** wireproxy'yi indir, **[1]** servisi kur.
3. `chrome://extensions` → Geliştirici modu → **Paketlenmemiş öğe yükle** →
   `Chrome Extension` klasörü (Chrome 137+).
4. Proton için Chrome'da `account.protonvpn.com`'a bir kez giriş yap.

Profiller `%PROGRAMDATA%\wg-chrome-manager\profiles` altında tutulur.

## Yapı

| Dosya | Görev |
| --- | --- |
| `vpn_api.py` | Yerel API (`127.0.0.1:5000`): profiller, wireproxy başlat/durdur, tünel kontrolü |
| `wireguard_service.py` | API'yi Windows servisi olarak çalıştırır |
| `Chrome Extension/background.js` | Proxy yönlendirme, sekme öğrenme, Proton API |
| `Chrome Extension/popup.*` | Arayüz |
