import { defineConfig } from "vite";

export default defineConfig({
  // 静的ホスティング(GitHub Pages等)のサブパスでも動くよう相対パスで出力
  base: "./",
});
