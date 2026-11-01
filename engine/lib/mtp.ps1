# The phone over USB File transfer (MTP), through Windows' shell (t-71306596ff).
#
#   powershell -NoProfile -STA -File mtp.ps1 -Op <devices|list|pull|push|mkdir>
#   powershell -NoProfile -STA -File mtp.ps1 -Op serve
#
# One operation: its arguments come as JSON on stdin and the answer goes to
# stdout as JSON: {"ok":true,...} or {"ok":false,"error":"..."}. With serve,
# one helper answers a whole sync (t-2f21cca482): each line on stdin is a
# request {"id","op",...args}, each answer one line {"id","ok",...}, one at
# a time, and the folders it walked to are remembered, so a file is not
# found again by walking from This PC down. A phone is named by how it shows
# under This PC; "folder:<path>" names a plain folder instead, which the
# tests use. Shell copies run in the background, so each copy is waited for
# until the file or folder is there whole.
param([string]$Op)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$sh = New-Object -ComObject Shell.Application
# No progress window, yes to all, make folders without asking, no error windows.
$COPY = 4 + 16 + 512 + 1024
$script:folders = @{}

function To-Json($o) { return ($o | ConvertTo-Json -Depth 8 -Compress) }

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

# A child by name: its shown name first, which needs no question to the phone, then its real name.
function Child($folder, [string]$name) {
  $items = @($folder.Items())
  foreach ($i in $items) { if ([string]$i.Name -eq $name) { return $i } }
  foreach ($i in $items) { if ((Name-Of $i) -eq $name) { return $i } }
  return $null
}

# A folder by its path, through the folders already walked to; a miss walks again from the top.
function Walk([string]$device, $segs, [switch]$Fresh) {
  if ($Fresh) { $script:folders = @{} }
  $key = "$device"
  if ($script:folders.ContainsKey($key)) { $f = $script:folders[$key] } else { $f = Root $device; $script:folders[$key] = $f }
  foreach ($s in @($segs)) {
    $key = "$key`n$s"
    if ($script:folders.ContainsKey($key)) { $f = $script:folders[$key]; continue }
    $i = Child $f $s
    if (-not $i -or -not $i.IsFolder) {
      if (-not $Fresh) { return Walk $device $segs -Fresh }
      throw "No folder $s on $device."
    }
    $f = $i.GetFolder
    $script:folders[$key] = $f
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

# Waits until done says so; every second look walks again, in case the shell kept an old view.
function Wait-Until([scriptblock]$done, [int]$seconds, [string]$what) {
  $until = (Get-Date).AddSeconds($seconds)
  $n = 0
  while ((Get-Date) -lt $until) {
    $fresh = ($n % 4) -eq 3
    try { if (& $done $fresh) { return } } catch {}
    $n++
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out copying $what."
}

function Invoke-Op([string]$op, $a) {
  switch ($op) {
    'devices' {
      $list = @()
      foreach ($i in $sh.Namespace(17).Items()) { if (Is-Device $i) { $list += @{ name = [string]$i.Name } } }
      return @{ devices = $list }
    }
    'list' {
      $f = Walk $a.device @($a.path)
      $items = @()
      foreach ($i in $f.Items()) {
        $m = $null
        try { $d = $i.ExtendedProperty('System.DateModified'); if ($d) { $m = ([datetime]$d).ToUniversalTime().ToString('o') } } catch {}
        $items += @{ name = (Name-Of $i); folder = [bool]$i.IsFolder; size = (Size-Of $i); modified = $m }
      }
      return @{ items = $items }
    }
    'pull' {
      $f = Walk $a.device @($a.path)
      $dest = $sh.Namespace([string]$a.dest)
      if (-not $dest) { throw "No folder $($a.dest)." }
      foreach ($name in @($a.names)) {
        $i = Child $f $name
        if (-not $i) { $f = Walk $a.device @($a.path) -Fresh; $i = Child $f $name }
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
      return @{}
    }
    'push' {
      $src = [string]$a.src
      $leaf = Split-Path -Leaf $src
      $isDir = Test-Path -LiteralPath $src -PathType Container
      $want = if ($isDir) { (Get-ChildItem -LiteralPath $src -Recurse -File).Count } else { (Get-Item -LiteralPath $src).Length }
      $bytes = if ($isDir) { (Get-ChildItem -LiteralPath $src -Recurse -File | Measure-Object Length -Sum).Sum } else { $want }
      (Walk $a.device @($a.path)).CopyHere($src, $COPY)
      $device = $a.device
      $path = @($a.path)
      Wait-Until {
        param($fresh)
        $parent = if ($fresh) { Walk $device $path -Fresh } else { Walk $device $path }
        $i = Child $parent $leaf
        if (-not $i) { return $false }
        if ($isDir) { return (Count-Files $i.GetFolder) -ge $want }
        return (Size-Of $i) -eq $want
      } (60 + [int]($bytes / 1MB) * 2) $leaf
      return @{}
    }
    'mkdir' {
      $f = Walk $a.device @($a.path)
      if (-not (Child $f $a.name)) { $f.NewFolder([string]$a.name) }
      $device = $a.device
      $path = @($a.path)
      $name = [string]$a.name
      Wait-Until {
        param($fresh)
        $parent = if ($fresh) { Walk $device $path -Fresh } else { Walk $device $path }
        $i = Child $parent $name
        return [bool]($i -and $i.IsFolder)
      } 30 $name
      return @{}
    }
    default { throw "No operation $op." }
  }
}

if ($Op -eq 'serve') {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $id = $null
    try {
      $req = $line | ConvertFrom-Json
      $id = $req.id
      $r = Invoke-Op ([string]$req.op) $req
      $r.ok = $true
    } catch {
      $script:folders = @{} # the phone may have gone away or changed: walk afresh next time
      $r = @{ ok = $false; error = $_.Exception.Message }
    }
    $r.id = $id
    [Console]::Out.WriteLine((To-Json $r))
    [Console]::Out.Flush()
  }
  exit 0
}

try {
  $a = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $r = Invoke-Op $Op $a
  $r.ok = $true
  [Console]::Out.Write((To-Json $r))
} catch {
  [Console]::Out.Write((To-Json @{ ok = $false; error = $_.Exception.Message }))
}
