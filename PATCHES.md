# Patches sraleik sur Paperclip

Base : tag `v2026.1001.0`. Branche `sraleik/patches`, un commit par intention,
préfixe `patch:`. À rebaser sur chaque nouveau tag stable (rerere activé).

| # | Intention | PR amont | Statut amont |
|---|---|---|---|
| 1 | Rotation des identifiants Claude depuis un fichier : le CLI réécrit le jeton court au lieu qu'il gèle en variable d'env | #13726 | ouverte, non fusionnée au 2026-10-03 |
| 2 | claude-local charge les skills avec une connexion IA gérée | #14341 | ouverte, non fusionnée au 2026-10-03 |
| 3 | Une mention sur le ticket d'un autre agent ne publie plus d'office le message final du run (`skipRunIssueComment` vrai si `issue_comment_mentioned` et assigné ≠ agent) | aucune | à proposer en amont |

Test du patch 3 : `server/src/__tests__/heartbeat-mention-comment-suppression.test.ts`.
