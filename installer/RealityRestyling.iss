#define AppVersion "0.1.0"

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
OutputDir=..\dist
OutputBaseFilename=RealityRestylingSetup
Compression=lzma2/ultra64
SolidCompression=yes
UninstallDisplayName=Reality Restyling

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\app.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\runtime.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\model_setup.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\run.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\run.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\setup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-flow.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Reality Restyling"; Filename: "{app}\run.bat"; Parameters: "-Launcher"; WorkingDir: "{app}"
Name: "{autodesktop}\Reality Restyling"; Filename: "{app}\run.bat"; Parameters: "-Launcher"; WorkingDir: "{app}"; Tasks: desktopicon

[InstallDelete]
Type: files; Name: "{group}\Reality Restyling (Phone).lnk"
Type: files; Name: "{group}\Setup Guide.lnk"

[Run]
Filename: "{app}\run.bat"; Parameters: "-Launcher"; Description: "Launch Reality Restyling"; Flags: postinstall skipifsilent nowait

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.runtime"
Type: filesandordirs; Name: "{app}\.venv"
Type: filesandordirs; Name: "{app}\__pycache__"
Type: filesandordirs; Name: "{app}\web\__pycache__"
Type: dirifempty; Name: "{app}"

[Code]
var
  ModelPage: TInputOptionWizardPage;
  ModelDirPage: TInputDirWizardPage;
  TailscalePage: TInputOptionWizardPage;

procedure InitializeWizard;
begin
  ModelPage := CreateInputOptionPage(wpSelectDir, 'Model files', 'Choose your model setup', 'Select whether to reuse existing model files, download them now, or do this later.', True, False);
  ModelPage.Add('I already have the model files');
  ModelPage.Add('Download the model now (about 22.4 GB if no files are found)');
  ModelPage.Add('Download later');
  ModelPage.SelectedValueIndex := 2;

  ModelDirPage := CreateInputDirPage(ModelPage.ID, 'Model folder', 'Select model files', 'Choose the folder containing your model files or where they should be downloaded.', False, '');
  ModelDirPage.Add('Model files folder:');
  ModelDirPage.Values[0] := ExpandConstant('{localappdata}\Reality Restyling\Models');

  TailscalePage := CreateInputOptionPage(ModelDirPage.ID, 'Phone connection', 'Tailscale (optional)', 'Install Tailscale if you plan to connect a phone.', False, False);
  TailscalePage.Add('Install Tailscale with winget if it is missing');
  TailscalePage.Values[0] := False;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = ModelDirPage.ID) and (ModelPage.SelectedValueIndex = 2);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = ModelDirPage.ID) and (ModelPage.SelectedValueIndex = 0) then begin
    if not DirExists(ModelDirPage.Values[0]) then begin
      MsgBox('Select the folder that contains your model files.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function GetInstallParameters(Param: String): String;
var
  ModeName: String;
begin
  case ModelPage.SelectedValueIndex of
    0: ModeName := 'existing';
    1: ModeName := 'download';
  else
    ModeName := 'later';
  end;
  if ModelPage.SelectedValueIndex = 2 then
    Result := '-ModelMode ' + ModeName + ' -ModelsPath "' + ExpandConstant('{localappdata}\Reality Restyling\Models') + '"'
  else
    Result := '-ModelMode ' + ModeName + ' -ModelsPath "' + ModelDirPage.Values[0] + '"';
  if TailscalePage.Values[0] then
    Result := Result + ' -InstallTailscale';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Parameters: String;
begin
  if CurStep = ssPostInstall then begin
    if not WizardSilent then begin
      Parameters := '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ExpandConstant('{app}\install-flow.ps1') + '" ' + GetInstallParameters('');
      if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
        MsgBox('The setup wizard could not start the local runtime setup.', mbError, MB_OK)
      else if ResultCode <> 0 then
        MsgBox('Setup needs attention. Run RealityRestylingSetup.exe again to retry.', mbError, MB_OK);
    end;
  end;
end;
