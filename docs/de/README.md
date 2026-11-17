# ioBroker.chihiros – Beschreibung (Deutsch)

Bindet Chihiros-Aquariengeräte (Licht WRGB II, Dosierpumpe, CO2-Steuerung, Doctor, Lüfter) per **Bluetooth** an ioBroker an –
ohne Chihiros-Cloud und ohne WiFi-Hub. Der Adapter erreicht die Geräte über einen **ESPHome-Bluetooth-Proxy** in der Nähe des Aquariums.

Stand: frühe Version. Alle Geräte lesen, Licht steuern, Handdosis der Dosierpumpe, Lüfterstufe. Weitere Befehle folgen in den nächsten Versionen.

## Funktionen (bisher)

- Verbindung zu einem ESPHome-Bluetooth-Proxy (API-Verschlüsselung empfohlen), Wiederverbinden mit wachsender Wartezeit
- Je Gerät: wird es gehört (`reachable`), wann zuletzt (`lastSeen`), Signalstärke (`rssi`), Bluetooth-Name
- Warnung im Log, wenn ein Gerät fehlt; **saisonale** Geräte (z. B. Lüfter nur im Sommer) ohne Warnung
- Neu abonnieren, wenn der Proxy keine Meldungen mehr weiterreicht (seit ESPHome 2026.7 übernimmt ein zweiter API-Client sie)
- **Werte lesen**: alle erreichbaren Geräte nacheinander in kurzen Bluetooth-Verbindungen (Standard alle 5 Minuten, je Gerät 1–2 s). Beim Lesen werden nur Abfragen gesendet (und bei Bedarf die Uhr gestellt, siehe unten).
  - Dosierpumpe: dosierte ml je Pumpe gesamt und heute
  - Licht: Uhr des Geräts, Zeitplan (An-Zeiten wie in der App, Dauer Sonnenaufgang/-untergang, Punkte), Rot laut Zeitplan jetzt. Grün, Blau und Weiß meldet das Licht nicht zurück; die App führt diese Werte selbst.
  - Doctor: Wassertemperatur
  - Lüfter: Wasser- und Raumtemperatur, Luftfeuchte
  - CO2-Steuerung: nur erreichbar (sie meldet keinen Ventilzustand)
- **Licht steuern**: Rot, Grün, Blau, Weiß (0–255) und an/aus (`red`, `green`, `blue`, `white`, `on`). Befehle warten auf eine laufende Abfrage und laufen in einer eigenen kurzen Verbindung (Anmelden, Uhr, Befehl). Das Licht meldet die Werte nicht zurück: Die Datenpunkte zeigen, was der Adapter zuletzt gesetzt hat (`commandResult`: „sent, not confirmed“). Änderungen in der App sieht der Adapter nicht.
- **Handdosis** der Dosierpumpe: ml in `pumpN.doseNow` schreiben (0,1–5 je Befehl, Sicherheitsgrenze). Etwa 15 s plus 6 s je ml später liest der Adapter den Gesamtzähler: `commandResult` meldet „confirmed: pump N total a -> b ml“ oder „not confirmed“.
- **Lüfterstufe** 0–20 (0 = aus) in `level`. Der Lüfter meldet seine Stufe nicht: Der Datenpunkt zeigt, was der Adapter zuletzt gesetzt hat. Die Temperatursteuerung der App wird noch nicht unterstützt.
- **Leistungsmessung** (optional, Lüfter und CO2-Steuerung): Mit einem Leistungs-Datenpunkt je Gerät (z. B. Shelly-Steckdose, wird nur gelesen, nie geschaltet) zeigt der Adapter `running` (Lüfter, ab 0,5 W) bzw. `valveOpen` (CO2, ab 1 W). Nach jedem Stufenbefehl prüft er 10 s später die Leistung; läuft der Lüfter nicht an, stößt er ihn wie in der App an (Stufe 11, 4, dann die gewünschte Stufe) und prüft erneut. `commandResult`: „confirmed: running“, „confirmed after kick“ oder „not running after kick“ (Warnung).
- **Uhr der Geräte stellen** (abschaltbar): beim Licht ab 2 Minuten Abweichung, bei den anderen Geräten nach dem Adapterstart, wenn sie wieder gehört werden (z. B. nach Stromausfall) und einmal am Tag. Jeder Befehl stellt die Uhr mit, wie die App.

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
| Uhr der Geräte stellen | Uhren automatisch stellen (siehe oben), Standard an |
| Geräte | Name, Typ, MAC-Adresse, „saisonal“ und optional ein Leistungs-Datenpunkt (W) je Gerät |

## Sicherheit

Chihiros-Geräte nutzen Bluetooth ohne Kopplung: Jeder in Funkreichweite kann sie steuern. Der Adapter spricht nur die
eingetragenen MAC-Adressen an und probiert keine Befehle aus. Siehe [SECURITY.md](../../SECURITY.md).
