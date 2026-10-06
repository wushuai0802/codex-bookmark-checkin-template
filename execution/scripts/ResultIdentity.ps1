function ConvertTo-EncodeURIComponent([string]$Value) {
    $builder = [System.Text.StringBuilder]::new()
    foreach ($byte in [System.Text.Encoding]::UTF8.GetBytes($Value)) {
        $unescaped = ($byte -ge 0x41 -and $byte -le 0x5A) `
            -or ($byte -ge 0x61 -and $byte -le 0x7A) `
            -or ($byte -ge 0x30 -and $byte -le 0x39) `
            -or $byte -in @(0x21, 0x27, 0x28, 0x29, 0x2A, 0x2D, 0x2E, 0x5F, 0x7E)
        if ($unescaped) { [void]$builder.Append([char]$byte) }
        else { [void]$builder.AppendFormat('%{0:X2}', $byte) }
    }
    return $builder.ToString()
}

function Get-CanonicalResultOrigin([object]$Value) {
    return ([uri][string]$Value.origin).GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
}

function Get-PlanDefaultOrigins([object[]]$Targets = @()) {
    return @($Targets | Where-Object {
        [string]::IsNullOrWhiteSpace([string]$_.accountKey)
    } | ForEach-Object {
        try { Get-CanonicalResultOrigin $_ } catch { }
    } | Where-Object { $_ } | Sort-Object -Unique)
}

function Get-CanonicalResultIdentity([object]$Value) {
    $origin = Get-CanonicalResultOrigin $Value
    $accountKey = ([string]$Value.accountKey).Trim()
    if ($accountKey) { return "$origin#account=$(ConvertTo-EncodeURIComponent $accountKey)" }
    return $origin
}

function Get-PlanCompatibleResultIdentity([object]$Value, [string[]]$DefaultOrigins = @()) {
    $origin = Get-CanonicalResultOrigin $Value
    $accountKey = ([string]$Value.accountKey).Trim()
    # Native PT receipts use the explicit site-default selector, while the
    # bookmark plan deliberately leaves a single-account site unqualified.
    # Normalize only when the current plan proves that this origin is one of
    # those unqualified sites. Explicit multi-account bindings remain exact.
    if ($accountKey -eq 'site-default' -and @($DefaultOrigins) -contains $origin) {
        return $origin
    }
    return Get-CanonicalResultIdentity $Value
}
