; Teti's protected Profile and WebView data are intentionally outside $INSTDIR.
; These hooks stay explicit so future installer changes cannot silently acquire
; ownership of user identity or language preference data during upgrade/uninstall.

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
