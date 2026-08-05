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
#    {"kind":"media","title":"...","artist":"...","app":"Spotify","status":"Playing",
#     "position":63.2,"duration":214.0,"canNext":true,...}
#    {"kind":"app","app":"Valorant"}
#    {"kind":"none"}
#
#  Commands are read from stdin, one per line, and applied to the current
#  session: play / pause / playpause / next / prev / seek <seconds>
#
#  NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files
#  as CP1252, where a UTF-8 em-dash decodes into a curly quote -- which PS
#  accepts as a string delimiter, so one stray dash breaks the whole parse.
# ---------------------------------------------------------------------------
param(
  [int]$ExcludePid = 0,
  [int]$ParentPid = 0,
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

  // Master volume of the default render endpoint - the same thing the taskbar
  // speaker slider drives. Every method up to GetMute has to be declared even
  // though most are unused: this is a vtable, and a missing entry silently
  // shifts every call after it.
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float levelDb, IntPtr ctx);
    int SetMasterVolumeLevelScalar(float level, IntPtr ctx);
    int GetMasterVolumeLevel(out float levelDb);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float levelDb, IntPtr ctx);
    int SetChannelVolumeLevelScalar(uint channel, float level, IntPtr ctx);
    int GetChannelVolumeLevel(uint channel, out float levelDb);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  public class Volume {
    // Deliberately not cached: the default endpoint changes when headphones go
    // in, and a cached pointer would quietly keep driving the old device.
    static IAudioEndpointVolume Endpoint() {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice dev;
      if (en.GetDefaultAudioEndpoint(0, 0, out dev) != 0) return null;
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return null;
      return o as IAudioEndpointVolume;
    }

    /// 0..1, or -1 when there is no usable endpoint.
    public static float Level() {
      try {
        var v = Endpoint();
        if (v == null) return -1f;
        float f;
        return v.GetMasterVolumeLevelScalar(out f) == 0 ? f : -1f;
      } catch { return -1f; }
    }

    /// 1 muted, 0 not, -1 unknown.
    public static int Muted() {
      try {
        var v = Endpoint();
        if (v == null) return -1;
        bool m;
        return v.GetMute(out m) == 0 ? (m ? 1 : 0) : -1;
      } catch { return -1; }
    }

    public static void SetLevel(float level) {
      try {
        var v = Endpoint();
        if (v == null) return;
        if (level < 0f) level = 0f;
        if (level > 1f) level = 1f;
        v.SetMasterVolumeLevelScalar(level, IntPtr.Zero);
      } catch { }
    }

    public static void SetMuted(bool mute) {
      try {
        var v = Endpoint();
        if (v != null) v.SetMute(mute, IntPtr.Zero);
      } catch { }
    }
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

# ---- transport commands ----------------------------------------------------
# Numbers on the wire are always invariant ("12.5"), because that is what
# JavaScript produces. [double]::TryParse defaults to the *current* culture, so
# on a pt-BR / de-DE / fr-FR machine "123.45" parses as 12345 - which turned a
# seek into a position past the end of the track, and the player answered by
# skipping to the next song. Returns -1 when the text is not a number.
function Parse-Number([string]$text) {
  $v = 0.0
  $ok = [double]::TryParse(
    $text,
    [System.Globalization.NumberStyles]::Float,
    [System.Globalization.CultureInfo]::InvariantCulture,
    [ref]$v)
  if ($ok) { return $v }
  return -1.0
}

function Invoke-MediaCommand([string]$line) {
  if ([string]::IsNullOrWhiteSpace($line)) { return }
  $parts = $line.Trim().Split(' ')
  $cmd = $parts[0].ToLowerInvariant()

  $m = Get-Manager
  if ($null -eq $m) { return }
  try {
    $s = $m.GetCurrentSession()
    if ($null -eq $s) { return }
    switch ($cmd) {
      'play'      { $null = Await ($s.TryPlayAsync()) ([bool]) }
      'pause'     { $null = Await ($s.TryPauseAsync()) ([bool]) }
      'playpause' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
      'next'      { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
      'prev'      { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
      'seek' {
        if ($parts.Count -gt 1) {
          $secs = Parse-Number $parts[1]
          if ($secs -ge 0) {
            # TryChangePlaybackPositionAsync takes 100-nanosecond ticks
            $null = Await ($s.TryChangePlaybackPositionAsync([long]($secs * 10000000))) ([bool])
          }
        }
      }
      'volume' {
        if ($parts.Count -gt 1) {
          $lvl = Parse-Number $parts[1]
          if ($lvl -ge 0) { [BHV.Volume]::SetLevel([float]$lvl) }
        }
      }
      'mute'   { [BHV.Volume]::SetMuted($true) }
      'unmute' { [BHV.Volume]::SetMuted($false) }
      'togglemute' {
        $m = [BHV.Volume]::Muted()
        if ($m -ge 0) { [BHV.Volume]::SetMuted(($m -eq 0)) }
      }
    }
  } catch {
    $script:mgr = $null
  }
}

# ---- poll loop -------------------------------------------------------------
# NOTE: do NOT use [Console]::In here. That reader is a SyncTextReader, whose
# ReadLineAsync() is not actually asynchronous - it calls the blocking
# ReadLine() and hands back an already-completed task. Polling .IsCompleted on
# it either blocks the loop forever (stdin open, no data) or reports instant
# EOF. The raw stdin stream wrapped in a plain StreamReader is genuinely async.
$stdinReader = $null
$stdinTask = $null
try {
  $stdinReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
  $stdinTask = $stdinReader.ReadLineAsync()
} catch {
  $stdinReader = $null                     # no stdin: run read-only
}

$last = ''
$sincePoll = [int]$IntervalMs              # force an immediate first poll

# Timeline interpolation state - see the poll loop.
$script:tlStamp = 0
$script:pausedFor = 0.0
$script:lastTick = $null
$SLICE = 40

while ($true) {
  # Commands are checked on a 40 ms slice so a button press feels instant,
  # while the (much heavier) SMTC poll stays on its own slower cadence.
  while ($null -ne $stdinTask -and $stdinTask.IsCompleted) {
    $line = $null
    try { $line = $stdinTask.Result } catch { }
    if ($null -eq $line) {
      # stdin closed. Keep reporting; orphan detection is the parent-pid check.
      $stdinTask = $null
      break
    }
    Invoke-MediaCommand $line
    $stdinTask = $stdinReader.ReadLineAsync()
    Start-Sleep -Milliseconds 220          # let the app act before we re-read
    $sincePoll = [int]$IntervalMs
  }

  # Don't outlive the app that spawned us.
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    exit 0
  }

  if ($sincePoll -lt [int]$IntervalMs) {
    Start-Sleep -Milliseconds $SLICE
    $sincePoll += $SLICE
    continue
  }
  $sincePoll = 0

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
          $info = $session.GetPlaybackInfo()
          $ctrl = $info.Controls
          $status = [string]$info.PlaybackStatus

          # Timeline. Apps refresh Position only now and then, so advance it by
          # however long ago the value was published; the UI interpolates from
          # there. LastUpdatedTime is unset for some apps - ignore silly ages.
          $pos = 0.0; $dur = 0.0
          try {
            $tl = $session.GetTimelineProperties()
            $pos = $tl.Position.TotalSeconds - $tl.StartTime.TotalSeconds
            $dur = ($tl.EndTime - $tl.StartTime).TotalSeconds

            # Pauses have to come off the age below, or resuming jumps the
            # position forward by however long the track sat paused. The tally
            # resets whenever the player republishes, since the new Position
            # already accounts for everything before it.
            $stamp = $tl.LastUpdatedTime.UtcTicks
            if ($stamp -ne $script:tlStamp) {
              $script:tlStamp = $stamp
              $script:pausedFor = 0.0
            }
            $tick = [DateTimeOffset]::Now
            if ($status -ne 'Playing' -and $null -ne $script:lastTick) {
              $script:pausedFor += ($tick - $script:lastTick).TotalSeconds
            }
            $script:lastTick = $tick

            if ($status -eq 'Playing') {
              $age = ($tick - $tl.LastUpdatedTime).TotalSeconds - $script:pausedFor
              # Bounded by the track, NOT by a fixed few seconds. Chrome
              # publishes the timeline once when a track starts and never
              # again, so by the middle of a song the last update is minutes
              # old and is still the only truth available. A 30-second cap
              # discarded exactly that and reported a frozen position near zero
              # for the rest of the song - which is what made the lyrics start
              # from the top of the track whenever the app began mid-song.
              $limit = 900.0
              if ($dur -gt 0) { $limit = $dur + 5.0 }
              if ($age -gt 0 -and $age -lt $limit) { $pos += $age }
            }
            if ($dur -gt 0) { $pos = [Math]::Min($pos, $dur) }
            if ($pos -lt 0) { $pos = 0.0 }
          } catch { }

          $media = [ordered]@{
            kind     = 'media'
            title    = [string]$props.Title
            artist   = [string]$props.Artist
            album    = [string]$props.AlbumTitle
            app      = (Format-AppName ([string]$session.SourceAppUserModelId))
            status   = $status
            position = [Math]::Round($pos, 2)
            duration = [Math]::Round($dur, 2)
            canPlay  = [bool]$ctrl.IsPlayEnabled
            canPause = [bool]$ctrl.IsPauseEnabled
            canNext  = [bool]$ctrl.IsNextEnabled
            canPrev  = [bool]$ctrl.IsPreviousEnabled
            canSeek  = [bool]$ctrl.IsPlaybackPositionEnabled
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

  # Some apps report a bare COM GUID instead of a real AUMID. A raw
  # "{726E1262-...}" on screen is useless, so borrow the process name from the
  # WASAPI side when that happens.
  if ($null -ne $media -and $media.app -match '^\{?[0-9A-Fa-f]{8}-') {
    $media.app = if ($appName) { $appName } else { '' }
  }

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

  # System volume rides along on every message, whatever is playing (or isn't),
  # so the panel and the tray always have a current reading.
  $vol = [BHV.Volume]::Level()
  $state.volume = if ($vol -ge 0) { [Math]::Round([double]$vol, 3) } else { -1 }
  $state.muted = ([BHV.Volume]::Muted() -eq 1)

  $json = ConvertTo-Json $state -Compress
  if ($json -ne $last) {
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    $last = $json
  }
}
