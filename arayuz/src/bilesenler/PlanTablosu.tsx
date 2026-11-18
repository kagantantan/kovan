// Teslim planındaki iş kalemleri: sıra, yazılımcı, bağımlılık, karşıladığı kriterler ve durum.
// Bir kaleme tıklayınca petekte ve zaman çizelgesinde o kalemin aşamasına gidilir.
import type { PlanKalemiGorunumu } from "../api";

const DURUM: Record<PlanKalemiGorunumu["durum"], string> = {
  tamam: "tamamlandı", aktif: "çalışıyor", bekliyor: "kararını bekliyor", sirada: "sırada",
};

export function PlanTablosu({ plan, onSec }: { plan: PlanKalemiGorunumu[]; onSec: (asamaId: string) => void }) {
  const biten = plan.filter((k) => k.durum === "tamam").length;
  return (
    <section className="plan" aria-labelledby="plan-baslik">
      <div className="plan-ust">
        <h2 id="plan-baslik" className="plan-baslik">İş kalemleri</h2>
        <span className="plan-ilerleme">{biten}/{plan.length} kalem tamam</span>
      </div>
      <div className="plan-kaydir">
        <table className="plan-tablo">
          <thead>
            <tr><th scope="col">Kalem</th><th scope="col">Kapsam</th><th scope="col">Yazılımcı</th><th scope="col">Bağımlı</th><th scope="col">Kabul</th><th scope="col">Durum</th></tr>
          </thead>
          <tbody>
            {plan.map((k) => {
              const hedef = k.asamalar.find((a) => a.endsWith("-is-kalemi")) ?? k.asamalar.at(-1);
              return (
                <tr key={k.id} className={`plan-satir plan-satir--${k.durum}`}>
                  <th scope="row">
                    <button type="button" className="plan-kalem" disabled={!hedef} onClick={() => hedef && onSec(hedef)}>
                      <b>{k.id}</b> {k.baslik}
                    </button>
                  </th>
                  <td className="plan-kapsam">{k.kapsam}</td>
                  <td><span className="plan-kim" title={k.gelistirici_ad}>{k.gelistirici_kisa}</span></td>
                  <td>{k.bagimli.length ? k.bagimli.join(", ") : "-"}</td>
                  <td>{k.kabul.length ? k.kabul.join(", ") : "-"}</td>
                  <td><span className={`plan-durum plan-durum--${k.durum}`}>{DURUM[k.durum]}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
