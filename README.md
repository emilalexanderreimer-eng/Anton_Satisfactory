# Anton Satisfactory Planner

Ein Produktionsplaner für **Satisfactory**, ähnlich dem Satisfactory Production Planner —
als rein statische Website (HTML/CSS/JS, kein Build-Schritt nötig).

## Funktionen

- **Produktionsziele**: beliebig viele Ziel-Items mit Rate (Stück/min bzw. m³/min) festlegen
- **Automatische Produktionskette**: berechnet alle benötigten Zwischenprodukte, Maschinen und Rohstoffe
- **Rezeptauswahl**: Standard- und Alternativ-Rezepte pro Produkt frei wählbar
- **Nebenprodukte** werden automatisch gegen den Bedarf verrechnet
- **Stromverbrauch** inkl. korrekter Untertaktungs-Skalierung (Exponent 1,321929 wie im Spiel)
- **0,25-Modifikator (Update 1.2)**: ein Klick setzt alle Rezepte/Maschinen auf 25 % Taktung —
  alternativ ist jede beliebige Taktung von 1–250 % einstellbar
- Einstellungen werden im Browser gespeichert (localStorage)

## Nutzung

Einfach `index.html` im Browser öffnen — oder lokal starten mit:

```
python -m http.server 8123
```

und http://localhost:8123 aufrufen.

Für GitHub Pages: in den Repository-Einstellungen unter *Pages* den Branch `main` (Root) auswählen.

## Daten

- `data.js` wird aus dem Community-Datensatz von [SatisfactoryTools](https://github.com/greeny/SatisfactoryTools) generiert
  (aktuellster öffentlich verfügbarer Datenstand; das Generator-Skript filtert auf Maschinen-Rezepte
  und rechnet Flüssigkeitsmengen von Litern in m³ um)

Kein offizielles Produkt von Coffee Stain Studios.
