// import.meta.env.PUBLIC_API_URL se define en .env (ver .env.example) y en
// las variables de entorno del proyecto de Cloudflare Pages una vez desplegado.
export const API_URL = import.meta.env.PUBLIC_API_URL as string;
