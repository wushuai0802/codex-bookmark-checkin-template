Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Invoke-SafeAutomationControl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Element,
        [ValidateSet('Invoke', 'Toggle', 'SelectionItem')][string[]]$AllowedPatterns = @('Invoke')
    )

    if ($null -eq $Element) { return $false }
    foreach ($patternName in $AllowedPatterns) {
        try {
            switch ($patternName) {
                'Invoke' {
                    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                    $pattern.Invoke()
                }
                'Toggle' {
                    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
                    if ($pattern.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) {
                        $pattern.Toggle()
                    }
                }
                'SelectionItem' {
                    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                    if (-not $pattern.Current.IsSelected) { $pattern.Select() }
                }
            }
            return $true
        }
        catch { }
    }
    return $false
}
