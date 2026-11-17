# ioBroker.chihiros – Beschreibung (Deutsch)

Bindet Chihiros-Aquariengeräte (Licht WRGB II, Dosierpumpe, CO2-Steuerung, Doctor, Lüfter) per **Bluetooth** an ioBroker an –
ohne Chihiros-Cloud und ohne WiFi-Hub. Der Adapter erreicht die Geräte über einen **ESPHome-Bluetooth-Proxy** in der Nähe des Aquariums.

Stand: frühe Version, **nur lesen**. Geräte steuern folgt in den nächsten Versionen.

## Funktionen (bisher)

- Verbindung zu einem ESPHome-Bluetooth-Proxy (API-Verschlüsselung empfohlen), Wiederverbinden mit wachsender Wartezeit
- Je Gerät: wird es gehört (`reachable`), wann zuletzt (`lastSeen`), Signalstärke (`rssi`), Bluetooth-Name
- Warnung im Log, wenn ein Gerät fehlt; **saisonale** Geräte (z. B. Lüfter nur im Sommer) ohne Warnung
- Neu abonnieren, wenn der Proxy keine Meldungen mehr weiterreicht (seit ESPHome 2026.7 übernimmt ein zweiter API-Client sie)
- **Werte lesen**: alle erreichbaren Geräte nacheinander in kurzen Bluetooth-Verbindungen (Standard alle 5 Minuten, je Gerät 1–2 s). Es werden nur Abfragen gesendet, keine Uhrzeit gestellt, nichts verändert.
  - Dosierpumpe: dosierte ml je Pumpe gesamt und heute
  - Licht: Uhr des Geräts, Zeitplan (An-Zeiten, Punkte), Stufe laut Zeitplan jetzt
  - Doctor: Wassertemperatur
  - Lüfter: Wasser- und Raumtemperatur, Luftfeuchte
  - CO2-Steuerung: nur erreichbar (sie meldet keinen Ventilzustand)

## Voraussetzungen

- js-controller >= 6.0.11, admin >= 7.6.20, Node.js >= 22
- ESPHome-Bluetooth-Proxy (empfohlen ESPHome >= 2026.10.2) in Funkreichweite, nur von diesem Adapter benutzt
- Die Geräte dürfen **nicht** von der Chihiros-App oder dem WiFi-Hub gehalten werden: Ein verbundenes Gerät sendet nichts und nimmt nur eine Verbindung an. In der App vom Hub entkoppeln.

## Einstellungen

| Feld | Bedeutung |
|---|---|
| Proxy (Hostname oder IP) | ESPHome-Proxy am Aquarium |
| API-Verschlüsselungsschlüssel | `api: encryption: key` des Proxys (Base64), wird verschlüsselt gespeichert |
| Fehlt nach (Minuten) | So lange darf ein Gerät schweigen (Standard 5) |
| Abfrage-Intervall (Minuten) | So oft werden alle erreichbaren Geräte gelesen (Standard 5); bei offener App kann ein Gerät nicht gelesen werden |
| Geräte | Name, Typ, MAC-Adresse und „saisonal“ je Gerät |

## Sicherheit

Chihiros-Geräte nutzen Bluetooth ohne Kopplung: Jeder in Funkreichweite kann sie steuern. Der Adapter spricht nur die
eingetragenen MAC-Adressen an und probiert keine Befehle aus. Siehe [SECURITY.md](../../SECURITY.md).
