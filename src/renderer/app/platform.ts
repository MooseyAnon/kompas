// A browser-provided layout hint only. No privileged platform API crosses IPC.
export function shellPlatform(
  platform = navigator.platform,
): 'mac' | 'windows' | 'other' {
  if (platform.startsWith('Mac')) return 'mac';
  if (platform.startsWith('Win')) return 'windows';
  return 'other';
}
