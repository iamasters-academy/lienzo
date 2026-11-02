# Montar Lienzo con Claude — guía para el asistente

Esta guía la sigue **Claude Code** cuando alguien le pide «monta Lienzo». Esa persona quiere una pizarra colaborativa propia (como Miro) para su equipo o sus clientes y, casi seguro, no es técnica. Háblale claro, un paso cada vez, y **comprueba cada paso antes de seguir**.

Repositorio: `https://github.com/iamasters-academy/lienzo`

## Reglas

- **Nada que cueste dinero o cree cuentas sin su OK.** El servidor y el dominio los contrata ella.
- **Secretos, nunca por el chat.** No le pidas la contraseña del servidor ni claves de API, y no muestres el contenido de `.env`.
- Si un comando falla, lee el error, explícalo en una frase y propón el siguiente intento.

## 0. Presenta el plan

En dos o tres frases: Lienzo es una pizarra como Miro que vive en su servidor, sin cuota por usuario. Necesita un **servidor** (VPS, unos 5 €/mes; si ya tiene uno con DM Engine, vale el mismo) y un **subdominio** (por ejemplo `pizarra.sudominio.com`). Unos 20 minutos.

Pregunta qué tiene ya.

## 1. Acceso al servidor

**Si no tiene VPS:** Ubuntu 24.04 con 2 GB de RAM como mínimo (4 GB si va a compartirlo con DM Engine). Hetzner, Hostinger, DigitalOcean u OVH valen. Que lo contrate ella.

**Clave SSH** (tú no puedes escribir contraseñas en una terminal):
- Si ya existe una clave que entra en ese servidor (por ejemplo `~/.ssh/dm_engine` de cuando montó DM Engine), úsala.
- Si no: `ssh-keygen -t ed25519 -f ~/.ssh/lienzo -N "" -C lienzo`. Para un VPS nuevo, que pegue la clave pública (`cat ~/.ssh/lienzo.pub`) en «Claves SSH» del proveedor al crearlo. Para uno que ya existe con contraseña, que ejecute ella `ssh-copy-id -i ~/.ssh/lienzo.pub root@LA_IP` en una terminal (en Claude Desktop, el panel **Terminal**) y escriba la contraseña.
- Comprueba: `ssh -i ~/.ssh/<clave> -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@LA_IP 'echo ok'`

En adelante, los comandos del servidor van por `ssh -i ~/.ssh/<clave> root@LA_IP '…'`.

## 2. El subdominio

Dile el registro exacto que tiene que crear donde gestiona sus DNS:

| Tipo | Nombre | Valor |
|---|---|---|
| A | `pizarra` | la IP del VPS |

Comprueba hasta que coincida (`dig +short pizarra.sudominio.com`). No arranques sin esto: el certificado HTTPS no se emite.

## 3. ¿El servidor ya tiene DM Engine u otra web?

```bash
docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E ':(80|443)->' ; ss -ltnp | grep -E ':(80|443) '
```

- **Nada en 80/443:** modo normal (Lienzo pone su propio HTTPS).
- **Está DM Engine** (en `/root/dm-engine`, contenedores `dm-engine-…`): modo **junto a DM Engine**. Los dos comparten el Caddy de DM Engine.
- **Otra cosa** (Nginx, Traefik, un panel tipo Coolify…): para y explícaselo. Lo más sencillo suele ser usar ese proxy para apuntar el subdominio al puerto 3000 de Lienzo; acuérdalo con ella antes de tocar nada.

## 4. Instalar

```bash
apt-get update -y && apt-get install -y git
command -v docker || curl -fsSL https://get.docker.com | sh
git clone https://github.com/iamasters-academy/lienzo.git /root/lienzo
```

Crea la configuración:

- Modo normal: `cd /root/lienzo && DOMAIN=pizarra.sudominio.com bash scripts/crear-env.sh`
- Junto a DM Engine: `cd /root/lienzo && DOMAIN=pizarra.sudominio.com JUNTO_A_DM_ENGINE=1 bash scripts/crear-env.sh`

Si usa `ufw` (`ufw status`), abre los puertos: `ufw allow 22,80,443/tcp`.

## 5. Arrancar

Avisa de que la primera vez tarda 3-5 minutos. Ejecútalo en segundo plano:

```bash
cd /root/lienzo && docker compose up -d --build && docker compose ps
```

**Solo en modo junto a DM Engine**, añade el sitio al Caddy de DM Engine y reinícialo:

```bash
cd /root/dm-engine && printf '\npizarra.sudominio.com {\n\tencode gzip\n\treverse_proxy lienzo:3000\n}\n' >> Caddyfile && docker compose restart caddy
```

(Al actualizar DM Engine con `git pull`, ese cambio local del `Caddyfile` se conserva; si `git pull` protesta, `git stash && git pull && git stash pop`.)

Comprueba desde fuera:

```bash
curl -s https://pizarra.sudominio.com/api/health        # {"ok":true}
```

Si HTTPS falla: `docker compose logs --tail 50 caddy` (en `/root/lienzo`, o en `/root/dm-engine` en modo compartido). Casi siempre es el DNS o los puertos.

## 6. Su cuenta de administrador

Pregúntale el email con el que quiere entrar y crea la invitación:

```bash
cd /root/lienzo && docker compose exec -T app node dist-server/cli.js invite SU_EMAIL admin
```

Imprime un enlace de un solo uso (válido 7 días). Ábreselo en el navegador (`open <enlace>` en Mac, `start <enlace>` en Windows) para que ponga su nombre y su contraseña. No lo pegues en ningún otro sitio.

Luego enséñale **Equipo** (arriba a la derecha): ahí genera enlaces de invitación para su gente.

## 7. IA (opcional)

«Texto a diagrama» con Claude funciona solo si pone su clave de Anthropic, y cada uso se cobra en su cuenta (céntimos por diagrama). Sin clave, el resto de Lienzo funciona igual y los diagramas Mermaid también. Si la quiere, que ejecute ella, en su terminal, sustituyendo `SU_CLAVE`:

```bash
ssh -i ~/.ssh/<clave> root@LA_IP "cd /root/lienzo && sed -i 's/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=SU_CLAVE/' .env && docker compose up -d"
```

## 8. Cierra

Resume:
- la dirección de su pizarra y que invita a gente desde **Equipo**;
- cómo actualizar: `ssh … 'cd /root/lienzo && git pull && docker compose up -d --build'`;
- copia de seguridad, que queda en su ordenador: `ssh -i ~/.ssh/<clave> root@LA_IP 'cd /root/lienzo && docker compose exec -T db pg_dump -U lienzo lienzo' > lienzo-copia.sql`.
