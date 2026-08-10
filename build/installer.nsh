; Register the bridge during installation, even when the user does not launch
; Mosaic from the finish page. Library/profile data is never removed here.
!macro customInstall
  ExecWait '"$INSTDIR\Mosaic.exe" --register-native-host'
!macroend

; A browser extension without its desktop companion must not retain a stale
; native-host registration after Mosaic is removed.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.indeck.mastervision"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.indeck.mastervision"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.indeck.mastervision"
  Delete "$LOCALAPPDATA\InDeck\native-messaging\com.indeck.mastervision.json"
  RMDir "$LOCALAPPDATA\InDeck\native-messaging"
!macroend
