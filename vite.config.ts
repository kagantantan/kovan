import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// Arayüz arayuz/ altında; derlenmiş hali arayuz/dist (sunucu oradan sunar).
// `npm run gelistir` ile geliştirirken API istekleri çalışan Kovan sunucusuna yönlenir.
const SUNUCU = `http://127.0.0.1:${process.env.KOVAN_PORT ?? 8765}`;

// Sunucu yalnızca kendi adresinden gelen istekleri kabul eder (Host ve Origin denetimi).
// Geliştirme sunucusundan gelen isteklerde ikisini de sunucunun adresine çeviririz; başka sitelerin isteklerine dokunmayız.
const vekil: ProxyOptions = {
  target: SUNUCU,
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyReq", (giden, gelen) => {
      const koken = gelen.headers.origin;
      if (koken && /^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(koken)) giden.setHeader("origin", SUNUCU);
    });
  },
};

export default defineConfig({
  root: "arayuz",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { port: 5173, strictPort: true, proxy: { "/api": vekil, "/onizle": vekil } },
});
