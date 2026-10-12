!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ReadRegStr $0 HKCU "Software\Classes\AppUserModelId\${BUNDLEID}" "CustomActivator"
    ${If} $0 != ""
      DeleteRegKey HKCU "Software\Classes\CLSID\$0"
    ${EndIf}
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\${BUNDLEID}"
  ${EndIf}
!macroend
