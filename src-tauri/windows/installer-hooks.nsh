!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\活動・進捗管理.lnk" "$INSTDIR\team-mgt.exe" "" "$INSTDIR\team-mgt.exe" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\活動・進捗管理.lnk"
!macroend
