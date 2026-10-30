# Windows-/Linux-Hintergrundhilfe prüfen

Die Hilfe startet nach der Benutzeranmeldung, wenn eingehende Benachrichtigungen in der Wallet aktiviert sind. Sie erhält ausschließlich allgemeine Ereigniskennungen; das Installationsgeheimnis bleibt im OS-Credential-Store. Keine Zahlung ist für diese Prüfungen nötig.

## Windows

Die App registriert die Aufgabe `TEX8.MoneroFastWallet.Notifications.<Benutzer-SID>` für den aktuellen interaktiven Benutzer mit `LeastPrivilege`, unbegrenzter Laufzeit und Wiederanlauf nach einem Fehler (eine Minute). Eine zusätzliche Minuten-Repetition mit `IgnoreNew` sichert auch einen später endenden kompatiblen Run-Altprozess ab, ohne eine bereits laufende Taskinstanz zu unterbrechen. Sie speichert kein Passwort. Erst nach erfolgreicher Aufgabenregistrierung und Start wird der bekannte ältere HKCU-Run-Eintrag entfernt. Unbekannte Aufgaben/Run-Einträge werden erhalten.

Der Task startet eine private, anhand SHA-256 geprüfte Version der Helper-EXE aus den Appdaten. Das Paket selbst bleibt dadurch bei Updates entsperrt. Ein geänderter Helper ersetzt nur den verifizierten eigenen Task. Frühere private Versionen bleiben für eine mögliche Rücknahme erhalten. Der eigene URI-Handler `tex8-mfw-notification` wird ausschließlich unter HKCU mit einem App-/Benutzer-Marker registriert. Er akzeptiert laut Helpervertrag nur bereits im privaten Journal bekannte Ereignisse; dadurch öffnen auch ältere Toasts nach einem Helper-Neustart die Wallet. Fremde Handler werden nicht überschrieben. Ein wirklich alter Run-Helper ohne Singleton wird dadurch nicht sofort übernommen: Vor der ersten Installation muss geprüft werden, dass kein solcher Altprozess mehr läuft; andernfalls ist ein geordneter Ab-/Anmelde-Handoff nötig.

Read-only prüfen (den tatsächlichen Native-Konfigurationspfad verwenden):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe-notification-agent-windows.ps1 -ConfigPath "C:\Users\USER\AppData\Roaming\com.tex8.monerowallet.desktop\notifications\background-agent.json"
```

`-CrashRestartProbe` beendet ausdrücklich nur den durch Aufgabenbesitz, frischen Health-Snapshot und EXE-Pfad verifizierten eigenen Prozess und wartet bis zu 95 Sekunden auf den Task-Wiederanlauf. Es sendet keinen Push.

## Linux

Die App liest die tatsächlichen privaten ELF-Abhängigkeiten des paketierten Helpers mit `ldd -r`, kopiert ausschließlich diese in eine private versionierte Runtime und validiert die kopierte Closure erneut. Kein verbliebener temporärer AppImage-Pfad ist zulässig. Systembibliotheken werden nicht kopiert. Die Unit erhält den tatsächlichen Native-Appdaten-/Konfigurationspfad, auch bei `XDG_DATA_HOME`, und den stabilen privaten Librarypfad. Eine gescheiterte Unit-Aktivierung stellt die vorherige Unit wieder her.

Für Klickstarts wird der ursprüngliche absolute `APPIMAGE`-Pfad gespeichert. Ein flüchtiger `.mount_`-Startpfad ohne Original wird abgelehnt. Die Installation benötigt nur einen systemd-User-Manager, keine Root-Rechte.

```sh
scripts/probe-notification-agent-linux.sh --config "$XDG_DATA_HOME/com.tex8.monerowallet.desktop/notifications/background-agent.json"
```

Bei nicht gesetztem `XDG_DATA_HOME` den tatsächlichen Pfad unter `~/.local/share` verwenden. `--crash-restart-probe` beendet ausdrücklich nur den anhand User-Service, UID, frischem Health-Snapshot und stabiler Runtime verifizierten eigenen Prozess und wartet bis zu 40 Sekunden auf systemd-Wiederanlauf. Keine VM oder systemweiten Dienste werden gestartet.

Die private Windows-EXE-Kopie benötigt zusätzlich einen tatsächlichen PE-/DLL-Closure-Nachweis am gebauten Windows-Artefakt. Dieser wird durch den Quellcode-/Task-XML-Test nicht ersetzt.

## Noch auf beiden echten Plattformen abnehmen

- Nach Ab-/Anmelden bei geschlossener Wallet existiert genau eine Hilfe; kein Konsolenfenster erscheint.
- Offline, Wiederverbindung und Suspend/Resume: Queue und Empfangsnachweise bleiben erhalten.
- Den vorhandenen Settings-Test einmal verwenden, dann mindestens 60 Sekunden warten. Dieselbe Ereignis-ID muss Queue, OS-Annahme und echten Geräteempfang korrelieren. OS-Annahme bedeutet noch kein sichtbares Banner.
- Normaler Banner-Klick und Aktionsbutton öffnen die Wallet, auch nach Helper-Neustart; bei gesperrter Wallet bleibt das Ereignis bis zum Entsperren erhalten.
- Update und Deaktivierung prüfen: eigener Task/User-Service aktualisiert beziehungsweise stoppt; unbekannte Tasks/Einträge und andere Benutzer bleiben unverändert.

Plattformneutrale Vertrags-/Unit-Tests ersetzen diese Laufzeitabnahme nicht. Die Probeskripte lesen keine OS-Credential-Werte und lösen selbst keine Testbenachrichtigung aus.
