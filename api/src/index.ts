import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Bindings } from "./types";
import { authRoutes } from "./routes/auth";
import { reservasRoutes } from "./routes/reservas";
import { gestionRoutes, catalogosRoutes } from "./routes/gestion";
import { clientesRoutes } from './routes/clientes';

const app = new Hono<{ Bindings: Bindings }>();

// El panel (otro origen: crm. vs crm-api.) necesita CORS con credenciales
// para poder mandar/recibir la cookie de sesión. Solo se permiten los
// orígenes listados en CORS_ORIGIN — nunca "*", porque con credentials:true
// el navegador lo rechaza de todas formas, y sin restringir sería abrir la
// API a cualquier sitio.
app.use("*", (c, next) =>
  cors({
    origin: (origin) => {
      const permitidos = (c.env.CORS_ORIGIN || "")
        .split(",")
        .map((s) => s.trim());
      return origin && permitidos.includes(origin) ? origin : "";
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })(c, next),
);

// Solo confirma que el Worker está vivo y que el binding de D1 llegó bien.
app.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok", db: "connected", env: c.env.ENVIRONMENT });
  } catch (e) {
    console.error("D1 no responde:", e);
    return c.json({ status: "error", db: "unreachable" }, 500);
  }
});
// Raíz: para que abrir la URL del Worker no muestre un 404 que parezca una falla.
app.get("/", (c) =>
  c.json({ service: "Luxury Transfers CRM API", status: "ok" }),
);
app.route("/auth", authRoutes);
app.route("/reservas", reservasRoutes);
app.route("/reservas", gestionRoutes);
app.route("/catalogos", catalogosRoutes);
app.route('/clientes', clientesRoutes);

export default app;
