# Prompt à coller dans le chat qui pilote Somatica Library

---

Bonjour. Tu travailles sur **Somatica Library** (`~/Documents/Claude/Projects/apps/somatica-library`, déployée sur `somatica-library.netlify.app`).

Je viens de mettre en place, dans le **Studio de dérushage** (l'autre application, locale, port 7779), un mécanisme de contrôle des personnes qui ne veulent pas apparaître dans les publications. Il te reste la moitié du travail, côté Library. Voici le contrat exact.

## Le besoin

Certaines participantes ne veulent pas apparaître dans mes publications — Nathalie systématiquement, et d'autres selon les formations. Aujourd'hui je les repère à la main, c'est très long.

Désormais, quand je marque une séance « à contrôler » dans le Studio, **tous ses clips et toutes ses photos arrivent dans Library bloqués**. Je dois pouvoir les passer en revue et les valider un par un, dans Library.

## Ce qui arrive déjà dans la base (c'est fait, ne le refais pas)

Quand une séance est marquée « à contrôler », le Studio écrit sur **chaque clip et chaque photo** de cette séance :

| Table | Colonne | Valeur posée |
|---|---|---|
| `video_library` et `image_library` | `tri_status` | `'a_trier'` |
| `video_library` et `image_library` | `tri_tags` | ajout de `a_controler` + un `controle_<prenom>` par personne |
| `video_library` seulement | `usable_for_reel` | `false` |

Exemples réels d'étiquettes posées :
- séance à contrôler pour Nathalie → `['a_controler', 'controle_nathalie']`
- séance à contrôler pour « Océane et Mathilde » → `['a_controler', 'controle_oceane', 'controle_mathilde']`

Les étiquettes sont **ajoutées, jamais substituées** : `innerdance`, `facil_nath`, `seance`, etc. sont préservées.

Les clips concernés viennent tous du dérushage, donc `r2_key` commence par `derush-clips/` (photos : `banque/derush/`).

## Ce que je te demande de construire

### 1. Un écran « À contrôler »

Un filtre ou un onglet qui montre tout ce qui porte l'étiquette `a_controler`, en **groupant par séance**.

Requête de base (le code existant utilise déjà `q.contains('tri_tags', [...])`, ligne ~487 de `app.js`) :

```js
supabase.from('video_library').select(SELECT).contains('tri_tags', ['a_controler'])
```

Pour grouper par séance : le `r2_key` a la forme `derush-clips/<rush_id>/<clip_id>.mp4`. Le `<rush_id>` identifie la séance. Tu peux aussi utiliser `session_label` quand il est rempli.

Affiche clairement **qui vérifier** : lis les étiquettes `controle_*` et affiche les prénoms en clair (`controle_nathalie` → « Nathalie »).

### 2. La validation, clip par clip

Sur chaque clip, deux actions :

- **Valider** (la personne n'est pas visible, ou c'est acceptable) → `tri_status = 'ok'`, `usable_for_reel = true`, et **on retire les étiquettes `a_controler` et `controle_*`**
- **Refuser** (la personne est visible) → `tri_status = 'refuse'`, `usable_for_reel` reste `false`, on **garde** les étiquettes pour trace

Important : ne touche pas aux autres étiquettes de `tri_tags` quand tu retires les `controle_*`. Filtre, ne remplace pas.

### 3. Valider toute une séance d'un coup

Un bouton par groupe. Je regarde les clips d'une séance, et si tout va bien je valide les 20 d'un coup au lieu de cliquer 20 fois. C'est ça qui me fait gagner du temps.

### 4. Un compteur visible

Le nombre d'éléments en attente de contrôle, visible depuis l'accueil, pour que je n'oublie pas qu'il y a du travail en attente.

## Contraintes à respecter

- **Ne déploie rien.** Ni Netlify, ni GitHub. Tu prépares les fichiers, je pousse moi-même.
- **Fais une sauvegarde** avant de modifier `app.js` ou `index.html` (le dossier contient déjà des `.backup-*`, suis la même convention).
- **L'ergonomie mobile compte** : je valide souvent depuis mon iPhone. Les boutons doivent être atteignables au pouce.
- **Vérifie l'orthographe** de tout le texte affiché. Je suis dyslexique, une faute me gêne vraiment.
- **Ne nomme jamais les IA par leur marque** dans l'interface (pas de « Gemini », « Twelve Labs »…). On dit « l'analyse » ou « l'assistant ».
- Reste dans le style existant de l'app, ne refais pas la charte.

## État actuel de la base, pour ton information

`video_library` — 1769 clips au total, dont 508 venus du dérushage.

- `tri_status` : `ok` 1276, `refuse` 482, `a_trier` 6, `bug` 5
- `usable_for_reel` : 1284 vrai, 485 faux, 0 vide
- `tri_participante` : 766 clips étiquetés à la main, 30 personnes

Aucun clip ne porte encore l'étiquette `a_controler` : le mécanisme est en place mais je n'ai pas encore marqué de séance. Prévois donc l'état vide (« rien à contrôler pour l'instant »), et teste en posant l'étiquette à la main sur deux ou trois clips.

## Un détail utile

Les noms que j'utilise à la main ne sont pas ceux que Photos connaît :

| Chez moi (`tri_participante`) | Dans Photos (`persons_detected`) |
|---|---|
| céline G | Céline garnier |
| virginie b | virginie bousquet |
| Anais C | Anaïs Chadily |
| meki | meki |

Si tu proposes une aide à la saisie des prénoms, tiens-en compte : les deux formes doivent tomber sur la même personne.
