# Somatica Library Worker — guide d'installation

Le worker est un petit serveur Flask qui tourne sur ton Mac. Il expose des endpoints HTTP utilisés par l'UI Library (onglets Visages et Maintenance) pour :

- synchroniser iCloud -> R2 (nouvelles vidéos de l'album "extrait pour montage")
- générer les miniatures manquantes
- faire tourner la reconnaissance de visages (face_recognition + dlib, trop lourds pour une Edge Function)
- lister et renommer les clusters de visages

Deux choses à mettre en place :

1. `launchd` pour que le worker démarre tout seul quand ton Mac boote (et se relance s'il plante)
2. `cloudflared` (Cloudflare Tunnel) pour exposer `localhost:8787` en HTTPS derrière une URL publique, afin que l'UI Library déployée sur Netlify puisse taper dessus sans te forcer à être en local.

---

## 1. Prérequis (à faire une seule fois)

### 1.1 Installer les dépendances système

```bash
brew install cmake ffmpeg cloudflared
```

- `cmake` est nécessaire pour compiler `dlib` (utilisé par `face_recognition`)
- `ffmpeg` sert à extraire les miniatures des vidéos
- `cloudflared` est le client Cloudflare Tunnel

### 1.2 Préparer le worker

```bash
cd /Users/jeromelepilliet/Documents/Claude/Projects/somatica-library/export-icloud
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 1.3 Configurer le `.env`

Si tu n'as pas encore de `.env` :

```bash
cp .env.example .env
```

Ensuite, génère un token sécurisé et colle-le dans `.env` :

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Ouvre `.env` et remplis :

```
SUPABASE_URL=https://zrdlvoovrnglxcgoyyeb.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<celle que tu as déjà>
STORE_BACKGROUND_TOKEN=somatica-r2-2026
WORKER_PORT=8787
WORKER_TOKEN=<le token généré ci-dessus>
WORKER_PUBLIC_URL=https://worker.somatica.fr   # on y vient plus bas
```

### 1.4 Tester que ça tourne en local

```bash
cd /Users/jeromelepilliet/Documents/Claude/Projects/somatica-library/export-icloud
source .venv/bin/activate
python3 library_worker.py
```

Dans un autre terminal :

```bash
curl http://localhost:8787/health
# -> {"ok":true,"service":"somatica-library-worker", ...}
```

Coupe le worker avec `Ctrl+C` quand c'est bon.

---

## 2. Auto-démarrage via `launchd`

`launchd` est le système macOS qui lance les services en tâche de fond. On crée un fichier plist qui décrit comment lancer le worker.

### 2.1 Créer le plist

Crée le fichier `~/Library/LaunchAgents/com.somatica.library-worker.plist` :

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.somatica.library-worker.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.somatica.library-worker</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/jeromelepilliet/Documents/Claude/Projects/somatica-library/export-icloud/.venv/bin/python3</string>
    <string>/Users/jeromelepilliet/Documents/Claude/Projects/somatica-library/export-icloud/library_worker.py</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/jeromelepilliet/Documents/Claude/Projects/somatica-library/export-icloud</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/jeromelepilliet/Library/Logs/somatica-library-worker.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/jeromelepilliet/Library/Logs/somatica-library-worker.err.log</string>
</dict>
</plist>
EOF
```

Ajustes `PATH` si tu es sur un Mac Intel (remplace `/opt/homebrew/bin` par `/usr/local/bin` tout seul).

### 2.2 Charger et activer le service

```bash
launchctl unload ~/Library/LaunchAgents/com.somatica.library-worker.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.somatica.library-worker.plist

# Vérifier qu'il tourne
launchctl list | grep somatica
curl http://localhost:8787/health
```

Le worker est maintenant lancé automatiquement à chaque boot et relancé s'il crashe.

### 2.3 Commandes utiles

```bash
# Voir les logs en direct
tail -f ~/Library/Logs/somatica-library-worker.log
tail -f ~/Library/Logs/somatica-library-worker.err.log

# Arrêter
launchctl unload ~/Library/LaunchAgents/com.somatica.library-worker.plist

# Relancer après modif du code
launchctl unload ~/Library/LaunchAgents/com.somatica.library-worker.plist
launchctl load ~/Library/LaunchAgents/com.somatica.library-worker.plist
```

---

## 3. Exposer en HTTPS via Cloudflare Tunnel

Ton Mac n'est pas directement accessible depuis Internet. Cloudflare Tunnel crée un lien chiffré entre ton Mac et le réseau Cloudflare, qui expose une URL publique vers `localhost:8787`.

### 3.1 Authentifier cloudflared

```bash
cloudflared tunnel login
```

Ça ouvre le navigateur : connecte-toi avec le compte Cloudflare qui gère le domaine `somatica.fr` et autorise le tunnel.

### 3.2 Créer le tunnel

```bash
cloudflared tunnel create somatica-library-worker
```

Ça génère un UUID et un fichier de credentials dans `~/.cloudflared/<UUID>.json`. Note l'UUID.

### 3.3 Configurer le routage DNS

```bash
cloudflared tunnel route dns somatica-library-worker worker.somatica.fr
```

Cloudflare crée automatiquement un enregistrement DNS CNAME pour `worker.somatica.fr` pointant vers le tunnel.

### 3.4 Écrire le fichier de config

Crée `~/.cloudflared/config.yml` :

```yaml
tunnel: somatica-library-worker
credentials-file: /Users/jeromelepilliet/.cloudflared/<UUID>.json

ingress:
  - hostname: worker.somatica.fr
    service: http://localhost:8787
  - service: http_status:404
```

Remplace `<UUID>` par la valeur donnée à l'étape 3.2.

### 3.5 Tester le tunnel manuellement

```bash
cloudflared tunnel run somatica-library-worker
```

Dans un autre terminal :

```bash
curl https://worker.somatica.fr/health
# -> {"ok":true, ...}
```

Coupe avec `Ctrl+C` quand c'est bon.

### 3.6 Installer le tunnel comme service macOS

Cloudflare fournit sa propre commande pour créer le launchd plist :

```bash
sudo cloudflared service install
```

(Le tunnel tourne en tant que service root, ce qui permet aussi le port 80/443 si besoin.)

Vérifier :

```bash
sudo launchctl list | grep cloudflared
curl https://worker.somatica.fr/health
```

---

## 4. Configurer l'UI Library

Dans l'app Library (Netlify), ouvre l'onglet **Maintenance** puis la section "Connexion au worker" et remplis :

- **URL du worker** : `https://worker.somatica.fr`
- **Token** : la valeur de `WORKER_TOKEN` de ton `.env`

Clique sur **Enregistrer** puis sur **Tester la connexion**. Si tout va bien, tu vois `OK · ready` en vert.

Les valeurs sont stockées en `localStorage` du navigateur, donc elles sont locales à chaque navigateur mais persistantes entre sessions.

Si tu préfères pré-remplir ces valeurs côté Netlify au lieu de les entrer à la main, ajoute deux variables dans **Site settings -> Environment variables** :

- `VITE_WORKER_URL=https://worker.somatica.fr`
- `VITE_WORKER_TOKEN=<ton token>`

Le frontend pourra alors les lire au premier chargement et les injecter automatiquement dans `localStorage` (à ajouter plus tard dans `admin.js` si besoin).

---

## 5. Checklist de démarrage après reboot

Normalement tout redémarre tout seul. Pour vérifier :

```bash
# 1. Worker local actif ?
curl http://localhost:8787/health

# 2. Tunnel actif ?
curl https://worker.somatica.fr/health

# 3. Tunnel status Cloudflare ?
cloudflared tunnel list
cloudflared tunnel info somatica-library-worker
```

Si un des deux est KO, voir la section correspondante pour relancer.

---

## 6. Dépannage

### Le worker ne démarre pas (launchd)

```bash
cat ~/Library/Logs/somatica-library-worker.err.log
```

Les causes classiques :

- `.venv` inexistant -> relancer le `python3 -m venv .venv && pip install -r requirements.txt`
- `.env` manquant ou `WORKER_TOKEN` vide -> le worker `sys.exit` au démarrage
- `cmake` pas installé -> `dlib` n'a pas compilé -> `brew install cmake` puis reinstall
- Mac M1/M2 avec anciens wheels -> forcer `pip install --no-binary :all: dlib` dans le venv

### Le tunnel ne répond pas

```bash
sudo launchctl list | grep cloudflared
sudo cat /Library/Logs/com.cloudflare.cloudflared.err.log
```

Pour relancer complètement :

```bash
sudo cloudflared service uninstall
sudo cloudflared service install
```

### L'UI dit "Worker hors ligne"

1. Depuis ton Mac : `curl https://worker.somatica.fr/health` -> doit répondre
2. Depuis un autre appareil (téléphone en 4G par exemple) : même test
3. Vérifie l'URL dans l'onglet Maintenance -> pas de `/` final, bien préfixée `https://`
4. Vérifie le token -> doit être identique à `.env`

### Face recognition plante (`RuntimeError: Unsupported image type, must be 8bit gray or RGB image`)

Cause : une vidéo source corrompue. Le script `generate_thumbnails.py` skip déjà les sources < 50 Ko et les liste en fin de run pour ré-export depuis iCloud.

---

## 7. Notes sur la sécurité

- Le `WORKER_TOKEN` est la seule protection entre Internet et ton Mac. Garde-le secret.
- Le service role Supabase dans `.env` est ultra-sensible : il bypass RLS. Ne le commit jamais.
- `cloudflared` chiffre tout le trafic et Cloudflare filtre les IPs abusives. Mais si un attaquant devine le token, il peut appeler tous les endpoints.
- Tu peux restreindre davantage en ajoutant un Cloudflare Access (authentification par email ou SSO) sur `worker.somatica.fr` ; dans ce cas la requête doit porter un cookie Cloudflare en plus du Bearer token. À voir si la bande passante d'Access gratuit suffit.
