Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetDateSave off

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "${PUBLIC_PAYLOAD}"

Name "workbuddy反代胖胖熊助手"
OutFile "${PUBLIC_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\WorkBuddyPangPangXiong"
InstallDirRegKey HKCU "Software\WorkBuddyPangPangXiong" "InstallDir"
VIProductVersion "${PUBLIC_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "workbuddy反代胖胖熊助手"
VIAddVersionKey /LANG=2052 "FileDescription" "WorkBuddy PangPangXiong Setup"
VIAddVersionKey /LANG=2052 "FileVersion" "${PUBLIC_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "WorkBaby contributors"

Var WorkBuddy
Var Workspace
Var Port
Var StateRoot
Var NodeExe
Var NoShortcuts
Var WorkBuddyField
Var WorkspaceField
Var PortField

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom Configuration ConfigurationLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  StrCpy $StateRoot "$LOCALAPPDATA\WorkBuddyPangPangXiong"
  StrCpy $Workspace ""
  StrCpy $Port "0"
  ${GetParameters} $0
  ${GetOptions} $0 "/WORKBUDDY=" $WorkBuddy
  ${GetOptions} $0 "/WORKSPACE=" $Workspace
  ${GetOptions} $0 "/NO_SHORTCUTS=" $NoShortcuts
  ${GetOptions} $0 "/STATE=" $1
  ${If} $1 != ""
    StrCpy $StateRoot $1
  ${EndIf}
  ${GetOptions} $0 "/PORT=" $1
  ${If} $1 != ""
    StrCpy $Port $1
  ${EndIf}
FunctionEnd

Function SelectWorkBuddy
  Pop $0
  nsDialogs::SelectFileDialog open "$WorkBuddy" "WorkBuddyAI.exe|WorkBuddyAI.exe"
  Pop $0
  ${If} $0 != ""
    ${NSD_SetText} $WorkBuddyField $0
  ${EndIf}
FunctionEnd

Function SelectWorkspace
  Pop $0
  nsDialogs::SelectFolderDialog "选择允许访问的工作目录" "$Workspace"
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $WorkspaceField $0
  ${EndIf}
FunctionEnd

Function Configuration
  !insertmacro MUI_HEADER_TEXT "配置 WorkBuddy" "选择本机已安装的 WorkBuddy AI 5.7.6。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == "error"
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "WorkBuddyAI.exe 或安装目录"
  Pop $0
  ${NSD_CreateText} 0 15u 78% 13u "$WorkBuddy"
  Pop $WorkBuddyField
  ${NSD_CreateButton} 80% 14u 20% 15u "浏览..."
  Pop $0
  ${NSD_OnClick} $0 SelectWorkBuddy
  ${NSD_CreateLabel} 0 39u 100% 12u "工作目录（留空时使用本机助手目录）"
  Pop $0
  ${NSD_CreateText} 0 54u 78% 13u "$Workspace"
  Pop $WorkspaceField
  ${NSD_CreateButton} 80% 53u 20% 15u "浏览..."
  Pop $0
  ${NSD_OnClick} $0 SelectWorkspace
  ${NSD_CreateLabel} 0 78u 100% 12u "本机端口（0 表示自动选择）"
  Pop $0
  ${NSD_CreateNumber} 0 93u 30% 13u "$Port"
  Pop $PortField
  ${NSD_Edit_SetTextLimit} $PortField 5
  nsDialogs::Show
FunctionEnd

Function ConfigurationLeave
  ${NSD_GetText} $WorkBuddyField $WorkBuddy
  ${NSD_GetText} $WorkspaceField $Workspace
  ${NSD_GetText} $PortField $Port
  IfFileExists "$WorkBuddy\WorkBuddyAI.exe" valid_workbuddy
  IfFileExists "$WorkBuddy" valid_workbuddy
  MessageBox MB_OK|MB_ICONEXCLAMATION "请选择 WorkBuddyAI.exe 或正确的 WorkBuddy 安装目录。"
  Abort
valid_workbuddy:
FunctionEnd

