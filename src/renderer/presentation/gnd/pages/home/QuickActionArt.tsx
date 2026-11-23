import React from 'react';

/*
 * Illustrations for the Home quick actions. Flat shapes in the GND palette
 * with the backdrop's mint, lilac, butter and blush as accents. Decorative:
 * every one is aria-hidden, the card's label carries the meaning.
 */

// Softened tints of the GND palette, so the cards stay calm beside the UI.
const C = {
  blue: '#6f86f2',
  blueMid: '#8a9ef5',
  blueSoft: '#dfe5fb',
  ink: '#5c5e57',
  paper: '#fdfcf8',
  line: '#e9e8e0',
  mint: '#c4efdf',
  mintDeep: '#8fdcbf',
  lilac: '#e6dcf6',
  butter: '#ffe7a8',
  butterDeep: '#f4cf76',
  blush: '#ffd3e4',
  blushDeep: '#f5a9c8',
};

function Sparkle({
  x,
  y,
  size = 1,
  fill = C.butter,
}: {
  x: number;
  y: number;
  size?: number;
  fill?: string;
}) {
  return (
    <path
      transform={`translate(${x} ${y}) scale(${size})`}
      d="M0-8Q1.2-1.2 8 0Q1.2 1.2 0 8Q-1.2 1.2-8 0Q-1.2-1.2 0-8Z"
      fill={fill}
    />
  );
}

function Shadow({ cx = 80, w = 46 }: { cx?: number; w?: number }) {
  return <ellipse cx={cx} cy={108} rx={w} ry={5} fill={C.ink} opacity={0.07} />;
}

function Art({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="gnd-quick-art"
      viewBox="0 0 160 120"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Two speech bubbles in conversation. */
export function MockInterviewArt() {
  return (
    <Art>
      <Shadow />
      <g transform="rotate(-7 66 52)">
        <rect x={30} y={24} width={72} height={50} rx={18} fill={C.blue} />
        <path d="M46 70l-6 18 20-14z" fill={C.blue} />
        <circle cx={52} cy={49} r={5} fill={C.paper} />
        <circle cx={66} cy={49} r={5} fill={C.paper} />
        <circle cx={80} cy={49} r={5} fill={C.paper} />
      </g>
      <g transform="rotate(6 108 70)">
        <rect x={82} y={52} width={52} height={36} rx={14} fill={C.blush} />
        <path d="M120 84l8 14-18-10z" fill={C.blush} />
        <rect x={94} y={64} width={28} height={5} rx={2.5} fill={C.blushDeep} />
        <rect x={94} y={74} width={18} height={5} rx={2.5} fill={C.blushDeep} />
      </g>
      <Sparkle x={124} y={26} size={1.2} />
      <Sparkle x={24} y={86} size={0.8} fill={C.mintDeep} />
    </Art>
  );
}

/** A stack of question cards with a lightning bolt for quick-fire. */
export function QuestionsArt() {
  return (
    <Art>
      <Shadow />
      <rect
        x={50}
        y={20}
        width={60}
        height={78}
        rx={10}
        fill={C.lilac}
        transform="rotate(12 80 59)"
      />
      <rect
        x={50}
        y={20}
        width={60}
        height={78}
        rx={10}
        fill={C.mint}
        transform="rotate(-6 80 59)"
      />
      <g transform="rotate(4 80 59)">
        <rect x={50} y={20} width={60} height={78} rx={10} fill={C.blue} />
        <path
          d="M70 48c0-7 5-12 11-12s11 4 11 10c0 5-3 7-7 10-3 2-4 3-4 7"
          fill="none"
          stroke={C.paper}
          strokeWidth={7}
          strokeLinecap="round"
        />
        <circle cx={81} cy={78} r={4.5} fill={C.paper} />
      </g>
      <path
        d="M122 30l-14 22h10l-6 20 18-26h-11l7-16z"
        fill={C.butter}
        stroke={C.butterDeep}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <Sparkle x={34} y={34} size={1} fill={C.blushDeep} />
    </Art>
  );
}

function Page({
  x,
  y,
  rotate,
  header = C.blue,
}: {
  x: number;
  y: number;
  rotate: number;
  header?: string;
}) {
  return (
    <g transform={`rotate(${rotate} ${x + 30} ${y + 38})`}>
      <rect
        x={x}
        y={y}
        width={60}
        height={76}
        rx={8}
        fill={C.paper}
        stroke={C.line}
        strokeWidth={1.5}
      />
      <circle cx={x + 14} cy={y + 15} r={6} fill={C.blueSoft} />
      <rect x={x + 24} y={y + 11} width={26} height={4} rx={2} fill={header} />
      <rect
        x={x + 24}
        y={y + 18}
        width={16}
        height={3}
        rx={1.5}
        fill={C.line}
      />
      <rect x={x + 9} y={y + 32} width={42} height={3} rx={1.5} fill={C.line} />
      <rect x={x + 9} y={y + 40} width={36} height={3} rx={1.5} fill={C.line} />
      <rect x={x + 9} y={y + 48} width={40} height={3} rx={1.5} fill={C.line} />
      <rect x={x + 9} y={y + 56} width={28} height={3} rx={1.5} fill={C.line} />
    </g>
  );
}

/** A CV with a score disc. */
export function ScoreCvArt() {
  return (
    <Art>
      <Shadow />
      <Page x={34} y={20} rotate={-8} />
      <g transform="rotate(10 108 70)">
        <circle cx={108} cy={70} r={27} fill={C.blush} />
        <circle
          cx={108}
          cy={70}
          r={20}
          fill="none"
          stroke={C.paper}
          strokeWidth={5}
          strokeDasharray="100 126"
          strokeLinecap="round"
          transform="rotate(-90 108 70)"
        />
        <text
          x={108}
          y={77}
          textAnchor="middle"
          fontFamily="Space Grotesk, Inter, sans-serif"
          fontWeight={700}
          fontSize={19}
          fill={C.blue}
        >
          92
        </text>
      </g>
      <Sparkle x={136} y={36} size={1.1} fill={C.blue} />
      <Sparkle x={26} y={90} size={0.8} />
    </Art>
  );
}

/** Skill chips with a plus coin. */
export function SkillsArt() {
  return (
    <Art>
      <Shadow />
      <g transform="rotate(-8 70 40)">
        <rect x={30} y={28} width={70} height={22} rx={11} fill={C.blue} />
        <circle cx={42} cy={39} r={4} fill={C.paper} />
        <rect x={52} y={36} width={38} height={6} rx={3} fill={C.blueSoft} />
      </g>
      <g transform="rotate(4 70 66)">
        <rect x={40} y={56} width={60} height={22} rx={11} fill={C.lilac} />
        <circle cx={52} cy={67} r={4} fill={C.paper} />
        <rect x={62} y={64} width={28} height={6} rx={3} fill={C.paper} />
      </g>
      <g transform="rotate(-3 62 92)">
        <rect x={28} y={82} width={58} height={20} rx={10} fill={C.mint} />
        <circle cx={40} cy={92} r={4} fill={C.paper} />
        <rect x={50} y={89} width={26} height={6} rx={3} fill={C.paper} />
      </g>
      <g transform="translate(118 62)">
        <circle r={21} fill={C.butterDeep} />
        <circle r={17} fill={C.butter} />
        <path
          d="M0-8v16M-8 0h16"
          stroke={C.ink}
          strokeWidth={4}
          strokeLinecap="round"
        />
      </g>
      <Sparkle x={130} y={24} size={1} fill={C.blue} />
    </Art>
  );
}
