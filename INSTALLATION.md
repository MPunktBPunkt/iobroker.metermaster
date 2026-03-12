# MeterMaster ioBroker Adapter – Installation

## Voraussetzungen
- ioBroker läuft auf deinem Server
- SSH-Zugang oder ioBroker-Konsole
- ioBroker simple-api läuft auf Port 8087 (für ESP32 Node-Verwaltung)

---

## Installation von GitHub (empfohlen)

```bash
cd /opt/iobroker
iobroker url https://github.com/MPunktBPunkt/iobroker.metermaster
iobroker restart metermaster.0
```

---

## Manuelle Installation (offline)

### 1. Dateien kopieren

```bash
mkdir -p /opt/iobroker/node_modules/iobroker.metermaster
# Zielordner: /opt/iobroker/node_modules/iobroker.metermaster/
# Benötigte Dateien: main.js, io-package.json, package.json, admin/
```

### 2. Abhängigkeiten installieren

```bash
cd /opt/iobroker/node_modules/iobroker.metermaster
npm install
```

### 3. Adapter registrieren und starten

```bash
cd /opt/iobroker
iobroker add metermaster
iobroker start metermaster
```

---

## Konfiguration

In ioBroker Admin → Adapter → MeterMaster:

| Einstellung | Standard | Beschreibung |
|---|---|---|
| Port | `8089` | HTTP-Server-Port |
| Benutzername | `metermaster` | Basic-Auth Username |
| Passwort | – | Basic-Auth Passwort |
| Ausführliches Logging | ✅ | Debug-Einträge sichtbar |
| Log-Puffer | `500` | Max. Log-Einträge |
| Historie aufbewahren | `0` | 0 = unbegrenzt |

### Firewall (falls nötig)

```bash
sudo ufw allow 8089/tcp   # Adapter Web-UI + App-Sync
sudo ufw allow 8087/tcp   # simple-api (für ESP32 Nodes)
```

---

## MeterMaster App konfigurieren

Einstellungen → ioBroker → MeterMaster Adapter:

| Feld | Wert |
|---|---|
| Host | IP-Adresse des ioBroker (z.B. `192.168.178.113`) |
| Port | `8089` |
| Benutzer | wie oben konfiguriert |
| Passwort | wie oben konfiguriert |

---

## ESP32 Node-Verwaltung (ab Adapter v0.5.0)

ESP32 Nodes (Firmware v1.5.0+) registrieren sich automatisch, sobald sie im gleichen Netzwerk laufen. Der Node schreibt seinen Heartbeat via ioBroker **simple-api** (Port 8087) — der Adapter erkennt dies automatisch und legt alle States an.

**Voraussetzung:** ioBroker simple-api-Adapter muss auf Port 8087 laufen.

**Angelegte States unter `metermaster.0.nodes.{MAC}`:**
- `ip` – IP-Adresse des ESP32
- `name` – Gerätename
- `version` – Firmware-Version
- `lastSeen` – letzter Heartbeat (ms)
- `config` – Zähler-Konfiguration (Adapter schreibt, ESP32 liest)
- `configAck` – Quittierung durch den ESP32

**Zähler zuweisen:** Web-UI öffnen → Tab **📡 Nodes** → Dropdown → Speichern.  
Der ESP32 übernimmt die neue Konfiguration beim nächsten Config-Poll (alle 15 Sekunden).

---

## Angelegte Datenpunkte (Ablesungen)

```
metermaster.0
  info.connection        – Adapter verbunden
  info.lastSync          – letzter Sync
  info.readingsReceived  – Ablesungen gesamt

  └── {Haus}
       └── {Wohnung}
            └── {Zähler}
                 ├── readings.latest      (Zahl, ts = Ablesedatum)
                 ├── readings.latestDate  (ISO-Datum)
                 ├── readings.history     (JSON-Array)
                 ├── name
                 ├── unit
                 └── typeName

  └── nodes
       └── {MAC}
            ├── ip / name / version / lastSeen / config / configAck
```

---

## Aktualisierung

```bash
iobroker url https://github.com/MPunktBPunkt/iobroker.metermaster
iobroker restart metermaster.0
```

Oder über die Web-UI: Tab **⚙️ System** → „Auf Updates prüfen" → „Update installieren".
