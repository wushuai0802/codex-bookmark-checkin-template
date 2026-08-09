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

function Get-CanonicalResultIdentity([object]$Value) {
    $origin = ([uri][string]$Value.origin).GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
    $accountKey = ([string]$Value.accountKey).Trim()
    if ($accountKey) { return "$origin#account=$(ConvertTo-EncodeURIComponent $accountKey)" }
    return $origin
}
