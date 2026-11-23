import React from 'react';
import {
  AVATAR_MASCOTS,
  type AvatarMascot,
} from '../../../../shared/contracts';
import blob from '../mascots/blob.png';
import flop from '../mascots/flop.png';
import nose from '../mascots/nose.png';
import peek from '../mascots/peek.png';
import sprout from '../mascots/sprout.png';
import strut from '../mascots/strut.png';
import twins from '../mascots/twins.png';
import wriggle from '../mascots/wriggle.png';
import './Avatar.css';

/** Each sprout with its picture and a soft background tint. */
export const MASCOTS: Record<AvatarMascot, { src: string; tint: string }> = {
  sprout: { src: sprout, tint: '#dfe5fb' },
  flop: { src: flop, tint: '#d7f3e8' },
  wriggle: { src: wriggle, tint: '#fff0c9' },
  peek: { src: peek, tint: '#ffe1ec' },
  nose: { src: nose, tint: '#ece4f8' },
  strut: { src: strut, tint: '#dfe5fb' },
  twins: { src: twins, tint: '#d7f3e8' },
  blob: { src: blob, tint: '#fff0c9' },
};

export function randomMascot(random = Math.random): string {
  return `mascot:${AVATAR_MASCOTS[Math.floor(random() * AVATAR_MASCOTS.length)]}`;
}

export function mascotOf(
  value: string | null | undefined,
): AvatarMascot | null {
  const name = value?.startsWith('mascot:') ? value.slice(7) : '';
  return (AVATAR_MASCOTS as readonly string[]).includes(name)
    ? (name as AvatarMascot)
    : null;
}

/** A round profile picture: a sprout mascot, a photo, or initials. */
export function Avatar({
  value,
  initials,
  size = 64,
  className = '',
}: {
  value: string | null | undefined;
  initials: string;
  size?: number;
  className?: string;
}) {
  const mascot = mascotOf(value);
  const photo = value?.startsWith('data:image/') ? value : null;
  return (
    <span
      className={`gnd-avatar ${className}`.trim()}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        background: mascot ? MASCOTS[mascot].tint : undefined,
      }}
      aria-hidden="true"
    >
      {mascot ? (
        <img src={MASCOTS[mascot].src} alt="" draggable={false} />
      ) : photo ? (
        <img className="is-photo" src={photo} alt="" draggable={false} />
      ) : (
        <span className="gnd-avatar-initials">{initials}</span>
      )}
    </span>
  );
}

/**
 * Shrink a chosen image to a 256px square JPEG data URL, so the profile keeps
 * a small copy instead of the original file.
 */
export async function photoDataUrl(file: Blob, size = 256): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('unreadable image'));
      img.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
