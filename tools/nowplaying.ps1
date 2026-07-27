# ---------------------------------------------------------------------------
#  Reports what is currently making sound, as one JSON line per change.
#
#  Two sources, in priority order:
#    1. SMTC (Windows.Media.Control) - the same session that backs the media
#       flyout on the volume popup. Gives title / artist / album / app for
#       Spotify, YouTube in a browser, VLC, Groove, and most media apps.
#    2. WASAPI render sessions - names the process actually pushing audio,
#       for anything that never registers a media session (games, Discord,
#       a random video player).
#
#  Emitted shapes:
#    {"kind":"media","title":"...","artist":"...","app":"Spotify","status":"Playing"}
#    {"kind":"app","app":"Valorant"}
#    {"kind":"none"}
#
#  NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files
#  as CP1252, where a UTF-8 em-dash decodes into a curly quote -- which PS
#  accepts as a string delimiter, so one stray dash breaks the whole parse.
# ---------------------------------------------------------------------------
param(
  [int]$ExcludePid = 0,
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
# Song titles are full of accents and dashes; make sure they survive the pipe.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

# ---- WASAPI session enumeration -------------------------------------------
Add-Type @'
using System;
using System.Runtime.InteropServices;

namespace BHV {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumerator { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                 [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
    int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
    int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl2 session);
  }

  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName(out IntPtr name);
    int SetDisplayName(string v, ref Guid ctx);
    int GetIconPath(out IntPtr path);
    int SetIconPath(string v, ref Guid ctx);
    int GetGroupingParam(out Guid g);
    int SetGroupingParam(ref Guid g, ref Guid ctx);
    int RegisterAudioSessionNotification(IntPtr n);
    int UnregisterAudioSessionNotification(IntPtr n);
    int GetSessionIdentifier(out IntPtr id);
    int GetSessionInstanceIdentifier(out IntPtr id);
    int GetProcessId(out uint pid);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
  }

  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioMeterInformation {
    int GetPeakValue(out float peak);
  }

  public class Sessions {
    // Process id of the loudest active render session, or 0. The peak level is
    // returned too so the caller can tell "playing" from "merely open".
    public static int Loudest(int excludePid, out float peak) {
      peak = 0f;
      int bestPid = 0;
      try {
        var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice dev;
        if (en.GetDefaultAudioEndpoint(0, 0, out dev) != 0) return 0;

        Guid iid = typeof(IAudioSessionManager2).GUID;
        object o;
        if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return 0;

        IAudioSessionEnumerator sessions;
        if (((IAudioSessionManager2)o).GetSessionEnumerator(out sessions) != 0) return 0;

        int count;
        sessions.GetCount(out count);
        for (int i = 0; i < count; i++) {
          IAudioSessionControl2 sc;
          if (sessions.GetSession(i, out sc) != 0) continue;

          uint upid;
          if (sc.GetProcessId(out upid) != 0) continue;
          int pid = (int)upid;
          // pid 0 is the system-sounds session; skip it and skip ourselves.
          if (pid == 0 || pid == excludePid) continue;

          int state;
          sc.GetState(out state);
          if (state != 1) continue;          // 1 == AudioSessionStateActive

          var meter = sc as IAudioMeterInformation;
          if (meter == null) continue;
          float p;
          if (meter.GetPeakValue(out p) != 0) continue;
          if (p > peak) { peak = p; bestPid = pid; }
        }
      } catch { }
      return bestPid;
    }
  }
}
'@

# ---- SMTC (Windows.Media.Control) -----------------------------------------
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  if (-not $t.Wait(4000)) { return $null }
  $t.Result
}

$mgrType = $null
$propType = $null
$mgr = $null
try {
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
} catch {
  # No SMTC on this box; we can still report the app via WASAPI.
}

function Get-Manager {
  if ($null -eq $script:mgrType) { return $null }
  if ($null -ne $script:mgr) { return $script:mgr }
  try {
    $script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $script:mgrType
  } catch {
    $script:mgr = $null
  }
  return $script:mgr
}

