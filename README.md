# IW Design Library — Changelog

Automated changelog for the IW Design Library.  
Figma Library Publish → GitHub Action → Netlify deploy.

---

## Setup (einmalig, ~2 Stunden)

### 1. GitHub Repo anlegen

```bash
# Diesen Ordner als Git-Repo initialisieren
git init
git add .
git commit -m "initial: iw changelog setup"

# Auf GitHub pushen (Repo vorher auf github.com anlegen)
git remote add origin https://github.com/DEIN-ORG/iw-changelog.git
git push -u origin main
```

### 2. Figma Token holen

1. figma.com → Account Settings → **Personal access tokens**
2. "Generate new token" → Name: `IW Changelog Bot`
3. Scopes: `File content: Read` aktivieren
4. Token kopieren (wird nur einmal angezeigt)

### 3. Figma File ID ermitteln

Aus der Figma URL: `figma.com/design/**e9id05pwA4x9x8DtJgwWXR**/...`  
→ File ID = `e9id05pwA4x9x8DtJgwWXR`

### 4. GitHub Secrets setzen

Im GitHub Repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret Name      | Wert                          |
|------------------|-------------------------------|
| `FIGMA_TOKEN`    | Dein Figma Personal Token     |
| `FIGMA_FILE_ID`  | `e9id05pwA4x9x8DtJgwWXR`     |

### 5. Netlify verbinden

1. netlify.com → **Add new site → Import an existing project → GitHub**
2. Repo `iw-changelog` auswählen
3. Build settings: alles leer lassen, Publish directory: `/`
4. **Deploy site**
5. Unter Site settings → Change site name: `iw-design-library-changelog`

→ Seite ist live unter: `https://iw-design-library-changelog.netlify.app`

### 6. Figma Webhook registrieren

Einmalig per Terminal ausführen.  
Ersetzt `YOUR_GITHUB_TOKEN`, `YOUR_REPO` und `YOUR_FIGMA_TEAM_ID`:

```bash
# Schritt A: GitHub Actions Webhook-Endpoint ermitteln
# URL: https://api.github.com/repos/YOUR_ORG/iw-changelog/dispatches

# Schritt B: Figma Webhook registrieren
curl -X POST https://api.figma.com/v2/webhooks \
  -H "X-Figma-Token: DEIN_FIGMA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "LIBRARY_PUBLISH",
    "team_id": "DEINE_FIGMA_TEAM_ID",
    "endpoint": "https://api.github.com/repos/DEIN-ORG/iw-changelog/dispatches",
    "passcode": "iw-changelog-secret"
  }'
```

> **Figma Team ID** findest du unter: figma.com/files/team/**TEAM_ID**/...

---

## Workflow nach dem Setup

```
1. Figma Branch erstellen (z.B. "CXI-2010-neue-styles")
2. Änderungen in Figma vornehmen
3. Branch approven lassen
4. Branch mergen + Library publishen
         ↓ automatisch
5. GitHub Action startet (~30 Sek.)
6. Figma API wird abgefragt
7. Diff wird berechnet
8. changelog-data.json wird aktualisiert
9. Netlify deployed die neue Version
         ↓ optional manuell
10. Eintrag in changelog-data.json öffnen
11. Beschreibungstexte verfeinern
12. Commit pushen → Netlify updated nochmal
```

---

## changelog-data.json manuell bearbeiten

Für jeden Release ein Objekt oben in der Liste einfügen:

```json
[
  {
    "version": "v1.3",
    "date": "2026-08-01",
    "ticket": "CXI-2010",
    "ticketUrl": "https://interwetten.atlassian.net/browse/CXI-2010",
    "groups": [
      {
        "title": "Label Scale",
        "items": [
          {
            "type": "new",
            "title": "Label/XS hinzugefügt",
            "desc": "Neue Label-Stufe für 9px Micro-Texte. 9px / lh 12px"
          },
          {
            "type": "changed",
            "title": "Label/S — Größe angepasst",
            "desc": "fontSize: 10px → 11px · lineHeight: 14px → 16px"
          }
        ]
      }
    ],
    "actions": [
      "Developer: Neuen Token --label-xs-size: 9px in globales Stylesheet aufnehmen.",
      "Tester: Label-Komponenten auf korrekte Größe prüfen."
    ]
  },
  ... (bestehende Einträge)
]
```

### Erlaubte `type` Werte

| Wert          | Farbe   | Bedeutung                      |
|---------------|---------|--------------------------------|
| `new`         | Grün    | Neuer Style / Token            |
| `changed`     | Orange  | Wert wurde geändert            |
| `fixed`       | Blau    | Bugfix / Korrektur             |
| `deprecated`  | Grau    | Style wird entfernt            |
| `breaking`    | Rot     | Breaking Change                |

---

## Manuellen Run triggern (ohne Figma Publish)

Im GitHub Repo: **Actions → Figma Changelog Generator → Run workflow**

Optional: Version und Ticket manuell eingeben.

---

## Projektstruktur

```
iw-changelog/
├── index.html                    ← Changelog-Webseite
├── changelog-data.json           ← Einträge (auto + manuell befüllbar)
├── styles-snapshot.json          ← Figma-Stand für Diff-Berechnung
├── README.md
└── .github/
    ├── workflows/
    │   └── figma-changelog.yml   ← GitHub Action
    └── scripts/
        └── generate-changelog.js ← Figma API → JSON Script
```
