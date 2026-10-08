# data-fair/processing-rnb

Charger le [Référentiel National des Bâtiments](https://rnb.beta.gouv.fr/) (RNB) dans un jeu de données data-fair, puis le tenir à jour avec le différentiel quotidien.

## Fonctionnement

- **Création** : télécharge l'export national publié sur [data.gouv.fr](https://www.data.gouv.fr/fr/datasets/referentiel-national-des-batiments/) (~43 millions de bâtiments, archive ZIP d'environ 12 Go) et le charge en flux dans un nouveau jeu de données, sans écrire sur disque. Le traitement bascule alors en mode mise à jour.
- **Mise à jour** : interroge l'[API différentielle du RNB](https://rnb-fr.gitbook.io/documentation/api-et-outils/api-batiments/differentiel-entre-deux-dates) depuis la dernière modification appliquée (stockée dans les `extras` du jeu de données) et applique créations, mises à jour et suppressions par `_bulk_lines`.
- **Réparation** : si des lignes ont été rejetées par Elasticsearch à cause d'une géométrie invalide (auto-intersection, anneau de moins de 4 points), réécrit uniquement la colonne `shape` des bâtiments concernés (`_action: patch`), sans `drop` ni rechargement complet. Les lignes nommées par le journal d'indexation sont d'abord réparées depuis leur `shape` stockée (le bâtiment est retrouvé par la première coordonnée du message d'erreur), puis l'export national est réanalysé pour les autres lignes. Le journal sert de garde-fou : sans erreur d'indexation détectée, l'analyse de l'export est évitée.

Colonnes produites : `rnb_id`, `point`, `shape`, `status`, `ext_ids`, `addresses_id`, `validated_by`, `modified_at`.

Les contours sont arrondis à 6 décimales puis validés (sommets dupliqués, auto-intersections) et réparés par `polygon-clipping` avant indexation, afin qu'Elasticsearch n'ait jamais à rejeter une ligne pour une géométrie invalide. Les anneaux dégénérés ou négligeables et les trous sortis de leur coque sont supprimés ; en mode réparation, les lignes dont la `shape` stockée (non arrondie, des premières versions) n'est pas indexable telle quelle sont réécrites, y compris celles que l'ancien détecteur `sweepline-intersections` avait unionnées à tort. Un contour définitivement irréparable est remplacé par le point du bâtiment : une ligne sans géométrie disparaît de la carte, un point la garde localisable.

Si un import complet est interrompu, le prochain lancement le reprend automatiquement : sur la même archive (même ETag), les lignes déjà importées sont relues sans être renvoyées ; sur une archive différente, les lignes partielles sont remplacées (`drop`). À la fin de l'import, le différentiel repart deux jours avant la date de publication de l'export (`Last-Modified`), l'export étant un instantané antérieur à sa publication.

Une ligne absente du jeu de données lors d'une suppression (différentiel rejoué) est considérée comme déjà appliquée ; une ligne rejetée par data-fair est journalisée et ignorée, sans bloquer la synchronisation. Une réparation terminée repasse le traitement en mode mise à jour.

## Développement

```sh
npm i
npm run build-types
npm run lint
npm test
```

Les tests d'intégration se lancent contre une instance réelle en renseignant `config/local-test.mjs` (gitignoré) avec `dataFairUrl` et `dataFairAPIKey`.

## Release

Les plugins sont récupérés depuis le registre npm avec le mot-clé `data-fair-processings-plugin`. Ne pas modifier `version` à la main : les publications sont déclenchées par les tags (`publish-staging.yml`, `publish-production.yml`).
