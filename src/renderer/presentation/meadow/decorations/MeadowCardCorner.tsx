import React from 'react';
import whiteFlower from '../assets/single-white-flower.png';
import yellowFlowers from '../assets/two-yello-flower.png';
import purpleFlowers from '../assets/purple-flower-bunch.png';
import grass from '../assets/grass-tuft-3-v1.png';
import './MeadowCardCorner.css';

/** Opt-in artwork for a short, uncluttered card. The parent owns text clearance. */
export function MeadowCardCorner({
  variant,
}: {
  variant: 'subtle' | 'floral';
}) {
  return (
    <span
      className={`meadow-card-corner meadow-card-corner-${variant}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 170 90" preserveAspectRatio="none" focusable="false">
        <defs>
          <linearGradient
            id={`corner-hill-${variant}`}
            x1="0"
            y1="0"
            x2="1"
            y2="1"
          >
            <stop stopColor="#f1edb4" />
            <stop offset="1" stopColor="#c4dc94" />
          </linearGradient>
        </defs>
        <path
          d="M0 90 C48 80 72 52 112 44 C140 37 156 41 170 25 L170 90Z"
          fill={`url(#corner-hill-${variant})`}
        />
        <path
          d="M42 90 C90 86 120 65 170 66 L170 90Z"
          fill="#b4d38c"
          opacity=".55"
        />
      </svg>
      <img className="meadow-card-grass" src={grass} alt="" />
      <img className="meadow-card-white" src={whiteFlower} alt="" />
      {variant === 'floral' && (
        <>
          <img className="meadow-card-yellow" src={yellowFlowers} alt="" />
          <img className="meadow-card-purple" src={purpleFlowers} alt="" />
        </>
      )}
    </span>
  );
}
