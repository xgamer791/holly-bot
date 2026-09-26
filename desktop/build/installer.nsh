; Holly Bot Computer for Windows' installer (electron-builder's NSIS, package.json "build").
;
; Uninstalling takes Holly Bot Computer out of what starts with Windows (the app
; puts it there: src/main.js loginItem, under the name it had before it was
; Holly Bot Computer). An update leaves it: the new version carries on
; starting with Windows. Holly Bot Computer's own files (~\.holly) and the
; bots' workspace (~\Holly) stay, like the bots in your account.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Holly Computer"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Holly Computer"
  ${endIf}
!macroend
