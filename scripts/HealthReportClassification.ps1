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
