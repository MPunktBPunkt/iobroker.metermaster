# MeterMaster Adapter – Installationsanleitung

> Vollständige Schritt-für-Schritt-Anleitung für die Installation des `iobroker.metermaster`-Adapters.

---

## Voraussetzungen

- ioBroker installiert und aktiv
- Node.js ≥ 16 (empfohlen: Node 20 LTS)
- Port **8089** auf dem ioBroker-Server erreichbar (ggf. Firewall öffnen)
- ioBroker **Simple-API Adapter** installiert und aktiv (Port 8087) – wird vom ESP32 Node benötigt

---

## Option A – Installation von GitHub (empfohlen)

```bash
# Adapter installieren
iobroker add https://github.com/MPunktBPunkt/iobroker.metermaster

# Adapter starten
iobroker start metermaster
```

Zur Bestätigung im ioBroker-Log:
```
[SYSTEM] MeterMaster Adapter v0.7.0 gestartet — Port: 8089 | Logging: ausführlich
[SYSTEM] Lauscht auf Port 8089 — Web-UI: http://IP:8089/
```

---

## Option B – Manuelle Installation (Offline / ohne GitHub-Zugang)

```bash
# 1. Zielordner anlegen
mkdir -p /opt/iobroker/node_modules/iobroker.metermaster
mkdir -p /opt/iobroker/node_modules/iobroker.metermaster/admin

# 2. Dateien übertragen (per USB, SCP, WinSCP o.ä.)
#    Pflichtdateien:
#      main.js
#      io-package.json
#      package.json
#      admin/jsonConfig.json
#      admin/metermaster.svg   (optional, für das Icon im ioBroker Admin)

# 3. Abhängigkeiten installieren
cd /opt/iobroker/node_modules/iobroker.metermaster
npm install

# 4. Adapter bei ioBroker registrieren
cd /opt/iobroker
iobroker add metermaster

# 5. Adapter starten
iobroker start metermaster
```

---

## Instanz konfigurieren

Im ioBroker Admin unter **Adapter → MeterMaster** eine neue Instanz anlegen:

| Einstellung | Standard | Beschreibung |
|---|---|---|
| HTTP Port | `8089` | Port auf dem der Adapter lauscht |
| Benutzername | `metermaster` | Basic-Auth Username |
| Passwort | – | Basic-Auth Passwort |
| Ausführliches Logging | ✅ | DEBUG-Einträge im Web-UI Log-Viewer anzeigen |
| Log-Puffer | `500` | Max. gespeicherte Log-Einträge |
| Historie aufbewahren | `0` | 0 = unbegrenzt, sonst max. Einträge pro Zähler |

---

## Firewall öffnen (falls nötig)

```bash
sudo ufw allow 8089/tcp
sudo ufw reload
```

---

## MeterMaster App verbinden

In der App unter **Einstellungen → ioBroker → MeterMaster Adapter**:

| Feld | Wert |
|---|---|
| ioBroker aktivieren | ✅ |
| IP / Hostname | IP-Adresse des ioBroker-Servers |
| Adapter-Port | `8089` |
| Benutzername | wie im Adapter konfiguriert |
| Passwort | wie im Adapter konfiguriert |

„Verbindung testen" → `MeterMaster-Adapter erreichbar ✓`

---

## ESP32 Node verbinden (optional)

Der [MeterMaster ESP32 Node](https://github.com/MPunktBPunkt/esp32.MeterMaster) verbindet sich automatisch. Voraussetzungen:

- Im ESP32 Einstellungen-Tab: ioBroker-IP und **Adapter-Port `8089`** eintragen
- Der Simple-API Adapter muss auf Port **8087** laufen (für Zählerwerte-Abruf)
- Nach dem nächsten Heartbeat (max. 60 s) erscheint der Node im **Nodes-Tab** der Web-UI

---

## Update

### Über die Web-UI (empfohlen)
```
http://{IP}:8089/ → Tab ⚙️ System → „Auf Updates prüfen" → „Update installieren"
```

### Kommandozeile
```bash
iobroker upgrade metermaster https://github.com/MPunktBPunkt/iobroker.metermaster
iobroker restart metermaster
```

### Manuell (Offline)
```bash
# Neue Dateien nach /opt/iobroker/node_modules/iobroker.metermaster/ kopieren
cd /opt/iobroker/node_modules/iobroker.metermaster
npm install
iobroker restart metermaster
```

---

## Deinstallation

```bash
iobroker del metermaster
# Optional: Verzeichnis entfernen
rm -rf /opt/iobroker/node_modules/iobroker.metermaster
```

---

## Fehlerbehebung

**Adapter startet nicht**
```bash
# Log prüfen
iobroker logs metermaster --lines 50
# Adapter manuell starten
node /opt/iobroker/node_modules/iobroker.metermaster/main.js
```

**Port belegt**
```bash
sudo lsof -i :8089
# Oder anderen Port in der Adapter-Konfiguration wählen
```

**Web-UI nicht erreichbar**
```bash
# Adapter-Status prüfen
iobroker status metermaster
# Firewall prüfen
sudo ufw status
```

**ESP32 erscheint nicht im Nodes-Tab**
- Prüfen ob ESP32 und ioBroker im selben Netzwerk sind
- Im ESP32 Einstellungen-Tab: Adapter-Port auf `8089` prüfen
- Im Adapter-Log nach `[NODE] Heartbeat` suchen
