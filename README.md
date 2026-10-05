# data-fair/processing-rnb

Charger le [Référentiel National des Bâtiments](https://rnb.beta.gouv.fr/) (RNB) dans un jeu de données data-fair, puis le tenir à jour avec le différentiel quotidien.

## Fonctionnement

- **Création** : télécharge l'export national publié sur [data.gouv.fr](https://www.data.gouv.fr/fr/datasets/referentiel-national-des-batiments/) (~43 millions de bâtiments, archive ZIP d'environ 12 Go) et le charge en flux dans un nouveau jeu de données, sans écrire sur disque. Le traitement bascule alors en mode mise à jour.
- **Mise à jour** : interroge l'[API différentielle du RNB](https://rnb-fr.gitbook.io/documentation/api-et-outils/api-batiments/differentiel-entre-deux-dates) depuis la dernière modification appliquée (stockée dans les `extras` du jeu de données) et applique créations, mises à jour et suppressions par `_bulk_lines`.
- **Réparation** : si des lignes ont été rejetées par Elasticsearch à cause d'une géométrie invalide (auto-intersection, anneau de moins de 4 points), réanalyse l'export national et ne réécrit que la colonne `shape` des bâtiments concernés (`_action: patch`), sans `drop` ni rechargement complet. Le journal du jeu de données sert de garde-fou : sans erreur d'indexation détectée, l'analyse de l'export est évitée.

Colonnes produites : `rnb_id`, `point`, `shape`, `status`, `ext_ids`, `addresses_id`, `validated_by`, `modified_at`.

Les contours sont arrondis à 6 décimales puis validés (sommets dupliqués, auto-intersections) et réparés par `polygon-clipping` avant indexation, afin qu'Elasticsearch n'ait jamais à rejeter une ligne pour une géométrie invalide.

Si un import complet est interrompu, le prochain lancement le reprend automatiquement (les lignes partielles sont remplacées).

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
