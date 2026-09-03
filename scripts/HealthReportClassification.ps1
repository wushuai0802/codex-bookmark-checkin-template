function Get-CheckinReportStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [bool]$LatestResultValid,
        [Parameter(Mandatory)]
        [int]$ProblemCount
    )

    if (-not $LatestResultValid) { return 'incomplete' }
    if ($ProblemCount -gt 0) { return 'complete_with_attention' }
    return 'complete'
}

function Get-CheckinBusinessComplete {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [bool]$LatestExecutionComplete,
        [Parameter(Mandatory)]
        [int]$ProblemCount
    )

    return [bool]($LatestExecutionComplete -and $ProblemCount -eq 0)
}

function Test-SerializedCheckinBusinessComplete {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$SerializedBusinessComplete,
        [Parameter(Mandatory)]
        [bool]$ComputedBusinessComplete
    )

    return [bool]($null -eq $SerializedBusinessComplete -or [bool]$SerializedBusinessComplete -eq $ComputedBusinessComplete)
}

function Test-CheckinPlanMatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [bool]$CurrentPlanIdentityReady,
        [Parameter(Mandatory)]
        [bool]$LatestPlanIdentityReady,
        [Parameter(Mandatory)]
        [bool]$LatestResultIdentityReady,
        [Parameter(Mandatory)]
        [object[]]$CurrentPlanIdentities,
        [Parameter(Mandatory)]
        [object[]]$LatestPlanIdentities,
        [Parameter(Mandatory)]
        [object[]]$LatestResultIdentities,
        [Parameter(Mandatory)]
        [int]$CurrentPlannedTotal,
        [Parameter(Mandatory)]
        [int]$PlannedTotal,
        [AllowEmptyString()]
        [string]$CurrentPlanFingerprint,
        [AllowEmptyString()]
        [string]$LatestPlanFingerprint
    )

    return [bool]($CurrentPlanIdentityReady `
        -and $LatestPlanIdentityReady `
        -and $LatestResultIdentityReady `
        -and $CurrentPlannedTotal -eq $PlannedTotal `
        -and @(Compare-Object -ReferenceObject $CurrentPlanIdentities -DifferenceObject $LatestPlanIdentities).Count -eq 0 `
        -and @(Compare-Object -ReferenceObject $CurrentPlanIdentities -DifferenceObject $LatestResultIdentities).Count -eq 0 `
        -and -not [string]::IsNullOrWhiteSpace($CurrentPlanFingerprint) `
        -and -not [string]::IsNullOrWhiteSpace($LatestPlanFingerprint) `
        -and $CurrentPlanFingerprint -eq $LatestPlanFingerprint)
}
