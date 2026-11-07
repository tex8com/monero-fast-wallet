; Tauri CLI 2.12.1 calls this before deleting bundle resources. /UPDATE is
; reserved for replacement, never notification opt-out or wallet-data removal.
!macro NSIS_HOOK_PREUNINSTALL
  ; Wallets and recovery credentials are not disposable application settings.
  ; Override Tauri's broad AppData deletion even if its checkbox was selected.
  StrCpy $DeleteAppDataCheckboxState 0
  ${If} $UpdateMode <> 1
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    Push $0
    Push $1
    Push $2
    StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
    ; The NSIS launcher is 32-bit; use native PowerShell/registry on ARM64/x64.
    ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
      StrCpy $2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    ${EndIf}
    nsExec::ExecToStack /TIMEOUT=45000 '"$2" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\uninstall-notification-agent.ps1" -InstallDirectory "$INSTDIR"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      DetailPrint "Notification cleanup failed: $1"
      MessageBox MB_OK|MB_ICONSTOP "Windows notification cleanup failed. Close the wallet and try uninstalling again. Wallet data has been preserved."
      Pop $2
      Pop $1
      Pop $0
      SetErrorLevel 2
      Abort
    ${EndIf}
    DetailPrint "Background notifications removed. Wallet data has been preserved."
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

; Early local installations placed the helper next to the main executable.
; That obsolete reserved path shadows the packaged target/release resource.
; Migrate on fresh installs and updates alike, without touching the task or
; notification configuration. A locked legacy executable must fail visibly.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\monero-fast-walletd.exe"
    ${IfNot} ${FileExists} "$INSTDIR\target\release\monero-fast-walletd.exe"
      MessageBox MB_OK|MB_ICONSTOP "The packaged notification helper is missing. Setup could not complete. Wallet data has been preserved."
      SetErrorLevel 2
      Abort
    ${EndIf}
    ClearErrors
    Delete "$INSTDIR\monero-fast-walletd.exe"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "The old notification helper is still in use. Close Monero Fast Wallet and its notification helper, then run Setup again. Wallet data has been preserved."
      SetErrorLevel 2
      Abort
    ${EndIf}
    DetailPrint "Obsolete notification helper removed. The packaged helper will be used."
  ${EndIf}
!macroend