# ---- friendly names --------------------------------------------------------
$KNOWN = @{
  'chrome'          = 'Google Chrome'
  'msedge'          = 'Microsoft Edge'
  'firefox'         = 'Firefox'
  'spotify'         = 'Spotify'
  'vlc'             = 'VLC'
  'discord'         = 'Discord'
  'steam'           = 'Steam'
  'zuneMusic'       = 'Media Player'
  'brave'           = 'Brave'
  'opera'           = 'Opera'
  'itunes'          = 'iTunes'
  'applemusic'      = 'Apple Music'
  'foobar2000'      = 'foobar2000'
  'wmplayer'        = 'Windows Media Player'
  'mpc-hc64'        = 'MPC-HC'
  'mpv'             = 'mpv'
  'obs64'           = 'OBS Studio'
  'teams'           = 'Microsoft Teams'
  'whatsapp'        = 'WhatsApp'
  'telegram'        = 'Telegram'
}

function Format-AppName([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) { return '' }
  $name = $raw
  # AUMIDs look like "Package_hash!AppId" - the tail is the useful part
  if ($name.Contains('!')) { $name = $name.Split('!')[-1] }
  if ($name.Contains('.')) {
    $tail = $name.Split('.')[-1]
    if ($tail -ieq 'exe') { $name = $name.Substring(0, $name.Length - 4) } else { $name = $tail }
  }
  $key = $name.ToLowerInvariant()
  foreach ($k in $KNOWN.Keys) {
    if ($k.ToLowerInvariant() -eq $key) { return $KNOWN[$k] }
  }
  if ($name.Length -gt 1) { return $name.Substring(0,1).ToUpper() + $name.Substring(1) }
  return $name
}

function Get-ProcessName([int]$procId) {
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    # FileDescription is the human name ("Google Chrome"); fall back to the exe
    $desc = $null
    try { $desc = $p.MainModule.FileVersionInfo.FileDescription } catch { }
    if (-not [string]::IsNullOrWhiteSpace($desc)) { return $desc }
    return (Format-AppName $p.ProcessName)
  } catch {
    return ''
  }
}

# ---- poll loop -------------------------------------------------------------
$last = ''
while ($true) {
  $state = [ordered]@{ kind = 'none'; title = ''; artist = ''; album = ''; app = ''; status = '' }

  # 1. media session
  $media = $null
  $m = Get-Manager
  if ($null -ne $m) {
    try {
      $session = $m.GetCurrentSession()
      if ($null -ne $session) {
        $props = Await ($session.TryGetMediaPropertiesAsync()) $script:propType
        if ($null -ne $props) {
          $media = [ordered]@{
            kind   = 'media'
            title  = [string]$props.Title
            artist = [string]$props.Artist
            album  = [string]$props.AlbumTitle
            app    = (Format-AppName ([string]$session.SourceAppUserModelId))
            status = [string]$session.GetPlaybackInfo().PlaybackStatus
          }
        }
      }
    } catch {
      $script:mgr = $null   # session manager went stale; rebuild next tick
    }
  }

  # 2. loudest WASAPI session
  $peak = 0.0
  $procId = [BHV.Sessions]::Loudest($ExcludePid, [ref]$peak)
  $appName = ''
  if ($procId -gt 0) { $appName = Get-ProcessName $procId }

  if ($null -ne $media -and $media.status -eq 'Playing' -and $media.title) {
    $state = $media
  } elseif ($peak -gt 0.0015 -and $appName) {
    # Something is audibly playing but has no media metadata (a game, a call).
    $state.kind = 'app'
    $state.app = $appName
    $state.status = 'Playing'
  } elseif ($null -ne $media -and $media.title) {
    $state = $media                        # paused track: still worth showing
  }

  $json = ConvertTo-Json $state -Compress
  if ($json -ne $last) {
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    $last = $json
  }

  Start-Sleep -Milliseconds $IntervalMs
}
