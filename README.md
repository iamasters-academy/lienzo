# Lienzo — tu propia pizarra colaborativa, al estilo Miro

Una pizarra infinita para trabajar con tu equipo o tus clientes en tiempo real: notas adhesivas, plantillas, temporizador, votaciones, comentarios y diagramas. Construida sobre el editor de [Excalidraw](https://excalidraw.com) (MIT). Vive en tu servidor y no tiene cuota por usuario ni límite de tableros.

## Montarlo

### Opción 1 — Que lo haga Claude (recomendada)

Abre **Claude Code** (en Claude Desktop, la pestaña **Code**) y pega esto:

```text
Quiero montar Lienzo en mi servidor. Sigue paso a paso la guía
https://raw.githubusercontent.com/iamasters-academy/lienzo/main/docs/INSTALAR-CON-CLAUDE.md
Pregúntame lo que necesites y comprueba cada paso antes de seguir.
```

Claude te pregunta lo que necesita, prepara el acceso al servidor, instala todo, arranca la pizarra con HTTPS y te crea la cuenta de administrador. Si en ese servidor ya tienes **DM Engine**, lo detecta y los dos comparten el HTTPS.

**Lo que haces tú:** tener un servidor (VPS, unos 5 €/mes; vale el mismo de DM Engine) y un dominio o subdominio, y crear el registro DNS que Claude te diga.

### Opción 2 — A mano

En un servidor con Ubuntu y Docker (`curl -fsSL https://get.docker.com | sh`), con un subdominio apuntando a su IP (registro A) y los puertos 80 y 443 abiertos:

```bash
git clone https://github.com/iamasters-academy/lienzo.git && cd lienzo
DOMAIN=pizarra.tudominio.com bash scripts/crear-env.sh
docker compose up -d --build                                          # 3-5 minutos la primera vez
docker compose exec app node dist-server/cli.js invite tu@email.com admin
```

El último comando imprime un enlace de un solo uso. Ábrelo, pon tu nombre y tu contraseña, y ya estás dentro. Para invitar a más gente: **Equipo** dentro de la pizarra.

¿Ya tienes DM Engine en ese servidor? Usa `JUNTO_A_DM_ENGINE=1` al crear el `.env` y sigue las tres líneas de [docker-compose.junto-a-dm-engine.yml](docker-compose.junto-a-dm-engine.yml).

## Qué hace

- **Lienzo infinito** con formas, flechas que se enganchan, texto, dibujo libre, marcos, imágenes, biblioteca de elementos y exportar a PNG/SVG.
- **Notas adhesivas** de 7 colores: barra inferior (clic o arrastrar), tecla **N** bajo el cursor y **En bloque** (una nota por línea).
- **Tiempo real:** cambios, cursores y selección de cada persona, con presencia en la barra superior.
- **Facilitación:** temporizador compartido con aviso, votación con N votos por persona y resultados ocultos hasta revelar, reacciones y «traer a todos a mi vista».
- **Comentarios** anclados a un objeto, con resolver y reabrir.
- **9 plantillas:** retrospectiva, lluvia de ideas, DAFO, Eisenhower, kanban, customer journey, Business Model Canvas, roadmap trimestral y diagrama de flujo.
- **Panel de tableros:** recientes, destacados, míos, papelera, buscar, renombrar, duplicar y miniaturas.
- **Equipo:** cuentas solo por invitación (enlace de un solo uso, 7 días). Se puede desactivar a alguien y cerrar sus sesiones. Más de 10 intentos de entrar en 10 minutos desde una misma IP quedan bloqueados.
- **Diagramas desde texto:** Mermaid siempre; con IA de Claude («Texto a diagrama») solo si pones tu `ANTHROPIC_API_KEY` en `.env`. Sin clave, la IA está apagada y no se gasta nada.

## Mantenimiento

```bash
cd lienzo
git pull && docker compose up -d --build                                   # actualizar
docker compose exec -T db pg_dump -U lienzo lienzo > lienzo-copia.sql      # copia de seguridad
docker compose logs -f app                                                 # ver qué pasa
```

Las tablas se crean y se actualizan solas al arrancar. Temporizador y votación viven en memoria (se pierden si se reinicia); el contenido de los tableros, no.

---

*Lo que sigue es para quien quiera modificar Lienzo.*

## Cómo está hecho

Un solo proceso Node (Fastify) sirve la web (Vite + React + Tailwind), la API REST y el WebSocket `/ws`. Cada tablero es una sala en memoria que fusiona los cambios por versión de elemento (la regla `reconcileElements` de Excalidraw) y guarda en Postgres con *debounce*. Las imágenes van a la tabla `files` (10 MB como máximo cada una).

```
server/   index.ts (arranque), routes.ts (API), realtime.ts (salas y WebSocket), auth.ts (cuentas,
          sesiones, invitaciones), ai.ts (texto a diagrama), cli.ts (invitar desde el servidor),
          migrations/ (SQL, se aplican al arrancar)
web/src/  pages/ (entrar, panel, equipo, invitación) y board/ (pizarra, notas, plantillas, socket)
```

## Desarrollo local

Hace falta Node.js 22 y un Postgres (por ejemplo, `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16-alpine`).

```bash
npm install
printf 'DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres\nPUBLIC_BASE_URL=http://localhost:5173\n' > .env
npm run dev:server        # API y WebSocket en :3000
npm run dev:web           # web en http://localhost:5173
npx tsx --env-file=.env server/cli.ts invite tu@email.com admin
```

Antes de dar algo por hecho: `npm run typecheck` y `npm run build`. La prueba de punta a punta (`scripts/e2e.mjs`, 25 comprobaciones: invitación, tableros, sincronización entre dos clientes, cursores, temporizador, votación, comentarios, imágenes, papelera…) se lanza contra una instancia en marcha:

```bash
TOKEN=$(node --env-file=.env dist-server/cli.js invite e2e@lienzo.test admin | sed 's#.*/invite/##')
BASE_URL=http://localhost:3000 INVITE_TOKEN="$TOKEN" node scripts/e2e.mjs
```

## Licencia

PolyForm Shield 1.0.0 ([LICENSE.md](LICENSE.md)). En resumen: puedes instalarlo y usarlo en tu negocio, adaptarlo y mejorarlo; lo que no puedes es venderlo, revenderlo ni ofrecer con él un producto o servicio que compita con Lienzo. El texto legal es el que manda. Excalidraw y el resto de dependencias mantienen sus propias licencias (MIT y similares).
