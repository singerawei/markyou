<p align="center"><img src="https://raw.githubusercontent.com/singerawei/markyou/main/media/markyou-logo.png" alt="MarkYou" width="104"></p>

<h1 align="center">MarkYou</h1>

<p align="center"><strong>Un éditeur Markdown local-first pour VS Code.</strong><br>
Cliquez sur n'importe quel bloc pour le modifier sur place, et gardez vos fichiers <code>.md</code> comme source unique de vérité.</p>

<p align="center">
  <a href="https://github.com/singerawei/markyou/blob/main/README.md">English</a> ·
  <a href="https://github.com/singerawei/markyou/blob/main/README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/singerawei/markyou/blob/main/README.ja.md">日本語</a> ·
  <a href="https://github.com/singerawei/markyou/blob/main/README.ko.md">한국어</a> ·
  <a href="https://github.com/singerawei/markyou/blob/main/README.es.md">Español</a> ·
  <strong>Français</strong> ·
  <a href="https://github.com/singerawei/markyou/blob/main/README.de.md">Deutsch</a> ·
  <a href="https://github.com/singerawei/markyou/blob/main/README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=singeraw.markyou"><img src="https://img.shields.io/badge/Marketplace-Preview-007ACC?style=flat-square" alt="Marketplace preview"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20x64-0078D6?style=flat-square" alt="Windows x64">
  <img src="https://img.shields.io/badge/VS%20Code-1.100%2B-007ACC?style=flat-square" alt="VS Code 1.100+">
  <img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="MIT">
</p>

<p align="center"><img src="https://raw.githubusercontent.com/singerawei/markyou/main/media/markyou-hero.png" alt="MarkYou en train de modifier un document Markdown avec un tableau et un bloc de code coloré" width="100%"></p>

MarkYou transforme des fichiers `.md` ordinaires en un document modifiable au clic dans VS Code. Vos fichiers restent la source unique de vérité : chaque enregistrement réécrit le Markdown dans le fichier qui possède le contenu, de sorte que Git, votre éditeur de texte et tous les autres outils Markdown continuent de fonctionner.

Il est conçu pour les documents qui grandissent. Composez un document continu à partir de plusieurs fichiers avec `@import`, modifiez chaque section incluse sur place et n'enregistrez que les fichiers qui ont réellement changé. Aucun compte, aucune base de données, aucune télémétrie et aucun navigateur requis.

## Ce qui le distingue

- **Markdown en entrée, Markdown en sortie.** Pas de format propriétaire ni de base de données cachée. Le document rendu et le fichier source restent synchronisés.
- **Des includes modifiables.** Importez de nombreux fichiers dans une seule vue ; les modifications retournent dans le bon fichier source, y compris pour les imports imbriqués ou répétés.
- **Rendu, jamais remplacé.** Les blocs complexes restent rendus pendant leur modification ; ils ne se transforment jamais en zones de texte brut.
- **Local-first.** Aucune télémétrie, aucune connexion. Le seul trafic réseau provient des images distantes de votre document.
- **Confortable à grande échelle.** Les documents volumineux sont chargés progressivement et rendus près de la zone visible, avec un repli vers l'éditeur natif pour les blocs trop grands.

## Fonctionnalités

- **Modification au clic** — cliquez sur un paragraphe, un titre, une liste, un tableau, une liste de tâches, une citation, un bloc de code ou un lien pour le modifier sur place.
- **Markdown riche** — tableaux GFM, listes de tâches, mathématiques, notes de bas de page, alertes et callouts, admonitions, listes de définitions, TOC, liens wiki, surlignage, indice/exposant, emoji, frontmatter et un sous-ensemble HTML sûr.
- **Navigation** — Find et Outline partagent un panneau, suivent votre défilement et peuvent être épinglés par document.
- **Diagrammes Mermaid** — rendus et mis en cache localement ; copiez, modifiez, zoomez ou exportez en SVG/PNG.
- **Export PDF** — choisissez le format de papier, les marges, la taille de police, les en-têtes, les pieds de page, les numéros de page et les sauts de page H1. Les modifications non enregistrées sont incluses.
- **Lecture adaptée au thème** — suit les thèmes clair, sombre et à fort contraste de VS Code.
- **Pensé pour le clavier** — chaque action courante est une commande VS Code et peut être réassignée.
- **Documents longs** — le chargement progressif, le rendu à proximité de la zone visible et le déchargement du contenu lointain gardent les gros fichiers réactifs.

## Installation

**Prérequis :** Windows x64 et VS Code 1.100 ou supérieur. Aucune installation séparée de Chrome ou Edge n'est nécessaire.

