# Lienzo — instrucciones para Claude

**Si la persona quiere instalar o montar Lienzo** (en su servidor), sigue
[docs/INSTALAR-CON-CLAUDE.md](docs/INSTALAR-CON-CLAUDE.md) paso a paso. No hace falta tocar el código.

**Si quiere modificarlo**, el mapa está en [README.md](README.md):
- Un solo proceso Node (Fastify): `server/` (API, WebSocket, cuentas, migraciones) y `web/src/` (React + Excalidraw).
- Antes de dar algo por hecho: `npm run typecheck`, `npm run build` y la prueba de punta a punta `scripts/e2e.mjs` contra una instancia en marcha (instrucciones en el README).
- Las migraciones nuevas van en `server/migrations/` con el número siguiente; se aplican solas al arrancar.
- Nunca metas secretos en el repo: todo va en `.env` (ver `.env.example`).
