[CmdletBinding()]
param([ValidateSet('Status','Unlock','Disable','MigrateHddolbyDomain')][string]$Action='Status', [string]$BackupRoot)

$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$cfgPath=Join-Path $root 'config\config.json'
$localCfgPath=Join-Path $root 'config\config.local.json'
$protectedBase=(Join-Path $root 'data\bitwarden').TrimEnd([char[]]'\/')+[IO.Path]::DirectorySeparatorChar
$toolBase=(Join-Path $root 'tools\bitwarden-cli').TrimEnd([char[]]'\/')+[IO.Path]::DirectorySeparatorChar

function Test-AuxiliaryPath([string]$Base,[string]$Value){
    if(-not $Value-or $Value-notmatch '^[A-Za-z]:[\\/]' -or $Value-match '[\x00-\x1f]'){return $false}
    $part=[IO.Path]::GetFullPath($Value)
    if(-not $part.StartsWith($Base,[StringComparison]::OrdinalIgnoreCase)){return $false}
    while($part){
        if((Test-Path -LiteralPath $part)-and ((Get-Item -Force -LiteralPath $part).Attributes-band [IO.FileAttributes]::ReparsePoint)){return $false}
        $next=[IO.Path]::GetDirectoryName($part);if($next-eq $part){break};$part=$next
    }
    return $true
}
function Write-AuxiliaryAtomic([string]$Path,[string]$Value){
    $temporary=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try{[IO.File]::WriteAllText($temporary,$Value,[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $Path -Force}
    finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
}
function Convert-AuxiliaryArgument([string]$Value){
    if($Value.Length-gt 0-and $Value-notmatch '[\s"]'){return $Value}
    $builder=[Text.StringBuilder]::new();[void]$builder.Append([char]34);$slashes=0
    foreach($character in $Value.ToCharArray()){
        if($character-eq [char]92){$slashes++;continue}
        if($character-eq [char]34){[void]$builder.Append((('\'*($slashes*2+1))-join ''));[void]$builder.Append([char]34);$slashes=0;continue}
        if($slashes-gt 0){[void]$builder.Append((('\'*$slashes)-join ''))};[void]$builder.Append($character);$slashes=0
    }
    if($slashes-gt 0){[void]$builder.Append((('\'*($slashes*2))-join ''))};[void]$builder.Append([char]34)
    return $builder.ToString()
}
function Invoke-AuxiliaryCli([string[]]$Arguments,[switch]$Interactive){
    $process=$null;$output=$null;$errors=$null
    try{
        $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$node;$start.UseShellExecute=$false
        $start.CreateNoWindow=-not $Interactive;$start.WorkingDirectory=$root
        $start.RedirectStandardOutput=$true;$start.RedirectStandardError=-not $Interactive
        $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
        if(-not $Interactive){$start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false);$start.EnvironmentVariables['BW_NOINTERACTION']='true'}
        $allArguments=@([string]$provider.cliEntryPoint)+$Arguments
        if($null-ne $start.PSObject.Properties['ArgumentList']){foreach($argument in $allArguments){[void]$start.ArgumentList.Add($argument)}}
        else{$start.Arguments=(@($allArguments|ForEach-Object{Convert-AuxiliaryArgument $_}))-join ' '}
        $process=[Diagnostics.Process]::new();$process.StartInfo=$start
        if(-not $process.Start()){throw 'Auxiliary CLI unavailable'}
        $output=$process.StandardOutput.ReadToEndAsync()
        if(-not $Interactive){$errors=$process.StandardError.ReadToEndAsync()}
        if($Interactive){$process.WaitForExit()}
        elseif(-not $process.WaitForExit(15000)){try{$process.Kill($true)}catch{try{$process.Kill()}catch{}};throw 'Auxiliary CLI unavailable'}
        if(-not $output.Wait(2000)-or $process.ExitCode-ne 0-or ($errors-and -not $errors.Wait(2000))){throw 'Auxiliary CLI unavailable'}
        $text=$output.GetAwaiter().GetResult();if($text.Length-gt 65536){throw 'Auxiliary CLI unavailable'}
        return $text
    }finally{
        if($process){$process.StartInfo.EnvironmentVariables.Remove('BW_SESSION');$process.Dispose()}
        $output=$null;$errors=$null;$text=$null
    }
}
function Get-AuxiliarySiteContract([string]$Origin){
    switch -CaseSensitive ($Origin){
        'https://piggo.me'{return @{itemName='piggo.me';adapterId='piggo-nexus-stepup-v1'}}
        'https://www.hddolby.com'{return @{itemName='www.hddolby.com';adapterId='hddolby-nexus-stepup-v1'}}
        'https://www.uhddolby.com'{return @{itemName='www.hddolby.com';adapterId='hddolby-nexus-stepup-v1'}}
        'https://hhanclub.net'{return @{itemName='hhanclub.net';adapterId='hhclub-nexus-login-v1'}}
    }
    return $null
}
function Get-AuxiliaryAuthorizations($Payload){
    if($Payload.schemaVersion-eq 1){
        $entries=@([pscustomobject]@{origin=[string]$Payload.origin;accountKey='site-default';
            profileBinding=[string]$Payload.profileBinding;itemId=[string]$Payload.itemId;
            itemName=[string]$Payload.itemName;adapterId='piggo-nexus-stepup-v1'})
        if($entries[0].origin-cne 'https://piggo.me'){throw 'Protected authorization invalid'}
    }elseif($Payload.schemaVersion-eq 2-and $Payload.authorizations-is [array]){
        $entries=@($Payload.authorizations)
    }else{throw 'Protected authorization invalid'}
    if($entries.Count-lt 1-or $entries.Count-gt 3){throw 'Protected authorization invalid'}
    $seen=@{};$names=@('origin','accountKey','profileBinding','itemId','itemName','adapterId')
    foreach($entry in $entries){
        if($entry-isnot [pscustomobject]-or @($entry.PSObject.Properties).Count-ne $names.Count){throw 'Protected authorization invalid'}
        foreach($name in $names){if($name-cnotin @($entry.PSObject.Properties.Name)-or $entry.$name-isnot [string]){throw 'Protected authorization invalid'}}
        $contract=Get-AuxiliarySiteContract $entry.origin
        if($null-eq $contract-or $entry.accountKey-cne 'site-default'-or $entry.itemName-cne $contract.itemName-or
            $entry.adapterId-cne $contract.adapterId-or $entry.profileBinding-cnotmatch '\A[a-f0-9]{64}\z'-or
            $entry.itemId-cnotmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'-or
            $seen.ContainsKey($entry.origin)){throw 'Protected authorization invalid'}
        $seen[$entry.origin]=$true
    }
    return $entries
}
function Test-AuxiliaryRoute($Authorization,$Route){
    if($null-eq $Route){return $false}
    $legacy=$Authorization.origin-ceq 'https://piggo.me'
    $account=if($null-ne $Route.accountKey){[string]$Route.accountKey}elseif($legacy){'site-default'}else{''}
    $adapter=if($null-ne $Route.adapterId){[string]$Route.adapterId}elseif($legacy){'piggo-nexus-stepup-v1'}else{''}
    return $account-ceq $Authorization.accountKey-and $adapter-ceq $Authorization.adapterId-and
        [string]$Route.itemId-ceq $Authorization.itemId-and [string]$Route.itemName-ceq $Authorization.itemName-and
        [string]$Route.profileBinding-ceq $Authorization.profileBinding
}
function Set-AuxiliaryEnabled($Config,[bool]$Enabled,$Authorizations=@()){
    $Config.bitwardenTotp.enabled=$Enabled
    foreach($property in @($Config.bitwardenTotp.routes.PSObject.Properties)){
        $allowed=$Enabled-and @($Authorizations|Where-Object{$_.origin-ceq $property.Name-and (Test-AuxiliaryRoute $_ $property.Value)}).Count-eq 1
        $property.Value|Add-Member -NotePropertyName enabled -NotePropertyValue ([bool]$allowed) -Force
    }
    foreach($mapName in @('nativePtTwoFactorRecovery','siteTwoFactorRecovery')){
        if(-not $Config.$mapName){continue}
        foreach($property in @($Config.$mapName.PSObject.Properties)){
            if($property.Value.provider-cne 'bitwarden'){continue}
            $route=$Config.bitwardenTotp.routes.PSObject.Properties[$property.Name]
            $property.Value|Add-Member -NotePropertyName enabled -NotePropertyValue ([bool]($Enabled-and $route-and $route.Value.enabled-eq $true)) -Force
        }
    }
}
function Save-AuxiliaryConfiguration($Config,$LocalConfig){
    if($null-eq $LocalConfig.bitwardenTotp){$LocalConfig|Add-Member bitwardenTotp ([pscustomobject]@{})}
    $localProvider=$LocalConfig.bitwardenTotp
    foreach($property in @($Config.bitwardenTotp.PSObject.Properties)){
        if($property.Name-ceq 'routes'){continue}
        $localProvider|Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value -Force
    }
    if($null-eq $localProvider.routes){$localProvider|Add-Member routes ([pscustomobject]@{})}
    foreach($property in @($localProvider.routes.PSObject.Properties)){
        $property.Value|Add-Member enabled $false -Force
    }
    foreach($property in @($Config.bitwardenTotp.routes.PSObject.Properties)){
        $localRoute=$localProvider.routes.PSObject.Properties[$property.Name]
        if($null-eq $localRoute){$localProvider.routes|Add-Member -NotePropertyName $property.Name -NotePropertyValue ([pscustomobject]@{});$localRoute=$localProvider.routes.PSObject.Properties[$property.Name]}
        foreach($field in @($property.Value.PSObject.Properties)){$localRoute.Value|Add-Member -NotePropertyName $field.Name -NotePropertyValue $field.Value -Force}
    }
    foreach($mapName in @('nativePtTwoFactorRecovery','siteTwoFactorRecovery')){
        if($LocalConfig.$mapName){
            foreach($property in @($LocalConfig.$mapName.PSObject.Properties)){
                if($property.Value.provider-ceq 'bitwarden'){$property.Value|Add-Member enabled $false -Force}
            }
        }
        if(-not $Config.$mapName){continue}
        if($null-eq $LocalConfig.$mapName){$LocalConfig|Add-Member -NotePropertyName $mapName -NotePropertyValue ([pscustomobject]@{})}
        foreach($property in @($Config.$mapName.PSObject.Properties)){
            if($property.Value.provider-cne 'bitwarden'){continue}
            $localEntry=$LocalConfig.$mapName.PSObject.Properties[$property.Name]
            if($null-eq $localEntry){$LocalConfig.$mapName|Add-Member -NotePropertyName $property.Name -NotePropertyValue ([pscustomobject]@{});$localEntry=$LocalConfig.$mapName.PSObject.Properties[$property.Name]}
            foreach($field in @($property.Value.PSObject.Properties)){$localEntry.Value|Add-Member -NotePropertyName $field.Name -NotePropertyValue $field.Value -Force}
        }
    }
    Write-AuxiliaryAtomic $localCfgPath ($LocalConfig|ConvertTo-Json -Depth 40)
    Write-AuxiliaryAtomic $cfgPath ($Config|ConvertTo-Json -Depth 40)
}

$keys=@([Environment]::GetEnvironmentVariables('Process').Keys|Where-Object{[string]$_-match '^(?:BW_|PIGGO_BW_|BITWARDENCLI_APPDATA_DIR$)'})
foreach($key in @('BW_SESSION','BITWARDENCLI_APPDATA_DIR','BW_NOINTERACTION')){if($key-notin $keys){$keys+=$key}}
$before=@{};foreach($key in $keys){$before[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
$session=$null;$payload=$null;$plainText=$null;$secure=$null;$clientLock=$null
try{
    $ancestor=$root
    while($ancestor){if(Test-Path -LiteralPath (Join-Path $ancestor '.git')){throw 'Source checkout rejected'};$ancestor=[IO.Path]::GetDirectoryName($ancestor)}
    if(-not(Test-AuxiliaryPath ($root.TrimEnd([char[]]'\/')+[IO.Path]::DirectorySeparatorChar) $cfgPath)-or
        -not(Test-Path -LiteralPath $cfgPath -PathType Leaf)-or (Get-Item -LiteralPath $cfgPath).Length-gt 1048576){throw 'Private configuration invalid'}
    $cfg=Get-Content -Raw -Encoding UTF8 -LiteralPath $cfgPath|ConvertFrom-Json
    $provider=$cfg.bitwardenTotp
    if($null-eq $provider-or $null-eq $provider.routes){@{configured=$false;reason='not_configured'}|ConvertTo-Json -Compress;exit 2}
    if(-not(Test-AuxiliaryPath $protectedBase ([string]$provider.sessionFile))-or
        -not(Test-AuxiliaryPath $protectedBase ([string]$provider.appDataDir))-or
        -not(Test-AuxiliaryPath $toolBase ([string]$provider.cliEntryPoint))){throw 'Auxiliary paths rejected'}
    if($Action-ceq 'Status'){
        $sites=@($provider.routes.PSObject.Properties|Where-Object{Get-AuxiliarySiteContract $_.Name}|ForEach-Object{[pscustomobject]@{origin=$_.Name;enabled=($_.Value.enabled-is [bool]-and $_.Value.enabled-eq $true)}})
        @{configured=$true;enabled=($provider.enabled-is [bool]-and $provider.enabled-eq $true-and @($sites|Where-Object{$_.enabled}).Count-gt 0);
            protectedCredentialPresent=(Test-Path -LiteralPath $provider.sessionFile -PathType Leaf);sites=$sites}|ConvertTo-Json -Compress -Depth 4
        return
    }
    $server=$null;$uri=$null
    if([string]$provider.serverUrl-match '[?#\\]'-or -not[Uri]::TryCreate([string]$provider.serverUrl,[UriKind]::Absolute,[ref]$uri)-or
        $uri.Scheme-cne 'https'-or -not $uri.Host-or $uri.UserInfo-or $uri.AbsolutePath-cne '/'){throw 'Auxiliary server invalid'}
    $server=$uri.GetLeftPart([UriPartial]::Authority)
    . (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
    $node=Resolve-CheckinNode $cfg
    $lockPath=Join-Path $protectedBase 'provider.lock'
    if(-not(Test-AuxiliaryPath $protectedBase $lockPath)){throw 'Auxiliary lock path rejected'}
    try{$clientLock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch{Write-Host '辅助客户端正在被签到任务使用，请稍后重试。';return}
    if(-not(Test-AuxiliaryPath ($root.TrimEnd([char[]]'\/')+[IO.Path]::DirectorySeparatorChar) $localCfgPath)){throw 'Private override path invalid'}
    $localCfg=if(Test-Path -LiteralPath $localCfgPath -PathType Leaf){
        if((Get-Item -LiteralPath $localCfgPath).Length-gt 1048576){throw 'Private override invalid'}
        Get-Content -Raw -Encoding UTF8 -LiteralPath $localCfgPath|ConvertFrom-Json
    }else{[pscustomobject]@{}}
    if($localCfg-isnot [pscustomobject]){throw 'Private override invalid'}
    foreach($key in $keys){[Environment]::SetEnvironmentVariable($key,$null,'Process')}
    $env:BITWARDENCLI_APPDATA_DIR=[string]$provider.appDataDir
    if($Action-ceq 'Disable'){
        $env:BW_NOINTERACTION='true'
        try{$ignored=Invoke-AuxiliaryCli @('lock','--nointeraction')}catch{ }
        Set-AuxiliaryEnabled $cfg $false
        Save-AuxiliaryConfiguration $cfg $localCfg
        Write-Host 'Bitwarden 辅助已全部停用，原签到和账号资料保留。'
        return
    }
    if(-not(Test-Path -LiteralPath $provider.sessionFile -PathType Leaf)-or (Get-Item -LiteralPath $provider.sessionFile).Length-gt 65536){throw 'Auxiliary enrollment required'}
    $outer=Get-Content -Raw -Encoding UTF8 -LiteralPath $provider.sessionFile|ConvertFrom-Json
    if(($outer.schemaVersion-isnot [int]-and $outer.schemaVersion-isnot [long])-or $outer.schemaVersion-notin @(1,2)-or
        $outer.protection-cne 'CurrentUserDPAPI'-or [string]$outer.protectedPayload-cnotmatch '\A[0-9a-fA-F]{80,60000}\z'){throw 'Protected credential invalid'}
    if($PSVersionTable.PSVersion.Major-lt 6){Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop}
    $secure=ConvertTo-SecureString ([string]$outer.protectedPayload)
    $plainText=[Net.NetworkCredential]::new('',$secure).Password
    $jsonOptions=@{};if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')){$jsonOptions.DateKind='String'}
    $payload=$plainText|ConvertFrom-Json @jsonOptions
    $uuid='\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
    if(($payload.schemaVersion-isnot [int]-and $payload.schemaVersion-isnot [long])-or $payload.schemaVersion-notin @(1,2)-or
        $payload.serverUrl-cne $server-or $payload.windowsSid-cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value-or
        [string]$payload.vaultUserId-cnotmatch $uuid-or [string]$payload.session-cnotmatch '\A[A-Za-z0-9+/]{40,8192}={0,2}\z'){throw 'Auxiliary identity invalid'}
    $created=[DateTimeOffset]::MinValue
    $validCreated=$false
    if($payload.createdAtUtc-is [DateTimeOffset]){
        $created=$payload.createdAtUtc;$validCreated=$created.Offset-eq [TimeSpan]::Zero
    }elseif($payload.createdAtUtc-is [datetime]){
        $validCreated=$payload.createdAtUtc.Kind-eq [DateTimeKind]::Utc;$created=[DateTimeOffset]$payload.createdAtUtc
    }else{
        $validCreated=$payload.createdAtUtc-is [string]-and $payload.createdAtUtc-cmatch '\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,7})?(?:Z|\+00:00)\z'-and
            [DateTimeOffset]::TryParse($payload.createdAtUtc,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind,[ref]$created)-and
            $created.Offset-eq [TimeSpan]::Zero
    }
    if(-not $validCreated-or $created-gt [DateTimeOffset]::UtcNow-or $created.Year-lt 2000){throw 'Protected credential date invalid'}
    $authorizations=@(Get-AuxiliaryAuthorizations $payload)
    if(@($authorizations|Where-Object{Test-AuxiliaryRoute $_ $provider.routes.PSObject.Properties[$_.origin].Value}).Count-eq 0){throw 'Auxiliary enrollment differs from configuration'}
    if($Action-ceq 'MigrateHddolbyDomain'){
        $from='https://www.hddolby.com';$to='https://www.uhddolby.com'
        $oldRoute=$provider.routes.PSObject.Properties[$from]
        $newRoute=$provider.routes.PSObject.Properties[$to]
        if(-not $oldRoute-and $newRoute-and @($authorizations|Where-Object{$_.origin-ceq $to-and (Test-AuxiliaryRoute $_ $newRoute.Value)}).Count-eq 1){
            @{migrated=$false;alreadyConfigured=$true;origin=$to}|ConvertTo-Json -Compress;return
        }
        $grant=@($authorizations|Where-Object{$_.origin-ceq $from})
        if($payload.schemaVersion-ne 2-or -not $oldRoute-or $newRoute-or $grant.Count-ne 1-or
            -not(Test-AuxiliaryRoute $grant[0] $oldRoute.Value)-or @($authorizations|Where-Object{$_.origin-ceq $to}).Count){throw 'Domain enrollment mismatch'}
        if(-not $BackupRoot-or $BackupRoot-notmatch '^[A-Za-z]:[\\/]'-or
            [IO.Path]::GetFullPath($BackupRoot).TrimEnd([char[]]'\/')-eq [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($BackupRoot)).TrimEnd([char[]]'\/')-or
            (Test-Path -LiteralPath $BackupRoot)){throw 'Dedicated migration backup required'}
        $integration=Get-Content -LiteralPath (Join-Path $root 'data/v2-integration.json') -Raw|ConvertFrom-Json
        $catalog=Get-Content -LiteralPath $integration.harvestPtGate.catalogFile -Raw|ConvertFrom-Json
        $bookmarks=Get-Content -LiteralPath $cfg.bookmarksPath -Raw|ConvertFrom-Json
        $script:DomainBookmarkMatched=$false
        function Test-MigrationBookmarks($Node,[bool]$InScope=$false,[string]$ParentId=''){
            if($null-eq $Node){return}
            $inside=$InScope-or ([string]$Node.id-ceq [string]$catalog.scope.folderId-and $ParentId-ceq [string]$catalog.scope.parentId)
            if($inside-and $Node.type-ceq 'url'){
                try{$u=[uri][string]$Node.url;if($u.GetLeftPart([UriPartial]::Authority)-ceq $to-and
                    $u.AbsolutePath-cin @('/index.php','/attendance.php')-and -not $u.Query-and -not $u.Fragment-and -not $u.UserInfo){$script:DomainBookmarkMatched=$true}}catch{}
            }
            foreach($child in @($Node.children)){Test-MigrationBookmarks $child $inside ([string]$Node.id)}
        }
        foreach($node in @($bookmarks.roots.PSObject.Properties.Value)){Test-MigrationBookmarks $node}
        if(-not $script:DomainBookmarkMatched){throw 'New domain must be in the exact PT bookmark folder'}
        [void](New-Item -ItemType Directory -Path $BackupRoot)
        $originalCfg=[IO.File]::ReadAllText($cfgPath);$originalLocal=[IO.File]::ReadAllText($localCfgPath)
        $originalProtected=[IO.File]::ReadAllText([string]$provider.sessionFile)
        [IO.File]::WriteAllText((Join-Path $BackupRoot 'config.json'),$originalCfg,[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $BackupRoot 'config.local.json'),$originalLocal,[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $BackupRoot 'session.dpapi.json'),$originalProtected,[Text.UTF8Encoding]::new($false))
        function Move-HddolbySetting($Map){
            if(-not $Map){return};$property=$Map.PSObject.Properties[$from]
            if(-not $property){return};if($Map.PSObject.Properties[$to]){throw 'Conflicting new-domain configuration'}
            $value=$property.Value
            if($value-is [string]){$value=$value.Replace($from,$to)}
            elseif($value-is [array]){$value=@($value|ForEach-Object{if($_-isnot [string]){throw 'URL migration type invalid'};$_.Replace($from,$to)})}
            elseif($value.PSObject.Properties['url']){$value.url=([string]$value.url).Replace($from,$to)}
            if($value-isnot [string]-and $value.PSObject.Properties['origin']){$value.origin=$to}
            $Map.PSObject.Properties.Remove($from);$Map|Add-Member -NotePropertyName $to -NotePropertyValue $value
        }
        try{
            foreach($document in @($cfg,$localCfg)){
                foreach($name in @('ptReadOnlyPolicies','siteTwoFactorRecovery','savedLoginUrls','relatedCandidateUrls')){Move-HddolbySetting $document.$name}
                Move-HddolbySetting $document.bitwardenTotp.routes
                foreach($name in @('disabledCheckinOrigins','excludedOrigins')){
                    if($document.PSObject.Properties[$name]){$document.$name=@($document.$name|ForEach-Object{if($_-ceq $from){$to}else{$_}})}
                }
                if(-not $document.savedLoginUrls){$document|Add-Member savedLoginUrls ([pscustomobject]@{})}
                $document.savedLoginUrls|Add-Member -NotePropertyName $to -NotePropertyValue ($to+'/login.php') -Force
                $opt=$document.siteTwoFactorRecovery.PSObject.Properties[$to].Value
                if(-not $opt){throw 'Two-factor settings missing'}
                $opt|Add-Member allowPasswordLogin $true -Force;$opt|Add-Member loginSource 'bitwarden' -Force
                if($document.baiduOcr.enabled-eq $true){$document.baiduOcr|Add-Member allowedOrigins @(@($document.baiduOcr.allowedOrigins)+$to|Select-Object -Unique) -Force}
            }
            if($cfg.baiduOcr.enabled-eq $true){
                if(-not $localCfg.baiduOcr){$localCfg|Add-Member baiduOcr ([pscustomobject]@{})}
                $localCfg.baiduOcr|Add-Member allowedOrigins @($cfg.baiduOcr.allowedOrigins) -Force
            }
            $grant[0].origin=$to
            $plainText=$null;if($secure){$secure.Dispose();$secure=$null}
            $secure=ConvertTo-SecureString ($payload|ConvertTo-Json -Compress -Depth 8) -AsPlainText -Force
            $outer.protectedPayload=ConvertFrom-SecureString $secure
            Write-AuxiliaryAtomic ([string]$provider.sessionFile) ($outer|ConvertTo-Json -Compress)
            Save-AuxiliaryConfiguration $cfg $localCfg
            $manifestFiles=@(
                @{path=$cfgPath;backup='config.json'},
                @{path=$localCfgPath;backup='config.local.json'},
                @{path=[string]$provider.sessionFile;backup='session.dpapi.json'}
            )
            function Get-MigrationHash([string]$Path){
                $algorithm=[Security.Cryptography.SHA256]::Create()
                try{return ([BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-','')}
                finally{$algorithm.Dispose()}
            }
            foreach($entry in $manifestFiles){
                $entry.beforeHash=Get-MigrationHash (Join-Path $BackupRoot $entry.backup)
                $entry.afterHash=Get-MigrationHash $entry.path
            }
            [IO.File]::WriteAllText((Join-Path $BackupRoot 'manifest.json'),(@{schemaVersion=1;runtimeRoot=$root;from=$from;to=$to;files=$manifestFiles}|ConvertTo-Json -Compress -Depth 6),[Text.UTF8Encoding]::new($false))
        }catch{
            Write-AuxiliaryAtomic ([string]$provider.sessionFile) $originalProtected
            Write-AuxiliaryAtomic $cfgPath $originalCfg;Write-AuxiliaryAtomic $localCfgPath $originalLocal
            throw
        }
        @{migrated=$true;origin=$to;profileUnchanged=$true;itemUnchanged=$true;otherAuthorizationsUnchanged=$true}|ConvertTo-Json -Compress
        return
    }
    $plainText=$null;$secure.Dispose();$secure=$null
    Write-Host '请在本机输入密码库主密码；如需重新登录，输入密码库邮箱及自身二次验证码。'
    $status=(Invoke-AuxiliaryCli @('status','--nointeraction'))|ConvertFrom-Json
    if($status.serverUrl-cne $server){throw 'Auxiliary server mismatch'}
    $session=if($status.status-ceq 'unauthenticated'){Invoke-AuxiliaryCli @('login','--raw') -Interactive}
        elseif($status.status-cin @('locked','unlocked')){Invoke-AuxiliaryCli @('unlock','--raw') -Interactive}else{throw 'Auxiliary vault state invalid'}
    $session=$session.Trim()
    if($session-cnotmatch '\A[A-Za-z0-9+/]{40,8192}={0,2}\z'){throw 'Unlock incomplete'}
    $env:BW_SESSION=$session
    $status=(Invoke-AuxiliaryCli @('status','--nointeraction'))|ConvertFrom-Json
    if($status.status-cne 'unlocked'-or $status.serverUrl-cne $server-or
        $status.userId-cne $payload.vaultUserId){throw 'Wrong auxiliary account'}
    # Refresh only the session and creation time. Never add an authorization.
    $payload.session=$session;$payload.createdAtUtc=[datetimeoffset]::UtcNow.ToString('o')
    $secure=ConvertTo-SecureString ($payload|ConvertTo-Json -Compress -Depth 8) -AsPlainText -Force
    $outer.protectedPayload=ConvertFrom-SecureString $secure
    Write-AuxiliaryAtomic ([string]$provider.sessionFile) ($outer|ConvertTo-Json -Compress)
    Set-AuxiliaryEnabled $cfg $true $authorizations
    Save-AuxiliaryConfiguration $cfg $localCfg
    Write-Host '辅助授权已恢复，已登记的站点会在需要验证时使用；新增条目仍须单独授权。'
}catch{Write-Host '辅助授权尚未完成，请保留窗口并告知当前步骤。';exit 2}
finally{
    if($secure){$secure.Dispose()};$secure=$null;$plainText=$null;$session=$null;$sessionLines=$null;$payload=$null;$authorizations=$null
    if($clientLock){$clientLock.Dispose()}
    foreach($key in $keys){[Environment]::SetEnvironmentVariable($key,$before[$key],'Process')}
}