Installez la [préversion de MarkYou sur Marketplace](https://marketplace.visualstudio.com/items?itemName=singeraw.markyou) avec **Install Pre-Release Version**. Vous pouvez aussi installer le fichier VSIX :

1. Téléchargez `markyou-win32-x64-1.1.2.vsix` depuis [GitHub Releases](https://github.com/singerawei/markyou/releases).
2. Dans VS Code, ouvrez **Extensions**, cliquez sur **… → Installer depuis un VSIX…** et sélectionnez le fichier.
3. Rechargez VS Code.
4. Faites un clic droit sur un fichier `.md` et choisissez **Ouvrir avec… → MarkYou**.

Mermaid et l’export PDF utilisent en priorité Microsoft Edge ou Google Chrome déjà installé. Si aucun n’est disponible, le moteur est téléchargé à la première utilisation et conservé séparément pour une utilisation hors ligne.

## Démarrage rapide

1. **Ouvrez** un fichier `.md` avec **Ouvrir avec… → MarkYou**.
2. **Modifiez** en cliquant sur n'importe quel bloc. Appuyez sur `Ctrl/Cmd+S` pour enregistrer ou `Ctrl/Cmd+Shift+S` pour enregistrer sous.
3. **Composez** plusieurs fichiers en une seule vue :

   ```markdown
   # Conception du système

   @import "./product/overview.md"
   @import "./architecture/system.md"
   @import "./features/payment.md"
   ```

   Modifiez directement les sections rendues ; l'enregistrement n'écrit que les fichiers source modifiés.
4. **Naviguez** avec `Ctrl/Cmd+Shift+O`, insérez des blocs avec `Ctrl/Cmd+Alt+I` et exportez avec **More → Export PDF**.

## Prise en charge de Markdown

| Syntaxe | Modification |
| --- | --- |
| Titres, paragraphes, emphase, code, citations, listes et séparateurs CommonMark | ✅ Sur place |
| Tableaux GFM, alignement, listes de tâches, barré et liens automatiques | ✅ Sur place |
| Surlignage `==texte==`, indice, exposant et emoji | ✅ Sur place |
| HTML sûr (`kbd`, `mark`, `details`, `sub`, `sup`, …) | ✅ Contenteditable rendu et assaini |
| Mathématiques `$...$`, `$$...$$` | ✅ KaTeX, éditeur de bloc avec aperçu en direct |
| Notes de bas de page, liens de référence, listes de définitions et abréviations | ✅ Rendu, éditeur de bloc avec aperçu en direct |
| GitHub Alerts, Obsidian Callouts et admonitions | ✅ Rendu, titres personnalisés et repliables |
| TOC, liens wiki, commentaires Obsidian et frontmatter | ✅ Rendu |
| Mermaid | ✅ Rendu localement |
| Images distantes | ✅ Chargées à l'ouverture ; téléchargées pour le PDF |

La syntaxe non prise en charge est conservée plutôt qu'aplatie.

## Raccourcis clavier

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Enregistrer / Enregistrer sous | `Ctrl+S` / `Ctrl+Shift+S` | `Cmd+S` / `Cmd+Shift+S` |
| Rechercher | `Ctrl+F` | `Cmd+F` |
| Plan / Naviguer | `Ctrl+Shift+O` | `Cmd+Shift+O` |
| Insérer | `Ctrl+Alt+I` | `Cmd+Alt+I` |
| Mode concentration | `Ctrl+Alt+F` | `Cmd+Alt+F` |
| Masquer la barre d'outils | `Ctrl+Alt+T` | `Cmd+Alt+T` |
| Aide | `?` ou `Ctrl+Alt+H` | `?` ou `Cmd+Alt+H` |

Tous les raccourcis sont des commandes VS Code et peuvent être réassignés. Consultez **MarkYou: Help** pour la liste complète et les conflits avec l'hôte.

## Bon à savoir

- Fichiers `.md` locaux uniquement. Les systèmes de fichiers distants ou virtuels, la synchronisation cloud et les comptes ne sont pas pris en charge.
- **Enregistrer sous** doit rester dans le même dossier pour que les includes relatifs continuent de fonctionner.
- Les blocs trop volumineux reviennent à l'éditeur de texte : code de plus de 128 Kio, texte de plus de 16 Kio ou tableaux de plus de 200 lignes.
- Les inclusions wiki (`![[Page]]`) s'ouvrent sous forme de cartes cliquables, et non de transclusions complètes.
- Cette préversion est disponible pour Windows x64.

## Licence

MIT. Les licences des dépendances tierces et de Chromium sont répertoriées dans [THIRD_PARTY_NOTICES.md](https://github.com/singerawei/markyou/blob/main/THIRD_PARTY_NOTICES.md).
