import { defineConfig } from "vite";

export default defineConfig({
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  plugins: [
    {
      name: "redirect-www-to-root",
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          const hostname = request.headers.host?.split(":")[0].toLowerCase();
          if (hostname === "www.geoturing.com") {
            response.writeHead(301, {
              Location: `https://geoturing.com${request.url || "/"}`,
            });
            response.end();
            return;
          }
          next();
        });
      },
    },
  ],
  preview: {
    allowedHosts: ["geoturing.com", "www.geoturing.com"],
  },
});
