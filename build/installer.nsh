; ---------------------------------------------------------------------------
;  Custom installer behaviour, merged into electron-builder's own NSIS script.
;
;  Two jobs:
;    1. refuse to install on a Windows this app cannot work on, with a reason
;    2. leave nothing behind on uninstall
;
;  Both include guards below are no-ops if electron-builder already pulled the
;  header in; NSIS's own headers are idempotent.
; ---------------------------------------------------------------------------
!include "x64.nsh"
!include "WinVer.nsh"

; Windows 10 1809. Not an arbitrary line: below it there is no
; Windows.Media.Control, which is what the now-playing panel, the transport
; controls and the lyrics timing are all built on, and Chromium's WASAPI
; loopback capture is unreliable. The visuals alone would work; three of the
; four features would silently not.
!define MIN_BUILD 17763

!macro customInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP \
      "Black Hole Visualizer needs 64-bit Windows.$\r$\n$\r$\n\
       This PC is running a 32-bit version."
    Abort
  ${EndIf}

  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP \
      "Black Hole Visualizer needs Windows 10 or newer."
    Abort
  ${EndIf}

  ReadRegStr $R9 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $R9 < ${MIN_BUILD}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION \
      "This is Windows 10 build $R9. Black Hole Visualizer expects build \
       ${MIN_BUILD} (version 1809) or newer.$\r$\n$\r$\n\
       The visuals will work, but reading what is playing, the transport \
       controls and the synced lyrics all need a newer Windows and will stay \
       empty.$\r$\n$\r$\n\
       Install anyway?" IDYES +2
    Abort
  ${EndIf}
!macroend

; Guarded on ${isUpdated} because this macro also runs when an installer
; replaces an older version -- without the guard, every update would wipe the
; user's settings on the way through.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; The optional "start with Windows" shortcut, which the app writes for
    ; itself from the tray menu rather than at install time.
    Delete "$SMSTARTUP\Black Hole Visualizer.lnk"

    ; Settings and Chromium's cache. Named after package.json's `name`, not
    ; productName: that is what Electron uses for app.getPath('userData').
    RMDir /r "$APPDATA\blackhole-visualizer"
  ${endIf}
!macroend
