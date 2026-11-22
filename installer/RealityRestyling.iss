[Setup]
AppId={{DA4D8C60-7C90-49B7-BE1E-844183982AA1}
AppName=Reality Restyling
AppVersion={#AppVersion}
AppPublisher=Max Vorwaller
DefaultDirName={localappdata}\Programs\Reality Restyling
DefaultGroupName=Reality Restyling
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
WizardStyle=modern
OutputDir=..
OutputBaseFilename=RealityRestylingSetup
Compression=lzma2/ultra64
SolidCompression=yes
UninstallDisplayName=Reality Restyling

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\app.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\hardware_check.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\phone_access.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\user_styles.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\log_retention.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\runtime.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\runtime_settings.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\preferences.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\timing.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\sessions.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\local_frames.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\webrtc_track.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\model_setup.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\runtime_cleanup.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\upscaler_models\*"; DestDir: "{app}\upscaler_models"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\updates.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\updater.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#LauncherExe}"; DestDir: "{app}"; DestName: "RealityRestyling.exe"; Flags: ignoreversion
Source: "{#BundledPythonDir}\*"; DestDir: "{app}\python"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\run.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\launcher.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\setup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "repair-runtime.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\NOTICE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-flow.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Reality Restyling"; Filename: "{app}\RealityRestyling.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Reality Restyling"; Filename: "{app}\RealityRestyling.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[InstallDelete]
Type: files; Name: "{app}\web\transport.js"
Type: files; Name: "{app}\run.bat"
Type: files; Name: "{app}\launcher.py"
Type: files; Name: "{app}\launcher_ipc.py"
Type: files; Name: "{group}\Reality Restyling (Phone).lnk"
Type: files; Name: "{group}\Setup Guide.lnk"
Type: files; Name: "{app}\web\styles\infrared-film.webp"
Type: files; Name: "{app}\web\styles\bleach-bypass.webp"
Type: files; Name: "{app}\web\styles\cool-chrome.webp"

[Run]
Filename: "{app}\RealityRestyling.exe"; Parameters: "--first-launch"; Description: "Start app and open browser"; WorkingDir: "{app}"; Flags: postinstall skipifsilent nowait runhidden unchecked; Check: IsRuntimeSetupSucceeded

[UninstallDelete]
Type: files; Name: "{app}\version.txt"
Type: files; Name: "{app}\version.pending"
Type: filesandordirs; Name: "{app}\.runtime"
Type: filesandordirs; Name: "{app}\.venv"
Type: filesandordirs; Name: "{app}\__pycache__"
Type: filesandordirs; Name: "{app}\web\__pycache__"
Type: dirifempty; Name: "{app}"

[Code]
var
  ModelPage: TInputOptionWizardPage;
  ModelDirPage: TInputQueryWizardPage;
  UpscalerPage: TInputOptionWizardPage;
  TailscalePage: TInputOptionWizardPage;
  RuntimeSetupAttempted: Boolean;
  RuntimeSetupSucceeded: Boolean;
  RuntimeSetupCanceled: Boolean;
  IsUpdateInstall: Boolean;

function MoveFileEx(ExistingFile, NewFile: String; Flags: DWORD): Boolean;
  external 'MoveFileExW@kernel32.dll stdcall';

function InitializeSetup: Boolean;
begin
  IsUpdateInstall := RegKeyExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{DA4D8C60-7C90-49B7-BE1E-844183982AA1}_is1');
  Result := True;
end;

function IsRuntimeSetupSucceeded: Boolean;
begin
  Result := RuntimeSetupSucceeded;
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := 0;
  if RuntimeSetupAttempted and not RuntimeSetupSucceeded then begin
    if RuntimeSetupCanceled then
      Result := 130
    else
      Result := 10;
  end;
end;

function CleanModelPath(const Input: String): String;
begin
  Result := Trim(Input);
  if Length(Result) >= 2 then
    if (Result[1] = '"') and (Result[Length(Result)] = '"') then
      Result := Trim(Copy(Result, 2, Length(Result) - 2));
  StringChangeEx(Result, '/', '\', True);
end;

function ModelFolderError(var Path: String; Existing: Boolean): String;
var
  Location: String;
begin
  Result := '';
  if ((Length(Path) < 3) or ((Copy(Path, 2, 2) <> ':\') and
     (Copy(Path, 1, 2) <> '\\'))) or (Pos('"', Path) > 0) then begin
    Result := 'Paste a full Windows path or click Browse.';
    Exit;
  end;

  Location := Path;
  if Existing and not DirExists(Path) then begin
    if CompareText(ExtractFileExt(Path), '.safetensors') = 0 then begin
      if FileExists(Path) then
        Path := ExtractFileDir(Path)
      else
        Result := 'Could not open the model file:';
    end else
      Result := 'Could not open the model folder:';
  end else if not Existing and FileExists(Path) then
    Result := 'Choose a folder for the download:';

  if Result <> '' then begin
    Result := Result + #13#10 + Location;
    if Length(Location) >= 260 then
      Result := Result + #13#10#13#10 + 'Try a shorter model folder path.';
  end;
end;

procedure BrowseModelFolder(Sender: TObject);
var
  Folder: String;
begin
  Folder := CleanModelPath(ModelDirPage.Values[0]);
  if FileExists(Folder) then
    Folder := ExtractFileDir(Folder);
  if BrowseForFolder('Select the model folder', Folder, False) then
    ModelDirPage.Values[0] := Folder;
end;

procedure InitializeWizard;
var
  BrowseButton: TNewButton;
begin
  ModelPage := CreateInputOptionPage(wpSelectDir, 'Model files', 'Choose your model setup', 'Select whether to reuse existing model files, download them now, or do this later.', True, False);
  ModelPage.Add('Use existing model files');
  ModelPage.Add('Download the model (about 22.4 GB)');
  ModelPage.Add('Later (app cannot restyle until the model is downloaded)');
  ModelPage.SelectedValueIndex := 1;

  ModelDirPage := CreateInputQueryPage(ModelPage.ID, 'Model location', 'Select model files', 'Browse to a folder or paste a folder or model file path.');
  ModelDirPage.Add('Model path:', False);
  ModelDirPage.Values[0] := ExpandConstant('{localappdata}\Reality Restyling\Models');
  ModelDirPage.Edits[0].Width := ModelDirPage.SurfaceWidth - ScaleX(88);
  BrowseButton := TNewButton.Create(ModelDirPage);
  BrowseButton.Parent := ModelDirPage.Surface;
  BrowseButton.Caption := SetupMessage(msgButtonWizardBrowse);
  BrowseButton.Left := ModelDirPage.SurfaceWidth - ScaleX(78);
  BrowseButton.Top := ModelDirPage.Edits[0].Top - 1;
  BrowseButton.Width := ScaleX(78);
  BrowseButton.Height := WizardForm.NextButton.Height;
  BrowseButton.OnClick := @BrowseModelFolder;

  UpscalerPage := CreateInputOptionPage(ModelDirPage.ID, 'Upscaler', 'Choose the upscaler', 'One upscaler will be installed.', True, False);
  UpscalerPage.Add('SPANV2 4×');
  UpscalerPage.Add('Compact 2×');
  UpscalerPage.SelectedValueIndex := 0;

  TailscalePage := CreateInputOptionPage(UpscalerPage.ID, 'Phone access', 'Connect a phone (optional)', 'Enable phone access now or later from the launcher.', False, False);
  TailscalePage.Add('Enable phone access (install Tailscale if needed)');
  TailscalePage.Values[0] := False;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and RuntimeSetupAttempted and not RuntimeSetupSucceeded then begin
    if RuntimeSetupCanceled then begin
      WizardForm.FinishedHeadingLabel.Caption := 'Setup was canceled';
      WizardForm.FinishedLabel.Caption := 'The local runtime is not ready, and Reality Restyling was not launched. Run the installer again to continue.';
    end else begin
      WizardForm.FinishedHeadingLabel.Caption := 'Setup needs attention';
      WizardForm.FinishedLabel.Caption := 'The local runtime setup failed, and Reality Restyling was not launched. Run the installer again to retry.';
    end;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (IsUpdateInstall and ((PageID = wpSelectDir) or (PageID = ModelPage.ID) or
    (PageID = ModelDirPage.ID) or (PageID = UpscalerPage.ID) or (PageID = TailscalePage.ID))) or
    ((PageID = ModelDirPage.ID) and (ModelPage.SelectedValueIndex = 2));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Path, ErrorText: String;
begin
  Result := True;
  if CurPageID = ModelDirPage.ID then begin
    Path := CleanModelPath(ModelDirPage.Values[0]);
    ErrorText := ModelFolderError(Path, ModelPage.SelectedValueIndex = 0);
    if ErrorText <> '' then begin
      MsgBox(ErrorText, mbError, MB_OK);
      WizardForm.ActiveControl := ModelDirPage.Edits[0];
      Result := False;
    end else
      ModelDirPage.Values[0] := Path;
  end;
end;

function GetInstallParameters(Param: String): String;
var
  ModeName, ModelPath, UpscalerId: String;
begin
  case ModelPage.SelectedValueIndex of
    0: ModeName := 'existing';
    1: ModeName := 'download';
  else
    ModeName := 'later';
  end;
  if ModelPage.SelectedValueIndex = 2 then
    ModelPath := ExpandConstant('{localappdata}\Reality Restyling\Models')
  else
    ModelPath := ModelDirPage.Values[0];
  if UpscalerPage.SelectedValueIndex = 0 then
    UpscalerId := 'spanv2x4'
  else
    UpscalerId := 'compact2x';
  if (Length(ModelPath) > 0) and (ModelPath[Length(ModelPath)] = '\') then
    ModelPath := ModelPath + '.';
  Result := '-ModelMode ' + ModeName + ' -ModelsPath "' + ModelPath + '" -UpscalerId ' + UpscalerId;
  if TailscalePage.Values[0] then
    Result := Result + ' -InstallTailscale';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Parameters: String;
  PendingVersion: String;
begin
  if CurStep = ssPostInstall then begin
    RuntimeSetupAttempted := True;
    RuntimeSetupSucceeded := False;
    RuntimeSetupCanceled := False;
    if WizardSilent or IsUpdateInstall then
      Parameters := '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ExpandConstant('{app}\repair-runtime.ps1') + '"'
    else
      Parameters := '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ExpandConstant('{app}\install-flow.ps1') + '" ' + GetInstallParameters('');
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
      if not WizardSilent then
        MsgBox('The setup wizard could not start the local runtime setup.', mbError, MB_OK);
    end else if ResultCode = 0 then begin
      PendingVersion := ExpandConstant('{app}\version.pending');
      if SaveStringToFile(PendingVersion, '{#AppVersion}' + #13#10, False) then
        RuntimeSetupSucceeded := MoveFileEx(PendingVersion, ExpandConstant('{app}\version.txt'), 9);
      if not RuntimeSetupSucceeded then
        DeleteFile(PendingVersion);
    end else if ResultCode = 130 then
      RuntimeSetupCanceled := True;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  StartupCommand: String;
  CurrentValue: String;
begin
  if CurUninstallStep = usUninstall then begin
    StartupCommand := '"' + ExpandConstant('{app}\RealityRestyling.exe') + '" --phone-startup';
    if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'RealityRestylingPhoneAccess', CurrentValue) and
       (CompareText(CurrentValue, StartupCommand) = 0) then
      RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'RealityRestylingPhoneAccess');
    RegDeleteValue(HKCU, 'Software\RealityRestyling', 'PhoneStartupApprovedHostname');
    RegDeleteValue(HKCU, 'Software\RealityRestyling', 'PhoneAccessApprovedHostname');
    RegDeleteValue(HKCU, 'Software\RealityRestyling', 'PhoneAccessEnabled');
  end;
end;
