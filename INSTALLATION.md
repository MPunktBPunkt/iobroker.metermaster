# MeterMaster ioBroker Adapter – Installation

## Voraussetzungen
- ioBroker läuft auf deinem Server/Raspberry Pi
- SSH-Zugang oder Zugang zur ioBroker-Konsole

## Installation (lokale Methode – kein Store nötig)

### 1. Dateien auf den ioBroker-Server kopieren

```bash
# Ordner anlegen
mkdir -p /opt/iobroker/node_modules/iobroker.metermaster

# Alle Dateien in diesen Ordner kopieren:
# - main.js
# - io-package.json
# - package.json
```

Am einfachsten per **USB-Stick**, **SCP** oder direkt per **WinSCP / FileZilla**:
- Zielordner: `/opt/iobroker/node_modules/iobroker.metermaster/`

### 2. Abhängigkeiten installieren

```bash
cd /opt/iobroker/node_modules/iobroker.metermaster
npm install
```

### 3. Adapter in ioBroker registrieren

```bash
cd /opt/iobroker
iobroker add metermaster
```

### 4. Instanz konfigurieren

In ioBroker Admin → Adapter → MeterMaster (erscheint nach `iobroker add`):
- **Port**: `8089` (oder anderer freier Port)
- **Benutzername**: z. B. `metermaster`
- **Passwort**: sicheres Passwort wählen
- **Historie aufbewahren**: `0` = alle, oder z.B. `120` für 10 Jahre monatliche Ablesungen

### 5. Adapter starten

```bash
iobroker start metermaster
```

Im ioBroker-Log sollte erscheinen:
```
MeterMaster Adapter gestartet. Port: 8089
HTTP-Server lauscht auf Port 8089
```

### 6. Firewall (falls nötig)

```bash
# Port 8089 öffnen (nur im lokalen Netz nötig)
sudo ufw allow 8089/tcp
```

### 7. MeterMaster App konfigurieren

In der App → Einstellungen → ioBroker → **MeterMaster Adapter**:
- **Host**: IP-Adresse deines ioBroker (z.B. `192.168.178.113`)
- **Port**: `8089`
- **Benutzer**: `metermaster`
- **Passwort**: das oben gewählte Passwort

---

## Angelegte Datenpunkte

Nach dem ersten Sync erscheinen unter `metermaster.0`:

```
metermaster.0
  └── MeinHaus
       └── Westerheim
            └── Warmwasser
                 ├── readings.latest       (Zahl, mit korrektem Zeitstempel)
                 ├── readings.latestDate   (ISO-Datum der Ablesung)
                 ├── readings.history      (JSON-Array aller Ablesungen)
                 ├── name                  (Zählername)
                 ├── unit                  (Einheit)
                 └── typeName              (Zählertyp)
```

**`readings.history` Format:**
```json
[
  { "value": 125.3, "unit": "m³", "readingDate": "2024-01-15T10:00:00.000Z", "ts": 1705312800000 },
  { "value": 128.7, "unit": "m³", "readingDate": "2024-02-12T09:30:00.000Z", "ts": 1707729000000 }
]
```

---

## HTTP API

### Verbindungstest
```
GET http://192.168.178.113:8089/api/ping
→ { "ok": true, "adapter": "metermaster", "version": "0.3.2" }
```

### Einzelne Ablesung
```
POST http://192.168.178.113:8089/api/reading
Authorization: Basic base64(user:passwort)
Content-Type: application/json

{
  "house":       "MeinHaus",
  "apartment":   "Westerheim",
  "meter":       "Warmwasser",
  "value":       128.75,
  "unit":        "m³",
  "typeName":    "Warmwasser",
  "readingDate": "2024-02-12T09:30:00.000Z"
}
```

### Mehrere Ablesungen (Batch)
```
POST http://192.168.178.113:8089/api/readings
Authorization: Basic base64(user:passwort)
Content-Type: application/json

[ { ... }, { ... }, { ... } ]
```

---

## Aktualisierung

Wenn du neue Zähler in der App anlegst, werden die Datenpunkte beim ersten Sync
**automatisch** in ioBroker angelegt – kein manuelles Eingreifen nötig.
