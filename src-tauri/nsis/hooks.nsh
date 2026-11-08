; Fetchweir 安装/卸载钩子。
;
; 为什么需要它：
;  · 1.0.5 起的 NSIS 卸载器只删除自己分发过的文件。1.0.4 及更早版本随包带的
;    WebView2Loader.dll 在升级后仍会留在程序目录里，卸载时没人删它，目录就删不掉。
;  · 浏览器 Native Messaging 注册是应用运行时写进 HKCU 的，卸载器本身不知道。
;    卸载后宿主 exe 已不存在，注册留着会让扩展反复尝试拉起一个已删除的进程。
;
; 注意：安装时不能盲目删 WebView2Loader.dll —— 本地 MinGW 构建的 exe 仍动态依赖它，
; 只有 CI 的 MSVC 构建才是静态链接。所以这里只在卸载阶段清理。

!macro NSIS_HOOK_POSTUNINSTALL
  ; 更新流程（/UPDATE）不清注册：安装器随后会拉起新版本，应用启动时会重新注册。
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\dev.fetchweir.nmh"
    DeleteRegKey HKCU "Software\Chromium\NativeMessagingHosts\dev.fetchweir.nmh"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\dev.fetchweir.nmh"
    DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\dev.fetchweir.nmh"
    DeleteRegKey HKCU "Software\Vivaldi\NativeMessagingHosts\dev.fetchweir.nmh"
    DeleteRegKey HKCU "Software\Mozilla\NativeMessagingHosts\dev.fetchweir.nmh"
    Delete "$APPDATA\Fetchweir\nm\dev.fetchweir.nmh.json"
    Delete "$APPDATA\Fetchweir\nm\dev.fetchweir.nmh.firefox.json"
  ${EndIf}
  ; 兜底：老版本残留的已知文件若仍在，删掉后尝试移除空目录（目录非空时 RMDir 会失败，不会误删）。
  Delete "$INSTDIR\WebView2Loader.dll"
  RMDir "$INSTDIR"
!macroend