Function VerifyInstallDirectory
  ReadINIStr $0 "$INSTDIR\workbuddy-setup.ini" "install" "product"
  ${If} $0 == "WorkBuddyPangPangXiong"
    Return
  ${EndIf}
  ClearErrors
  FindFirst $0 $1 "$INSTDIR\*"
  ${If} ${Errors}
    Return
  ${EndIf}
  ${Do}
    ${If} $1 != "."
    ${AndIf} $1 != ".."
      FindClose $0
      SetErrorLevel 3
      MessageBox MB_OK|MB_ICONSTOP "请选择新的或空的安装目录。" /SD IDOK
      Abort
    ${EndIf}
    ClearErrors
    FindNext $0 $1
  ${LoopUntil} ${Errors}
  FindClose $0
FunctionEnd

Section "安装 WorkBuddy 胖胖熊助手"
  ClearErrors
  SearchPath $NodeExe "node.exe"
  ${If} ${Errors}
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "请安装 Node.js 22.16 或更新版本，并确认 node.exe 在 PATH 中。" /SD IDOK
    Abort
  ${EndIf}
  ${If} $WorkBuddy == ""
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "请配置本机 WorkBuddy 安装位置。" /SD IDOK
    Abort
  ${EndIf}
  Call VerifyInstallDirectory
  CreateDirectory "$INSTDIR"
  WriteINIStr "$INSTDIR\workbuddy-setup.ini" "install" "product" "WorkBuddyPangPangXiong"
  !insertmacro PublicInstallFiles
  SetOutPath "$INSTDIR"
  StrCpy $0 '"$NodeExe" "$INSTDIR\scripts\public-desktop.mjs" install --home "$StateRoot" --workbuddy-root "$WorkBuddy" --port "$Port"'
  ${If} $Workspace != ""
    StrCpy $0 '$0 --workspace "$Workspace"'
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=30000 $0
  Pop $0
  Pop $1
  DetailPrint $1
  ${If} $0 != "0"
    FileOpen $2 "$INSTDIR\setup-error.txt" w
    FileWriteUTF16LE $2 "$1"
    FileClose $2
    SetErrorLevel 4
    MessageBox MB_OK|MB_ICONSTOP "配置失败。请检查 WorkBuddy 版本、工作目录和 setup-error.txt。" /SD IDOK
    Abort
  ${EndIf}
  Delete "$INSTDIR\setup-error.txt"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} $NoShortcuts != "1"
    CreateDirectory "$SMPROGRAMS\WorkBuddyPangPangXiong"
    CreateShortCut "$SMPROGRAMS\WorkBuddyPangPangXiong\WorkBuddy 胖胖熊助手.lnk" "$INSTDIR\Start.cmd" '--home "$StateRoot"'
    WriteRegStr HKCU "Software\WorkBuddyPangPangXiong" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WorkBuddyPangPangXiong" "DisplayName" "workbuddy反代胖胖熊助手"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WorkBuddyPangPangXiong" "DisplayVersion" "${PUBLIC_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WorkBuddyPangPangXiong" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteINIStr "$INSTDIR\workbuddy-setup.ini" "install" "registered" "1"
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ReadINIStr $0 "$INSTDIR\workbuddy-setup.ini" "install" "registered"
  ${If} $0 == "1"
    ReadRegStr $0 HKCU "Software\WorkBuddyPangPangXiong" "InstallDir"
    ${If} $0 == $INSTDIR
      Delete "$SMPROGRAMS\WorkBuddyPangPangXiong\WorkBuddy 胖胖熊助手.lnk"
      RMDir "$SMPROGRAMS\WorkBuddyPangPangXiong"
      DeleteRegKey HKCU "Software\WorkBuddyPangPangXiong"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\WorkBuddyPangPangXiong"
    ${EndIf}
  ${EndIf}
  !insertmacro PublicRemoveFiles
  Delete "$INSTDIR\setup-error.txt"
  Delete "$INSTDIR\workbuddy-setup.ini"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
