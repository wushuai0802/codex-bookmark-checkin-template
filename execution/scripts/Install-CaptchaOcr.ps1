[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$bundledPython = if ($env:CHECKIN_BUNDLED_PYTHON) {
    $env:CHECKIN_BUNDLED_PYTHON
} else {
    Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
}
$requirements = Join-Path $root 'requirements-ocr.txt'

if (-not (Test-Path -LiteralPath $requirements)) { throw "缺少 OCR 依赖清单：$requirements" }
if (-not (Test-Path -LiteralPath $venvPython)) {
    $bootstrap = if (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { (Get-Command python -ErrorAction Stop).Source }
    & $bootstrap -m venv (Join-Path $root '.venv')
    if ($LASTEXITCODE -ne 0) { throw '创建本地 OCR Python 环境失败。' }
}

& $venvPython -m pip install --disable-pip-version-check -r $requirements
if ($LASTEXITCODE -ne 0) { throw '安装本地验证码 OCR 依赖失败。' }
& $venvPython -c 'import ddddocr, cv2, numpy'
if ($LASTEXITCODE -ne 0) { throw '本地验证码 OCR 运行时自检失败。' }
Write-Output '本地离线验证码 OCR 已就绪。'
