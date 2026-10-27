import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// Modo servidor: cada página se renderiza en el Worker de Cloudflare Pages,
// necesario porque login/dashboard dependen de la sesión, no se pueden
// generar como HTML estático en build time.
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
});
