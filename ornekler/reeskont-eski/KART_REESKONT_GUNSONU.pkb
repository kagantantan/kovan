CREATE OR REPLACE PACKAGE BODY kart_reeskont_gunsonu AS
  -- Kurgusal örnek eski sistem: kart bakiyeleri için gün sonu faiz tahakkuku (reeskont).
  -- Kovan'ın replatform akışını denemek için yazıldı; gerçek bir kurumun kodu değildir.

  c_gun_esasi    CONSTANT NUMBER       := 365;
  c_reeskont_hes CONSTANT VARCHAR2(10) := '18100';

  FUNCTION gunluk_faiz(p_bakiye NUMBER, p_yillik_oran NUMBER) RETURN NUMBER IS
  BEGIN
    IF p_bakiye <= 0 THEN
      RETURN 0;
    END IF;
    RETURN ROUND(p_bakiye * p_yillik_oran / 100 / c_gun_esasi, 2);
  END gunluk_faiz;

  PROCEDURE calistir(p_tarih DATE) IS
    v_toplam NUMBER := 0;
    v_faiz   NUMBER;
  BEGIN
    FOR r IN (SELECT kart_no, faize_esas_bakiye, yillik_oran
                FROM kart_bakiye
               WHERE durum = 'A'
                 AND faiz_isler = 'E'
               ORDER BY kart_no) LOOP
      v_faiz := gunluk_faiz(r.faize_esas_bakiye, r.yillik_oran);
      IF v_faiz > 0 THEN
        INSERT INTO reeskont_hareket (tarih, kart_no, tutar)
        VALUES (p_tarih, r.kart_no, v_faiz);
        v_toplam := v_toplam + v_faiz;
      END IF;
    END LOOP;

    UPDATE reeskont_ozet
       SET bakiye    = bakiye + v_toplam,
           son_tarih = p_tarih
     WHERE urun = 'KART';

    INSERT INTO muhasebe_fis (tarih, hesap, tutar, aciklama)
    VALUES (p_tarih, c_reeskont_hes, v_toplam, 'Kart reeskont tahakkuku');

    COMMIT;
  EXCEPTION
    WHEN OTHERS THEN
      ROLLBACK;
      RAISE;
  END calistir;
END kart_reeskont_gunsonu;
/
