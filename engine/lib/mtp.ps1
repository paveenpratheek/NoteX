# The phone over USB File transfer (MTP), through Windows' shell (t-71306596ff).
#
#   powershell -NoProfile -STA -File mtp.ps1 -Op <devices|list|pull|push|mkdir>
#
# The arguments come as JSON on stdin and the answer goes to stdout as JSON:
# {"ok":true,...} or {"ok":false,"error":"..."}. A phone is named by how it
# shows under This PC; "folder:<path>" names a plain folder instead, which
# the tests use. Shell copies run in the background, so each copy is waited
# for until the file or folder is there whole.
param([string]$Op)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$sh = New-Object -ComObject Shell.Application
# No progress window, yes to all, make folders without asking, no error windows.
$COPY = 4 + 16 + 512 + 1024

function Out-Json($o) { [Console]::Out.Write(($o | ConvertTo-Json -Depth 8 -Compress)) }

function Is-Device($item) { return $item.IsFolder -and ([string]$item.Path).Contains('\\?\') }

function Root([string]$device) {
  if ($device.StartsWith('folder:')) {
    $f = $sh.Namespace($device.Substring(7))
    if (-not $f) { throw "No folder $($device.Substring(7))." }
    return $f
  }
  foreach ($i in $sh.Namespace(17).Items()) { if ((Is-Device $i) -and $i.Name -eq $device) { return $i.GetFolder } }
  throw "$device is not attached - plug it in and pick File transfer on the phone."
}

# The real file name: Name hides known extensions when Explorer is set to.
function Name-Of($item) {
  try { $n = $item.ExtendedProperty('System.FileName'); if ($n) { return [string]$n } } catch {}
  return [string]$item.Name
}

function Child($folder, [string]$name) {
  foreach ($i in $folder.Items()) { if ((Name-Of $i) -eq $name) { return $i } }
  return $null
}

function Walk([string]$device, $segs) {
  $f = Root $device
  foreach ($s in $segs) {
    $i = Child $f $s
    if (-not $i -or -not $i.IsFolder) { throw "No folder $s on $device." }
    $f = $i.GetFolder
  }
  return $f
}

function Size-Of($item) {
  try { $v = $item.ExtendedProperty('System.Size'); if ($v -ne $null) { return [int64]$v } } catch {}
  try { return [int64]$item.Size } catch { return -1 }
}

function Count-Files($folder) {
  $n = 0
  foreach ($i in $folder.Items()) { if ($i.IsFolder) { $n += Count-Files $i.GetFolder } else { $n++ } }
  return $n
}

function Wait-Until([scriptblock]$done, [int]$seconds, [string]$what) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    try { if (& $done) { return } } catch {}
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out copying $what."
}

try {
  $a = [Console]::In.ReadToEnd() | ConvertFrom-Json
  switch ($Op) {
    'devices' {
      $list = @()
      foreach ($i in $sh.Namespace(17).Items()) { if (Is-Device $i) { $list += @{ name = [string]$i.Name } } }
      Out-Json @{ ok = $true; devices = $list }
    }
    'list' {
      $f = Walk $a.device @($a.path)
      $items = @()
      foreach ($i in $f.Items()) {
        $m = $null
        try { $d = $i.ExtendedProperty('System.DateModified'); if ($d) { $m = ([datetime]$d).ToUniversalTime().ToString('o') } } catch {}
        $items += @{ name = (Name-Of $i); folder = [bool]$i.IsFolder; size = (Size-Of $i); modified = $m }
      }
      Out-Json @{ ok = $true; items = $items }
    }
    'pull' {
      $f = Walk $a.device @($a.path)
      $dest = $sh.Namespace([string]$a.dest)
      if (-not $dest) { throw "No folder $($a.dest)." }
      foreach ($name in @($a.names)) {
        $i = Child $f $name
        if (-not $i -or $i.IsFolder) { throw "No file $name on the phone." }
        $size = Size-Of $i
        $target = Join-Path ([string]$a.dest) $name
        $dest.CopyHere($i, $COPY)
        Wait-Until {
          if (-not (Test-Path -LiteralPath $target)) { return $false }
          $len = (Get-Item -LiteralPath $target).Length
          if ($size -ge 0 -and $len -ne $size) { return $false }
          $s = [IO.File]::Open($target, 'Open', 'Read', 'None'); $s.Close(); return $true
        } (60 + [int]($size / 1MB) * 2) $name
      }
      Out-Json @{ ok = $true }
    }
    'push' {
      $src = [string]$a.src
      $leaf = Split-Path -Leaf $src
      $isDir = Test-Path -LiteralPath $src -PathType Container
      $want = if ($isDir) { (Get-ChildItem -LiteralPath $src -Recurse -File).Count } else { (Get-Item -LiteralPath $src).Length }
      $bytes = if ($isDir) { (Get-ChildItem -LiteralPath $src -Recurse -File | Measure-Object Length -Sum).Sum } else { $want }
      (Walk $a.device @($a.path)).CopyHere($src, $COPY)
      Wait-Until {
        $i = Child (Walk $a.device @($a.path)) $leaf
        if (-not $i) { return $false }
        if ($isDir) { return (Count-Files $i.GetFolder) -ge $want }
        return (Size-Of $i) -eq $want
      } (60 + [int]($bytes / 1MB) * 2) $leaf
      Out-Json @{ ok = $true }
    }
    'mkdir' {
      $f = Walk $a.device @($a.path)
      if (-not (Child $f $a.name)) { $f.NewFolder([string]$a.name) }
      Wait-Until { $i = Child (Walk $a.device @($a.path)) $a.name; return [bool]($i -and $i.IsFolder) } 30 $a.name
      Out-Json @{ ok = $true }
    }
    default { throw "No operation $Op." }
  }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
}
