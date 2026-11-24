import React, { useEffect, useId, useRef, useState } from 'react';
import './Buddy.css';

export type BuddyMood = 'idle' | 'thinking' | 'working' | 'happy';

/** Furthest the eyes move (SVG units) when following the pointer. */
const LOOK_RANGE = 7;
const TICKLE_MS = 1100;

/** Where the eyes should point: toward the pointer, within LOOK_RANGE. */
export function lookAt(
  pointer: { x: number; y: number },
  centre: { x: number; y: number },
) {
  const dx = pointer.x - centre.x;
  const dy = pointer.y - centre.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return { x: 0, y: 0 };
  // Close to the buddy the eyes move a little; further away, the full range.
  const reach = Math.min(1, distance / 260) * LOOK_RANGE;
  return {
    x: Math.round((dx / distance) * reach * 10) / 10,
    y: Math.round((dy / distance) * reach * 0.7 * 10) / 10,
  };
}

/**
 * Kompas's companion: a soft, fluffy egg-shaped blob with two dark eyes. It
 * floats, blinks and follows the pointer with its eyes; "working" reads side
 * to side, "thinking" looks up, "happy" smiles with its eyes and hops.
 * `entrance` drops it in with a little bounce. Click it and it closes its
 * eyes into happy moons, wiggles, and its glow spreads.
 * `say` is read to screen readers only; speech bubbles are off for now.
 */
export function Buddy({
  mood = 'idle',
  size = 120,
  say,
  entrance = false,
  className,
}: {
  mood?: BuddyMood;
  size?: number;
  say?: React.ReactNode;
  entrance?: boolean;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [following, setFollowing] = useState(false);
  const [tickled, setTickled] = useState(false);

  useEffect(() => {
    let frame = 0;
    let idle = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = root.current?.getBoundingClientRect();
        if (!box) return;
        setLook(
          lookAt(
            { x: event.clientX, y: event.clientY },
            { x: box.left + box.width / 2, y: box.top + box.height * 0.38 },
          ),
        );
        setFollowing(true);
      });
      window.clearTimeout(idle);
      // After a few still seconds it goes back to glancing around.
      idle = window.setTimeout(() => setFollowing(false), 4000);
    };
    window.addEventListener('pointermove', move);
    return () => {
      window.removeEventListener('pointermove', move);
      cancelAnimationFrame(frame);
      window.clearTimeout(idle);
    };
  }, []);

  useEffect(() => {
    if (!tickled) return;
    const timer = window.setTimeout(() => setTickled(false), TICKLE_MS);
    return () => window.clearTimeout(timer);
  }, [tickled]);

  const raw = useId();
  const id = raw.replace(/[^a-zA-Z0-9]/gu, '');
  const egg =
    'M100 22 C146 22 170 64 175 116 C180 168 150 198 100 198 C50 198 20 168 25 116 C30 64 54 22 100 22 Z';

  return (
    <div
      ref={root}
      className={[
        'gnd-buddy',
        `is-${mood}`,
        following && 'is-following',
        tickled && 'is-tickled',
        entrance && 'is-entering',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ '--buddy-size': `${size}px` } as React.CSSProperties}
      onClick={() => setTickled(true)}
    >
      {say && (
        <p className="gnd-visually-hidden" role="status">
          {say}
        </p>
      )}
      <svg
        className="gnd-buddy-art"
        viewBox="0 0 200 230"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={`${id}-base`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffb98e" />
            <stop offset="0.45" stopColor="#f9a7ad" />
            <stop offset="0.75" stopColor="#b3b2ec" />
            <stop offset="1" stopColor="#97b9ee" />
          </linearGradient>
          <clipPath id={`${id}-clip`}>
            <path d={egg} />
          </clipPath>
          <filter
            id={`${id}-fluff`}
            x="-40%"
            y="-40%"
            width="180%"
            height="180%"
          >
            <feGaussianBlur stdDeviation="14" />
          </filter>
          <filter
            id={`${id}-edge`}
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
          >
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <filter
            id={`${id}-shadow`}
            x="-50%"
            y="-200%"
            width="200%"
            height="500%"
          >
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>

        <ellipse
          className="gnd-buddy-shadow"
          cx="100"
          cy="216"
          rx="52"
          ry="7"
          fill="#7c7fb0"
          filter={`url(#${id}-shadow)`}
        />

        <g className="gnd-buddy-float">
          <g className="gnd-buddy-squish">
            {/* A soft halo so the edge looks fluffy rather than drawn. */}
            <path
              className="gnd-buddy-halo"
              d={egg}
              fill={`url(#${id}-base)`}
              opacity="0.7"
              filter={`url(#${id}-fluff)`}
            />
            <g filter={`url(#${id}-edge)`}>
              <path d={egg} fill={`url(#${id}-base)`} />
              <g clipPath={`url(#${id}-clip)`} filter={`url(#${id}-fluff)`}>
                <circle
                  className="gnd-buddy-glow-a"
                  cx="128"
                  cy="52"
                  r="46"
                  fill="#ffc792"
                />
                <circle
                  className="gnd-buddy-glow-b"
                  cx="58"
                  cy="108"
                  r="44"
                  fill="#ff9fbc"
                  opacity="0.8"
                />
                <circle
                  className="gnd-buddy-glow-c"
                  cx="76"
                  cy="176"
                  r="52"
                  fill="#8fc7f2"
                  opacity="0.9"
                />
                <circle
                  className="gnd-buddy-glow-d"
                  cx="146"
                  cy="168"
                  r="46"
                  fill="#9d9cf2"
                  opacity="0.85"
                />
              </g>
            </g>

            <g
              className="gnd-buddy-look"
              transform={`translate(${look.x} ${look.y})`}
            >
              <g className="gnd-buddy-eyes">
                <g className="gnd-buddy-eye-shapes">
                  <ellipse cx="84" cy="80" rx="7.5" ry="8.5" fill="#24232c" />
                  <ellipse cx="116" cy="80" rx="7.5" ry="8.5" fill="#24232c" />
                </g>
                <g
                  className="gnd-buddy-smile-eyes"
                  fill="none"
                  stroke="#24232c"
                  strokeWidth="4.5"
                  strokeLinecap="round"
                >
                  <path d="M77 82 Q84 73 91 82" />
                  <path d="M109 82 Q116 73 123 82" />
                </g>
              </g>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
