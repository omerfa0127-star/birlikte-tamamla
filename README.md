# Birlikte Tamamla — çalışan örnek

## Çalıştırma

1. Bilgisayarda Node.js LTS kurulu olmalıdır.
2. Windows'ta `BASLAT.bat` dosyasına çift tıklayın.
3. Tarayıcıda `http://localhost:3000` açılır.

Alternatif olarak bu klasörde `node server.js` komutunu çalıştırabilirsiniz. Harici paket kurulumu gerekmez.

## Deneme

- `Oda oluştur` düğmesine basın.
- Fotoğraf seçebilir veya örnek fotoğrafı kullanabilirsiniz.
- 25, 64 ya da 100 parça seçin.
- Oluşan altı karakterli kodu ikinci tarayıcı penceresinde `Davet kodum var` alanına yazın.
- İki pencere aynı puzzle durumunu görür.

## Örnekte bulunanlar

- Türkçe ve mobil uyumlu açılış sayfası
- Kullanıcının JPG, PNG veya WebP yüklemesi
- Tarayıcıda yeniden boyutlandırma ve kare kırpma
- 25, 64 ve 100 parça
- Yuvarlak çıkıntılı ve komşusuyla tam eşleşen yapboz parçaları
- Altı karakterli oda kodu
- Canlı parça hareketi ve parça kilidi
- Doğru konuma yaklaşınca otomatik yerleşme
- İlerleme göstergesi ve bitiş mesajı

## Bu sürümde eklenenler

- Odalar artık `rooms.json` dosyasına periyodik olarak yazılır; sunucu yeniden başlasa da odalar kaybolmaz. 48 saat boyunca değişmeyen odalar otomatik silinir.
- WebSocket bağlantılarında origin kontrolü var: sadece kendi siteniz (aynı host) bağlanabilir. Başka bir alan adına da izin vermek isterseniz `ALLOWED_ORIGINS` ortam değişkenine virgülle ayrılmış origin listesi verin (örn. `ALLOWED_ORIGINS=https://ornek.com node server.js`).
- Basit oran sınırlama eklendi: bir IP 10 dakikada en fazla 8 oda oluşturabilir, bir bağlantı saniyede 40 mesajdan fazlasını gönderemez.
- Kullanılmayan hesap/giriş sistemi (arayüzde hiç bağlı değildi) kaldırıldı; site hâlâ üyelik gerektirmiyor.

## Canlı siteye geçerken

Bu, tek dosyalık `rooms.json` ile basit bir kalıcılık sağlar; birden fazla sunucu örneği (yatay ölçekleme) çalıştıracaksanız gerçek bir veritabanı (Redis/Postgres vb.) gerekir. Ayrıca canlı sürümde: kalıcı/harici resim depolama (CDN), uygunsuz içerik bildirimi ve HTTPS/WSS (ters proxy ile) yapılandırması eklenmelidir. Hazır örnek görseli canlı kullanımda kendi lisanslı görselinizle değiştirin.
